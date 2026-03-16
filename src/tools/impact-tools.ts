import { execFileSync } from "node:child_process";
import { getCodeIndex } from "./index-tools.js";
import { buildAdjacencyIndex, stripSource } from "./graph-tools.js";
import { validateGitRef } from "../utils/git-validation.js";
import { isTestFileStrict as isTestFile } from "../utils/test-file.js";
import type { CodeSymbol, CodeIndex, AffectedTest, RiskScore, ImpactResult } from "../types.js";
import type { AdjacencyIndex } from "./graph-tools.js";

const DEFAULT_IMPACT_DEPTH = 2;
const MAX_AFFECTED_SYMBOLS = 200;
const MAX_DEPENDENCY_GRAPH_FILES = 100;

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
 * Build a file-level dependency graph scoped to relevant files only.
 * Only includes changed files + their direct dependents (not the entire repo graph).
 * Capped at MAX_DEPENDENCY_GRAPH_FILES to prevent 2.6M token responses.
 */
function buildFileDependencyGraph(
  index: CodeIndex,
  adjacency: AdjacencyIndex,
  relevantFiles: Set<string>,
): Record<string, string[]> {
  const graph: Record<string, string[]> = {};
  const symbolsByFile = new Map<string, CodeSymbol[]>();

  // Only index symbols from relevant files
  for (const sym of index.symbols) {
    if (!relevantFiles.has(sym.file)) continue;
    const existing = symbolsByFile.get(sym.file);
    if (existing) existing.push(sym);
    else symbolsByFile.set(sym.file, [sym]);
  }

  let fileCount = 0;
  for (const [file, fileSymbols] of symbolsByFile) {
    if (fileCount >= MAX_DEPENDENCY_GRAPH_FILES) break;

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
      fileCount++;
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
    // SEC-002: Use execFileSync (array form) to prevent shell injection — R-1 pattern
    const output = execFileSync("git", ["diff", "--name-only", `${since}..${until}`], {
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

  // Find all symbols in changed files — use Set for O(1) lookup (CQ17 fix)
  const changedFileSet = new Set(changedFiles);
  const changedSymbols = index.symbols.filter((s) =>
    changedFileSet.has(s.file),
  );

  // Build adjacency index once, reuse for both affected + dependency graph
  // Include test files for impact analysis (want to know which tests are affected)
  const adjacency = buildAdjacencyIndex(index.symbols, false);

  const allAffected = findAffectedSymbols(
    changedSymbols,
    adjacency,
    maxDepth,
  );

  // Cap affected symbols to prevent massive responses
  const affectedSymbols = allAffected.slice(0, MAX_AFFECTED_SYMBOLS);

  // Build dependency graph scoped to changed + affected files only (not entire repo)
  const relevantFiles = new Set([
    ...changedFiles,
    ...affectedSymbols.map((s) => s.file),
  ]);
  const dependencyGraph = buildFileDependencyGraph(index, adjacency, relevantFiles);

  // Find affected test files: test files that import changed symbols/files
  const affectedTests = findAffectedTests(changedFiles, affectedSymbols, index, adjacency);

  // Calculate risk scores per changed file
  const riskScores = calculateRiskScores(changedFiles, changedSymbols, affectedTests, adjacency);

  return {
    changed_files: changedFiles,
    affected_symbols: includeSource
      ? affectedSymbols
      : affectedSymbols.map(stripSource),
    affected_tests: affectedTests,
    risk_scores: riskScores,
    dependency_graph: dependencyGraph,
  };
}

/**
 * Calculate risk scores for changed files.
 * Score = f(callers, test_coverage, symbols_changed).
 */
function calculateRiskScores(
  changedFiles: string[],
  changedSymbols: CodeSymbol[],
  affectedTests: AffectedTest[],
  adjacency: AdjacencyIndex,
): RiskScore[] {
  // Pre-build symbol lookup per file (CQ17 fix: avoid .filter() per file)
  const symbolsByFile = new Map<string, CodeSymbol[]>();
  for (const sym of changedSymbols) {
    const existing = symbolsByFile.get(sym.file);
    if (existing) existing.push(sym);
    else symbolsByFile.set(sym.file, [sym]);
  }

  return changedFiles.map((file) => {
    const fileSymbols = symbolsByFile.get(file) ?? [];
    const symbolsChanged = fileSymbols.length;

    // Count callers (other symbols that depend on symbols in this file)
    let callers = 0;
    for (const sym of fileSymbols) {
      const symCallers = adjacency.callers.get(sym.id) ?? [];
      callers += symCallers.filter((c) => c.file !== file).length;
    }

    // Count test files covering this file
    const shortName = file.split("/").pop()!;
    const baseName = file.replace(/\.ts$/, "");
    const testCoverage = affectedTests.filter((t) =>
      t.reason.includes(shortName) || t.test_file.includes(baseName),
    ).length;

    // Score: 0-100
    // High callers + low test coverage = high risk
    const callerWeight = Math.min(callers * 10, 40);
    const coverageWeight = testCoverage > 0 ? 0 : 30; // No tests = +30 risk
    const sizeWeight = Math.min(symbolsChanged * 5, 30);
    const score = Math.min(100, callerWeight + coverageWeight + sizeWeight);

    let risk: "low" | "medium" | "high" | "critical";
    if (score >= 70) risk = "critical";
    else if (score >= 50) risk = "high";
    else if (score >= 25) risk = "medium";
    else risk = "low";

    return { file, risk, score, callers, test_coverage: testCoverage, symbols_changed: symbolsChanged };
  }).sort((a, b) => b.score - a.score);
}

/**
 * Find test files that would be affected by the changed symbols/files.
 * A test is affected if it imports (directly or transitively) any changed symbol.
 */
function findAffectedTests(
  changedFiles: string[],
  affectedSymbols: CodeSymbol[],
  index: CodeIndex,
  adjacency: AdjacencyIndex,
): AffectedTest[] {
  const affectedFileSet = new Set([
    ...changedFiles,
    ...affectedSymbols.map((s) => s.file),
  ]);

  const tests: AffectedTest[] = [];
  const seenTestFiles = new Set<string>();

  // Direct: test files in changed files
  for (const file of changedFiles) {
    if (isTestFile(file) && !seenTestFiles.has(file)) {
      seenTestFiles.add(file);
      tests.push({ test_file: file, reason: "directly changed" });
    }
  }

  // Indirect: test files that call/import symbols from affected files
  for (const sym of index.symbols) {
    if (!isTestFile(sym.file)) continue;
    if (seenTestFiles.has(sym.file)) continue;

    // Check if this test symbol calls anything in affected files
    const callees = adjacency.callees.get(sym.id) ?? [];
    for (const callee of callees) {
      if (affectedFileSet.has(callee.file)) {
        seenTestFiles.add(sym.file);
        tests.push({
          test_file: sym.file,
          reason: `imports ${callee.name} (${callee.file.split("/").pop()})`,
        });
        break;
      }
    }
  }

  return tests;
}
