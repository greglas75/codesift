import { getCodeIndex, getIndexSummary } from "./index-tools.js";
import { runGit } from "./git-exec.js";
import { adjacencyFor, stripSource } from "./graph-tools.js";
import { graphSymbolsAt, nativeGraphFor } from "./graph-native.js";
import type { NativeCallGraphHandle } from "../native/index.js";
import { buildGitDiffArgs } from "../utils/git-validation.js";
import { isTestFileStrict as isTestFile } from "../utils/test-file.js";
import type { CodeSymbol, CodeIndex, AffectedTest, RiskScore, ImpactResult } from "../types.js";
import type { AdjacencyIndex } from "./graph-tools.js";
import { assertGitTreeMatches } from "./git-tree-guard.js";

const DEFAULT_IMPACT_DEPTH = 2;
const MAX_AFFECTED_SYMBOLS = 20;
const MAX_DEPENDENCY_GRAPH_FILES = 15;
const MAX_SOURCE_CHARS = 300; // Truncate source in impact results

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
async function getChangedFiles(
  repoRoot: string, since: string, until: string,
): Promise<string[]> {
  // buildGitDiffArgs validates refs and translates the WORKING/STAGED pseudo-refs
  // (uncommitted diffs) — a bare `${since}..${until}` fails git for those.
  const args = buildGitDiffArgs(since, until, true);

  try {
    // SEC-002: array form, never a shell string — the injection guard survives the move to the
    // async runGit (which blocks nothing; see git-exec.ts for why that mattered).
    const output = await runGit(args, { cwd: repoRoot, timeout: 10_000 });
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
  // The summary runs the freshness check; the whole index is loaded only if the native graph cannot
  // answer (ADR-006 stage 7: on a 450k-symbol repo that load is ~13 s and +2.4 GB of heap).
  const summary = await getIndexSummary(repo);
  if (!summary) {
    throw new Error(`Repository not found: ${repo}`);
  }
  assertGitTreeMatches(repo, summary.root);

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

  const changedFiles = await getChangedFiles(summary.root, since, untilRef);

  const native = await nativeImpact(repo, changedFiles, maxDepth, includeSource);
  if (native) return { changed_files: changedFiles, ...native };

  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository not found: ${repo}`);
  }
  // Include test files for impact analysis (want to know which tests are affected).
  //
  // Monorepo note (Task 14 of monorepo workspace intelligence plan):
  // buildAdjacencyIndex resolves callers/callees by symbol name across the
  // ENTIRE indexed symbol set, so cross-package symbol references propagate
  // automatically when both packages live in the same CodeIndex. Workspace
  // metadata on `index.workspaces` (Task 7) is therefore NOT consulted here —
  // it is already implicit in the symbol set.
  const adjacency = await adjacencyFor(repo, index.symbols, false);
  return {
    changed_files: changedFiles,
    ...impactFromIndex(index, adjacency, changedFiles, maxDepth, includeSource),
  };
}

/** The TypeScript path: the walks over a loaded index and its adjacency (exported for parity tests). */
export function impactFromIndex(
  index: CodeIndex,
  adjacency: AdjacencyIndex,
  changedFiles: string[],
  maxDepth: number,
  includeSource: boolean,
): Omit<ImpactResult, "changed_files"> {
  // Find all symbols in changed files — use Set for O(1) lookup (CQ17 fix)
  const changedFileSet = new Set(changedFiles);
  const changedSymbols = index.symbols.filter((s) =>
    changedFileSet.has(s.file),
  );

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
    affected_symbols: formatAffected(affectedSymbols, includeSource),
    affected_tests: affectedTests,
    risk_scores: riskScores,
    dependency_graph: dependencyGraph,
  };
}

function formatAffected(symbols: CodeSymbol[], includeSource: boolean): CodeSymbol[] {
  return includeSource
    ? symbols.map((s) => s.source && s.source.length > MAX_SOURCE_CHARS
        ? { ...s, source: s.source.slice(0, MAX_SOURCE_CHARS) + "..." }
        : s)
    : symbols.map(stripSource);
}

/**
 * `impactAnalysis` over the native call graph, with no index in memory: the same walks as the
 * functions below, in the same order, on node positions — files and ids come from the graph, and only
 * the symbols the answer shows are read from the store. `null` means "use the TypeScript path": no
 * graph (native store off), or one released or out of date mid-call.
 */
async function nativeImpact(
  repo: string,
  changedFiles: string[],
  maxDepth: number,
  includeSource: boolean,
): Promise<Omit<ImpactResult, "changed_files"> | null> {
  const graph = await nativeGraphFor(repo, false, false);
  if (!graph) return null;
  try {
    return await nativeImpactFrom(graph, changedFiles, maxDepth, includeSource);
  } catch {
    return null;
  }
}

export async function nativeImpactFrom(
  graph: NativeCallGraphHandle,
  changedFiles: string[],
  maxDepth: number,
  includeSource: boolean,
): Promise<Omit<ImpactResult, "changed_files">> {
  // The walks run in Rust in one call: per-node calls across napi took 66 s on a 1.4M-node graph.
  const walk = await graph.impactWalk(changedFiles, maxDepth, MAX_AFFECTED_SYMBOLS, MAX_DEPENDENCY_GRAPH_FILES);

  const dependencyGraph: Record<string, string[]> = {};
  for (const entry of walk.dependencyGraph) dependencyGraph[entry.file] = entry.dependents;

  const tests: AffectedTest[] = [];
  const seenTestFiles = new Set<string>();
  for (const file of changedFiles) {
    if (isTestFile(file) && !seenTestFiles.has(file)) {
      seenTestFiles.add(file);
      tests.push({ test_file: file, reason: "directly changed" });
    }
  }
  const testPositions = walk.testHits.filter((_, i) => i % 2 === 0);
  const calleePositions = walk.testHits.filter((_, i) => i % 2 === 1);
  if (testPositions.length > 0) {
    const testFiles = graph.filesAt(Uint32Array.from(testPositions));
    const calleeFiles = graph.filesAt(Uint32Array.from(calleePositions));
    // Names only for the callees the reasons quote.
    const callees = await graphSymbolsAt(graph, calleePositions, false);
    testFiles.forEach((testFile, i) => {
      tests.push({
        test_file: testFile,
        reason: `imports ${callees[i]!.name} (${calleeFiles[i]!.split("/").pop()})`,
      });
    });
  }

  const changedFilesOfNodes = walk.changed.length > 0 ? graph.filesAt(Uint32Array.from(walk.changed)) : [];
  const riskScores = calculateRiskScoresFromCounts(
    changedFiles,
    changedFilesOfNodes.map((file, i) => ({ file, externalCallers: walk.changedExternalCallers[i]! })),
    tests,
  );

  const affectedSymbols = await graphSymbolsAt(graph, walk.affected, includeSource);
  return {
    affected_symbols: formatAffected(affectedSymbols, includeSource),
    affected_tests: tests,
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
  return calculateRiskScoresFromCounts(
    changedFiles,
    changedSymbols.map((sym) => ({
      file: sym.file,
      // Count callers (other symbols that depend on symbols in this file)
      externalCallers: (adjacency.callers.get(sym.id) ?? []).filter((c) => c.file !== sym.file).length,
    })),
    affectedTests,
  );
}

/** Risk per changed file from each changed symbol's count of callers in other files. */
function calculateRiskScoresFromCounts(
  changedFiles: string[],
  changedSymbols: ReadonlyArray<{ file: string; externalCallers: number }>,
  affectedTests: AffectedTest[],
): RiskScore[] {
  // Pre-build symbol lookup per file (CQ17 fix: avoid .filter() per file)
  const symbolsByFile = new Map<string, Array<{ file: string; externalCallers: number }>>();
  for (const sym of changedSymbols) {
    const existing = symbolsByFile.get(sym.file);
    if (existing) existing.push(sym);
    else symbolsByFile.set(sym.file, [sym]);
  }

  return changedFiles.map((file) => {
    const fileSymbols = symbolsByFile.get(file) ?? [];
    const symbolsChanged = fileSymbols.length;

    let callers = 0;
    for (const sym of fileSymbols) callers += sym.externalCallers;

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
