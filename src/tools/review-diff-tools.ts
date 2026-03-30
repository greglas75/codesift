/**
 * review-diff-tools.ts
 *
 * Types, tier assignment, scoring, and verdict functions for the review_diff MCP tool.
 * All exports are pure functions — no side effects.
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ReviewDiffOptions {
  repo: string;
  since?: string;
  /** Comma-separated check names to run (defaults to all) */
  checks?: string;
  /** Token budget for responses (default 8000) */
  token_budget?: number;
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

export interface ReviewDiffResult {
  repo: string;
  since: string;
  checks: CheckResult[];
  findings: ReviewFinding[];
  /** 0-100 quality score */
  score: number;
  verdict: "pass" | "warn" | "fail";
  duration_ms: number;
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
