/**
 * Next.js Server Actions security audit (T2).
 *
 * Walks files containing `"use server"` (file-scope or inline) and audits each
 * exported server action against four checks: authorization guards, input
 * validation, rate limiting, and structured error handling. Per-action scoring
 * follows a weighted formula (auth 40, validation 30, rate 20, error 10).
 *
 * This file is the public-facing entry point and types module. The reader and
 * scoring helpers live in their own files (`nextjs-security-readers.ts` and
 * `nextjs-security-scoring.ts`) per the 3-file split (D10).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthConfidence = "high" | "medium" | "low" | "none";

export type ValidationLib = "zod" | "yup" | "joi" | "manual" | "none";

export type RateLimitLib = "upstash" | "vercel" | "express" | "manual" | "none";

export interface AuthGuardInfo {
  confidence: AuthConfidence;
  pattern: "direct" | "hoc" | "none";
  callsite?: { name: string; line: number };
}

export interface InputValidationInfo {
  lib: ValidationLib;
  confidence: "high" | "medium" | "low";
}

export interface RateLimitingInfo {
  lib: RateLimitLib;
  confidence: "high" | "medium" | "low";
}

export interface ErrorHandlingInfo {
  has_try_catch: boolean;
  confidence: "high" | "medium" | "low";
}

export interface ServerActionAudit {
  name: string;
  file: string;
  line: number;
  is_async: boolean;
  auth: AuthGuardInfo;
  input_validation: InputValidationInfo;
  rate_limiting: RateLimitingInfo;
  error_handling: ErrorHandlingInfo;
  score: number;
  grade: "poor" | "needs_work" | "good" | "excellent";
  top_missing: string[];
}

export interface SecurityScore {
  score: number;
  grade: "poor" | "needs_work" | "good" | "excellent";
  top_missing: string[];
}

export interface ServerActionsAuditCounts {
  excellent: number;
  good: number;
  needs_work: number;
  poor: number;
}

export interface ServerActionsAuditResult {
  total: number;
  actions: ServerActionAudit[];
  counts: ServerActionsAuditCounts;
  violations: string[];
  parse_failures: string[];
  scan_errors: string[];
  workspaces_scanned: string[];
  limitations: string[];
}

export interface NextjsAuditServerActionsOptions {
  workspace?: string | undefined;
  max_files?: number | undefined;
}

// ---------------------------------------------------------------------------
// Stub orchestrator (Task 18 wires this)
// ---------------------------------------------------------------------------

export async function nextjsAuditServerActions(
  _repo: string,
  _options?: NextjsAuditServerActionsOptions,
): Promise<ServerActionsAuditResult> {
  throw new Error("not implemented");
}
