import { getCodeIndex } from "./index-tools.js";
import { isTestFileStrict as isTestFile } from "../utils/test-file.js";
import { REACT_STDLIB_HOOKS } from "./react-tools.js";
import type { CodeSymbol, Direction, CallNode } from "../types.js";

const DEFAULT_CALL_DEPTH = 1;

/** Maximum total nodes in a call tree to prevent runaway expansion */
const MAX_TREE_NODES = 500;

/** Maximum children per node to keep output readable */
const MAX_CHILDREN_PER_NODE = 20;

/** Minimum symbol name length to consider as a call edge (skip `id`, `e`, etc.) */
const MIN_CALL_NAME_LENGTH = 3;

/** Symbol kinds that represent callable entities */
const CALLABLE_KINDS = new Set([
  "function", "method", "class", "default_export", "variable",
  "component", "hook",
]);

/**
 * Pre-computed adjacency lists for O(1) lookup during BFS.
 * Built once per traceCallChain / impactAnalysis call.
 */
export interface AdjacencyIndex {
  /** symbol id → symbols that this symbol references (callees) */
  callees: Map<string, CodeSymbol[]>;
  /** symbol id → symbols that reference this symbol (callers) */
  callers: Map<string, CodeSymbol[]>;
}

/**
 * Extract identifiers that look like function/method calls from source code.
 * Matches patterns like: `functionName(`, `obj.methodName(`, `this.method(`
 * Also matches JSX component usage: `<ComponentName`, which captures React
 * component rendering as a call-graph edge (PascalCase filter skips HTML tags).
 * Returns a Set of the called/used identifier names.
 */
function extractCallSites(source: string): Set<string> {
  const calls = new Set<string>();

  // Match: word followed by ( — captures function calls and method calls
  // Also handles: this.method(, obj.method(, await func(, new Class(
  const callPattern = /\b([a-zA-Z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(source)) !== null) {
    const name = match[1]!;
    // Skip language keywords that look like calls
    if (!KEYWORD_SET.has(name) && name.length >= MIN_CALL_NAME_LENGTH) {
      calls.add(name);
    }
  }

  // JSX component usage: <PascalCaseComponent ...> or <PascalCaseComponent/>
  // PascalCase filter (<[A-Z]) skips HTML elements like <div>, <span>, <button>.
  // This makes trace_call_chain, impact_analysis, find_dead_code etc. React-aware.
  const jsxPattern = /<([A-Z][a-zA-Z0-9_$]*)\b/g;
  while ((match = jsxPattern.exec(source)) !== null) {
    const name = match[1]!;
    if (name.length >= MIN_CALL_NAME_LENGTH) {
      calls.add(name);
    }
  }

  // PHP method and static calls: ->method(, ::method(
  // e.g. $this->render(, Yii::$app->db->createCommand(, User::find(
  const phpCallPattern = /(?:->|::)([a-zA-Z_][\w]*)\s*\(/g;
  while ((match = phpCallPattern.exec(source)) !== null) {
    const name = match[1]!;
    if (!KEYWORD_SET.has(name) && name.length >= MIN_CALL_NAME_LENGTH) {
      calls.add(name);
    }
  }

  return calls;
}

/** JS/TS keywords that appear with ( but are not function calls */
const KEYWORD_SET = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "instanceof",
  "new", "throw", "delete", "void", "yield", "await", "import", "export",
  "from", "const", "let", "var", "function", "class", "extends", "implements",
  "interface", "type", "enum", "async", "static", "get", "set", "constructor",
  "super", "this", "true", "false", "null", "undefined", "try", "finally",
  "else", "case", "default", "break", "continue", "do", "in", "of",
  "as", "is", "keyof", "readonly", "declare", "abstract", "override",
  "public", "private", "protected",
  // Kotlin keywords that appear with ( but are not function calls
  "when", "fun", "val", "var", "data", "sealed", "object", "companion",
  "suspend", "inline", "reified", "lateinit", "init", "typealias", "by",
  "internal", "open", "inner", "crossinline", "noinline", "tailrec",
  "operator", "infix", "annotation", "actual", "expect",
  // PHP keywords that appear with ( but are not function calls
  "foreach", "endforeach", "endif", "endwhile", "endfor", "endswitch",
  "match", "fn", "list", "array", "empty", "isset", "unset", "print",
  "echo", "include", "include_once", "require", "require_once",
  "global", "clone", "instanceof", "trait", "namespace", "use",
]);

