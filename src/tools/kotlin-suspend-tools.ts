import { getCodeIndex } from "./index-tools.js";
import type { CodeSymbol } from "../types.js";

export interface SuspendDispatcherTransition {
  function: string;
  dispatcher: string;
  line: number;
}

export interface SuspendWarning {
  function: string;
  file: string;
  line: number;
  message: string;
  severity: "warning" | "critical";
}

export interface SuspendChainResult {
  root: string;
  chain: string[];
  dispatcher_transitions: SuspendDispatcherTransition[];
  warnings: SuspendWarning[];
  depth: number;
}

function canonicalizeDispatcherName(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower === "io") return "IO";
  if (lower === "main" || lower === "mainimmediate") return "Main";
  if (lower === "default") return "Default";
  if (lower === "unconfined") return "Unconfined";
  return raw;
}

function classifyDispatcherExpression(expr: string): string | null {
  const staticMatch = /^Dispatchers\.(\w+)$/.exec(expr);
  if (staticMatch) return canonicalizeDispatcherName(staticMatch[1]!);

  const fieldMatch = /^[a-z]\w*\.(io|main|default|unconfined)$/i.exec(expr);
  if (fieldMatch) return canonicalizeDispatcherName(fieldMatch[1]!);

  const conventionMatch = /^(io|main|default|unconfined)Dispatcher$/i.exec(expr);
  if (conventionMatch) return canonicalizeDispatcherName(conventionMatch[1]!);
  return null;
}

function isSuspendFunction(symbol: CodeSymbol): boolean {
  if (symbol.kind !== "function" && symbol.kind !== "method") return false;
  if (symbol.signature?.startsWith("suspend")) return true;
  const head = symbol.source?.slice(0, 200);
  return head ? /\bsuspend\s+fun\b/.test(head) : false;
}

function sourceLine(symbol: CodeSymbol, matchIndex: number): number {
  return symbol.start_line + (symbol.source ?? "").slice(0, matchIndex).split("\n").length - 1;
}

function collectDispatcherTransitions(symbol: CodeSymbol): SuspendDispatcherTransition[] {
  const transitions: SuspendDispatcherTransition[] = [];
  const source = symbol.source ?? "";
  const dispatcherPattern = /withContext\s*\(\s*([A-Za-z_][\w.]*)\s*[,)]/g;
  let match: RegExpExecArray | null;
  while ((match = dispatcherPattern.exec(source)) !== null) {
    const dispatcher = classifyDispatcherExpression(match[1]!);
    if (dispatcher) {
      transitions.push({ function: symbol.name, dispatcher, line: sourceLine(symbol, match.index) });
    }
  }
  return transitions;
}

function blockingWarning(
  symbol: CodeSymbol,
  pattern: RegExp,
  message: string,
): SuspendWarning | undefined {
  const match = pattern.exec(symbol.source ?? "");
  return match ? {
    function: symbol.name,
    file: symbol.file,
    line: sourceLine(symbol, match.index),
    message,
    severity: "critical",
  } : undefined;
}

function cancellationWarning(symbol: CodeSymbol): SuspendWarning | undefined {
  const source = symbol.source ?? "";
  const match = /\bwhile\s*\(\s*true\s*\)\s*\{/.exec(source);
  if (!match) return undefined;
  const bodyStart = match.index + match[0].length;
  let depth = 1;
  let bodyEnd = bodyStart;
  for (let index = bodyStart; index < source.length && depth > 0; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}") depth--;
    bodyEnd = index;
  }
  const body = source.slice(bodyStart, bodyEnd);
  const isCancellable = /\bensureActive\s*\(/.test(body)
    || /\bisActive\b/.test(body)
    || /\bcoroutineContext\.isActive\b/.test(body);
  return isCancellable ? undefined : {
    function: symbol.name,
    file: symbol.file,
    line: sourceLine(symbol, match.index),
    message: "while(true) loop without ensureActive()/isActive — loop is not cancellable, coroutine will leak",
    severity: "warning",
  };
}

function analyzeSuspendBody(
  symbol: CodeSymbol,
): { warnings: SuspendWarning[]; transitions: SuspendDispatcherTransition[] } {
  const warnings = [
    blockingWarning(
      symbol,
      /\brunBlocking\s*[\{(]/,
      "runBlocking inside a suspend function — deadlock risk on caller's dispatcher",
    ),
    blockingWarning(
      symbol,
      /\bThread\.sleep\s*\(/,
      "Thread.sleep() in suspend function — blocks dispatcher thread, use delay() instead",
    ),
    cancellationWarning(symbol),
  ].filter((warning): warning is SuspendWarning => warning !== undefined);
  return { warnings, transitions: collectDispatcherTransitions(symbol) };
}

interface TraversalState {
  maxDepth: number;
  suspendByName: Map<string, CodeSymbol[]>;
  chain: string[];
  visited: Set<string>;
  warnings: SuspendWarning[];
  transitions: SuspendDispatcherTransition[];
}

function walkSuspendChain(symbol: CodeSymbol, level: number, state: TraversalState): void {
  if (state.visited.has(symbol.id) || level > state.maxDepth) return;
  state.visited.add(symbol.id);
  state.chain.push(symbol.name);
  const analysis = analyzeSuspendBody(symbol);
  state.warnings.push(...analysis.warnings);
  state.transitions.push(...analysis.transitions);
  if (level === state.maxDepth) return;

  const callPattern = /\b([A-Za-z_]\w*)\s*\(/g;
  const keywords = new Set(["catch", "for", "if", "try", "when", "while"]);
  const calleesSeen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(symbol.source ?? "")) !== null) {
    const name = match[1]!;
    if (name === symbol.name || keywords.has(name) || calleesSeen.has(name)) continue;
    calleesSeen.add(name);
    for (const callee of state.suspendByName.get(name) ?? []) {
      if (callee.id !== symbol.id) walkSuspendChain(callee, level + 1, state);
    }
  }
}

/** Trace a suspend call chain and report dispatcher transitions and warnings. */
export async function traceSuspendChain(
  repo: string,
  functionName: string,
  options?: { depth?: number },
): Promise<SuspendChainResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const maxDepth = options?.depth ?? 3;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new Error("depth must be a non-negative integer");
  }
  const root = index.symbols.find(
    (symbol) => symbol.name === functionName
      && (symbol.kind === "function" || symbol.kind === "method"),
  );
  if (!root) throw new Error(`Suspend function "${functionName}" not found.`);
  if (!isSuspendFunction(root)) throw new Error(`"${functionName}" is not a suspend function.`);

  const suspendByName = new Map<string, CodeSymbol[]>();
  for (const symbol of index.symbols) {
    if (!isSuspendFunction(symbol)) continue;
    const overloads = suspendByName.get(symbol.name) ?? [];
    overloads.push(symbol);
    suspendByName.set(symbol.name, overloads);
  }

  const state: TraversalState = {
    maxDepth,
    suspendByName,
    chain: [],
    visited: new Set(),
    warnings: [],
    transitions: [],
  };
  walkSuspendChain(root, 0, state);
  return {
    root: root.name,
    chain: state.chain,
    dispatcher_transitions: state.transitions,
    warnings: state.warnings,
    depth: maxDepth,
  };
}
