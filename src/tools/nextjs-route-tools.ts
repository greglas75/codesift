/**
 * Next.js route map: enumerate all route files (App Router + Pages Router),
 * classify rendering strategy from route segment config, and detect hybrid
 * conflicts where the same URL is served by both routers.
 */

import { readFile } from "node:fs/promises";
import { relative, basename, join } from "node:path";
import type Parser from "web-tree-sitter";
import { parseFile } from "../parser/parser-manager.js";
import {
  computeLayoutChain,
  deriveUrlPath,
  discoverWorkspaces,
  extractFetchCalls,
  scanDirective,
  traceMiddleware,
} from "../utils/nextjs.js";
import { walkDirectory } from "../utils/walk.js";
import { getCodeIndex } from "./index-tools.js";

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
  /** Free-text explanation of *why* a route is SSR. Set only when rendering === "ssr". */
  rendering_reason?: string;
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
// Route segment config reader (AST initializer extraction)
// ---------------------------------------------------------------------------

const KNOWN_CONFIG_NAMES = new Set([
  "dynamic",
  "revalidate",
  "runtime",
  "fetchCache",
  "preferredRegion",
  "maxDuration",
  "dynamicParams",
]);

const DYNAMIC_VALUES = new Set(["auto", "force-dynamic", "force-static", "error"]);
const RUNTIME_VALUES = new Set(["nodejs", "edge"]);

/**
 * Read Next.js route segment config exports from an AST.
 *
 * Recognizes:
 *   export const dynamic = "force-dynamic"
 *   export const revalidate = 60 | false
 *   export const runtime = "edge"
 *   export async function generateStaticParams() {...}
 *
 * Non-literal initializers (Identifier, BinaryExpression, etc.) set a
 * `_non_literal` flag and leave the corresponding value `undefined`.
 *
 * @internal exported for unit testing
 */
export function readRouteSegmentConfig(
  tree: Parser.Tree,
  _source: string,
): RouteSegmentConfig {
  const config: RouteSegmentConfig = { has_generate_static_params: false };
  const root = tree.rootNode;

  for (const exportNode of root.descendantsOfType("export_statement")) {
    // `export const X = Y` → lexical_declaration > variable_declarator
    for (const decl of exportNode.descendantsOfType("variable_declarator")) {
      const nameNode = decl.childForFieldName("name") ?? decl.namedChild(0);
      if (nameNode?.type !== "identifier") continue;
      const name = nameNode.text;
      if (!KNOWN_CONFIG_NAMES.has(name)) continue;

      const value = decl.childForFieldName("value") ?? decl.namedChild(1);
      if (!value) continue;

      readConfigValue(config, name, value);
    }

    // `export async function generateStaticParams() {...}` / `export function ...`
    for (const fn of exportNode.descendantsOfType("function_declaration")) {
      const nameNode = fn.childForFieldName("name") ?? fn.namedChild(0);
      if (nameNode?.type === "identifier" && nameNode.text === "generateStaticParams") {
        config.has_generate_static_params = true;
      }
    }
  }

  return config;
}

function readConfigValue(
  config: RouteSegmentConfig,
  name: string,
  value: Parser.SyntaxNode,
): void {
  // String literal
  if (value.type === "string") {
    const frag = value.namedChild(0);
    const text = frag?.type === "string_fragment" ? frag.text : value.text.slice(1, -1);
    if (name === "dynamic" && DYNAMIC_VALUES.has(text)) {
      config.dynamic = text as "auto" | "force-dynamic" | "force-static" | "error";
    } else if (name === "runtime" && RUNTIME_VALUES.has(text)) {
      config.runtime = text as "nodejs" | "edge";
    }
    return;
  }

  // Number literal
  if (value.type === "number") {
    const num = parseFloat(value.text);
    if (!Number.isNaN(num) && name === "revalidate") {
      config.revalidate = num;
    }
    return;
  }

  // Boolean false literal
  if (value.type === "false") {
    if (name === "revalidate") config.revalidate = false;
    return;
  }
  if (value.type === "true") {
    // `revalidate = true` is not a valid Next.js value — ignore
    return;
  }

  // Any other initializer (Identifier, BinaryExpression, CallExpression, ...)
  // is "non-literal". Flag it so callers know the value is unknowable at
  // static-analysis time.
  if (name === "dynamic") config.dynamic_non_literal = true;
  else if (name === "revalidate") config.revalidate_non_literal = true;
  else if (name === "runtime") config.runtime_non_literal = true;
}

