/**
 * Astro file-based routing: src/pages/ → routes.
 * Exports findAstroHandlers (for traceRoute) and astroRouteMap (tool handler).
 */
import type { CodeSymbol, FileEntry, RouteFramework } from "../types.js";
import { matchPath } from "./route-shared.js";
import { findRepoSymbolsInFiles, getIndexSummary } from "./index-tools.js";

export interface AstroRouteHandler {
  symbol: Omit<CodeSymbol, "source" | "tokens">;
  file: string;
  method?: string;
  framework: RouteFramework;
}

interface AstroRouteEntry {
  path: string;
  file: string;
  type: "page" | "endpoint";
  rendering: "static" | "server";
  dynamic_params: string[];
  has_getStaticPaths: boolean;
  methods?: string[] | undefined;
  layout?: string | undefined;
}

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] as const;
const PAGES_RE = /^src\/pages\//;
const EXT_RE = /\.(astro|ts|js)$/;

/** Convert src/pages/blog/[slug].astro → /blog/:slug */
export function fileToRoute(filePath: string): string {
  let r = filePath.replace(PAGES_RE, "").replace(EXT_RE, "");
  r = r.replace(/\/index$/, "").replace(/^index$/, "");
  r = r.replace(/\[\.\.\.([^\]]+)\]/g, "*$1").replace(/\[([^\]]+)\]/g, ":$1");
  return "/" + r;
}

function extractDynamicParams(route: string): string[] {
  const params: string[] = [];
  for (const seg of route.split("/")) {
    if (seg.startsWith(":")) params.push(seg.slice(1));
    else if (seg.startsWith("*")) params.push(seg.slice(1));
  }
  return params;
}

function routeSortKey(route: string): number {
  return route.includes("*") ? 2 : route.includes(":") ? 1 : 0;
}

function stripSym(sym: CodeSymbol): Omit<CodeSymbol, "source" | "tokens"> {
  const { source: _, tokens: _t, ...rest } = sym;
  return rest;
}

function placeholder(file: string, name: string): Omit<CodeSymbol, "source" | "tokens"> {
  return { id: `${file}:${name}`, repo: "", name, kind: "function", file, start_line: 1, end_line: 1 };
}

/**
 * What route building reads: the file list, and the symbols of the PAGE files under src/pages/ —
 * every symbol lookup below is `s.file === <page file>`, so symbols elsewhere in the repository are
 * never consulted. A full `CodeIndex` satisfies this, and so does a summary paired with exactly the
 * page files' symbols (`loadAstroRouteIndex`), which is what lets astro_route_map and astro_audit
 * stop materialising every symbol in the repo to list a handful of pages (ADR-004 stage 2).
 */
export interface AstroRouteIndex {
  files: ReadonlyArray<Pick<FileEntry, "path">>;
  symbols: ReadonlyArray<Pick<CodeSymbol, "file" | "name">>;
}

/** A page file under src/pages/ — the only files route building reads symbols for. */
export function isAstroPageFile(path: string): boolean {
  return isPageFile(path);
}

function isPageFile(path: string): boolean {
  return PAGES_RE.test(path) && EXT_RE.test(path);
}

/**
 * The route index from a summary: its file list, plus the symbols of the page files, fetched in ONE
 * `file IN (…)` read rather than one awaited lookup per page (each of which also re-resolved the
 * repo — an N+1 on exactly the many-pages case this tool serves). Source is not requested — route
 * building reads only names. Freshness was already settled by the summary read.
 *
 * `buildRouteEntries` filters symbols per page file, and within a file the rows keep their index
 * order, so every `filter`/`find`/`some` there sees the same sequence it saw over the full index.
 */
export async function loadAstroRouteIndex(
  repo: string,
  files: readonly FileEntry[],
): Promise<AstroRouteIndex> {
  const pages = files.filter((file) => isPageFile(file.path)).map((file) => file.path);
  const symbols = await findRepoSymbolsInFiles(repo, pages, { withSource: false, skipFreshness: true });
  return { files, symbols };
}

