/**
 * Next.js route map: enumerate all route files (App Router + Pages Router),
 * classify rendering strategy from route segment config, and detect hybrid
 * conflicts where the same URL is served by both routers.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RenderingStrategy =
  | "static" // SSG
  | "ssr" // force-dynamic / getServerSideProps
  | "isr" // revalidate = N > 0
  | "edge" // runtime = "edge"
  | "client" // "use client" on page
  | "unknown";

export type RouteEntryType =
  | "page"
  | "route"
  | "layout"
  | "loading"
  | "error"
  | "not-found"
  | "global-error"
  | "default"
  | "template"
  | "parallel"
  | "intercepting"
  | "app"
  | "document"
  | "error_page";

export interface RouteSegmentConfig {
  dynamic?: "auto" | "force-dynamic" | "force-static" | "error";
  dynamic_non_literal?: boolean;
  revalidate?: number | false;
  revalidate_non_literal?: boolean;
  runtime?: "nodejs" | "edge";
  runtime_non_literal?: boolean;
  has_generate_static_params: boolean;
}

export interface NextjsRouteEntry {
  url_path: string;
  file_path: string;
  router: "app" | "pages";
  type: RouteEntryType;
  rendering: RenderingStrategy;
  config: RouteSegmentConfig;
  has_metadata: boolean;
  methods?: string[];
  layout_chain: string[];
  middleware_applies: boolean;
  is_client_component: boolean;
}

export interface NextjsRouteConflict {
  url_path: string;
  app: string;
  pages: string;
}

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
// Orchestrator stub (real impl in Task 30)
// ---------------------------------------------------------------------------

export async function nextjsRouteMap(
  _repo: string,
  _options?: NextjsRouteMapOptions,
): Promise<NextjsRouteMapResult> {
  throw new Error("nextjsRouteMap: not implemented");
}
