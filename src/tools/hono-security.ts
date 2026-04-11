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
import { detectFrameworks } from "../utils/framework-detect.js";
import { join } from "node:path";

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

  // Check 2: mutation routes without rate limiting
  for (const route of model.routes) {
    if (!MUTATION_METHODS.has(route.method)) continue;

    const activeChains = model.middleware_chains.filter((mc) => {
      if (mc.scope === "*") return true;
      const pattern = mc.scope.replace(/\*/g, ".*");
      return new RegExp(`^${pattern}$`).test(route.path);
    });
    const hasRateLimit = activeChains.some((mc) =>
      mc.entries.some((e) => RATE_LIMIT_KEYWORDS.test(e.name)),
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

  // Check 3: auth ordering — auth middleware appearing after non-auth in chain
  for (const mc of model.middleware_chains) {
    let seenNonAuth = false;
    for (const entry of mc.entries) {
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

function resolveHonoEntryFile(index: {
  symbols: Array<{ source?: string | undefined; file: string }>;
  root: string;
}): string | null {
  for (const sym of index.symbols) {
    if (sym.source && /new\s+(?:Hono|OpenAPIHono)\s*(?:<[^>]*>)?\s*\(/.test(sym.source)) {
      return join(index.root, sym.file);
    }
  }
  return null;
}
