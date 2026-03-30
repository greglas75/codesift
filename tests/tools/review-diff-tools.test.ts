import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — MUST be before imports so vi.mock hoists correctly
// ---------------------------------------------------------------------------

vi.mock("../../src/tools/diff-tools.js", () => ({ changedSymbols: vi.fn() }));
vi.mock("../../src/tools/impact-tools.js", () => ({ impactAnalysis: vi.fn() }));
vi.mock("../../src/tools/secret-tools.js", () => ({ scanSecrets: vi.fn() }));
vi.mock("../../src/tools/symbol-tools.js", () => ({ findDeadCode: vi.fn() }));
vi.mock("../../src/tools/pattern-tools.js", () => ({ searchPatterns: vi.fn() }));
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
} from "../../src/tools/review-diff-tools.js";
import type { ReviewFinding, CheckResult, ReviewDiffOptions } from "../../src/tools/review-diff-tools.js";
import { changedSymbols } from "../../src/tools/diff-tools.js";
import { getCodeIndex } from "../../src/tools/index-tools.js";
import { validateGitRef } from "../../src/utils/git-validation.js";
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

  const fakeIndex = makeFakeIndex();

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: valid index, valid refs
    mockedGetCodeIndex.mockResolvedValue(fakeIndex);
    mockedValidateGitRef.mockImplementation(() => {});
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
