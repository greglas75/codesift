/**
 * AST readers for Next.js Server Actions security audit (T2).
 *
 * Each reader is a focused, pure function that extracts a specific signal
 * from a parsed tree-sitter Tree. The orchestrator in `nextjs-security-tools.ts`
 * composes them into a per-action audit.
 */

import type Parser from "web-tree-sitter";
import type {
  AuthGuardInfo,
  InputValidationInfo,
  RateLimitingInfo,
} from "./nextjs-security-tools.js";

// ---------------------------------------------------------------------------
// Server action enumeration (Task 14)
// ---------------------------------------------------------------------------

export interface ServerActionFn {
  name: string;
  file: string;
  line: number;
  isAsync: boolean;
  bodyNode: Parser.SyntaxNode | null;
  fnNode: Parser.SyntaxNode;
}

export function extractServerActionFunctions(
  _tree: Parser.Tree,
  _source: string,
  _file: string,
): ServerActionFn[] {
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// Auth guard detection (Task 15)
// ---------------------------------------------------------------------------

export function detectAuthGuard(_fn: ServerActionFn): AuthGuardInfo {
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// Input validation detection (Task 16)
// ---------------------------------------------------------------------------

export function detectInputValidation(
  _fn: ServerActionFn,
  _tree: Parser.Tree,
  _source: string,
): InputValidationInfo {
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// Rate limiting detection (Task 16)
// ---------------------------------------------------------------------------

export function detectRateLimiting(
  _fn: ServerActionFn,
  _tree: Parser.Tree,
  _source: string,
): RateLimitingInfo {
  throw new Error("not implemented");
}
