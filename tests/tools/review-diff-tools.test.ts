import { describe, it, expect } from "vitest";
import {
  findingTier,
  calculateScore,
  determineVerdict,
} from "../../src/tools/review-diff-tools.js";
import type { ReviewFinding, CheckResult } from "../../src/tools/review-diff-tools.js";

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