// ---------------------------------------------------------------------------
// Rendering strategy classification
// ---------------------------------------------------------------------------

export interface PagesRouterSignals {
  hasGetServerSideProps?: boolean;
  hasGetStaticProps?: boolean;
  hasRevalidateInReturn?: boolean;
}

/**
 * Map a route segment config (+ optional Pages Router signals) to a
 * rendering strategy.
 *
 * Priority (App Router): runtime=edge > force-dynamic > force-static >
 * revalidate > generateStaticParams > default (static).
 *
 * Pages Router: getServerSideProps → ssr; getStaticProps + revalidate → isr;
 * getStaticProps → static; otherwise unknown.
 *
 * @internal exported for unit testing
 */
export function classifyRendering(
  config: RouteSegmentConfig,
  router: "app" | "pages",
  pagesSignals?: PagesRouterSignals,
): RenderingStrategy {
  if (router === "pages") {
    if (pagesSignals?.hasGetServerSideProps) return "ssr";
    if (pagesSignals?.hasGetStaticProps) {
      return pagesSignals.hasRevalidateInReturn ? "isr" : "static";
    }
    return "unknown";
  }

  // App Router priority
  if (config.runtime === "edge") return "edge";
  if (config.dynamic === "force-dynamic") return "ssr";
  if (config.dynamic === "force-static") return "static";
  if (typeof config.revalidate === "number" && config.revalidate > 0) return "isr";
  if (config.has_generate_static_params) return "static";

  // Next.js 15 default: static
  return "static";
}

// ---------------------------------------------------------------------------
// parseRouteFile — process a single route file into a NextjsRouteEntry
// ---------------------------------------------------------------------------

const HTTP_METHODS = new Set([
  "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS",
]);

const APP_CONVENTION_TYPES: Record<string, RouteEntryType> = {
  page: "page",
  route: "route",
  layout: "layout",
  loading: "loading",
  error: "error",
  "not-found": "not-found",
  "global-error": "global-error",
  default: "default",
  template: "template",
};

/** Derive a route file's `type` field from its path. */
function deriveRouteType(filePath: string, router: "app" | "pages"): RouteEntryType {
  const name = basename(filePath).replace(/\.[jt]sx?$/, "");

  if (router === "pages") {
    if (name === "_app") return "app";
    if (name === "_document") return "document";
    if (name === "_error") return "error_page";
    // default for pages/ files: treat api/* as route, otherwise page
    return filePath.includes("/api/") ? "route" : "page";
  }

  // App Router
  if (filePath.includes("/@")) return "parallel";
  if (/\/\(\.{1,3}\)/.test(filePath)) return "intercepting";
  return APP_CONVENTION_TYPES[name] ?? "page";
}

/** Detect Pages Router data-fetching signals via exported function/const names. */
function detectPagesRouterSignals(tree: Parser.Tree): PagesRouterSignals {
  const signals: PagesRouterSignals = {};
  for (const exportNode of tree.rootNode.descendantsOfType("export_statement")) {
    for (const fn of exportNode.descendantsOfType("function_declaration")) {
      const name = (fn.childForFieldName("name") ?? fn.namedChild(0))?.text;
      if (name === "getServerSideProps") signals.hasGetServerSideProps = true;
      if (name === "getStaticProps") signals.hasGetStaticProps = true;
    }
    for (const decl of exportNode.descendantsOfType("variable_declarator")) {
      const name = (decl.childForFieldName("name") ?? decl.namedChild(0))?.text;
      if (name === "getServerSideProps") signals.hasGetServerSideProps = true;
      if (name === "getStaticProps") signals.hasGetStaticProps = true;
    }
  }
  return signals;
}

/** Detect `export const metadata = {...}` or `export function generateMetadata`. */
function detectMetadataExport(tree: Parser.Tree): boolean {
  for (const exportNode of tree.rootNode.descendantsOfType("export_statement")) {
    for (const decl of exportNode.descendantsOfType("variable_declarator")) {
      const name = (decl.childForFieldName("name") ?? decl.namedChild(0))?.text;
      if (name === "metadata") return true;
    }
    for (const fn of exportNode.descendantsOfType("function_declaration")) {
      const name = (fn.childForFieldName("name") ?? fn.namedChild(0))?.text;
      if (name === "generateMetadata") return true;
    }
  }
  return false;
}