/** Build all routes from an Astro project index. */
export function buildRouteEntries(index: AstroRouteIndex): { routes: AstroRouteEntry[]; warnings: string[] } {
  const routes: AstroRouteEntry[] = [];
  const warnings: string[] = [];
  const pageFiles = index.files.filter((f) => isPageFile(f.path));

  for (const file of pageFiles) {
    const routePath = fileToRoute(file.path);
    const isAstro = file.path.endsWith(".astro");
    const syms = index.symbols.filter((s) => s.file === file.path);
    const type: "page" | "endpoint" = isAstro ? "page" : "endpoint";
    const methods = isAstro ? undefined
      : syms.filter((s) => HTTP_METHODS.includes(s.name as typeof HTTP_METHODS[number])).map((s) => s.name);
    const has_getStaticPaths = syms.some((s) => s.name === "getStaticPaths");
    const hasPrerender = syms.some((s) => s.name === "prerender");
    const dynamicParams = extractDynamicParams(routePath);
    const isDynamic = dynamicParams.length > 0;
    const rendering: "static" | "server" = isDynamic && !has_getStaticPaths && !hasPrerender ? "server" : "static";

    if (isDynamic && !has_getStaticPaths && isAstro) {
      warnings.push(`Dynamic route "${routePath}" (${file.path}) is missing getStaticPaths — will be server-rendered`);
    }

    const layoutSym = syms.find((s) => s.name === "Layout" || s.name === "BaseLayout");
    routes.push({
      path: routePath, file: file.path, type, rendering,
      dynamic_params: dynamicParams, has_getStaticPaths,
      methods: methods && methods.length > 0 ? methods : undefined,
      layout: layoutSym?.name,
    });
  }

  routes.sort((a, b) => routeSortKey(a.path) - routeSortKey(b.path));

  // Detect conflicts: dynamic + rest at same prefix
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const a = routes[i]!, b = routes[j]!;
      const aDir = a.path.split("/").slice(0, -1).join("/");
      const bDir = b.path.split("/").slice(0, -1).join("/");
      if (aDir === bDir && a.path.includes(":") && b.path.includes("*")) {
        warnings.push(`Potential route conflict: "${a.path}" and "${b.path}" overlap at "${aDir || "/"}"`);
      }
    }
  }
  return { routes, warnings };
}

/** Find Astro route handlers matching a search path (for traceRoute dispatch). */
export function findAstroHandlers(
  index: { files: AstroRouteIndex["files"]; symbols: ReadonlyArray<CodeSymbol> },
  searchPath: string,
): AstroRouteHandler[] {
  const handlers: AstroRouteHandler[] = [];
  const { routes } = buildRouteEntries(index);

  for (const route of routes) {
    if (!matchPath(route.path, searchPath)) continue;
    const syms = index.symbols.filter((s) => s.file === route.file);

    if (route.type === "endpoint" && route.methods) {
      for (const method of route.methods) {
        const sym = syms.find((s) => s.name === method);
        handlers.push({ symbol: sym ? stripSym(sym) : placeholder(route.file, method), file: route.file, method, framework: "astro" });
      }
    } else {
      const sym = syms[0];
      handlers.push({ symbol: sym ? stripSym(sym) : placeholder(route.file, "page"), file: route.file, framework: "astro" });
    }
  }
  return handlers;
}

/** The astro_route_map MCP tool handler. */
export async function astroRouteMap(args: {
  repo?: string;
  include_endpoints?: boolean;
  output_format?: "json" | "tree" | "table";
}): Promise<{
  routes: AstroRouteEntry[];
  warnings: string[];
  summary: { total_routes: number; static_pages: number; server_pages: number; api_endpoints: number; dynamic_routes: number };
  virtual_routes_disclaimer: string[];
}> {
  const repo = args.repo ?? "";
  const summary = await getIndexSummary(repo);
  if (!summary) throw new Error("Repository not found");

  const { routes: allRoutes, warnings } = buildRouteEntries(await loadAstroRouteIndex(repo, summary.files));
  const routes = args.include_endpoints === false ? allRoutes.filter((r) => r.type === "page") : allRoutes;

  return {
    routes,
    warnings,
    summary: {
      total_routes: routes.length,
      static_pages: routes.filter((r) => r.type === "page" && r.rendering === "static").length,
      server_pages: routes.filter((r) => r.type === "page" && r.rendering === "server").length,
      api_endpoints: routes.filter((r) => r.type === "endpoint").length,
      dynamic_routes: routes.filter((r) => r.dynamic_params.length > 0).length,
    },
    virtual_routes_disclaimer: [
      "Virtual/redirect routes defined in astro.config are not detected.",
      "Middleware rewrites are not reflected in this map.",
    ],
  };
}
