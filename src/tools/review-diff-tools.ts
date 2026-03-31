/**
 * review-diff-tools.ts
 *
 * Types, tier assignment, scoring, verdict, and orchestrator for the review_diff MCP tool.
 * Pure functions + one async orchestrator that fans out sub-checks.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { changedSymbols } from "./diff-tools.js";
import { getCodeIndex } from "./index-tools.js";
import { impactAnalysis } from "./impact-tools.js";
import { scanSecrets } from "./secret-tools.js";
import { findDeadCode } from "./symbol-tools.js";
import { searchPatterns, listPatterns } from "./pattern-tools.js";
import { analyzeHotspots } from "./hotspot-tools.js";
import { analyzeComplexity } from "./complexity-tools.js";
import { validateGitRef } from "../utils/git-validation.js";
import { isTestFile } from "../utils/test-file.js";
import picomatch from "picomatch";
import type { CodeIndex } from "../types.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ReviewDiffOptions {
  repo: string;
  since?: string;
  /** End ref — defaults to "HEAD". Use "WORKING" for uncommitted changes. */
  until?: string;
  /** Comma-separated check names to run (defaults to all) */
  checks?: string;
  /** Token budget for responses (default 8000) */
  token_budget?: number;
  /** Glob patterns of files to exclude from review */
  exclude_patterns?: string[];
  /** Maximum files to review before capping (default 50) */
  max_files?: number;
  /** Per-check timeout in milliseconds (default 30000) */
  check_timeout_ms?: number;
}

export interface ReviewFinding {
  /** Which check produced this finding */
  check: string;
  severity: "error" | "warn" | "info";
  message: string;
  file?: string;
  line?: number;
  symbol?: string;
}

export interface CheckResult {
  check: string;
  status: "pass" | "warn" | "fail" | "error" | "timeout";
  findings: ReviewFinding[];
  duration_ms: number;
  /** Human-readable summary line (optional) */
  summary?: string;
}

export interface DiffStats {
  files_changed: number;
  files_reviewed: number;
}

export interface ReviewMetadata {
  files_capped?: boolean;
  index_warning?: string;
}

export interface ReviewDiffResult {
  repo: string;
  since: string;
  checks: CheckResult[];
  findings: ReviewFinding[];
  /** 0-100 quality score */
  score: number;
  verdict: "pass" | "warn" | "fail";
  duration_ms: number;
  diff_stats: DiffStats;
  metadata: ReviewMetadata;
  /** Structured error (present instead of throwing) */
  error?: string;
}

// ---------------------------------------------------------------------------
// Tier assignment
// ---------------------------------------------------------------------------

/**
 * Returns the tier (1 | 2 | 3) for a given check name.
 *
 * Tier 1 — critical (−20 per finding): secrets, breaking
 * Tier 2 — important (−5 per finding): coupling, complexity, dead-code,
 *           blast-radius, bug-patterns
 * Tier 3 — advisory (−1 per finding, only if no T1/T2): test-gaps, hotspots
 */
export function findingTier(check: string): 1 | 2 | 3 {
  switch (check) {
    case "secrets":
    case "breaking":
      return 1;

    case "coupling":
    case "complexity":
    case "dead-code":
    case "blast-radius":
    case "bug-patterns":
      return 2;

    default:
      return 3;
  }
}

// ---------------------------------------------------------------------------
// Score calculation
// ---------------------------------------------------------------------------

/**
 * Calculates a 0-100 quality score from findings and check results.
 *
 * Deductions:
 *   - T1 findings: −20 each, floor at 0
 *   - T2 findings: −5 each, floor at 20 (overridden by T1 floor)
 *   - T3 findings: −1 each, floor at 50 (only applied when there are no T1/T2 findings)
 *   - Errored checks: −3 each
 *   - Final floor: 0
 */
