/**
 * Next.js middleware coverage analyzer (T8).
 *
 * Cross-references the route map (via `nextjsRouteMap`) with the middleware
 * matcher config (via existing `traceMiddleware`) to compute coverage:
 * which routes are protected and which are unprotected. Flags admin routes
 * without middleware as high-severity warnings.
 */

import { traceMiddleware } from "../utils/nextjs.js";
import { getCodeIndex } from "./index-tools.js";
import { nextjsRouteMap } from "./nextjs-route-tools.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CoverageMap {
  protected: string[];
  unprotected: string[];
  total_routes: number;
}

export interface SecurityWarning {
  severity: "high" | "medium" | "low";
  route: string;
  reason: string;
}

export interface CoverageEntry {
  url_path: string;
  protected: boolean;
}

export interface NextjsMiddlewareCoverageResult {
  coverage: CoverageMap;
  warnings: SecurityWarning[];
  total: number;
  workspaces_scanned: string[];
  limitations: string[];
}

export interface NextjsMiddlewareCoverageOptions {
  workspace?: string | undefined;
  flag_admin_prefix?: string | string[] | undefined;
}

// ---------------------------------------------------------------------------
// Pure helpers (Tasks 41, 42)
// ---------------------------------------------------------------------------

const DEFAULT_ADMIN_PREFIXES = ["/admin", "/dashboard"];

export async function calculateCoverage(
  routes: Array<{ url_path: string }>,
  repoRoot: string,
): Promise<CoverageMap> {
  const protectedRoutes: string[] = [];
  const unprotectedRoutes: string[] = [];
  for (const r of routes) {
    const trace = await traceMiddleware(repoRoot, r.url_path);
    if (trace && trace.applies) {
      protectedRoutes.push(r.url_path);
    } else {
      unprotectedRoutes.push(r.url_path);
    }
  }
  return {
    protected: protectedRoutes,
    unprotected: unprotectedRoutes,
    total_routes: routes.length,
  };
}

export function flagSecurityWarnings(
  coverage: CoverageMap,
  options?: { flag_admin_prefix?: string | string[] },
): SecurityWarning[] {
  const prefixes = options?.flag_admin_prefix
    ? Array.isArray(options.flag_admin_prefix)
      ? options.flag_admin_prefix
      : [options.flag_admin_prefix]
    : DEFAULT_ADMIN_PREFIXES;

  const warnings: SecurityWarning[] = [];
  for (const route of coverage.unprotected) {
    for (const prefix of prefixes) {
      if (route === prefix || route.startsWith(`${prefix}/`)) {
        warnings.push({
          severity: "high",
          route,
          reason: `admin route without middleware (${prefix} prefix)`,
        });
        break;
      }
    }
  }
  // Sort by severity desc (high first)
  const order = { high: 3, medium: 2, low: 1 };
  warnings.sort((a, b) => order[b.severity] - order[a.severity]);
  return warnings;
}

// ---------------------------------------------------------------------------
// Orchestrator (Task 43a)
// ---------------------------------------------------------------------------

export async function nextjsMiddlewareCoverage(
  repo: string,
  options?: NextjsMiddlewareCoverageOptions,
): Promise<NextjsMiddlewareCoverageResult> {
  if (process.env.CODESIFT_DISABLE_TOOLS?.includes("nextjs_middleware_coverage")) {
    throw new Error("nextjs_middleware_coverage is disabled via CODESIFT_DISABLE_TOOLS");
  }

  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository not found: ${repo}. Run index_folder first.`);
  }
  const projectRoot = index.root;

  const routeMap = await nextjsRouteMap(
    repo,
    options?.workspace ? { workspace: options.workspace } : undefined,
  );
  // Only consider page/route entries for coverage
  const pageRoutes = routeMap.routes.filter((r) => r.type === "page" || r.type === "route");

  const coverage = await calculateCoverage(pageRoutes, projectRoot);
  const warnings = flagSecurityWarnings(coverage, {
    ...(options?.flag_admin_prefix !== undefined ? { flag_admin_prefix: options.flag_admin_prefix } : {}),
  });

  return {
    coverage,
    warnings,
    total: coverage.total_routes,
    workspaces_scanned: routeMap.workspaces_scanned,
    limitations: [
      "fail-open behavior on computed matcher (treats as protected)",
      "default admin prefixes: /admin, /dashboard (override with flag_admin_prefix)",
    ],
  };
}
