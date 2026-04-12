/**
 * Next.js route map: enumerate all route files (App Router + Pages Router),
 * classify rendering strategy from route segment config, and detect hybrid
 * conflicts where the same URL is served by both routers.
 *
 * This file is the orchestrator. AST reader helpers (`readRouteSegmentConfig`,
 * `classifyRendering`, `parseRouteFile`) live in `nextjs-route-readers.ts` and
 * are re-exported from here for backward compatibility.
 */

import { relative, join } from "node:path";
import { discoverWorkspaces, traceMiddleware } from "../utils/nextjs.js";
import { cachedWalkDirectory as walkDirectory } from "../utils/nextjs-audit-cache.js";
import { getCodeIndex } from "./index-tools.js";
import { parseRouteFile } from "./nextjs-route-readers.js";
import type { NextjsRouteEntry, NextjsRouteConflict } from "./nextjs-route-readers.js";

// Re-export reader APIs so existing consumers continue to import from this file.
export {
  readRouteSegmentConfig,
  classifyRendering,
  parseRouteFile,
} from "./nextjs-route-readers.js";
export type {
  RenderingStrategy,
  RouteEntryType,
  RouteSegmentConfig,
  NextjsRouteEntry,
  NextjsRouteConflict,
  PagesRouterSignals,
} from "./nextjs-route-readers.js";

// ---------------------------------------------------------------------------
// Orchestrator-specific types
// ---------------------------------------------------------------------------

export interface NextjsRouteMapResult {
  routes: NextjsRouteEntry[];
  conflicts: NextjsRouteConflict[];
  middleware: { file: string; matchers: string[] } | null;
  workspaces_scanned: string[];
  scan_errors: string[];
  truncated: boolean;
  truncated_at?: number;
}

