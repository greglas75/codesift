import { execSync } from "node:child_process";
import { getCodeIndex } from "./index-tools.js";
import { validateGitRef } from "../utils/git-validation.js";
import { isTestFileStrict as isTestFile } from "../utils/test-file.js";
import type { CodeSymbol, CodeIndex, Direction, CallNode, ImpactResult } from "../types.js";

const DEFAULT_CALL_DEPTH = 1;
const DEFAULT_IMPACT_DEPTH = 2;

/** Maximum total nodes in a call tree to prevent runaway expansion */
const MAX_TREE_NODES = 500;

/** Maximum children per node to keep output readable */
const MAX_CHILDREN_PER_NODE = 20;

/** Minimum symbol name length to consider as a call edge (skip `id`, `e`, etc.) */
const MIN_CALL_NAME_LENGTH = 3;

/** Symbol kinds that represent callable entities */
const CALLABLE_KINDS = new Set([
  "function", "method", "class", "default_export", "variable",
]);

/**
 * Pre-computed adjacency lists for O(1) lookup during BFS.
 * Built once per traceCallChain / impactAnalysis call.
 */
interface AdjacencyIndex {
  /** symbol id → symbols that this symbol references (callees) */
  callees: Map<string, CodeSymbol[]>;
  /** symbol id → symbols that reference this symbol (callers) */
  callers: Map<string, CodeSymbol[]>;
}

/**
 * Extract identifiers that look like function/method calls from source code.
 * Matches patterns like: `functionName(`, `obj.methodName(`, `this.method(`
 * Returns a Set of the called identifier names.
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
 */
function buildAdjacencyIndex(allSymbols: CodeSymbol[], skipTests = true): AdjacencyIndex {
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
  const { source: _, ...rest } = sym;
  return rest;
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

export interface TraceOptions {
  depth?: number | undefined;
  include_source?: boolean | undefined;
  include_tests?: boolean | undefined;
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
  if (typeof depthOrOptions === "object" && depthOrOptions !== null) {
    maxDepth = depthOrOptions.depth ?? DEFAULT_CALL_DEPTH;
    includeSource = depthOrOptions.include_source ?? false;
    includeTests = depthOrOptions.include_tests ?? false;
  } else {
    maxDepth = depthOrOptions ?? DEFAULT_CALL_DEPTH;
    includeSource = false;
    includeTests = false;
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

  const adjacency = buildAdjacencyIndex(index.symbols, !includeTests);
  const tree = buildCallTree(target, adjacency, direction, maxDepth);

  return includeSource ? tree : stripCallTreeSource(tree);
}

/**
 * Find all callers of the given symbols, recursing up to depth levels.
 * Uses pre-built adjacency index for efficient lookups.
 */
function findAffectedSymbols(
  changedSymbols: CodeSymbol[],
  adjacency: AdjacencyIndex,
  maxDepth: number,
): CodeSymbol[] {
  const affected = new Map<string, CodeSymbol>();

  for (const sym of changedSymbols) {
    affected.set(sym.id, sym);
  }

  let frontier = changedSymbols;

  for (let d = 0; d < maxDepth; d++) {
    const nextFrontier: CodeSymbol[] = [];

    for (const sym of frontier) {
      const symCallers = adjacency.callers.get(sym.id) ?? [];
      for (const caller of symCallers) {
        if (!affected.has(caller.id)) {
          affected.set(caller.id, caller);
          nextFrontier.push(caller);
        }
      }
    }

    if (nextFrontier.length === 0) break;
    frontier = nextFrontier;
  }

  return [...affected.values()];
}

/**
 * Build a file-level dependency graph from pre-computed adjacency.
 */
function buildFileDependencyGraph(
  index: CodeIndex,
  adjacency: AdjacencyIndex,
): Record<string, string[]> {
  const graph: Record<string, string[]> = {};
  const symbolsByFile = new Map<string, CodeSymbol[]>();

  for (const sym of index.symbols) {
    const existing = symbolsByFile.get(sym.file);
    if (existing) existing.push(sym);
    else symbolsByFile.set(sym.file, [sym]);
  }

  for (const [file, fileSymbols] of symbolsByFile) {
    const dependentFiles = new Set<string>();

    for (const sym of fileSymbols) {
      const symCallers = adjacency.callers.get(sym.id) ?? [];
      for (const caller of symCallers) {
        if (caller.file !== file) {
          dependentFiles.add(caller.file);
        }
      }
    }

    if (dependentFiles.size > 0) {
      graph[file] = [...dependentFiles];
    }
  }

  return graph;
}

/**
 * Run git diff to find changed files between two refs.
 */
function getChangedFiles(repoRoot: string, since: string, until: string): string[] {
  validateGitRef(since);
  validateGitRef(until);

  try {
    const output = execSync(`git diff --name-only ${since}..${until}`, {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 10_000,
    });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Git diff failed: ${message}`);
  }
}

export interface ImpactOptions {
  depth?: number | undefined;
  until?: string | undefined;
  include_source?: boolean | undefined;
}

/**
 * Analyze the impact of recent git changes on a repository.
 * Finds changed files, affected symbols, and builds a dependency graph.
 * By default, source code is stripped from symbols to keep output compact.
 */
export async function impactAnalysis(
  repo: string,
  since: string,
  depthOrOptions?: number | ImpactOptions,
  until?: string,
): Promise<ImpactResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository not found: ${repo}`);
  }

  // Support both legacy (depth: number, until: string) and new (options: ImpactOptions) signatures
  let maxDepth: number;
  let untilRef: string;
  let includeSource: boolean;
  if (typeof depthOrOptions === "object" && depthOrOptions !== null) {
    maxDepth = depthOrOptions.depth ?? DEFAULT_IMPACT_DEPTH;
    untilRef = depthOrOptions.until ?? until ?? "HEAD";
    includeSource = depthOrOptions.include_source ?? false;
  } else {
    maxDepth = depthOrOptions ?? DEFAULT_IMPACT_DEPTH;
    untilRef = until ?? "HEAD";
    includeSource = false;
  }

  const changedFiles = getChangedFiles(index.root, since, untilRef);

  // Find all symbols in changed files
  const changedSymbols = index.symbols.filter((s) =>
    changedFiles.includes(s.file),
  );

  // Build adjacency index once, reuse for both affected + dependency graph
  // Include test files for impact analysis (want to know which tests are affected)
  const adjacency = buildAdjacencyIndex(index.symbols, false);

  const affectedSymbols = findAffectedSymbols(
    changedSymbols,
    adjacency,
    maxDepth,
  );

  const dependencyGraph = buildFileDependencyGraph(index, adjacency);

  return {
    changed_files: changedFiles,
    affected_symbols: includeSource
      ? affectedSymbols
      : affectedSymbols.map(stripSource),
    dependency_graph: dependencyGraph,
  };
}

// Export for testing
export { buildAdjacencyIndex, extractCallSites, buildCallTree, isTestFile };
