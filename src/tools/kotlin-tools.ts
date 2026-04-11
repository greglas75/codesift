/**
 * Kotlin-specific analysis tools.
 *
 * find_extension_functions — discover all extension functions for a receiver type
 * analyze_sealed_hierarchy — find subtypes and missing when() branches
 * trace_suspend_chain      — suspend call chain + dispatcher + blocking anti-patterns
 */
import { getCodeIndex } from "./index-tools.js";
import type { CodeSymbol } from "../types.js";

// ---------------------------------------------------------------------------
// find_extension_functions
// ---------------------------------------------------------------------------

export interface ExtensionFunctionResult {
  receiver_type: string;
  extensions: Array<{
    name: string;
    file: string;
    start_line: number;
    signature?: string;
    docstring?: string;
  }>;
  total: number;
}

/**
 * Find all extension functions defined for a given receiver type.
 * Scans Kotlin symbol signatures for the `ReceiverType.` prefix pattern.
 */
export async function findExtensionFunctions(
  repo: string,
  receiverType: string,
  options?: { file_pattern?: string },
): Promise<ExtensionFunctionResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const pattern = `${receiverType}.`;
  const extensions: ExtensionFunctionResult["extensions"] = [];

  for (const sym of index.symbols) {
    if (sym.kind !== "function") continue;
    if (!sym.signature) continue;
    if (options?.file_pattern && !sym.file.includes(options.file_pattern)) continue;

    // Match receiver type in signature — look for "ReceiverType." prefix
    // Signatures look like: "String.(param: Int): Boolean" or "suspend List<T>.(x: T): T"
    // Strip leading "suspend " for matching
    const sig = sym.signature.replace(/^suspend\s+/, "");
    // Check for exact type match or generic match (e.g., "List<T>." matches "List")
    if (sig.startsWith(pattern) || sig.startsWith(`${receiverType}<`)) {
      extensions.push({
        name: sym.name,
        file: sym.file,
        start_line: sym.start_line,
        ...(sym.signature ? { signature: sym.signature } : {}),
        ...(sym.docstring ? { docstring: sym.docstring } : {}),
      });
    }
  }

  // Sort by file then line for stable output
  extensions.sort((a, b) => a.file.localeCompare(b.file) || a.start_line - b.start_line);

  return {
    receiver_type: receiverType,
    extensions,
    total: extensions.length,
  };
}

// ---------------------------------------------------------------------------
// analyze_sealed_hierarchy
// ---------------------------------------------------------------------------

export interface SealedHierarchyResult {
  sealed_class: {
    name: string;
    file: string;
    start_line: number;
    kind: string;
  };
  subtypes: Array<{
    name: string;
    file: string;
    start_line: number;
    kind: string;
  }>;
  when_blocks: Array<{
    file: string;
    line: number;
    branches_found: string[];
    branches_missing: string[];
    is_exhaustive: boolean;
  }>;
  total_subtypes: number;
  total_when_blocks: number;
  all_exhaustive: boolean;
}

/**
 * Analyze a sealed class/interface hierarchy.
 * Finds all subtypes and checks when() blocks for exhaustiveness.
 */