export interface NextjsRouteMapOptions {
  workspace?: string | undefined;
  router?: "app" | "pages" | "both" | undefined;
  include_metadata?: boolean | undefined;
  max_routes?: number | undefined;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const APP_CONVENTION_RE = /^(page|layout|loading|error|not-found|global-error|default|template|route)\.[jt]sx?$/;
const ROUTE_EXTS = new Set([".tsx", ".jsx", ".ts", ".js"]);
const DEFAULT_MAX_ROUTES = 1000;
const ROUTE_PARSE_CONCURRENCY = 10;

/** Whether a file in `app/` is a canonical convention route file. */
function isAppConventionFile(name: string): boolean {
  return APP_CONVENTION_RE.test(name);
}

/**
 * Enumerate all Next.js routes (App + Pages Router) with rendering strategy
 * classification and hybrid conflict detection.
 */
export async function nextjsRouteMap(
  repo: string,
  options?: NextjsRouteMapOptions,
): Promise<NextjsRouteMapResult> {
  if (process.env.CODESIFT_DISABLE_TOOLS?.includes("nextjs_route_map")) {
    throw new Error("nextjs_route_map is disabled via CODESIFT_DISABLE_TOOLS");
  }

  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository not found: ${repo}. Run index_folder first.`);
  }
  const projectRoot = index.root;

  // Resolve workspaces
  let workspaceRoots: string[];
  if (options?.workspace) {
    workspaceRoots = [join(projectRoot, options.workspace)];
  } else {
    const discovered = await discoverWorkspaces(projectRoot);
    workspaceRoots = discovered.length > 0
      ? discovered.map((w) => w.root)
      : [projectRoot];
  }

  const routerFilter = options?.router ?? "both";
  const maxRoutes = options?.max_routes ?? DEFAULT_MAX_ROUTES;
  const routes: NextjsRouteEntry[] = [];
  const scan_errors: string[] = [];
  const workspaces_scanned: string[] = [];
  let truncated = false;
  let truncated_at: number | undefined;

  // Middleware: use the first workspace's middleware.ts (single-app case).
  // traceMiddleware accepts a URL path for matching — we pass "/" as a probe
  // so we can still return the file + matchers fields.
  let middleware: NextjsRouteMapResult["middleware"] = null;

  for (const wsRoot of workspaceRoots) {
    workspaces_scanned.push(wsRoot);

    // Collect candidate files
    const appCandidates: string[] = [];
    const pagesCandidates: string[] = [];

    if (routerFilter === "app" || routerFilter === "both") {
      for (const appDir of ["app", "src/app"]) {
        try {
          const walked = await walkDirectory(join(wsRoot, appDir), {
            followSymlinks: true,
            fileFilter: (ext, name) => {
              if (!ROUTE_EXTS.has(ext)) return false;
              return name ? isAppConventionFile(name) : false;
            },
          });
          appCandidates.push(...walked);
        } catch (err) {
          scan_errors.push(`${appDir}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (routerFilter === "pages" || routerFilter === "both") {
      for (const pagesDir of ["pages", "src/pages"]) {
        try {
          const walked = await walkDirectory(join(wsRoot, pagesDir), {
            followSymlinks: true,
            fileFilter: (ext) => ROUTE_EXTS.has(ext),
          });
          pagesCandidates.push(...walked);
        } catch (err) {
          scan_errors.push(`${pagesDir}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    const wsMiddleware = await traceMiddleware(wsRoot, "/").catch(() => null);
    if (wsMiddleware && !middleware) {
      middleware = { file: wsMiddleware.file, matchers: wsMiddleware.matchers };
    }

    // Process each router's candidates. Apply the global max_routes cap.
    const workspaceFiles: Array<{ path: string; router: "app" | "pages" }> = [
      ...appCandidates.map((p) => ({ path: p, router: "app" as const })),
      ...pagesCandidates.map((p) => ({ path: p, router: "pages" as const })),
    ];

    for (let i = 0; i < workspaceFiles.length; i += ROUTE_PARSE_CONCURRENCY) {
      if (routes.length >= maxRoutes) {
        truncated = true;
        truncated_at = maxRoutes;
        break;
      }
      const chunk = workspaceFiles.slice(i, i + ROUTE_PARSE_CONCURRENCY);
      const entries = await Promise.all(
        chunk.map(async ({ path, router }) => {
          try {
            // Parse relative to workspace root so deriveUrlPath sees `app/…`
            const entry = await parseRouteFile(path, wsRoot, router);
            // Re-anchor file_path to the repo root for display
            entry.file_path = relative(projectRoot, path);
            // Fill middleware_applies per route
            if (wsMiddleware) {
              const perRoute = await traceMiddleware(wsRoot, entry.url_path).catch(() => null);
              entry.middleware_applies = perRoute?.applies ?? false;
            }
            return entry;
          } catch (err) {
            const rel = relative(projectRoot, path);
            scan_errors.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          }
        }),
      );
      for (const entry of entries) {
        if (entry === null) continue;
        if (routes.length >= maxRoutes) {
          truncated = true;
          truncated_at = maxRoutes;
          break;
        }
        routes.push(entry);
      }
    }
  }

  // Detect hybrid conflicts: same url_path appears in both routers
  const byPath = new Map<string, { app?: string; pages?: string }>();
  for (const route of routes) {
    const bucket = byPath.get(route.url_path) ?? {};
    if (route.router === "app" && !bucket.app) bucket.app = route.file_path;
    if (route.router === "pages" && !bucket.pages) bucket.pages = route.file_path;
    byPath.set(route.url_path, bucket);
  }
  const conflicts: NextjsRouteConflict[] = [];
  for (const [url_path, bucket] of byPath.entries()) {
    if (bucket.app && bucket.pages) {
      conflicts.push({ url_path, app: bucket.app, pages: bucket.pages });
    }
  }

  const result: NextjsRouteMapResult = {
    routes,
    conflicts,
    middleware,
    workspaces_scanned,
    scan_errors,
    truncated,
  };
  if (truncated_at !== undefined) result.truncated_at = truncated_at;
  return result;
}