/**
 * Build caller/callee adjacency lists by extracting actual call sites from source code.
 *
 * For each symbol with source, extracts identifiers used as function calls (pattern: `name(`)
 * and looks them up in the symbol name index. This produces much more accurate edges than
 * simple word-boundary matching, which matches any mention of a symbol name.
 *
 * @param allSymbols - All symbols in the index
 * @param skipTests - If true, exclude symbols from test files (default: true)
 * @param filterReactHooks - If true, skip edges to React stdlib hooks (useState, useEffect, etc.)
 *                           to reduce call graph noise in React codebases.
 */
function buildAdjacencyIndex(
  allSymbols: CodeSymbol[],
  skipTests = true,
  filterReactHooks = false,
): AdjacencyIndex {
  const callees = new Map<string, CodeSymbol[]>();
  const callers = new Map<string, CodeSymbol[]>();

  // Filter symbols: optionally skip test files
  const symbols = skipTests
    ? allSymbols.filter(s => !isTestFile(s.file))
    : allSymbols;

  // Build name → symbols lookup (only callable kinds for callee targets)
  const nameToSymbols = new Map<string, CodeSymbol[]>();
  for (const sym of symbols) {
    if (!CALLABLE_KINDS.has(sym.kind)) continue;
    if (sym.name.length < MIN_CALL_NAME_LENGTH) continue;

    const existing = nameToSymbols.get(sym.name);
    if (existing) existing.push(sym);
    else nameToSymbols.set(sym.name, [sym]);
  }

  // For each symbol with source, extract call sites and find matching targets
  for (const sym of symbols) {
    if (!sym.source) continue;

    const callSites = extractCallSites(sym.source);
    const symCallees: CodeSymbol[] = [];

    for (const calledName of callSites) {
      // Filter out React stdlib hooks when requested (reduces graph noise)
      if (filterReactHooks && REACT_STDLIB_HOOKS.has(calledName)) continue;

      const targets = nameToSymbols.get(calledName);
      if (!targets) continue;

      for (const target of targets) {
        if (target.id === sym.id) continue;
        // Skip self-file references for common patterns (e.g., method calling sibling method)
        // Keep cross-file references always
        symCallees.push(target);

        // Record reverse edge (caller)
        const targetCallers = callers.get(target.id);
        if (targetCallers) targetCallers.push(sym);
        else callers.set(target.id, [sym]);
      }
    }

    if (symCallees.length > 0) {
      callees.set(sym.id, symCallees);
    }
  }

  return { callees, callers };
}

/**
 * BFS traversal to build a call chain tree up to the given depth.
 * Uses pre-built adjacency index for O(1) neighbor lookups.
 * Enforces MAX_TREE_NODES and MAX_CHILDREN_PER_NODE limits.
 */
function buildCallTree(
  root: CodeSymbol,
  adjacency: AdjacencyIndex,
  direction: Direction,
  maxDepth: number,
): CallNode {
  const visited = new Set<string>([root.id]);
  const adj = direction === "callees" ? adjacency.callees : adjacency.callers;
  let totalNodes = 1;

  function expand(symbol: CodeSymbol, depth: number): CallNode {
    if (depth >= maxDepth || totalNodes >= MAX_TREE_NODES) {
      return { symbol, children: [] };
    }

    const neighbors = adj.get(symbol.id) ?? [];

    const children: CallNode[] = [];
    for (const neighbor of neighbors) {
      if (totalNodes >= MAX_TREE_NODES) break;
      if (children.length >= MAX_CHILDREN_PER_NODE) break;
      if (visited.has(neighbor.id)) continue;
      visited.add(neighbor.id);
      totalNodes++;
      children.push(expand(neighbor, depth + 1));
    }

    return { symbol, children };
  }

  return expand(root, 0);
}

/**
 * Strip the `source` field from a CodeSymbol, keeping compact metadata.
 */
function stripSource(sym: CodeSymbol): CodeSymbol {
  const { source: _, repo: _r, tokens: _t, start_col: _sc, end_col: _ec, id, ...rest } = sym;
  const shortId = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  return { ...rest, id: shortId } as CodeSymbol;
}

/**
 * Recursively strip `source` from all symbols in a CallNode tree.
 */
