/**
 * Next.js route map: enumerate all route files (App Router + Pages Router),
 * classify rendering strategy from route segment config, and detect hybrid
 * conflicts where the same URL is served by both routers.
 */

import { readFile } from "node:fs/promises";
import { relative, basename } from "node:path";
import type Parser from "web-tree-sitter";
import { parseFile } from "../parser/parser-manager.js";
import {
  computeLayoutChain,
  deriveUrlPath,
  scanDirective,
} from "../utils/nextjs.js";

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
      config.dynamic = text as RouteSegmentConfig["dynamic"];
    } else if (name === "runtime" && RUNTIME_VALUES.has(text)) {
      config.runtime = text as RouteSegmentConfig["runtime"];
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
  const rendering = classifyRendering(config, router, pagesSignals);

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
  return entry;
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
