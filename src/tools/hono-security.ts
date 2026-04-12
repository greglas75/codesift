/**
 * audit_hono_security — security + type-safety audit of Hono application.
 *
 * Checks:
 *   - missing-secure-headers (global)
 *   - missing-rate-limit (mutation routes, conditional-aware)
 *   - missing-auth (mutation routes, conditional-aware)
 *   - auth-ordering (auth after non-auth in a chain)
 *   - env-regression (plain createMiddleware in 3+ chains, Issue #3587)
 *     — absorbed from the former detect_middleware_env_regression tool.
 *       It is a type-safety check that still walks middleware chains,
 *       so it fits the audit surface.
 *
 * Spec: docs/specs/2026-04-10-hono-framework-intelligence-spec.md (Task 21) +
 *       docs/specs/2026-04-11-hono-phase-2-plan.md (T10 consolidation)
 */

import { getCodeIndex } from "./index-tools.js";
import { honoCache } from "../cache/hono-cache.js";
import { HonoExtractor } from "../parser/extractors/hono.js";
import { resolveHonoEntryFile } from "./hono-entry-resolver.js";
import { detectFrameworks } from "../utils/framework-detect.js";
import type { MiddlewareEntry } from "../parser/extractors/hono-model.js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve as pathResolve } from "node:path";

export interface SecurityFinding {
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  rule: string;
  message: string;
  file?: string;
  line?: number;
}

export interface SecurityAuditResult {
  findings?: SecurityFinding[];
  /** Heuristic disclaimers for rules that rely on regex/lookups rather than a real type checker. */
  notes?: Record<string, string>;
  error?: string;
}

const RATE_LIMIT_KEYWORDS = /rate\s*limit/i;
const SECURE_HEADERS_KEYWORDS = /secure[_-]?headers/i;
const AUTH_KEYWORDS = /auth|jwt|bearer|clerk|session/i;
const MUTATION_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

/**
 * Regex explanation:
 *   \bcreateMiddleware   → word-boundary before the token
 *   (?!\s*<)             → negative lookahead — NOT followed by `<` (generic arg)
 *   \s*\(                → open paren of the call
 *
 * Matches:  createMiddleware(async (c, next) => ...)
 * Does not match:  createMiddleware<AppEnv>(...)
 */