export function calculateScore(
  findings: ReviewFinding[],
  checks: CheckResult[],
): number {
  const t1Count = findings.filter((f) => findingTier(f.check) === 1).length;
  const t2Count = findings.filter((f) => findingTier(f.check) === 2).length;
  const t3Count = findings.filter((f) => findingTier(f.check) === 3).length;
  const errorCount = checks.filter((c) => c.status === "error").length;

  let score = 100;

  // Tier 1 deductions
  score -= t1Count * 20;
  if (score < 0) score = 0;

  // Tier 2 deductions (floor 20, but T1 can override below 20)
  const afterT2 = score - t2Count * 5;
  if (t1Count === 0) {
    // T2 floor is 20 only when no T1 findings
    score = Math.max(afterT2, 20);
  } else {
    // T1 already applied; T2 can further reduce but overall floor is 0
    score = Math.max(afterT2, 0);
  }

  // Tier 3 deductions (floor 50, only when no T1/T2 findings)
  if (t1Count === 0 && t2Count === 0) {
    const afterT3 = score - t3Count * 1;
    score = Math.max(afterT3, 50);
  }

  // Error deductions
  score -= errorCount * 3;

  // Final floor
  return Math.max(score, 0);
}

// ---------------------------------------------------------------------------
// Verdict determination
// ---------------------------------------------------------------------------

/**
 * Determines the overall verdict from check statuses.
 *
 * - Any "fail" → "fail"
 * - Any "warn" (and no "fail") → "warn"
 * - Otherwise → "pass"
 * - "timeout" and "error" do not affect verdict direction
 */
export function determineVerdict(checks: CheckResult[]): "pass" | "warn" | "fail" {
  const hasFail = checks.some((c) => c.status === "fail");
  if (hasFail) return "fail";

  const hasWarn = checks.some((c) => c.status === "warn");
  if (hasWarn) return "warn";

  return "pass";
}

// ---------------------------------------------------------------------------
// All known check names
// ---------------------------------------------------------------------------

const ALL_CHECKS = [
  "secrets",
  "breaking",
  "coupling",
  "complexity",
  "dead-code",
  "blast-radius",
  "bug-patterns",
  "test-gaps",
  "hotspots",
] as const;

type CheckName = (typeof ALL_CHECKS)[number];

const DEFAULT_MAX_FILES = 50;
const DEFAULT_CHECK_TIMEOUT_MS = 30_000;
const HEAD_TILDE_PATTERN = /^HEAD~\d+$/;

// ---------------------------------------------------------------------------
// Timeout wrapper
// ---------------------------------------------------------------------------