/** Collect HTTP method names from top-level exports of a route.ts file. */
function extractHttpMethods(tree: Parser.Tree): string[] {
  const methods = new Set<string>();
  for (const exportNode of tree.rootNode.descendantsOfType("export_statement")) {
    for (const fn of exportNode.descendantsOfType("function_declaration")) {
      const name = (fn.childForFieldName("name") ?? fn.namedChild(0))?.text;
      if (name && HTTP_METHODS.has(name)) methods.add(name);
    }
    for (const decl of exportNode.descendantsOfType("variable_declarator")) {
      const name = (decl.childForFieldName("name") ?? decl.namedChild(0))?.text;
      if (name && HTTP_METHODS.has(name)) methods.add(name);
    }
  }
  return [...methods];
}

/**
 * Process a single route file into a `NextjsRouteEntry`.
 *
 * @internal exported for unit testing
 */
export async function parseRouteFile(
  filePath: string,
  repoRoot: string,
  router: "app" | "pages",
): Promise<NextjsRouteEntry> {
  const relPath = relative(repoRoot, filePath);
  const type = deriveRouteType(relPath, router);
  const url_path = deriveUrlPath(relPath, router);

  const source = await readFile(filePath, "utf8");
  const tree = await parseFile(filePath, source);

  if (!tree) {
    return {
      url_path,
      file_path: relPath,
      router,
      type,
      rendering: "unknown",
      config: { has_generate_static_params: false },
      has_metadata: false,
      layout_chain: [],
      middleware_applies: false,
      is_client_component: false,
    };
  }

  const config = readRouteSegmentConfig(tree, source);
  const has_metadata = detectMetadataExport(tree);

  let methods: string[] | undefined;
  if (type === "route") {
    methods = extractHttpMethods(tree);
  }

  const pagesSignals = router === "pages" ? detectPagesRouterSignals(tree) : undefined;
  let rendering = classifyRendering(config, router, pagesSignals);

  // Q2 — detect runtime SSR triggers (cookies/headers/fetch no-store) and
  // upgrade `static` → `ssr` when present, capturing a human-readable reason.
  let rendering_reason: string | undefined;
  if (router === "app") {
    if (rendering === "ssr") {
      // Already SSR — explain why.
      if (config.dynamic === "force-dynamic") {
        rendering_reason = "dynamic='force-dynamic' config export";
      } else {
        const fetches = extractFetchCalls(tree, source);
        const noStore = fetches.find(
          (f) => f.callee === "fetch" && f.cacheOption === "no-store",
        );
        if (noStore) {
          rendering_reason = `fetch with cache:'no-store' at line ${noStore.line}`;
        } else {
          const dynamicCall = fetches.find(
            (f) => f.callee === "cookies" || f.callee === "headers",
          );
          if (dynamicCall) {
            rendering_reason = `${dynamicCall.callee}() called at line ${dynamicCall.line}`;
          } else {
            rendering_reason = "unknown SSR trigger";
          }
        }
      }
    } else if (rendering === "static") {
      // Maybe upgrade: presence of cookies/headers/fetch no-store implies SSR.
      const fetches = extractFetchCalls(tree, source);
      const noStore = fetches.find(
        (f) => f.callee === "fetch" && f.cacheOption === "no-store",
      );
      if (noStore) {
        rendering = "ssr";
        rendering_reason = `fetch with cache:'no-store' at line ${noStore.line}`;
      } else {
        const dynamicCall = fetches.find(
          (f) => f.callee === "cookies" || f.callee === "headers",
        );
        if (dynamicCall) {
          rendering = "ssr";
          rendering_reason = `${dynamicCall.callee}() called at line ${dynamicCall.line}`;
        }
      }
    }
  }

  const directive = await scanDirective(filePath);
  const is_client_component = directive === "use client";

  const layout_chain = router === "app"
    ? await computeLayoutChain(relPath, repoRoot)
    : [];

  const entry: NextjsRouteEntry = {
    url_path,
    file_path: relPath,
    router,
    type,
    rendering,
    config,
    has_metadata,
    layout_chain,
    middleware_applies: false, // filled in by orchestrator (Task 30)
    is_client_component,
  };
  if (methods !== undefined) {
    entry.methods = methods;
  }
  if (rendering_reason !== undefined) {
    entry.rendering_reason = rendering_reason;
  }
  return entry;
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