const PLAIN_CREATE_MIDDLEWARE = /\bcreateMiddleware(?!\s*<)\s*\(/g;
const ENV_REGRESSION_NOTE =
  "env-regression is a heuristic regex scan; false positives possible when middleware factories wrap createMiddleware or re-export it under a different name. Review each finding before typing changes.";

/**
 * Does a conditional middleware apply to a given HTTP method?
 *
 * Phase 2 T4 populates `applied_when` on inline-gated middleware like
 *
 *     app.use('/posts/*', async (c, next) => {
 *       if (c.req.method !== 'GET') return basicAuth({...})(c, next);
 *       await next();
 *     });
 *
 * Without this check the auditor reports "missing auth" on POST /posts even
 * though the route IS gated. We inspect condition_text for method equality
 * patterns and decide whether the conditional entry covers the method in
 * question. When we can't tell statically, we default to "applies" (safe
 * side — no false positive).
 */
function conditionalAppliesToMethod(
  entry: MiddlewareEntry,
  method: string,
): boolean {
  if (!entry.applied_when) return true;
  if (entry.applied_when.condition_type !== "method") return true;
  const text = entry.applied_when.condition_text;
  // Pattern: method !== 'X' (or "X") — middleware runs for anything NOT X
  const neqMatch = text.match(/method\s*!==?\s*["']([A-Z]+)["']/i);
  if (neqMatch?.[1]) return neqMatch[1].toUpperCase() !== method.toUpperCase();
  // Pattern: method === 'X' — middleware runs only for X
  const eqMatch = text.match(/method\s*===?\s*["']([A-Z]+)["']/i);
  if (eqMatch?.[1]) return eqMatch[1].toUpperCase() === method.toUpperCase();
  return true;
}

export async function auditHonoSecurity(
  repo: string,
): Promise<SecurityAuditResult> {
  const index = await getCodeIndex(repo);
  if (!index) return { error: `Repository "${repo}" not found` };

  const frameworks = detectFrameworks(index);
  if (!frameworks.has("hono")) return { error: "No Hono app detected" };

  const entryFile = resolveHonoEntryFile(index);
  if (!entryFile) return { error: "No Hono entry file found" };

  let model;
  try {
    model = await honoCache.get(repo, entryFile, new HonoExtractor());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Failed to parse: ${msg}` };
  }

  const findings: SecurityFinding[] = [];

  // Check 1: global secure-headers middleware
  const hasSecureHeaders = model.middleware_chains.some(
    (mc) =>
      mc.scope === "*" &&
      mc.entries.some((e) => SECURE_HEADERS_KEYWORDS.test(e.name)),
  );
  if (!hasSecureHeaders) {
    findings.push({
      severity: "MEDIUM",
      rule: "missing-secure-headers",
      message:
        "No secure-headers middleware registered globally. Consider `app.use('*', secureHeaders())` from hono/secure-headers.",
    });
  }

  // Check 2: mutation routes without rate limiting.
  // Phase 2: conditional entries only count if their applied_when covers
  // the route's method — otherwise a conditional GET-only middleware would
  // fail to protect a POST route anyway.
  for (const route of model.routes) {
    if (!MUTATION_METHODS.has(route.method)) continue;

    const activeChains = model.middleware_chains.filter((mc) => {
      if (mc.scope === "*") return true;
      const pattern = mc.scope.replace(/\*/g, ".*");
      return new RegExp(`^${pattern}$`).test(route.path);
    });
    const hasRateLimit = activeChains.some((mc) =>
      mc.entries.some(
        (e) =>
          RATE_LIMIT_KEYWORDS.test(e.name) &&
          conditionalAppliesToMethod(e, route.method),
      ),
    );
    if (!hasRateLimit) {
      findings.push({
        severity: "HIGH",
        rule: "missing-rate-limit",
        message: `Mutation route ${route.method} ${route.path} has no rate limiting middleware.`,
        file: route.file,
        line: route.line,
      });
    }
  }

  // Check 2b: mutation routes without auth. Uses the same conditional-aware
  // logic so conditional basicAuth like the blog API pattern is recognized.
  for (const route of model.routes) {
    if (!MUTATION_METHODS.has(route.method)) continue;
    const activeChains = model.middleware_chains.filter((mc) => {
      if (mc.scope === "*") return true;
      const pattern = mc.scope.replace(/\*/g, ".*");
      return new RegExp(`^${pattern}$`).test(route.path);
    });
    const hasAuth = activeChains.some((mc) =>
      mc.entries.some(
        (e) =>
          AUTH_KEYWORDS.test(e.name) &&
          conditionalAppliesToMethod(e, route.method),
      ),
    );
    if (!hasAuth) {
      findings.push({
        severity: "HIGH",
        rule: "missing-auth",
        message: `Mutation route ${route.method} ${route.path} has no auth middleware in its scope.`,
        file: route.file,
        line: route.line,
      });
    }
  }

  // Check 3: auth ordering — auth middleware appearing after non-auth in chain.
  // Skip <inline> wrappers and conditional entries from the "seenNonAuth"
  // ordering check: both are structurally different from named middleware
  // and reporting them as "non-auth" causes false positives on the common
  // conditional-auth wrapper pattern.
  for (const mc of model.middleware_chains) {
    let seenNonAuth = false;
    for (const entry of mc.entries) {
      if (entry.name === "<inline>" || entry.applied_when) continue;
      if (AUTH_KEYWORDS.test(entry.name)) {
        if (seenNonAuth) {
          findings.push({
            severity: "MEDIUM",
            rule: "auth-ordering",
            message: `Auth middleware "${entry.name}" appears after non-auth middleware in scope "${mc.scope}". Auth should be registered first.`,
            file: entry.file,
            line: entry.line,
          });
        }
      } else {
        seenNonAuth = true;
      }
    }
  }

  // Check 4: env-regression — Hono Issue #3587. Middleware chains of 3+
  // entries where an intermediate member is declared with plain
  // `createMiddleware(...)` (no Env generic) reset the accumulated Env
  // type to BlankEnv for all downstream middleware.
  // Cache file scans so shared middleware files are only read once.
  const regressionScanCache = new Map<string, Array<{ line: number }>>();
  let emittedEnvRegression = false;
  for (const chain of model.middleware_chains) {
    if (chain.entries.length < 3) continue;
    // Intermediate entries only — first + last are endpoints of the chain.
    const intermediates = chain.entries.slice(1, -1);
    for (const entry of intermediates) {
      if (entry.is_third_party) continue;
      if (entry.inline) continue;
      const definitionFile = resolveDefinitionFile(entry.file, entry.imported_from);
      if (!definitionFile) continue;
      let hits = regressionScanCache.get(definitionFile);
      if (!hits) {
        hits = await scanFileForPlainCreateMiddleware(definitionFile);
        regressionScanCache.set(definitionFile, hits);
      }
      if (hits.length === 0) continue;
      const first = hits[0];
      if (!first) continue;
      emittedEnvRegression = true;
      findings.push({
        severity: "MEDIUM",
        rule: "env-regression",
        message: `Middleware "${entry.name}" in chain "${chain.scope}" (${chain.entries.length} entries) is declared with plain createMiddleware(...) without an Env generic — this resets the accumulated Env type to BlankEnv for downstream middleware (Hono Issue #3587).`,
        file: definitionFile,
        line: first.line,
      });
    }
  }

  const result: SecurityAuditResult = { findings };
  if (emittedEnvRegression) {
    result.notes = { "env-regression": ENV_REGRESSION_NOTE };
  }
  return result;
}

/**
 * Resolve the definition file for a middleware entry from the caller file and
 * its import specifier. Returns the absolute path, or null if the import is
 * third-party or cannot be resolved on disk. Used by the env-regression check.
 */
function resolveDefinitionFile(
  callerFile: string,
  importSpec: string | undefined,
): string | null {
  if (!importSpec) {
    return existsSync(callerFile) ? callerFile : null;
  }
  if (!importSpec.startsWith(".")) {
    return null;
  }
  const base = pathResolve(dirname(callerFile), importSpec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    join(base, "index.js"),
    join(base, "index.jsx"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function scanFileForPlainCreateMiddleware(
  file: string,
): Promise<Array<{ line: number }>> {
  let source: string;
  try {
    source = await readFile(file, "utf-8");
  } catch {
    return [];
  }
  const hits: Array<{ line: number }> = [];
  // Reset regex state per scan (global flag retains lastIndex).
  PLAIN_CREATE_MIDDLEWARE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLAIN_CREATE_MIDDLEWARE.exec(source)) !== null) {
    const line = source.slice(0, m.index).split("\n").length;
    hits.push({ line });
  }
  return hits;
}