export async function analyzeSealedHierarchy(
  repo: string,
  sealedClassName: string,
): Promise<SealedHierarchyResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  // Find the sealed class/interface
  const sealedSym = index.symbols.find(
    (s) =>
      s.name === sealedClassName &&
      (s.kind === "class" || s.kind === "interface") &&
      s.source?.includes("sealed"),
  );

  if (!sealedSym) {
    throw new Error(
      `Sealed class/interface "${sealedClassName}" not found. Ensure the file is indexed.`,
    );
  }

  // Find subtypes — classes whose source contains `: SealedName` or `: SealedName()`
  // as a delegation specifier (supertype)
  const subtypePattern = new RegExp(
    `:\\s*(?:[\\w<>,\\s]+,\\s*)?${sealedClassName}\\s*[({,)]|:\\s*${sealedClassName}\\s*$`,
  );

  const subtypes: SealedHierarchyResult["subtypes"] = [];
  for (const sym of index.symbols) {
    if (sym.kind !== "class" && sym.kind !== "interface") continue;
    if (sym.name === sealedClassName) continue;
    if (!sym.source) continue;

    if (subtypePattern.test(sym.source)) {
      subtypes.push({
        name: sym.name,
        file: sym.file,
        start_line: sym.start_line,
        kind: sym.kind,
      });
    }
  }

  const subtypeNames = new Set(subtypes.map((s) => s.name));

  // Find when() blocks that reference the sealed class
  // Search for `when (expr)` patterns in Kotlin files where expr involves the sealed type
  const whenBlocks: SealedHierarchyResult["when_blocks"] = [];

  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const kotlinFiles = index.files.filter((f) => /\.kts?$/.test(f.path));

  for (const file of kotlinFiles) {
    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch {
      continue;
    }

    // Find when blocks — look for `when (` or `when {` patterns
    const whenPattern = /\bwhen\s*\([^)]*\)\s*\{/g;
    let match: RegExpExecArray | null;

    while ((match = whenPattern.exec(source)) !== null) {
      // Check if this when block references any of the subtypes
      // Extract the block content (approximate — find matching closing brace)
      const blockStart = match.index + match[0].length;
      let depth = 1;
      let blockEnd = blockStart;
      for (let i = blockStart; i < source.length && depth > 0; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") depth--;
        blockEnd = i;
      }

      const blockContent = source.slice(match.index, blockEnd + 1);

      // Check if this when block references our sealed class subtypes
      const branchesFound: string[] = [];
      for (const subName of subtypeNames) {
        // Match: `is SubName ->` or `SubName ->` or `is SubName,`
        const branchRe = new RegExp(`\\b(?:is\\s+)?${subName}\\b`);
        if (branchRe.test(blockContent)) {
          branchesFound.push(subName);
        }
      }

      // Only report when blocks that reference at least one subtype
      if (branchesFound.length === 0) continue;

      const branchesMissing = [...subtypeNames].filter(
        (n) => !branchesFound.includes(n),
      );

      const lineNum =
        source.slice(0, match.index).split("\n").length;

      whenBlocks.push({
        file: file.path,
        line: lineNum,
        branches_found: branchesFound.sort(),
        branches_missing: branchesMissing.sort(),
        is_exhaustive: branchesMissing.length === 0,
      });
    }
  }

  return {
    sealed_class: {
      name: sealedSym.name,
      file: sealedSym.file,
      start_line: sealedSym.start_line,
      kind: sealedSym.kind,
    },
    subtypes,
    when_blocks: whenBlocks,
    total_subtypes: subtypes.length,
    total_when_blocks: whenBlocks.length,
    all_exhaustive: whenBlocks.length > 0 && whenBlocks.every((w) => w.is_exhaustive),
  };
}

// ---------------------------------------------------------------------------
// trace_suspend_chain
// ---------------------------------------------------------------------------

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

/**
 * Determines whether a symbol is a suspend function. Checks the signature
 * prefix first (populated by the Kotlin extractor for extension funcs) then
 * falls back to scanning the source head for the `suspend` modifier keyword.
 */
function isSuspendFunction(sym: CodeSymbol): boolean {
  if (sym.kind !== "function" && sym.kind !== "method") return false;
  if (sym.signature?.startsWith("suspend")) return true;
  const head = sym.source?.slice(0, 200);
  if (!head) return false;
  return /\bsuspend\s+fun\b/.test(head);
}

/**
 * Scan a suspend function's source for common Kotlin coroutine anti-patterns.
 * Returns an array of warnings (one per finding) plus the dispatcher
 * transitions observed in the same pass.
 */
