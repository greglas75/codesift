/**
 * Pure scoring helpers for Server Actions security audit (T2).
 *
 * Takes per-check info objects (auth, validation, rate, error) and produces
 * a numeric score 0-100, a grade bucket, and a list of top missing checks.
 */

import type {
  AuthGuardInfo,
  InputValidationInfo,
  RateLimitingInfo,
  ErrorHandlingInfo,
  SecurityScore,
} from "./nextjs-security-tools.js";

export interface ServerActionAuditInput {
  auth: AuthGuardInfo;
  input_validation: InputValidationInfo;
  rate_limiting: RateLimitingInfo;
  error_handling: ErrorHandlingInfo;
}

const WEIGHTS = {
  auth: 40,
  input_validation: 30,
  rate_limiting: 20,
  error_handling: 10,
} as const;

const CONFIDENCE_MULTIPLIER: Record<string, number> = {
  high: 1.0,
  medium: 0.5,
  low: 0.2,
  none: 0,
};

function gradeFor(score: number): SecurityScore["grade"] {
  if (score >= 90) return "excellent";
  if (score >= 70) return "good";
  if (score >= 40) return "needs_work";
  return "poor";
}

export function scoreServerAction(audit: ServerActionAuditInput): SecurityScore {
  // Auth: score from confidence multiplier
  const authMult = CONFIDENCE_MULTIPLIER[audit.auth.confidence] ?? 0;
  const authPoints = Math.round(WEIGHTS.auth * authMult);

  // Input validation: zero unless lib != none
  let validationMult = 0;
  if (audit.input_validation.lib !== "none") {
    validationMult = CONFIDENCE_MULTIPLIER[audit.input_validation.confidence] ?? 0;
  }
  const validationPoints = Math.round(WEIGHTS.input_validation * validationMult);

  // Rate limiting: zero unless lib != none
  let rateMult = 0;
  if (audit.rate_limiting.lib !== "none") {
    rateMult = CONFIDENCE_MULTIPLIER[audit.rate_limiting.confidence] ?? 0;
  }
  const ratePoints = Math.round(WEIGHTS.rate_limiting * rateMult);

  // Error handling: try/catch present?
  const errorPoints = audit.error_handling.has_try_catch
    ? Math.round(WEIGHTS.error_handling * (CONFIDENCE_MULTIPLIER[audit.error_handling.confidence] ?? 0))
    : 0;

  const score = authPoints + validationPoints + ratePoints + errorPoints;

  // Top missing list (highest weight first)
  const top_missing: string[] = [];
  if (authPoints < WEIGHTS.auth) top_missing.push("auth");
  if (validationPoints < WEIGHTS.input_validation) top_missing.push("input_validation");
  if (ratePoints < WEIGHTS.rate_limiting) top_missing.push("rate_limiting");
  if (errorPoints < WEIGHTS.error_handling) top_missing.push("error_handling");

  return {
    score,
    grade: gradeFor(score),
    top_missing,
  };
}