function stripCallTreeSource(node: CallNode): CallNode {
  return {
    symbol: stripSource(node.symbol),
    children: node.children.map(stripCallTreeSource),
  };
}

export type OutputFormat = "json" | "mermaid";

export interface TraceOptions {
  depth?: number | undefined;
  include_source?: boolean | undefined;
  include_tests?: boolean | undefined;
  output_format?: OutputFormat | undefined;
  /** Skip edges to React stdlib hooks (useState, useEffect, etc.) to reduce graph noise. */
  filter_react_hooks?: boolean | undefined;
}

/**
 * Trace the call chain for a symbol in a repository.
 * Returns a tree of callers or callees up to the specified depth.
 * By default, source code is stripped from symbols to keep output compact.
 * Test files are excluded by default (use include_tests: true to include them).
 */
export async function traceCallChain(
  repo: string,
  symbolName: string,
  direction: Direction,
  depthOrOptions?: number | TraceOptions,
): Promise<CallNode> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository not found: ${repo}`);
  }

  // Support both legacy (depth: number) and new (options: TraceOptions) signatures
  let maxDepth: number;
  let includeSource: boolean;
  let includeTests: boolean;
  let outputFormat: OutputFormat;
  let filterReactHooks: boolean;
  if (typeof depthOrOptions === "object" && depthOrOptions !== null) {
    maxDepth = depthOrOptions.depth ?? DEFAULT_CALL_DEPTH;
    includeSource = depthOrOptions.include_source ?? false;
    includeTests = depthOrOptions.include_tests ?? false;
    outputFormat = depthOrOptions.output_format ?? "json";
    filterReactHooks = depthOrOptions.filter_react_hooks ?? false;
  } else {
    maxDepth = depthOrOptions ?? DEFAULT_CALL_DEPTH;
    includeSource = false;
    includeTests = false;
    outputFormat = "json";
    filterReactHooks = false;
  }

  // Find the target symbol — prefer non-test files when tests are excluded
  const candidates = index.symbols.filter((s) => s.name === symbolName);
  let target: CodeSymbol | undefined;
  if (!includeTests) {
    target = candidates.find((s) => !isTestFile(s.file));
  }
  target ??= candidates[0];

  if (!target) {
    throw new Error(
      `Symbol "${symbolName}" not found in repository "${repo}"`,
    );
  }

  const adjacency = buildAdjacencyIndex(index.symbols, !includeTests, filterReactHooks);
  const tree = buildCallTree(target, adjacency, direction, maxDepth);

  if (outputFormat === "mermaid") {
    const mermaid = callTreeToMermaid(tree, direction);
    // Return as a special shape that serializes to the diagram string
    return { mermaid, direction, root: symbolName, depth: maxDepth } as unknown as CallNode;
  }

  return includeSource ? tree : stripCallTreeSource(tree);
}

/**
 * Convert a CallNode tree to a Mermaid flowchart diagram.
 */
function callTreeToMermaid(tree: CallNode, direction: Direction): string {
  const lines: string[] = ["graph TD"];
  const visited = new Set<string>();

  function nodeId(sym: CodeSymbol): string {
    // Sanitize for Mermaid: replace special chars
    return sym.id.replace(/[^a-zA-Z0-9_]/g, "_");
  }

  function nodeLabel(sym: CodeSymbol): string {
    const shortFile = sym.file.split("/").pop() ?? sym.file;
    return `${sym.name}<br/><small>${shortFile}:${sym.start_line}</small>`;
  }

  function walk(node: CallNode, parentId?: string): void {
    const id = nodeId(node.symbol);

    if (!visited.has(id)) {
      visited.add(id);
      lines.push(`  ${id}["${nodeLabel(node.symbol)}"]`);
    }

    if (parentId) {
      if (direction === "callees") {
        lines.push(`  ${parentId} --> ${id}`);
      } else {
        lines.push(`  ${id} --> ${parentId}`);
      }
    }

    for (const child of node.children) {
      walk(child, id);
    }
  }

  walk(tree);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Symbol role classification
// ---------------------------------------------------------------------------

export type SymbolRole = "entry" | "core" | "utility" | "dead" | "leaf";

export interface SymbolRoleInfo {
  id: string;
  name: string;
  kind: string;
  file: string;
  role: SymbolRole;
  callers: number;
  callees: number;
}

/**
 * Classify every symbol's architectural role based on call graph connectivity.
 *
 * - entry: many callees, few callers (handlers, main, CLI commands)
 * - core: high connectivity both ways (key business logic)
 * - utility: many callers, few callees (helpers, formatters, validators)
 * - dead: zero callers (potentially unused)
 * - leaf: zero callees (terminal functions)
 */
export async function classifySymbolRoles(
  repo: string,
  options?: { file_pattern?: string | undefined; include_tests?: boolean | undefined; top_n?: number | undefined },
): Promise<SymbolRoleInfo[]> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository not found: ${repo}`);

  const skipTests = !(options?.include_tests ?? false);
  const adjacency = buildAdjacencyIndex(index.symbols, skipTests);

  const results: SymbolRoleInfo[] = [];

  for (const sym of index.symbols) {
    if (skipTests && isTestFile(sym.file)) continue;
    if (options?.file_pattern && !sym.file.includes(options.file_pattern)) continue;
    if (!CALLABLE_KINDS.has(sym.kind)) continue;

    const callerCount = (adjacency.callers.get(sym.id) ?? []).length;
    const calleeCount = (adjacency.callees.get(sym.id) ?? []).length;

    const role = classifyRole(callerCount, calleeCount);

    results.push({
      id: sym.id,
      name: sym.name,
      kind: sym.kind,
      file: sym.file,
      role,
      callers: callerCount,
      callees: calleeCount,
    });
  }

  results.sort((a, b) => (b.callers + b.callees) - (a.callers + a.callees));

  const limit = options?.top_n ?? 100;
  return results.slice(0, limit);
}

