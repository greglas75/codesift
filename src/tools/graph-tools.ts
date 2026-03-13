import { execSync } from "node:child_process";
import { getCodeIndex } from "./index-tools.js";
import type { CodeSymbol, CodeIndex, Direction, CallNode, ImpactResult } from "../types.js";

const DEFAULT_CALL_DEPTH = 3;
const DEFAULT_IMPACT_DEPTH = 2;

/**
 * Validate a git ref to prevent command injection.
 * Allows alphanumeric, `/`, `.`, `-`, `_`, `~`, `^`, `@`, `{`, `}`.
 */
const GIT_REF_PATTERN = /^[a-zA-Z0-9_./\-~^@{}]+$/;

function validateGitRef(ref: string): void {
  if (!ref || !GIT_REF_PATTERN.test(ref)) {
    throw new Error(`Invalid git ref: "${ref}"`);
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pre-computed adjacency lists for O(n) lookup during BFS.
 * Built once per traceCallChain / impactAnalysis call.
 */
interface AdjacencyIndex {
  /** symbol id → symbols that this symbol references (callees) */
  callees: Map<string, CodeSymbol[]>;
  /** symbol id → symbols that reference this symbol (callers) */
  callers: Map<string, CodeSymbol[]>;
}

/**
 * Build caller/callee adjacency lists in a single O(n×m) pass
 * where m = average unique symbol names per source. After this,
 * BFS lookups are O(1) per node.
 */
function buildAdjacencyIndex(allSymbols: CodeSymbol[]): AdjacencyIndex {
  const callees = new Map<string, CodeSymbol[]>();
  const callers = new Map<string, CodeSymbol[]>();

  // Collect unique names → symbols for regex matching targets
  const nameToSymbols = new Map<string, CodeSymbol[]>();
  for (const sym of allSymbols) {
    const existing = nameToSymbols.get(sym.name);
    if (existing) existing.push(sym);
    else nameToSymbols.set(sym.name, [sym]);
  }

  // For each symbol with source, find which names it references
  for (const sym of allSymbols) {
    if (!sym.source) continue;

    const symCallees: CodeSymbol[] = [];

    for (const [name, targets] of nameToSymbols) {
      const pattern = new RegExp(`\\b${escapeRegex(name)}\\b`);
      if (pattern.test(sym.source)) {
        for (const target of targets) {
          if (target.id === sym.id) continue;
          symCallees.push(target);

          // Also record the reverse edge (caller)
          const targetCallers = callers.get(target.id);
          if (targetCallers) targetCallers.push(sym);
          else callers.set(target.id, [sym]);
        }
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
 */
function buildCallTree(
  root: CodeSymbol,
  adjacency: AdjacencyIndex,
  direction: Direction,
  maxDepth: number,
): CallNode {
  const visited = new Set<string>([root.id]);
  const adj = direction === "callees" ? adjacency.callees : adjacency.callers;

  function expand(symbol: CodeSymbol, depth: number): CallNode {
    if (depth >= maxDepth) {
      return { symbol, children: [] };
    }

    const neighbors = adj.get(symbol.id) ?? [];

    const children: CallNode[] = [];
    for (const neighbor of neighbors) {
      if (visited.has(neighbor.id)) continue;
      visited.add(neighbor.id);
      children.push(expand(neighbor, depth + 1));
    }

    return { symbol, children };
  }

  return expand(root, 0);
}

/**
 * Trace the call chain for a symbol in a repository.
 * Returns a tree of callers or callees up to the specified depth.
 */
export async function traceCallChain(
  repo: string,
  symbolName: string,
  direction: Direction,
  depth?: number,
): Promise<CallNode> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository not found: ${repo}`);
  }

  const target = index.symbols.find((s) => s.name === symbolName);
  if (!target) {
    throw new Error(
      `Symbol "${symbolName}" not found in repository "${repo}"`,
    );
  }

  const maxDepth = depth ?? DEFAULT_CALL_DEPTH;
  const adjacency = buildAdjacencyIndex(index.symbols);
  return buildCallTree(target, adjacency, direction, maxDepth);
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
      const callers = adjacency.callers.get(sym.id) ?? [];
      for (const caller of callers) {
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
      const callers = adjacency.callers.get(sym.id) ?? [];
      for (const caller of callers) {
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

/**
 * Analyze the impact of recent git changes on a repository.
 * Finds changed files, affected symbols, and builds a dependency graph.
 */
export async function impactAnalysis(
  repo: string,
  since: string,
  depth?: number,
  until?: string,
): Promise<ImpactResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository not found: ${repo}`);
  }

  const untilRef = until ?? "HEAD";
  const changedFiles = getChangedFiles(index.root, since, untilRef);

  // Find all symbols in changed files
  const changedSymbols = index.symbols.filter((s) =>
    changedFiles.includes(s.file),
  );

  // Build adjacency index once, reuse for both affected + dependency graph
  const adjacency = buildAdjacencyIndex(index.symbols);

  const maxDepth = depth ?? DEFAULT_IMPACT_DEPTH;
  const affectedSymbols = findAffectedSymbols(
    changedSymbols,
    adjacency,
    maxDepth,
  );

  const dependencyGraph = buildFileDependencyGraph(index, adjacency);

  return {
    changed_files: changedFiles,
    affected_symbols: affectedSymbols,
    dependency_graph: dependencyGraph,
  };
}
