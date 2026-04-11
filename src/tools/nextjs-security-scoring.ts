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

export function scoreServerAction(_audit: ServerActionAuditInput): SecurityScore {
  throw new Error("not implemented");
}
