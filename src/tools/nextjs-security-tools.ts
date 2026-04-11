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

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { discoverWorkspaces } from "../utils/nextjs.js";
import { cachedParseFile as parseFile } from "../utils/nextjs-audit-cache.js";
import { cachedWalkDirectory as walkDirectory } from "../utils/nextjs-audit-cache.js";
import { getCodeIndex } from "./index-tools.js";
import {
  extractServerActionFunctions,
  detectAuthGuard,
  detectInputValidation,
  detectRateLimiting,
} from "./nextjs-security-readers.js";
import { scoreServerAction } from "./nextjs-security-scoring.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthConfidence = "high" | "medium" | "low" | "none";

export type ValidationLib = "zod" | "manual" | "none";

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
// Orchestrator (Task 18)
// ---------------------------------------------------------------------------

const ACTION_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const PARSE_CONCURRENCY = 10;
const MAX_FILE_SIZE_BYTES = 2_097_152;
const DEFAULT_MAX_FILES = 2000;

/** Quick sniff: does the file mention `"use server"` directive at all? */
function quickHasUseServer(source: string): boolean {
  // Cheap text check before invoking the parser.
  return source.includes("use server");
}

export async function nextjsAuditServerActions(
  repo: string,
  options?: NextjsAuditServerActionsOptions,
): Promise<ServerActionsAuditResult> {
  if (process.env.CODESIFT_DISABLE_TOOLS?.includes("nextjs_audit_server_actions")) {
    throw new Error("nextjs_audit_server_actions is disabled via CODESIFT_DISABLE_TOOLS");
  }

  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository not found: ${repo}. Run index_folder first.`);
  }
  const projectRoot = index.root;

  let workspaces: string[];
  if (options?.workspace) {
    workspaces = [join(projectRoot, options.workspace)];
  } else {
    const discovered = await discoverWorkspaces(projectRoot);
    workspaces = discovered.length > 0 ? discovered.map((w) => w.root) : [projectRoot];
  }

  const maxFiles = options?.max_files ?? DEFAULT_MAX_FILES;
  const actions: ServerActionAudit[] = [];
  const parse_failures: string[] = [];
  const scan_errors: string[] = [];
  const workspaces_scanned: string[] = [];
  const violations = new Set<string>();

  for (const workspace of workspaces) {
    workspaces_scanned.push(workspace);

    const candidates: string[] = [];
    for (const subdir of ["app", "src/app", "lib", "src/lib", "actions", "src/actions"]) {
      const fullDir = join(workspace, subdir);
      try {
        const walked = await walkDirectory(fullDir, {
          followSymlinks: true,
          fileFilter: (ext) => ACTION_EXTS.has(ext),
          maxFileSize: MAX_FILE_SIZE_BYTES,
        });
        candidates.push(...walked);
      } catch (err) {
        scan_errors.push(`${fullDir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const remaining = maxFiles - actions.length;
    const toProcess = candidates.slice(0, Math.max(0, remaining));

    for (let i = 0; i < toProcess.length; i += PARSE_CONCURRENCY) {
      const chunk = toProcess.slice(i, i + PARSE_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (filePath) => {
          const rel = relative(projectRoot, filePath);
          try {
            const source = await readFile(filePath, "utf8");
            if (!quickHasUseServer(source)) return null;
            const tree = await parseFile(filePath, source);
            if (!tree) {
              parse_failures.push(rel);
              return null;
            }
            const fns = extractServerActionFunctions(tree, source, rel);
            if (fns.length === 0) return null;
            return fns.map((fn) => {
              const auth = detectAuthGuard(fn);
              const input_validation = detectInputValidation(fn, tree, source);
              const rate_limiting = detectRateLimiting(fn, tree, source);
              const error_handling = {
                has_try_catch: fn.bodyNode ? /\btry\s*\{/.test(fn.bodyNode.text) : false,
                confidence: "high" as const,
              };
              const score = scoreServerAction({ auth, input_validation, rate_limiting, error_handling });
              const audit: ServerActionAudit = {
                name: fn.name,
                file: fn.file,
                line: fn.line,
                is_async: fn.isAsync,
                auth,
                input_validation,
                rate_limiting,
                error_handling,
                score: score.score,
                grade: score.grade,
                top_missing: score.top_missing,
              };
              for (const m of score.top_missing) violations.add(m);
              return audit;
            });
          } catch (err) {
            parse_failures.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          }
        }),
      );
      for (const r of results) {
        if (!r) continue;
        actions.push(...r);
      }
    }
  }

  const counts: ServerActionsAuditCounts = {
    excellent: 0,
    good: 0,
    needs_work: 0,
    poor: 0,
  };
  for (const a of actions) {
    counts[a.grade]++;
  }

  return {
    total: actions.length,
    actions,
    counts,
    violations: [...violations],
    parse_failures,
    scan_errors,
    workspaces_scanned,
    limitations: [
      "auth detection limited to default identifier set (auth, getSession, currentUser, etc.)",
      "input validation detection currently Zod-only (Yup/Joi/TypeBox not detected)",
    ],
  };
}
