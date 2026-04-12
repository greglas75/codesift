/**
 * trace_middleware_chain — middleware chain introspection.
 *
 * Three query modes (mutually exclusive):
 *   1. Route mode     — path + optional method → ordered chain effective for that route
 *   2. Scope mode     — scope literal (e.g. "/posts/*") → chain of that specific app.use
 *   3. App-wide mode  — no path, no scope → flattened entries from every chain
 *
 * Any mode supports `only_conditional: true` to filter entries down to those
 * whose `applied_when` field is populated (Phase 2 T4 conditional middleware
 * detection). This absorbs the former standalone `trace_conditional_middleware`
 * tool — a scope-filtered or app-wide query with only_conditional=true is
 * equivalent to the old tool's output.
 *
 * Spec: docs/specs/2026-04-10-hono-framework-intelligence-spec.md (Task 16) +
 *       docs/specs/2026-04-11-hono-phase-2-plan.md (T7 consolidation)
 */

import { getCodeIndex } from "./index-tools.js";
import { honoCache } from "../cache/hono-cache.js";
import { HonoExtractor } from "../parser/extractors/hono.js";
import { resolveHonoEntryFile } from "./hono-entry-resolver.js";
import { matchPath } from "./route-tools.js";
import { detectFrameworks } from "../utils/framework-detect.js";
import type { MiddlewareEntry, HonoRoute } from "../parser/extractors/hono-model.js";

export interface MiddlewareChainOptions {
  /** Filter to a specific middleware scope literal (e.g. "/posts/*"). */
  scope?: string;
  /** Return only entries whose applied_when field is populated. */
  only_conditional?: boolean;
}

export interface MiddlewareChainResult {
  /** Present only in route mode — describes the route that was looked up. */
  route?: {
    method: string;
    path: string;
    file: string;
    line: number;
  };
  /** Present only in scope / app-wide modes — the middleware scope(s) walked. */
  scopes?: string[];
  chain: MiddlewareEntry[];
  total: number;
  error?: string;
}

export async function traceMiddlewareChain(
  repo: string,
  path?: string,
  method?: string,
  options?: MiddlewareChainOptions,
): Promise<MiddlewareChainResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    return { chain: [], total: 0, error: `Repository "${repo}" not found` };
  }

  const frameworks = detectFrameworks(index);
  if (!frameworks.has("hono")) {
    return { chain: [], total: 0, error: "No Hono app detected in this repo" };
  }

  const entryFile = resolveHonoEntryFile(index);
  if (!entryFile) {
    return { chain: [], total: 0, error: "No Hono app entry file found" };
  }

  let model;
  try {
    model = await honoCache.get(repo, entryFile, new HonoExtractor());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { chain: [], total: 0, error: `Failed to parse Hono app: ${msg}` };
  }

  const onlyConditional = options?.only_conditional === true;
  const scopeFilter = options?.scope;

  // ── Route mode ──────────────────────────────────────────────────────────
  if (path !== undefined) {
    const upperMethod = method?.toUpperCase();
    const matchingRoute = model.routes.find(
      (r: HonoRoute) =>
        matchPath(r.path, path) && (!upperMethod || r.method === upperMethod),
    );
    if (!matchingRoute) {
      return {
        chain: [],
        total: 0,
        error: `No route matching ${method ?? "ANY"} ${path}`,
      };
    }
    const entries: MiddlewareEntry[] = [];
    for (const mc of model.middleware_chains) {
      const pattern = compileScopePattern(mc.scope_pattern);
      if (pattern.test(matchingRoute.path)) {
        entries.push(...mc.entries);
      }
    }
    entries.sort((a, b) => a.order - b.order);
    const filtered = onlyConditional
      ? entries.filter((e) => e.applied_when !== undefined)
      : entries;
    return {
      route: {
        method: matchingRoute.method,
        path: matchingRoute.path,
        file: matchingRoute.file,
        line: matchingRoute.line,
      },
      chain: filtered,
      total: filtered.length,
    };
  }

  // ── Scope mode ──────────────────────────────────────────────────────────
  if (scopeFilter !== undefined) {
    const chains = model.middleware_chains.filter(
      (mc) => mc.scope === scopeFilter,
    );
    const entries = chains.flatMap((mc) => mc.entries);
    entries.sort((a, b) => a.order - b.order);
    const filtered = onlyConditional
      ? entries.filter((e) => e.applied_when !== undefined)
      : entries;
    return {
      scopes: chains.map((mc) => mc.scope),
      chain: filtered,
      total: filtered.length,
    };
  }

  // ── App-wide mode ───────────────────────────────────────────────────────
  const allEntries: MiddlewareEntry[] = [];
  const allScopes: string[] = [];
  for (const mc of model.middleware_chains) {
    allScopes.push(mc.scope);
    allEntries.push(...mc.entries);
  }
  allEntries.sort((a, b) => a.order - b.order);
  const filtered = onlyConditional
    ? allEntries.filter((e) => e.applied_when !== undefined)
    : allEntries;
  return {
    scopes: allScopes,
    chain: filtered,
    total: filtered.length,
  };
}

function compileScopePattern(pattern: string): RegExp {
  // Simple glob→regex: * matches anything (non-greedy-ish for path segments)
  // Handle bare "*" as "match anything"
  if (pattern === "*") return /^.*$/;
  // Escape regex metachars EXCEPT *, then replace * with .*
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regexStr = escaped.replace(/\*/g, ".*");
  return new RegExp(`^${regexStr}$`);
}
