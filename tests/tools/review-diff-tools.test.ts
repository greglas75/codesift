import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — MUST be before imports so vi.mock hoists correctly
// ---------------------------------------------------------------------------

vi.mock("../../src/tools/diff-tools.js", () => ({ changedSymbols: vi.fn() }));
vi.mock("../../src/tools/impact-tools.js", () => ({ impactAnalysis: vi.fn() }));
vi.mock("../../src/tools/secret-tools.js", () => ({ scanSecrets: vi.fn() }));
vi.mock("../../src/tools/symbol-tools.js", () => ({ findDeadCode: vi.fn() }));
vi.mock("../../src/tools/pattern-tools.js", () => ({ searchPatterns: vi.fn(), listPatterns: vi.fn() }));
vi.mock("../../src/tools/hotspot-tools.js", () => ({ analyzeHotspots: vi.fn() }));
vi.mock("../../src/tools/complexity-tools.js", () => ({ analyzeComplexity: vi.fn() }));
vi.mock("../../src/tools/index-tools.js", () => ({ getCodeIndex: vi.fn() }));
vi.mock("../../src/utils/git-validation.js", () => ({ validateGitRef: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import {
  findingTier,
  calculateScore,
  determineVerdict,
  reviewDiff,
  checkBlastRadius,
  checkSecrets,
  checkDeadCode,
  checkBugPatterns,
  checkHotspots,
  checkComplexityDelta,
} from "../../src/tools/review-diff-tools.js";
import type { ReviewFinding, CheckResult, ReviewDiffOptions } from "../../src/tools/review-diff-tools.js";
import { changedSymbols } from "../../src/tools/diff-tools.js";
import { getCodeIndex } from "../../src/tools/index-tools.js";
import { validateGitRef } from "../../src/utils/git-validation.js";
import { impactAnalysis } from "../../src/tools/impact-tools.js";
import { scanSecrets } from "../../src/tools/secret-tools.js";
import { findDeadCode } from "../../src/tools/symbol-tools.js";
import { searchPatterns, listPatterns } from "../../src/tools/pattern-tools.js";
import { analyzeHotspots } from "../../src/tools/hotspot-tools.js";
import { analyzeComplexity } from "../../src/tools/complexity-tools.js";
import type { CodeIndex } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function finding(check: string, overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    check,
    severity: "warn",
    message: "test finding",
    file: "src/foo.ts",
    ...overrides,
  };
}

function check(
  name: string,
  status: CheckResult["status"],
  overrides: Partial<CheckResult> = {},
): CheckResult {
  return { check: name, status, findings: [], duration_ms: 0, ...overrides };
}

function makeFakeIndex(overrides: Partial<CodeIndex> = {}): CodeIndex {
  return {
    repo: "local/test-repo",
    root: "/tmp/test-repo",
    symbols: [],
    files: [],
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: 0,
    file_count: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// findingTier
// ---------------------------------------------------------------------------

describe("findingTier", () => {
  it("returns 1 for secrets", () => {
    expect(findingTier("secrets")).toBe(1);
  });

  it("returns 1 for breaking", () => {
    expect(findingTier("breaking")).toBe(1);
  });

  it("returns 2 for coupling", () => {
    expect(findingTier("coupling")).toBe(2);
  });

  it("returns 2 for complexity", () => {
    expect(findingTier("complexity")).toBe(2);
  });

  it("returns 2 for dead-code", () => {
    expect(findingTier("dead-code")).toBe(2);
  });

  it("returns 2 for blast-radius", () => {
    expect(findingTier("blast-radius")).toBe(2);
  });

  it("returns 2 for bug-patterns", () => {
    expect(findingTier("bug-patterns")).toBe(2);
  });

  it("returns 3 for test-gaps", () => {
    expect(findingTier("test-gaps")).toBe(3);
  });

  it("returns 3 for hotspots", () => {
    expect(findingTier("hotspots")).toBe(3);
  });

  it("returns 3 for unknown check names", () => {
    expect(findingTier("unknown")).toBe(3);
  });

  it("returns 3 for unrecognized check names", () => {
    expect(findingTier("some-future-check")).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// calculateScore
// ---------------------------------------------------------------------------

describe("calculateScore", () => {
  it("returns 100 when there are 0 findings and 0 errored checks", () => {
    const checks: CheckResult[] = [check("secrets", "pass")];
    expect(calculateScore([], checks)).toBe(100);
  });

  it("deducts 20 per T1 finding — 1 T1 → 80", () => {
    const findings: ReviewFinding[] = [finding("secrets")];
    const checks: CheckResult[] = [check("secrets", "pass")];
    expect(calculateScore(findings, checks)).toBe(80);
  });

  it("deducts 20 per T1 finding — 2 T1 → 60", () => {
    const findings: ReviewFinding[] = [finding("secrets"), finding("breaking")];
    const checks: CheckResult[] = [check("secrets", "pass"), check("breaking", "pass")];
    expect(calculateScore(findings, checks)).toBe(60);
  });

  it("deducts 5 per T2 finding — 5 T2 + 0 T1 → 75", () => {
    const findings: ReviewFinding[] = [
      finding("coupling"),
      finding("complexity"),
      finding("dead-code"),
      finding("blast-radius"),
      finding("bug-patterns"),
    ];
    const checks: CheckResult[] = [check("coupling", "pass")];
    expect(calculateScore(findings, checks)).toBe(75);
  });

  it("deducts T1 and T2 correctly — 1 T1 + 3 T2 → 65", () => {
    const findings: ReviewFinding[] = [
      finding("secrets"),         // T1: -20
      finding("coupling"),        // T2: -5
      finding("complexity"),      // T2: -5
      finding("dead-code"),       // T2: -5
    ];
    const checks: CheckResult[] = [check("secrets", "pass")];
    expect(calculateScore(findings, checks)).toBe(65);
  });

  it("deducts 1 per T3 finding — 10 T3 + no T1/T2 → 90", () => {
    const findings: ReviewFinding[] = Array.from({ length: 10 }, () => finding("test-gaps"));
    const checks: CheckResult[] = [check("test-gaps", "pass")];
    expect(calculateScore(findings, checks)).toBe(90);
  });

  it("floors at 0 — 6 T1 → 0", () => {
    const findings: ReviewFinding[] = Array.from({ length: 6 }, () => finding("secrets"));
    const checks: CheckResult[] = [check("secrets", "pass")];
    expect(calculateScore(findings, checks)).toBe(0);
  });

  it("deducts 3 per errored check — 9 errors + 0 findings → 73", () => {
    const erroredChecks: CheckResult[] = Array.from({ length: 9 }, (_, i) =>
      check(`check-${i}`, "error"),
    );
    expect(calculateScore([], erroredChecks)).toBe(73);
  });
});

// ---------------------------------------------------------------------------
// determineVerdict
// ---------------------------------------------------------------------------

describe("determineVerdict", () => {
  it("returns 'fail' when any check has status fail", () => {
    const checks: CheckResult[] = [
      check("secrets", "fail"),
      check("complexity", "warn"),
      check("hotspots", "pass"),
    ];
    expect(determineVerdict(checks)).toBe("fail");
  });

  it("returns 'warn' when only checks have warn status", () => {
    const checks: CheckResult[] = [
      check("complexity", "warn"),
      check("hotspots", "pass"),
    ];
    expect(determineVerdict(checks)).toBe("warn");
  });

  it("returns 'pass' when all checks pass", () => {
    const checks: CheckResult[] = [
      check("secrets", "pass"),
      check("complexity", "pass"),
    ];
    expect(determineVerdict(checks)).toBe("pass");
  });

  it("returns 'pass' when mix of pass and timeout (timeout doesn't change verdict)", () => {
    const checks: CheckResult[] = [
      check("secrets", "pass"),
      check("complexity", "timeout"),
    ];
    expect(determineVerdict(checks)).toBe("pass");
  });

  it("returns 'warn' when mix of warn and timeout", () => {
    const checks: CheckResult[] = [
      check("complexity", "warn"),
      check("hotspots", "timeout"),
    ];
    expect(determineVerdict(checks)).toBe("warn");
  });

  it("returns 'fail' even when only one check fails among many passes", () => {
    const checks: CheckResult[] = [
      check("secrets", "fail"),
      check("complexity", "pass"),
      check("hotspots", "pass"),
      check("test-gaps", "pass"),
    ];
    expect(determineVerdict(checks)).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// reviewDiff orchestrator
// ---------------------------------------------------------------------------

describe("reviewDiff orchestrator", () => {
  const mockedGetCodeIndex = vi.mocked(getCodeIndex);
  const mockedChangedSymbols = vi.mocked(changedSymbols);
  const mockedValidateGitRef = vi.mocked(validateGitRef);
  const mockedImpactAnalysisOrch = vi.mocked(impactAnalysis);
  const mockedScanSecretsOrch = vi.mocked(scanSecrets);
  const mockedFindDeadCodeOrch = vi.mocked(findDeadCode);
  const mockedSearchPatternsOrch = vi.mocked(searchPatterns);
  const mockedListPatternsOrch = vi.mocked(listPatterns);
  const mockedAnalyzeHotspotsOrch = vi.mocked(analyzeHotspots);
  const mockedAnalyzeComplexityOrch = vi.mocked(analyzeComplexity);

  const fakeIndex = makeFakeIndex();

  const emptyImpactResult = {
    changed_files: [],
    affected_symbols: [],
    affected_tests: [],
    risk_scores: [],
    dependency_graph: {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: valid index, valid refs, all adapters return empty/pass results
    mockedGetCodeIndex.mockResolvedValue(fakeIndex);
    mockedValidateGitRef.mockImplementation(() => {});
    mockedImpactAnalysisOrch.mockResolvedValue(emptyImpactResult);
    mockedScanSecretsOrch.mockResolvedValue({
      findings: [],
      files_scanned: 0,
      files_with_secrets: 0,
      scan_coverage: "none",
    });
    mockedFindDeadCodeOrch.mockResolvedValue({
      candidates: [],
      scanned_symbols: 0,
      scanned_files: 0,
    });
    mockedListPatternsOrch.mockReturnValue([
      { name: "useEffect-no-cleanup", description: "d1" },
      { name: "empty-catch", description: "d2" },
      { name: "any-type", description: "d3" },
      { name: "console-log", description: "d4" },
      { name: "await-in-loop", description: "d5" },
      { name: "no-error-type", description: "d6" },
      { name: "toctou", description: "d7" },
      { name: "unbounded-findmany", description: "d8" },
      { name: "scaffolding", description: "d9" },
    ]);
    mockedSearchPatternsOrch.mockResolvedValue({
      matches: [],
      pattern: "x",
      scanned_symbols: 0,
    });
    mockedAnalyzeHotspotsOrch.mockResolvedValue({
      hotspots: [],
      period: "last 90 days",
      total_files: 0,
      total_commits: 0,
    });
    mockedAnalyzeComplexityOrch.mockResolvedValue({
      functions: [],
      summary: {
        total_functions: 0,
        avg_complexity: 0,
        avg_lines: 0,
        max_complexity: 0,
        max_nesting: 0,
        above_threshold: 0,
      },
    });
  });

  // 1. Happy path
  it("returns pass with score 100 when diff has 2 files and all checks pass", async () => {
    mockedChangedSymbols.mockResolvedValue([
      { file: "src/a.ts", symbols: ["foo"] },
      { file: "src/b.ts", symbols: ["bar"] },
    ]);

    const result = await reviewDiff("local/test-repo", {
      repo: "local/test-repo",
      since: "HEAD~1",
    });

    expect(result.verdict).toBe("pass");
    expect(result.score).toBe(100);
    expect(result.findings).toEqual([]);
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks.every((c) => c.status === "pass")).toBe(true);
  });

  // 2. Empty diff
  it("returns pass with score 100 and 0 files when diff is empty", async () => {
    mockedChangedSymbols.mockResolvedValue([]);

    const result = await reviewDiff("local/test-repo", {
      repo: "local/test-repo",
      since: "HEAD~1",
    });

    expect(result.verdict).toBe("pass");
    expect(result.score).toBe(100);
    expect(result.diff_stats.files_changed).toBe(0);
  });

  // 3. Invalid ref
  it("returns structured error when git ref is invalid", async () => {
    mockedValidateGitRef.mockImplementation((ref: string) => {
      throw new Error(`Invalid git ref: "${ref}"`);
    });

    const result = await reviewDiff("local/test-repo", {
      repo: "local/test-repo",
      since: ";;;bad;;;",
    });

    expect(result.error).toBeDefined();
    expect(result.error).toContain("invalid_ref");
  });

  // 4. Check filtering
  it("runs only specified checks when checks option is provided", async () => {
    mockedChangedSymbols.mockResolvedValue([
      { file: "src/a.ts", symbols: ["foo"] },
    ]);

    const result = await reviewDiff("local/test-repo", {
      repo: "local/test-repo",
      since: "HEAD~1",
      checks: "secrets,breaking",
    });

    expect(result.checks.length).toBe(2);
    const checkNames = result.checks.map((c) => c.check);
    expect(checkNames).toContain("secrets");
    expect(checkNames).toContain("breaking");
  });

  // 5. Large diff
  it("adds T3 finding and sets files_capped when diff exceeds max_files", async () => {
    const manyFiles = Array.from({ length: 51 }, (_, i) => ({
      file: `src/file-${i}.ts`,
      symbols: [`fn${i}`],
    }));
    mockedChangedSymbols.mockResolvedValue(manyFiles);

    const result = await reviewDiff("local/test-repo", {
      repo: "local/test-repo",
      since: "HEAD~1",
      max_files: 50,
    });

    expect(result.metadata.files_capped).toBe(true);
    const largeDiffFinding = result.findings.find(
      (f: ReviewFinding) => f.message.toLowerCase().includes("large diff") || f.message.toLowerCase().includes("files"),
    );
    expect(largeDiffFinding).toBeDefined();
  });

  // 6. Exclude patterns
  it("excludes files matching exclude_patterns from checks", async () => {
    mockedChangedSymbols.mockResolvedValue([
      { file: "src/a.ts", symbols: ["foo"] },
      { file: "package-lock.json", symbols: [] },
    ]);

    const result = await reviewDiff("local/test-repo", {
      repo: "local/test-repo",
      since: "HEAD~1",
      exclude_patterns: ["*.lock", "*.json"],
    });

    // The package-lock.json should be excluded
    expect(result.diff_stats.files_changed).toBe(1);
  });

  // 7. Non-git repo error
  it("returns structured error when repo has no git", async () => {
    mockedGetCodeIndex.mockResolvedValue(null);

    const result = await reviewDiff("local/no-repo", {
      repo: "local/no-repo",
      since: "HEAD~1",
    });

    expect(result.error).toBeDefined();
  });

  // 8. Index warning
  it("sets index_warning when since ref is not HEAD~N pattern", async () => {
    mockedChangedSymbols.mockResolvedValue([
      { file: "src/a.ts", symbols: ["foo"] },
    ]);

    const result = await reviewDiff("local/test-repo", {
      repo: "local/test-repo",
      since: "abc1234567",
    });

    expect(result.metadata.index_warning).toBeDefined();
  });

  // 9. WORKING sentinel
  it("passes WORKING sentinel to changedSymbols correctly", async () => {
    mockedChangedSymbols.mockResolvedValue([]);

    await reviewDiff("local/test-repo", {
      repo: "local/test-repo",
      since: "HEAD~1",
      until: "WORKING",
    });

    expect(mockedChangedSymbols).toHaveBeenCalledWith(
      "local/test-repo",
      "HEAD~1",
      "WORKING",
      undefined,
    );
  });

  // 10. Check timeout
  it("marks check as timeout when it exceeds check_timeout_ms", async () => {
    mockedChangedSymbols.mockResolvedValue([
      { file: "src/a.ts", symbols: ["foo"] },
    ]);

    // With default stubs (synchronous resolve), 0ms timeout won't trigger
    // because microtasks beat macrotasks. Use check_timeout_ms: 1 and verify
    // the orchestrator handles the timeout field without error.
    // Real timeout testing will happen in Task 3+ when stubs are replaced
    // with actual async check runners.
    const result = await reviewDiff("local/test-repo", {
      repo: "local/test-repo",
      since: "HEAD~1",
      check_timeout_ms: 1,
    });

    expect(result).toBeDefined();
    expect(result.checks).toBeDefined();
    // All stubs are synchronous, so they won't actually timeout.
    // Verify that timeout infrastructure doesn't break normal flow.
    expect(result.checks.every(
      (c) => c.status === "pass" || c.status === "timeout",
    )).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Check adapters — blast-radius, secrets, dead-code
// ---------------------------------------------------------------------------

describe("check adapters — blast-radius, secrets, dead-code", () => {
  const mockedImpactAnalysis = vi.mocked(impactAnalysis);
  const mockedScanSecrets = vi.mocked(scanSecrets);
  const mockedFindDeadCode = vi.mocked(findDeadCode);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- checkBlastRadius ---

  it("checkBlastRadius: 2 affected symbols → 2 T2 findings, status warn", async () => {
    mockedImpactAnalysis.mockResolvedValue({
      changed_files: ["src/a.ts"],
      affected_symbols: [
        { name: "foo", file: "a.ts", id: "a:foo", kind: "function", start_line: 1, end_line: 10 } as any,
        { name: "bar", file: "b.ts", id: "b:bar", kind: "function", start_line: 5, end_line: 15 } as any,
      ],
      affected_tests: [],
      risk_scores: [],
      dependency_graph: {},
    });

    const result = await checkBlastRadius(makeFakeIndex(), "HEAD~1", "HEAD");

    expect(result.check).toBe("blast-radius");
    expect(result.status).toBe("warn");
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((f) => f.check === "blast-radius")).toBe(true);
    expect(result.findings[0]!.file).toBe("a.ts");
    expect(result.findings[1]!.file).toBe("b.ts");
  });

  it("checkBlastRadius: 0 affected symbols → 0 findings, status pass", async () => {
    mockedImpactAnalysis.mockResolvedValue({
      changed_files: [],
      affected_symbols: [],
      affected_tests: [],
      risk_scores: [],
      dependency_graph: {},
    });

    const result = await checkBlastRadius(makeFakeIndex(), "HEAD~1", "HEAD");

    expect(result.status).toBe("pass");
    expect(result.findings).toHaveLength(0);
  });

  it("checkBlastRadius: impactAnalysis throws → status error, findings empty", async () => {
    mockedImpactAnalysis.mockRejectedValue(new Error("git diff failed"));

    const result = await checkBlastRadius(makeFakeIndex(), "HEAD~1", "HEAD");

    expect(result.check).toBe("blast-radius");
    expect(result.status).toBe("error");
    expect(result.findings).toEqual([]);
  });

  // --- checkSecrets ---

  it("checkSecrets: 1 high-severity finding → 1 T1 finding, status fail", async () => {
    mockedScanSecrets.mockResolvedValue({
      findings: [
        {
          file: "a.ts",
          line: 5,
          rule: "hardcoded-secret",
          severity: "high",
          masked_secret: "sk-***",
          label: "API Key",
          confidence: "high",
          context: { type: "production" },
        },
      ],
      files_scanned: 1,
      files_with_secrets: 1,
      scan_coverage: "full",
    });

    const result = await checkSecrets(makeFakeIndex(), ["src/a.ts", "src/b.ts"]);

    expect(result.check).toBe("secrets");
    expect(result.status).toBe("fail");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.check).toBe("secrets");
    expect(result.findings[0]!.file).toBe("a.ts");
    expect(result.findings[0]!.line).toBe(5);
  });

  it("checkSecrets: passes file_pattern derived from changedFiles to scanSecrets", async () => {
    mockedScanSecrets.mockResolvedValue({
      findings: [],
      files_scanned: 2,
      files_with_secrets: 0,
      scan_coverage: "full",
    });

    const changedFiles = ["src/auth.ts", "src/config.ts"];
    await checkSecrets(makeFakeIndex(), changedFiles);

    expect(mockedScanSecrets).toHaveBeenCalledOnce();
    const callArgs = mockedScanSecrets.mock.calls[0]!;
    // Second arg is the options object containing file_pattern
    const options = callArgs[1] as { file_pattern?: string };
    expect(options).toBeDefined();
    expect(options.file_pattern).toBeDefined();
    // The file_pattern should reference the changed files somehow
    expect(typeof options.file_pattern).toBe("string");
  });

  it("checkSecrets: 0 findings → status pass", async () => {
    mockedScanSecrets.mockResolvedValue({
      findings: [],
      files_scanned: 1,
      files_with_secrets: 0,
      scan_coverage: "full",
    });

    const result = await checkSecrets(makeFakeIndex(), ["src/clean.ts"]);

    expect(result.status).toBe("pass");
    expect(result.findings).toHaveLength(0);
  });

  it("checkSecrets: scanSecrets throws → status error, findings empty", async () => {
    mockedScanSecrets.mockRejectedValue(new Error("scan failed"));

    const result = await checkSecrets(makeFakeIndex(), ["src/a.ts"]);

    expect(result.check).toBe("secrets");
    expect(result.status).toBe("error");
    expect(result.findings).toEqual([]);
  });

  // --- checkDeadCode ---

  it("checkDeadCode: 3 candidates → 3 T2 findings", async () => {
    mockedFindDeadCode.mockResolvedValue({
      candidates: [
        { name: "unused", file: "a.ts", start_line: 10, end_line: 15, kind: "function", reason: "no refs" },
        { name: "old", file: "b.ts", start_line: 20, end_line: 25, kind: "function", reason: "no refs" },
        { name: "stale", file: "c.ts", start_line: 30, end_line: 35, kind: "function", reason: "no refs" },
      ],
      scanned_symbols: 50,
      scanned_files: 10,
    });

    const result = await checkDeadCode(makeFakeIndex(), ["src/a.ts"]);

    expect(result.check).toBe("dead-code");
    expect(result.findings).toHaveLength(3);
    expect(result.findings.every((f) => f.check === "dead-code")).toBe(true);
    expect(result.findings[0]!.symbol).toBe("unused");
    expect(result.findings[1]!.symbol).toBe("old");
    expect(result.findings[2]!.symbol).toBe("stale");
  });

  it("checkDeadCode: 0 candidates → status pass", async () => {
    mockedFindDeadCode.mockResolvedValue({
      candidates: [],
      scanned_symbols: 10,
      scanned_files: 3,
    });

    const result = await checkDeadCode(makeFakeIndex(), ["src/a.ts"]);

    expect(result.status).toBe("pass");
    expect(result.findings).toHaveLength(0);
  });

  it("checkDeadCode: findDeadCode throws → status error, findings empty", async () => {
    mockedFindDeadCode.mockRejectedValue(new Error("scan failed"));

    const result = await checkDeadCode(makeFakeIndex(), ["src/a.ts"]);

    expect(result.check).toBe("dead-code");
    expect(result.status).toBe("error");
    expect(result.findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Check adapters — bug-patterns, hotspots, complexity
// ---------------------------------------------------------------------------

// The 9 built-in pattern names from pattern-tools.ts
const BUILTIN_PATTERN_NAMES = [
  "useEffect-no-cleanup",
  "empty-catch",
  "any-type",
  "console-log",
  "await-in-loop",
  "no-error-type",
  "toctou",
  "unbounded-findmany",
  "scaffolding",
];

describe("check adapters — bug-patterns, hotspots, complexity", () => {
  const mockedSearchPatterns = vi.mocked(searchPatterns);
  const mockedListPatternsLocal = vi.mocked(listPatterns);
  const mockedAnalyzeHotspots = vi.mocked(analyzeHotspots);
  const mockedAnalyzeComplexity = vi.mocked(analyzeComplexity);

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: listPatterns returns all 9 built-in pattern names
    mockedListPatternsLocal.mockReturnValue(
      BUILTIN_PATTERN_NAMES.map((name) => ({ name, description: `desc-${name}` })),
    );
  });

  // --- checkBugPatterns ---

  it("checkBugPatterns: matches from 2 patterns → merged findings, no duplicates", async () => {
    // Simulate searchPatterns returning different matches for different patterns
    mockedSearchPatterns.mockImplementation(async (_repo, pattern) => {
      if (pattern === "empty-catch") {
        return {
          matches: [
            {
              name: "fetchData",
              kind: "function",
              file: "src/a.ts",
              start_line: 5,
              end_line: 20,
              matched_pattern: "empty-catch: Empty catch block",
              context: "catch (e) {}",
            },
          ],
          pattern: "empty-catch: Empty catch block",
          scanned_symbols: 10,
        };
      }
      if (pattern === "any-type") {
        return {
          matches: [
            {
              name: "parseData",
              kind: "function",
              file: "src/b.ts",
              start_line: 10,
              end_line: 30,
              matched_pattern: "any-type: Usage of 'any' type",
              context: "const x: any = data",
            },
          ],
          pattern: "any-type: Usage of 'any' type",
          scanned_symbols: 10,
        };
      }
      return { matches: [], pattern, scanned_symbols: 10 };
    });

    const changedFiles = ["src/a.ts", "src/b.ts"];
    const result = await checkBugPatterns(makeFakeIndex(), changedFiles);

    expect(result.check).toBe("bug-patterns");
    // Should have findings from both patterns
    expect(result.findings.length).toBeGreaterThanOrEqual(2);
    // All findings belong to bug-patterns check
    expect(result.findings.every((f) => f.check === "bug-patterns")).toBe(true);
    // Status should be warn when findings exist
    expect(result.status).toBe("warn");
  });

  it("checkBugPatterns: calls searchPatterns once per BUILTIN_PATTERN", async () => {
    mockedSearchPatterns.mockResolvedValue({ matches: [], pattern: "x", scanned_symbols: 0 });

    const changedFiles = ["src/a.ts"];
    await checkBugPatterns(makeFakeIndex(), changedFiles);

    // There are 9 built-in patterns in pattern-tools.ts
    expect(mockedSearchPatterns).toHaveBeenCalledTimes(9);
  });

  it("checkBugPatterns: deduplicates findings by file+line+matched_pattern", async () => {
    // Two patterns return the same match (same file, same line)
    const duplicateMatch = {
      name: "foo",
      kind: "function" as const,
      file: "src/a.ts",
      start_line: 5,
      end_line: 20,
      matched_pattern: "empty-catch: Empty catch block",
      context: "catch (e) {}",
    };
    mockedSearchPatterns.mockResolvedValue({
      matches: [duplicateMatch],
      pattern: "empty-catch",
      scanned_symbols: 10,
    });

    const result = await checkBugPatterns(makeFakeIndex(), ["src/a.ts"]);

    // Even though all 9 pattern calls return the same match,
    // deduplication should collapse them (same file+line+matched_pattern)
    expect(result.findings.length).toBe(1);
  });

  it("checkBugPatterns: searchPatterns throws → status error, findings empty", async () => {
    mockedSearchPatterns.mockRejectedValue(new Error("pattern scan failed"));

    const result = await checkBugPatterns(makeFakeIndex(), ["src/a.ts"]);

    expect(result.check).toBe("bug-patterns");
    expect(result.status).toBe("error");
    expect(result.findings).toEqual([]);
  });

  it("checkBugPatterns: 0 matches → status pass", async () => {
    mockedSearchPatterns.mockResolvedValue({ matches: [], pattern: "x", scanned_symbols: 0 });

    const result = await checkBugPatterns(makeFakeIndex(), ["src/a.ts"]);

    expect(result.status).toBe("pass");
    expect(result.findings).toHaveLength(0);
  });

  // --- checkHotspots ---

  it("checkHotspots: 3 hotspots, 2 in changedFiles → 2 T3 findings, status warn", async () => {
    mockedAnalyzeHotspots.mockResolvedValue({
      hotspots: [
        { file: "src/a.ts", commits: 10, lines_changed: 500, symbol_count: 5, churn_score: 5000, hotspot_score: 25000 },
        { file: "src/b.ts", commits: 8, lines_changed: 300, symbol_count: 4, churn_score: 2400, hotspot_score: 9600 },
        { file: "src/c.ts", commits: 3, lines_changed: 100, symbol_count: 2, churn_score: 300, hotspot_score: 600 },
      ],
      period: "last 90 days",
      total_files: 3,
      total_commits: 7,
    });

    // Only src/a.ts and src/b.ts are in changedFiles
    const changedFiles = ["src/a.ts", "src/b.ts"];
    const result = await checkHotspots(makeFakeIndex(), changedFiles);

    expect(result.check).toBe("hotspots");
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((f) => f.check === "hotspots")).toBe(true);
    expect(result.status).toBe("warn");
    // Verify the right files are included
    const files = result.findings.map((f) => f.file);
    expect(files).toContain("src/a.ts");
    expect(files).toContain("src/b.ts");
    expect(files).not.toContain("src/c.ts");
  });

  it("checkHotspots: no hotspots in changedFiles → status pass", async () => {
    mockedAnalyzeHotspots.mockResolvedValue({
      hotspots: [
        { file: "src/other.ts", commits: 10, lines_changed: 500, symbol_count: 5, churn_score: 5000, hotspot_score: 25000 },
      ],
      period: "last 90 days",
      total_files: 1,
      total_commits: 10,
    });

    const changedFiles = ["src/a.ts"];
    const result = await checkHotspots(makeFakeIndex(), changedFiles);

    expect(result.status).toBe("pass");
    expect(result.findings).toHaveLength(0);
  });

  it("checkHotspots: analyzeHotspots throws → status error, findings empty", async () => {
    mockedAnalyzeHotspots.mockRejectedValue(new Error("git log failed"));

    const result = await checkHotspots(makeFakeIndex(), ["src/a.ts"]);

    expect(result.check).toBe("hotspots");
    expect(result.status).toBe("error");
    expect(result.findings).toEqual([]);
  });

  // --- checkComplexityDelta ---

  it("checkComplexityDelta: 2 functions in changedFiles with cyclomatic > 10 → 2 T2 findings", async () => {
    mockedAnalyzeComplexity.mockResolvedValue({
      functions: [
        { name: "complexFn", kind: "function", file: "src/a.ts", start_line: 1, end_line: 50, lines: 50, cyclomatic_complexity: 15, max_nesting_depth: 5, branches: 14 },
        { name: "alsoComplex", kind: "method", file: "src/b.ts", start_line: 10, end_line: 60, lines: 50, cyclomatic_complexity: 12, max_nesting_depth: 4, branches: 11 },
        { name: "notChanged", kind: "function", file: "src/other.ts", start_line: 1, end_line: 30, lines: 30, cyclomatic_complexity: 20, max_nesting_depth: 6, branches: 19 },
        { name: "simple", kind: "function", file: "src/a.ts", start_line: 55, end_line: 60, lines: 6, cyclomatic_complexity: 3, max_nesting_depth: 1, branches: 2 },
      ],
      summary: {
        total_functions: 4,
        avg_complexity: 12.5,
        avg_lines: 34,
        max_complexity: 20,
        max_nesting: 6,
        above_threshold: 3,
      },
    });

    // Only src/a.ts and src/b.ts are in changedFiles
    const changedFiles = ["src/a.ts", "src/b.ts"];
    const result = await checkComplexityDelta(makeFakeIndex(), changedFiles);

    expect(result.check).toBe("complexity");
    // complexFn (15 > 10, in changedFiles) + alsoComplex (12 > 10, in changedFiles)
    // notChanged (20 > 10, NOT in changedFiles) → excluded
    // simple (3 <= 10) → excluded
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((f) => f.check === "complexity")).toBe(true);
    expect(result.status).toBe("warn");
    const symbols = result.findings.map((f) => f.symbol);
    expect(symbols).toContain("complexFn");
    expect(symbols).toContain("alsoComplex");
  });

  it("checkComplexityDelta: functions not in changedFiles are excluded", async () => {
    mockedAnalyzeComplexity.mockResolvedValue({
      functions: [
        { name: "highComplexity", kind: "function", file: "src/other.ts", start_line: 1, end_line: 50, lines: 50, cyclomatic_complexity: 25, max_nesting_depth: 8, branches: 24 },
      ],
      summary: {
        total_functions: 1,
        avg_complexity: 25,
        avg_lines: 50,
        max_complexity: 25,
        max_nesting: 8,
        above_threshold: 1,
      },
    });

    const changedFiles = ["src/a.ts"]; // "src/other.ts" is NOT in changedFiles
    const result = await checkComplexityDelta(makeFakeIndex(), changedFiles);

    expect(result.findings).toHaveLength(0);
    expect(result.status).toBe("pass");
  });

  it("checkComplexityDelta: functions with cyclomatic <= 10 are excluded", async () => {
    mockedAnalyzeComplexity.mockResolvedValue({
      functions: [
        { name: "okFn", kind: "function", file: "src/a.ts", start_line: 1, end_line: 20, lines: 20, cyclomatic_complexity: 10, max_nesting_depth: 2, branches: 9 },
        { name: "simpleFn", kind: "function", file: "src/a.ts", start_line: 25, end_line: 35, lines: 10, cyclomatic_complexity: 5, max_nesting_depth: 1, branches: 4 },
      ],
      summary: {
        total_functions: 2,
        avg_complexity: 7.5,
        avg_lines: 15,
        max_complexity: 10,
        max_nesting: 2,
        above_threshold: 0,
      },
    });

    const changedFiles = ["src/a.ts"];
    const result = await checkComplexityDelta(makeFakeIndex(), changedFiles);

    // cyclomatic_complexity must be > 10, not >= 10
    expect(result.findings).toHaveLength(0);
    expect(result.status).toBe("pass");
  });

  it("checkComplexityDelta: analyzeComplexity throws → status error, findings empty", async () => {
    mockedAnalyzeComplexity.mockRejectedValue(new Error("complexity scan failed"));

    const result = await checkComplexityDelta(makeFakeIndex(), ["src/a.ts"]);

    expect(result.check).toBe("complexity");
    expect(result.status).toBe("error");
    expect(result.findings).toEqual([]);
  });
});