function classifyRole(callers: number, callees: number): SymbolRole {
  if (callers === 0 && callees === 0) return "dead";
  if (callers === 0) return "dead";
  if (callees === 0) return "leaf";

  const ratio = callers / (callees || 1);

  // High callers, few callees → utility (helpers called by many)
  if (ratio >= 3 && callers >= 3) return "utility";

  // Few callers, many callees → entry point (orchestrator)
  if (ratio <= 0.33 && callees >= 3) return "entry";

  // Both high → core business logic
  if (callers >= 2 && callees >= 2) return "core";

  // Default: leaf-like
  return "leaf";
}

// ---------------------------------------------------------------------------
// Circular dependency detection via DFS on import graph
// ---------------------------------------------------------------------------

export interface CircularDep {
  cycle: string[];   // file paths forming the cycle
  length: number;
}

export interface CircularDepsResult {
  cycles: CircularDep[];
  total_files: number;
  total_edges: number;
}

export async function findCircularDeps(
  repo: string,
  options?: { max_cycles?: number; file_pattern?: string },
): Promise<CircularDepsResult> {
  const { collectImportEdges } = await import("../utils/import-graph.js");
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found`);

  const edges = await collectImportEdges(index);
  const filteredEdges = options?.file_pattern
    ? edges.filter((e) => e.from.includes(options.file_pattern!) || e.to.includes(options.file_pattern!))
    : edges;

  // Build directed adjacency (from → to only)
  const adj = new Map<string, string[]>();
  for (const edge of filteredEdges) {
    let list = adj.get(edge.from);
    if (!list) { list = []; adj.set(edge.from, list); }
    list.push(edge.to);
  }

  const maxCycles = options?.max_cycles ?? 50;
  const cycles: CircularDep[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];

  function dfs(node: string): void {
    if (cycles.length >= maxCycles) return;
    if (inStack.has(node)) {
      // Found a cycle — extract it
      const cycleStart = stack.indexOf(node);
      if (cycleStart >= 0) {
        const cycle = [...stack.slice(cycleStart), node];
        cycles.push({ cycle, length: cycle.length - 1 });
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    stack.push(node);

    for (const neighbor of adj.get(node) ?? []) {
      dfs(neighbor);
      if (cycles.length >= maxCycles) return;
    }

    stack.pop();
    inStack.delete(node);
  }

  for (const node of adj.keys()) {
    if (!visited.has(node) && cycles.length < maxCycles) {
      dfs(node);
    }
  }

  return {
    cycles,
    total_files: new Set([...filteredEdges.map((e) => e.from), ...filteredEdges.map((e) => e.to)]).size,
    total_edges: filteredEdges.length,
  };
}

// Export shared utilities for impact-tools and testing
export { buildAdjacencyIndex, extractCallSites, buildCallTree, stripSource, isTestFile, classifyRole };