interface TimeoutSentinel {
  status: "timeout";
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | TimeoutSentinel> {
  return Promise.race([
    promise,
    new Promise<TimeoutSentinel>((resolve) =>
      setTimeout(() => resolve({ status: "timeout" }), ms),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Check adapters
// ---------------------------------------------------------------------------

/**
 * Blast-radius check: run impactAnalysis and map affected_symbols to T2 findings.
 */
export async function checkBlastRadius(
  index: CodeIndex,
  since: string,
  until: string,
): Promise<CheckResult> {
  const start = Date.now();
  try {
    const result = await impactAnalysis(index.repo, since, { until });
    const MAX_BLAST_FINDINGS = 10;
    const allFindings: ReviewFinding[] = result.affected_symbols.map((sym) => ({
      check: "blast-radius",
      severity: "warn",
      message: `Symbol "${sym.name}" in ${sym.file} is affected by changes`,
      file: sym.file,
      symbol: sym.name,
    }));
    const findings = allFindings.slice(0, MAX_BLAST_FINDINGS);
    const totalCount = allFindings.length;
    return {
      check: "blast-radius",
      status: findings.length > 0 ? "warn" : "pass",
      findings,
      duration_ms: Date.now() - start,
      summary: totalCount > 0
        ? `${totalCount} affected symbol(s) found${totalCount > MAX_BLAST_FINDINGS ? ` (showing ${MAX_BLAST_FINDINGS})` : ""}`
        : "No blast radius detected",
    };
  } catch (err: unknown) {
    return {
      check: "blast-radius",
      status: "error",
      findings: [],
      duration_ms: Date.now() - start,
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Secrets check: run scanSecrets scoped to changedFiles and map findings to T1.
 */
export async function checkSecrets(
  index: CodeIndex,
  changedFiles: string[],
): Promise<CheckResult> {
  const start = Date.now();
  try {
    // Build a glob pattern that matches any of the changed files
    const filePattern =
      changedFiles.length === 1
        ? changedFiles[0]!
        : `{${changedFiles.join(",")}}`;

    const result = await scanSecrets(index.repo, { file_pattern: filePattern, min_confidence: "high" });

    const findings: ReviewFinding[] = result.findings.map((f) => ({
      check: "secrets",
      severity: "error",
      message: `Secret detected: ${f.rule} (${f.severity}) — ${f.masked_secret}`,
      file: f.file,
      line: f.line,
    }));

    return {
      check: "secrets",
      status: findings.length > 0 ? "fail" : "pass",
      findings,
      duration_ms: Date.now() - start,
      summary: findings.length > 0
        ? `${findings.length} secret(s) detected`
        : "No secrets detected",
    };
  } catch (err: unknown) {
    return {
      check: "secrets",
      status: "error",
      findings: [],
      duration_ms: Date.now() - start,
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Dead-code check: run findDeadCode scoped to changedFiles and map candidates to T2 findings.
 */
export async function checkDeadCode(
  index: CodeIndex,
  changedFiles: string[],
): Promise<CheckResult> {
  const start = Date.now();
  try {
    // Build a glob pattern that matches any of the changed files
    const filePattern =
      changedFiles.length === 1
        ? changedFiles[0]!
        : `{${changedFiles.join(",")}}`;

    const result = await findDeadCode(index.repo, { file_pattern: filePattern });

    const findings: ReviewFinding[] = result.candidates.map((c) => ({
      check: "dead-code",
      severity: "warn",
      message: `"${c.name}" appears unused — ${c.reason}`,
      file: c.file,
      line: c.start_line,
      symbol: c.name,
    }));

    return {
      check: "dead-code",
      status: findings.length > 0 ? "warn" : "pass",
      findings,
      duration_ms: Date.now() - start,
      summary: findings.length > 0
        ? `${findings.length} dead-code candidate(s) found`
        : "No dead code detected",
    };
  } catch (err: unknown) {
    return {
      check: "dead-code",
      status: "error",
      findings: [],
      duration_ms: Date.now() - start,
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Bug-patterns check: run all BUILTIN_PATTERNS via searchPatterns, merge and
 * deduplicate findings across patterns.
 */
export async function checkBugPatterns(
  index: CodeIndex,
  changedFiles: string[],
): Promise<CheckResult> {
  const start = Date.now();
  try {
    // Build a file_pattern covering all changed files
    const filePattern =
      changedFiles.length === 1
        ? changedFiles[0]!
        : `{${changedFiles.join(",")}}`;

    // Get all built-in pattern names
    const patterns = listPatterns().map((p) => p.name);

    // Run all patterns in parallel
    const results = await Promise.all(
      patterns.map((p) =>
        searchPatterns(index.repo, p, { file_pattern: filePattern }),
      ),
    );

    // Merge matches, dedup by (file, start_line, matched_pattern)
    const seen = new Set<string>();
    const findings: ReviewFinding[] = [];

    for (const result of results) {
      for (const match of result.matches) {
        const key = `${match.file}:${match.start_line}:${match.matched_pattern}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          check: "bug-patterns",
          severity: "warn",
          message: `Pattern match: ${match.matched_pattern} — "${match.context}"`,
          file: match.file,
          line: match.start_line,
          symbol: match.name,
        });
      }
    }

    return {
      check: "bug-patterns",
      status: findings.length > 0 ? "warn" : "pass",
      findings,
      duration_ms: Date.now() - start,
      summary: findings.length > 0
        ? `${findings.length} bug pattern(s) found`
        : "No bug patterns detected",
    };
  } catch (err: unknown) {
    return {
      check: "bug-patterns",
      status: "error",
      findings: [],
      duration_ms: Date.now() - start,
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Hotspots check: run analyzeHotspots and filter to files in changedFiles.
 * Maps high-churn files to T3 advisory findings.
 */
export async function checkHotspots(
  index: CodeIndex,
  changedFiles: string[],
): Promise<CheckResult> {
  const start = Date.now();
  try {
    const changedSet = new Set(changedFiles);
    const result = await analyzeHotspots(index.repo);

    const findings: ReviewFinding[] = result.hotspots
      .filter((h) => changedSet.has(h.file))
      .map((h) => ({
        check: "hotspots",
        severity: "warn" as const,
        message: `High churn file: ${h.file} — hotspot_score ${h.hotspot_score} (${h.commits} commits, ${h.lines_changed} lines changed)`,
        file: h.file,
      }));

    return {
      check: "hotspots",
      status: findings.length > 0 ? "warn" : "pass",
      findings,
      duration_ms: Date.now() - start,
      summary: findings.length > 0
        ? `${findings.length} hotspot file(s) in diff`
        : "No hotspot files in diff",
    };
  } catch (err: unknown) {
    return {
      check: "hotspots",
      status: "error",
      findings: [],
      duration_ms: Date.now() - start,
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Complexity delta check: run analyzeComplexity and filter to functions in
 * changedFiles with cyclomatic complexity > 10. Maps to T2 findings.
 */
export async function checkComplexityDelta(
  index: CodeIndex,
  changedFiles: string[],
): Promise<CheckResult> {
  const start = Date.now();
  try {
    const changedSet = new Set(changedFiles);
    const result = await analyzeComplexity(index.repo, { top_n: 50 });

    const findings: ReviewFinding[] = result.functions
      .filter((fn) => changedSet.has(fn.file) && fn.cyclomatic_complexity > 10)
      .map((fn) => ({
        check: "complexity",
        severity: "warn" as const,
        message: `High complexity: "${fn.name}" in ${fn.file} — cyclomatic complexity ${fn.cyclomatic_complexity} (>${10})`,
        file: fn.file,
        line: fn.start_line,
        symbol: fn.name,
      }));

    return {
      check: "complexity",
      status: findings.length > 0 ? "warn" : "pass",
      findings,
      duration_ms: Date.now() - start,
      summary: findings.length > 0
        ? `${findings.length} high-complexity function(s) in diff`
        : "No high-complexity functions in diff",
    };
  } catch (err: unknown) {
    return {
      check: "complexity",
      status: "error",
      findings: [],
      duration_ms: Date.now() - start,
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Coupling gaps check: parse git log for co-change pairs, compute Jaccard
 * similarity, and flag coupled files that are missing from the diff.
 */
export async function checkCouplingGaps(
  repoRoot: string,
  changedFiles: string[],
): Promise<CheckResult> {
  const start = Date.now();
  const MIN_SUPPORT = 3;
  const MIN_JACCARD = 0.5;
  const MAX_FILES_PER_COMMIT = 50;

  try {
    const raw = execFileSync(
      "git",
      [
        "log",
        "--name-only",
        "--no-merges",
        "--diff-filter=AMRC",
        "--since=180 days ago",
        "--pretty=format:%H",
      ],
      { cwd: repoRoot, encoding: "utf-8", timeout: 15000 },
    );

    // Parse commits: git log --pretty=format:%H --name-only outputs:
    //   SHA\n\nfile1\nfile2\n\nSHA\n\nfile1\nfile2
    // Split by \n\n yields alternating blocks: [SHA, files, SHA, files, ...]
    const blocks = raw.split("\n\n").filter((b) => b.trim().length > 0);
    const fileCommitCounts = new Map<string, number>();
    const pairCounts = new Map<string, number>();

    // Process pairs: blocks[i] = SHA, blocks[i+1] = file list
    for (let i = 0; i < blocks.length - 1; i += 2) {
      const fileBlock = blocks[i + 1]!;
      const files = fileBlock.split("\n").filter((l) => l.trim().length > 0);

      // Skip bulk commits
      if (files.length > MAX_FILES_PER_COMMIT) continue;

      // Count file appearances
      for (const file of files) {
        fileCommitCounts.set(file, (fileCommitCounts.get(file) ?? 0) + 1);
      }

      // Count pairs (canonical: sorted alphabetically)
      for (let i = 0; i < files.length; i++) {
        for (let j = i + 1; j < files.length; j++) {
          const pair = [files[i]!, files[j]!].sort().join("\0");
          pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
        }
      }
    }

    // For each changed file, find partners with high Jaccard that are NOT in the diff
    const changedSet = new Set(changedFiles);
    const findings: ReviewFinding[] = [];

    for (const changedFile of changedFiles) {
      for (const [pair, coCount] of pairCounts) {
        if (coCount < MIN_SUPPORT) continue;

        const [fileA, fileB] = pair.split("\0") as [string, string];
        let partner: string | undefined;
        if (fileA === changedFile) partner = fileB;
        else if (fileB === changedFile) partner = fileA;
        else continue;

        // Skip if partner is already in the diff
        if (changedSet.has(partner)) continue;

        const countA = fileCommitCounts.get(fileA) ?? 0;
        const countB = fileCommitCounts.get(fileB) ?? 0;
        const jaccard = coCount / (countA + countB - coCount);

        if (jaccard >= MIN_JACCARD) {
          findings.push({
            check: "coupling",
            severity: "warn",
            message: `"${changedFile}" is frequently co-changed with "${partner}" (Jaccard ${jaccard.toFixed(2)}, ${coCount} co-commits) but "${partner}" is not in this diff`,
            file: changedFile,
          });
        }
      }
    }

    return {
      check: "coupling",
      status: findings.length > 0 ? "warn" : "pass",
      findings,
      duration_ms: Date.now() - start,
      summary: findings.length > 0
        ? `${findings.length} coupling gap(s) detected`
        : "No coupling gaps detected",
    };
  } catch (err: unknown) {
    return {
      check: "coupling",
      status: "error",
      findings: [],
      duration_ms: Date.now() - start,
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Breaking changes check: detect exported symbols removed between `since` and
 * current index.  For each changed .ts/.js file, `git show` retrieves the old
 * source and a regex extracts export names.  These are compared against the
 * current index symbols.  Missing exports → T1 "breaking" findings.
 *
 * File-level renames (detected via `git diff --find-renames`) are suppressed
 * because renames naturally lose old export names.
 */
export async function checkBreakingChanges(
  index: CodeIndex,
  repoRoot: string,
  changedFiles: string[],
  since: string,
  until: string,
): Promise<CheckResult> {
  const start = Date.now();
  const TS_JS_RE = /\.(tsx?|jsx?)$/;
  const EXPORT_NAMED_RE =
    /export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g;
  const EXPORT_DEFAULT_RE = /export\s+default/g;

  try {
    // 1. Detect renames so we can suppress findings for renamed files
    let renameRaw = "";
    try {
      renameRaw = execFileSync(
        "git",
        [
          "diff",
          "--find-renames",
          "--name-status",
          `${since}..${until || "HEAD"}`,
        ],
        { cwd: repoRoot, encoding: "utf-8", timeout: 10_000 },
      );
    } catch {
      // If rename detection fails, proceed without suppression
    }

    const renamedFiles = new Set<string>();
    for (const line of renameRaw.split("\n")) {
      if (line.startsWith("R")) {
        // R100\told-path\tnew-path  (tab-separated)
        const parts = line.split("\t");
        if (parts[1]) renamedFiles.add(parts[1]);
        if (parts[2]) renamedFiles.add(parts[2]);
      }
    }

    // 2. Filter to TS/JS files, exclude renames
    const tsJsFiles = changedFiles.filter(
      (f) => TS_JS_RE.test(f) && !renamedFiles.has(f),
    );

    const findings: ReviewFinding[] = [];

    // 3. For each file, compare old exports vs current exports
    for (const file of tsJsFiles) {
      try {
        const oldSource = execFileSync(
          "git",
          ["show", `${since}:${file}`],
          { cwd: repoRoot, encoding: "utf-8", timeout: 10_000 },
        );

        // Extract old export names
        const oldExports = new Set<string>();
        let match: RegExpExecArray | null;
        while ((match = EXPORT_NAMED_RE.exec(oldSource)) !== null) {
          oldExports.add(match[1]!);
        }
        while ((match = EXPORT_DEFAULT_RE.exec(oldSource)) !== null) {
          oldExports.add("default");
        }

        if (oldExports.size === 0) continue;

        // Get current exports from index: top-level symbols in this file
        const currentExports = new Set(
          index.symbols
            .filter((s) => s.file === file && !s.parent)
            .map((s) => s.name),
        );

        // Removed = in old but not in current
        for (const name of oldExports) {
          if (!currentExports.has(name)) {
            findings.push({
              check: "breaking",
              severity: "error",
              message: `Removed export "${name}" from ${file} — may break downstream consumers`,
              file,
              symbol: name,
            });
          }
        }
      } catch {
        // git show failed → file didn't exist at `since` (new file), skip
      }
    }

    return {
      check: "breaking",
      status: findings.length > 0 ? "fail" : "pass",
      findings,
      duration_ms: Date.now() - start,
      summary: findings.length > 0
        ? `${findings.length} removed export(s) detected`
        : "No breaking changes detected",
    };
  } catch (err: unknown) {
    return {
      check: "breaking",
      status: "error",
      findings: [],
      duration_ms: Date.now() - start,
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Test-gaps check: for each changed non-test source file, verify that at least
 * one test file covers it — either by naming convention or by import reference.
 *
 * Naming convention candidates:
 *   foo.ts → foo.test.ts, foo.spec.ts, __tests__/foo.ts, __tests__/foo.test.ts
 *
 * Import graph: search index symbols from test files whose source imports the
 * source file's base name (without extension).
 *
 * If BOTH pathways find 0 tests → T3 advisory finding.
 */
export async function checkTestGaps(
  index: CodeIndex,
  changedFiles: string[],
): Promise<CheckResult> {
  const start = Date.now();

  const SOURCE_EXTENSIONS = /\.(tsx?|jsx?)$/;

  // Only process non-test source files
  const sourceFiles = changedFiles.filter(
    (f) => SOURCE_EXTENSIONS.test(f) && !isTestFile(f),
  );

  const indexFilePaths = new Set(index.files.map((f) => f.path));
  const findings: ReviewFinding[] = [];

  for (const sourceFile of sourceFiles) {
    // -----------------------------------------------------------------------
    // 1. Naming check
    // -----------------------------------------------------------------------
    const dir = path.dirname(sourceFile);
    const base = path.basename(sourceFile).replace(SOURCE_EXTENSIONS, "");
    // Check co-located tests, __tests__/ dir, AND tests/ mirror directory
    // e.g., src/tools/foo.ts → tests/tools/foo.test.ts
    const testsDir = dir.replace(/^src\//, "tests/");
    const candidates = [
      path.join(dir, `${base}.test.ts`),
      path.join(dir, `${base}.spec.ts`),
      path.join(dir, `${base}.test.tsx`),
      path.join(dir, `${base}.spec.tsx`),
      path.join(dir, `${base}.test.js`),
      path.join(dir, `${base}.spec.js`),
      path.join(dir, "__tests__", `${base}.ts`),
      path.join(dir, "__tests__", `${base}.test.ts`),
      // Mirror in tests/ directory (common layout)
      path.join(testsDir, `${base}.test.ts`),
      path.join(testsDir, `${base}.spec.ts`),
      path.join(testsDir, `${base}.test.tsx`),
      path.join(testsDir, `${base}.test.js`),
    ];

    const foundByNaming = candidates.some((c) => indexFilePaths.has(c));
    if (foundByNaming) continue;

    // -----------------------------------------------------------------------
    // 2. Import graph check: look for test file symbols that import sourceFile
    // -----------------------------------------------------------------------
    const foundByImport = index.symbols.some((sym) => {
      if (!isTestFile(sym.file)) return false;
      if (!sym.source) return false;
      // Check if source mentions the file base name in an import
      return sym.source.includes(base);
    });
    if (foundByImport) continue;

    // -----------------------------------------------------------------------
    // 3. Neither pathway found a test → T3 finding
    // -----------------------------------------------------------------------
    findings.push({
      check: "test-gaps",
      severity: "warn",
      message: `No test found for "${sourceFile}" — add a test file matching naming convention or import it from a test`,
      file: sourceFile,
    });
  }

  return {
    check: "test-gaps",
    status: findings.length > 0 ? "warn" : "pass",
    findings,
    duration_ms: Date.now() - start,
    summary: findings.length > 0
      ? `${findings.length} source file(s) with no test coverage found`
      : "All changed source files have test coverage",
  };
}

// ---------------------------------------------------------------------------
// Check runner — dispatches to real adapters or stubs for unimplemented checks
// ---------------------------------------------------------------------------

async function runCheck(
  checkName: string,
  _repo: string,
  changedFiles: string[],
  index: CodeIndex,
  since: string,
  until: string,
): Promise<CheckResult> {
  switch (checkName) {
    case "blast-radius":
      return checkBlastRadius(index, since, until);
    case "secrets":
      return checkSecrets(index, changedFiles);
    case "dead-code":
      return checkDeadCode(index, changedFiles);
    case "bug-patterns":
      return checkBugPatterns(index, changedFiles);
    case "hotspots":
      return checkHotspots(index, changedFiles);
    case "complexity":
      return checkComplexityDelta(index, changedFiles);
    case "coupling":
      return checkCouplingGaps(index.root, changedFiles);
    case "breaking":
      return checkBreakingChanges(index, index.root, changedFiles, since, until);
    case "test-gaps":
      return checkTestGaps(index, changedFiles);
    default: {
      const tier = findingTier(checkName);
      return {
        check: checkName,
        status: "pass",
        tier,
        findings: [],
        duration_ms: 0,
        summary: "No findings",
      } as CheckResult & { tier: number };
    }
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function reviewDiff(
  repo: string,
  opts: ReviewDiffOptions,
): Promise<ReviewDiffResult> {
  const startTime = Date.now();
  const since = opts.since ?? "HEAD~1";
  const until = opts.until;
  const maxFiles = opts.max_files ?? DEFAULT_MAX_FILES;
  const checkTimeoutMs = opts.check_timeout_ms ?? DEFAULT_CHECK_TIMEOUT_MS;

  // -----------------------------------------------------------------------
  // Pre-flight: validate refs
  // -----------------------------------------------------------------------
  try {
    validateGitRef(since);
    if (until && until !== "WORKING" && until !== "STAGED") {
      validateGitRef(until);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      repo,
      since,
      checks: [],
      findings: [],
      score: 0,
      verdict: "fail",
      duration_ms: Date.now() - startTime,
      diff_stats: { files_changed: 0, files_reviewed: 0 },
      metadata: {},
      error: `invalid_ref: ${msg}`,
    };
  }

  // -----------------------------------------------------------------------
  // Pre-flight: validate repo exists
  // -----------------------------------------------------------------------
  const index = await getCodeIndex(repo);
  if (!index) {
    return {
      repo,
      since,
      checks: [],
      findings: [],
      score: 0,
      verdict: "fail",
      duration_ms: Date.now() - startTime,
      diff_stats: { files_changed: 0, files_reviewed: 0 },
      metadata: {},
      error: `Repository not found: ${repo}`,
    };
  }

  // -----------------------------------------------------------------------
  // Parse diff
  // -----------------------------------------------------------------------
  const diffResult = await changedSymbols(
    repo,
    since,
    until ?? "HEAD",
    undefined,
  );

  let changedFiles = diffResult.map((f) => f.file);

  // -----------------------------------------------------------------------
  // Exclude patterns
  // -----------------------------------------------------------------------
  if (opts.exclude_patterns && opts.exclude_patterns.length > 0) {
    const isExcluded = picomatch(opts.exclude_patterns);
    changedFiles = changedFiles.filter((f) => !isExcluded(f));
  }

  const totalFilesChanged = changedFiles.length;

  // -----------------------------------------------------------------------
  // Early return: empty diff
  // -----------------------------------------------------------------------
  if (changedFiles.length === 0) {
    return {
      repo,
      since,
      checks: [],
      findings: [],
      score: 100,
      verdict: "pass",
      duration_ms: Date.now() - startTime,
      diff_stats: { files_changed: 0, files_reviewed: 0 },
      metadata: {},
    };
  }

  // -----------------------------------------------------------------------
  // Large diff: cap files and add advisory finding
  // -----------------------------------------------------------------------
  const allFindings: ReviewFinding[] = [];
  const metadata: ReviewMetadata = {};

  if (changedFiles.length > maxFiles) {
    metadata.files_capped = true;
    allFindings.push({
      check: "large-diff",
      severity: "info",
      message: `Large diff: ${changedFiles.length} files changed, reviewing first ${maxFiles}. Consider smaller commits.`,
    });
    changedFiles = changedFiles.slice(0, maxFiles);
  }

  // -----------------------------------------------------------------------
  // Index warning: non-HEAD~N ref may mean stale index
  // -----------------------------------------------------------------------
  if (!HEAD_TILDE_PATTERN.test(since)) {
    metadata.index_warning =
      `Ref "${since}" is not a HEAD~N pattern. Index may not reflect this commit range.`;
  }

  // -----------------------------------------------------------------------
  // Check enablement
  // -----------------------------------------------------------------------
  const requestedChecks = opts.checks
    ? opts.checks.split(",").map((c) => c.trim())
    : [...ALL_CHECKS];

  const enabledChecks = requestedChecks.filter((c) =>
    ALL_CHECKS.includes(c as CheckName),
  );

  // -----------------------------------------------------------------------
  // Fan-out: run checks with timeout
  // -----------------------------------------------------------------------
  const checkPromises = enabledChecks.map((checkName) =>
    withTimeout(
      runCheck(checkName, repo, changedFiles, index, since, until ?? "HEAD"),
      checkTimeoutMs,
    ),
  );

  const settled = await Promise.allSettled(checkPromises);

  const checkResults: CheckResult[] = [];

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const checkName = enabledChecks[i];

    if (outcome.status === "rejected") {
      checkResults.push({
        check: checkName,
        status: "error",
        findings: [],
        duration_ms: 0,
        summary: `Error: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
      });
    } else if (
      outcome.value &&
      typeof outcome.value === "object" &&
      "status" in outcome.value &&
      outcome.value.status === "timeout"
    ) {
      checkResults.push({
        check: checkName,
        status: "timeout",
        findings: [],
        duration_ms: checkTimeoutMs,
        summary: `Timed out after ${checkTimeoutMs}ms`,
      });
    } else {
      checkResults.push(outcome.value as CheckResult);
    }
  }

  // -----------------------------------------------------------------------
  // Assembly: collect findings, score, verdict
  // -----------------------------------------------------------------------
  for (const cr of checkResults) {
    allFindings.push(...cr.findings);
  }

  const score = calculateScore(allFindings, checkResults);
  const verdict = determineVerdict(checkResults);

  return {
    repo,
    since,
    checks: checkResults,
    findings: allFindings,
    score,
    verdict,
    duration_ms: Date.now() - startTime,
    diff_stats: {
      files_changed: totalFilesChanged,
      files_reviewed: changedFiles.length,
    },
    metadata,
  };
}
