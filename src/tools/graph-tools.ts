import { execSync } from "node:child_process";
import { getCodeIndex } from "./index-tools.js";
import type { CodeSymbol, CodeIndex, Direction, CallNode, ImpactResult } from "../types.js";

const DEFAULT_CALL_DEPTH = 3;
const DEFAULT_IMPACT_DEPTH = 2;

/**
 * Check if a symbol's source contains a reference to another symbol name.
 * Uses word boundary matching to avoid substring false positives.
 */
function sourceContainsReference(source: string, name: string): boolean {
  const pattern = new RegExp(`\\b${escapeRegex(name)}\\b`);
  return pattern.test(source);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find direct callees of a symbol by scanning its source for references
 * to other indexed symbol names.
 */
function findCallees(
  target: CodeSymbol,
  allSymbols: CodeSymbol[],
): CodeSymbol[] {
  if (!target.source) return [];

  const callees: CodeSymbol[] = [];
  for (const sym of allSymbols) {
    if (sym.id === target.id) continue;
    if (sourceContainsReference(target.source, sym.name)) {
      callees.push(sym);
    }
  }
  return callees;
}

/**
 * Find direct callers of a symbol by scanning all other symbols' source
 * for references to the target name.
 */
function findCallers(
  target: CodeSymbol,
  allSymbols: CodeSymbol[],
): CodeSymbol[] {
  const callers: CodeSymbol[] = [];
  for (const sym of allSymbols) {
    if (sym.id === target.id) continue;
    if (sym.source && sourceContainsReference(sym.source, target.name)) {
      callers.push(sym);
    }
  }
  return callers;
}

/**
 * BFS traversal to build a call chain tree up to the given depth.
 */
function buildCallTree(
  root: CodeSymbol,
  allSymbols: CodeSymbol[],
  direction: Direction,
  maxDepth: number,
): CallNode {
  const visited = new Set<string>([root.id]);

  function expand(symbol: CodeSymbol, depth: number): CallNode {
    if (depth >= maxDepth) {
      return { symbol, children: [] };
    }

    const neighbors =
      direction === "callees"
        ? findCallees(symbol, allSymbols)
        : findCallers(symbol, allSymbols);

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
  return buildCallTree(target, index.symbols, direction, maxDepth);
}

/**
 * Find all callers of the given symbols, recursing up to depth levels.
 * Returns deduplicated affected symbols.
 */
function findAffectedSymbols(
  changedSymbols: CodeSymbol[],
  allSymbols: CodeSymbol[],
  maxDepth: number,
): CodeSymbol[] {
  const affected = new Map<string, CodeSymbol>();

  // Seed with changed symbols
  for (const sym of changedSymbols) {
    affected.set(sym.id, sym);
  }

  let frontier = changedSymbols;

  for (let d = 0; d < maxDepth; d++) {
    const nextFrontier: CodeSymbol[] = [];

    for (const sym of frontier) {
      const callers = findCallers(sym, allSymbols);
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
 * Build a file-level dependency graph: file -> files that reference symbols in it.
 */
function buildDependencyGraph(
  index: CodeIndex,
): Record<string, string[]> {
  const graph: Record<string, string[]> = {};
  const symbolsByFile = new Map<string, CodeSymbol[]>();

  for (const sym of index.symbols) {
    const existing = symbolsByFile.get(sym.file);
    if (existing) {
      existing.push(sym);
    } else {
      symbolsByFile.set(sym.file, [sym]);
    }
  }

  for (const [file, fileSymbols] of symbolsByFile) {
    const dependentFiles = new Set<string>();

    for (const sym of fileSymbols) {
      const callers = findCallers(sym, index.symbols);
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

  // Find affected symbols (callers of changed symbols, recursively)
  const maxDepth = depth ?? DEFAULT_IMPACT_DEPTH;
  const affectedSymbols = findAffectedSymbols(
    changedSymbols,
    index.symbols,
    maxDepth,
  );

  // Build file-level dependency graph
  const dependencyGraph = buildDependencyGraph(index);

  return {
    changed_files: changedFiles,
    affected_symbols: affectedSymbols,
    dependency_graph: dependencyGraph,
  };
}
