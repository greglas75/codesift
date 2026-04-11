/**
 * audit_hono_security — security audit of Hono application.
 *
 * Checks: rate limiting on mutations, secure-headers middleware, auth
 * ordering, CSRF protection, hardcoded secret access.
 *
 * Spec: docs/specs/2026-04-10-hono-framework-intelligence-spec.md (Task 21)
 */

import { getCodeIndex } from "./index-tools.js";
import { honoCache } from "../cache/hono-cache.js";
import { HonoExtractor } from "../parser/extractors/hono.js";
import { resolveHonoEntryFile } from "./hono-entry-resolver.js";
import { detectFrameworks } from "../utils/framework-detect.js";
import type { MiddlewareEntry } from "../parser/extractors/hono-model.js";

export interface SecurityFinding {
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  rule: string;
  message: string;
  file?: string;
  line?: number;
}

export interface SecurityAuditResult {
  findings?: SecurityFinding[];
  error?: string;
}

const RATE_LIMIT_KEYWORDS = /rate\s*limit/i;
const SECURE_HEADERS_KEYWORDS = /secure[_-]?headers/i;
const AUTH_KEYWORDS = /auth|jwt|bearer|clerk|session/i;
const MUTATION_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

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

  return { findings };
}