function analyzeSuspendBody(
  sym: CodeSymbol,
): { warnings: SuspendWarning[]; transitions: SuspendDispatcherTransition[] } {
  const warnings: SuspendWarning[] = [];
  const transitions: SuspendDispatcherTransition[] = [];

  const source = sym.source ?? "";
  const fnName = sym.name;

  // Dispatcher transitions: `withContext(Dispatchers.X)`
  const dispatcherRe = /withContext\s*\(\s*Dispatchers\.(\w+)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = dispatcherRe.exec(source)) !== null) {
    const lineOffset = source.slice(0, m.index).split("\n").length - 1;
    transitions.push({
      function: fnName,
      dispatcher: m[1]!,
      line: sym.start_line + lineOffset,
    });
  }

  // Anti-pattern 1: runBlocking inside a suspend function.
  const runBlockingMatch = /\brunBlocking\s*[\{(]/.exec(source);
  if (runBlockingMatch) {
    const lineOffset = source.slice(0, runBlockingMatch.index).split("\n").length - 1;
    warnings.push({
      function: fnName,
      file: sym.file,
      line: sym.start_line + lineOffset,
      message: "runBlocking inside a suspend function — deadlock risk on caller's dispatcher",
      severity: "critical",
    });
  }

  // Anti-pattern 2: Thread.sleep() blocks the coroutine thread.
  const threadSleepMatch = /\bThread\.sleep\s*\(/.exec(source);
  if (threadSleepMatch) {
    const lineOffset = source.slice(0, threadSleepMatch.index).split("\n").length - 1;
    warnings.push({
      function: fnName,
      file: sym.file,
      line: sym.start_line + lineOffset,
      message: "Thread.sleep() in suspend function — blocks dispatcher thread, use delay() instead",
      severity: "critical",
    });
  }

  // Anti-pattern 3: while(true) loop without ensureActive()/isActive check
  // means the coroutine can't be cancelled.
  const whileTrueMatch = /\bwhile\s*\(\s*true\s*\)\s*\{([\s\S]*?)\}/.exec(source);
  if (whileTrueMatch) {
    const body = whileTrueMatch[1] ?? "";
    const hasCancellationCheck =
      /\bensureActive\s*\(/.test(body) ||
      /\bisActive\b/.test(body) ||
      /\bcoroutineContext\.isActive\b/.test(body);
    if (!hasCancellationCheck) {
      const lineOffset = source.slice(0, whileTrueMatch.index).split("\n").length - 1;
      warnings.push({
        function: fnName,
        file: sym.file,
        line: sym.start_line + lineOffset,
        message:
          "while(true) loop without ensureActive()/isActive — loop is not cancellable, coroutine will leak",
        severity: "warning",
      });
    }
  }

  return { warnings, transitions };
}

/**
 * Trace the suspend function call chain starting from `functionName`. Walks
 * out up to `depth` levels through callees (identified by text scan of the
 * source), filtering to suspend-only nodes. Emits dispatcher transitions and
 * coroutine anti-pattern warnings for each visited function.
 *
 * Walk strategy: we look up each callee name in the symbol index. When a
 * function body contains `otherFn(`, we recurse into the symbol named
 * `otherFn` if it exists and is a suspend function. This is intentionally
 * lexical (not call-graph) — accurate enough for typical coroutine code and
 * avoids a full graph build.
 */
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

  const root = index.symbols.find(
    (s) => s.name === functionName && (s.kind === "function" || s.kind === "method"),
  );
  if (!root) {
    throw new Error(`Suspend function "${functionName}" not found.`);
  }
  if (!isSuspendFunction(root)) {
    throw new Error(`"${functionName}" is not a suspend function.`);
  }

  // Pre-index suspend functions by name for O(1) callee lookup.
  const suspendByName = new Map<string, CodeSymbol>();
  for (const sym of index.symbols) {
    if (isSuspendFunction(sym)) suspendByName.set(sym.name, sym);
  }

  const chain: string[] = [];
  const visited = new Set<string>();
  const allWarnings: SuspendWarning[] = [];
  const allTransitions: SuspendDispatcherTransition[] = [];

  function walk(sym: CodeSymbol, level: number): void {
    if (visited.has(sym.id) || level > maxDepth) return;
    visited.add(sym.id);
    chain.push(sym.name);

    const { warnings, transitions } = analyzeSuspendBody(sym);
    allWarnings.push(...warnings);
    allTransitions.push(...transitions);

    if (level === maxDepth) return;

    // Lexical callee discovery: find identifiers followed by ( in the body
    // and follow them if they map to a known suspend function.
    const source = sym.source ?? "";
    const callRe = /\b([a-z]\w*)\s*\(/g;
    const calleesSeen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(source)) !== null) {
      const name = m[1]!;
      if (name === sym.name || calleesSeen.has(name)) continue;
      calleesSeen.add(name);
      const callee = suspendByName.get(name);
      if (callee && callee.id !== sym.id) walk(callee, level + 1);
    }
  }

  walk(root, 0);

  return {
    root: root.name,
    chain,
    dispatcher_transitions: allTransitions,
    warnings: allWarnings,
    depth: maxDepth,
  };
}
