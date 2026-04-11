import type { CodeIndex, CodeSymbol } from "../types.js";

export type Framework = "react" | "nestjs" | "nextjs" | "express" | "astro" | "test";

const NEXT_ROUTE_FILE = /(^|\/)app\/.*\/route\.[jt]sx?$/;
const NEXT_APP_FILE = /(^|\/)app\/.+\.[jt]sx?$/;
const NEXT_PAGES_FILE = /(^|\/)pages\/.+\.[jt]sx?$/;
const NEXT_MIDDLEWARE_FILE = /(^|\/)middleware\.[jt]sx?$/;

const NEXT_ROUTE_METHODS = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/;
const NEXT_PAGES_DATA_FUNCTIONS = /^(getServerSideProps|getStaticProps|getStaticPaths)$/;
const NEXT_APP_METADATA_FUNCTIONS = /^(generateMetadata|generateStaticParams)$/;
/** Next.js config exports that are framework entry points (not dead code) */
const NEXT_CONFIG_EXPORTS = /^(metadata|viewport|dynamic|revalidate|runtime|preferredRegion|maxDuration|fetchCache|dynamicParams)$/;

/** NestJS lifecycle hooks + decorator-based entry points */
const NESTJS_LIFECYCLE = /^(onModuleInit|onModuleDestroy|onApplicationBootstrap|onApplicationShutdown|beforeApplicationShutdown)$/;
const NESTJS_CONTROLLER_FILE = /\.(controller|resolver|gateway)\.[jt]sx?$/;

/** Astro file-based routing — pages/ directory with .astro, .ts, or .js files */
const ASTRO_PAGES_FILE = /(^|\/)src\/pages\/.+\.(astro|[jt]sx?)$/;
/** Astro special exports that the framework consumes implicitly */
const ASTRO_ENTRY_SYMBOLS = /^(getStaticPaths|prerender|GET|POST|PUT|DELETE|PATCH)$/;

/** React/Next.js app router file conventions — these are route entry points */
const REACT_ROUTE_FILE = /(^|\/)(pages|app)\/.*\.(tsx|jsx)$/;
/** Special Next.js/Remix file names that are always entry points regardless of export name */
const REACT_SPECIAL_FILE = /(^|\/)(page|layout|loading|error|not-found|global-error|default|template|head)\.(tsx|jsx)$/;
/** Remix convention: routes/ directory with file-based routing */
const REMIX_ROUTE_FILE = /(^|\/)routes\/.*\.(tsx|jsx)$/;

/** Exported for testing — matches next.config.{js,mjs,cjs,ts} at root or src/ */
export const NEXT_CONFIG_FILE = /^(src\/)?next\.config\.[mc]?[jt]s$/;
/** Exported for testing — App Router convention files */
export const NEXT_APP_CONVENTION_FILE = /(^|\/)app\/(.*\/)?(page|layout|loading|error|not-found|global-error|default|template|route)\.[jt]sx?$/;

export function detectFrameworks(index: CodeIndex): Set<Framework> {
  const frameworks = new Set<Framework>();
  // Sample first 200 symbols' source for framework indicators
  const sources = index.symbols.slice(0, 200).map((s) => s.source ?? "").join("\n");

  if (sources.includes("@nestjs/") || sources.includes("NestFactory")) frameworks.add("nestjs");
  if (sources.includes("from 'react'") || sources.includes('from "react"') || sources.includes("useState")) frameworks.add("react");
  if (sources.includes("express()") || sources.includes("Router()")) frameworks.add("express");
  if (sources.includes("from 'astro'") || sources.includes('from "astro"') || sources.includes("from 'astro:") || sources.includes('from "astro:') || index.files.some((f) => f.path.endsWith(".astro"))) frameworks.add("astro");

  // Next.js detection: broadened to cover config file, pages/ dir, and App Router conventions
  const hasNextConfig = index.files.some((f) => NEXT_CONFIG_FILE.test(f.path));
  const hasPagesDir = index.files.some((f) => NEXT_PAGES_FILE.test(f.path) && /\.[jt]sx?$/.test(f.path));
  const hasAppConvention = index.files.some((f) => NEXT_APP_CONVENTION_FILE.test(f.path));
  if (hasNextConfig || hasPagesDir || hasAppConvention) {
    frameworks.add("nextjs");
  }

  frameworks.add("test"); // always include test patterns

  return frameworks;
}

export function isFrameworkEntryPoint(
  symbol: Pick<CodeSymbol, "name" | "file"> & { source?: string },
  frameworks: Set<Framework>,
): boolean {
  if (frameworks.has("nextjs")) {
    if (NEXT_ROUTE_FILE.test(symbol.file) && NEXT_ROUTE_METHODS.test(symbol.name)) return true;
    if (NEXT_MIDDLEWARE_FILE.test(symbol.file) && symbol.name === "middleware") return true;
    if (NEXT_PAGES_FILE.test(symbol.file) && NEXT_PAGES_DATA_FUNCTIONS.test(symbol.name)) return true;
    if (NEXT_APP_FILE.test(symbol.file) && NEXT_APP_METADATA_FUNCTIONS.test(symbol.name)) return true;
    if (NEXT_APP_FILE.test(symbol.file) && NEXT_CONFIG_EXPORTS.test(symbol.name)) return true;
  }

  if (frameworks.has("nestjs")) {
    if (NESTJS_LIFECYCLE.test(symbol.name)) return true;
    if (NESTJS_CONTROLLER_FILE.test(symbol.file)) return true;
  }

  if (frameworks.has("astro")) {
    if (ASTRO_PAGES_FILE.test(symbol.file)) return true;
    if (ASTRO_ENTRY_SYMBOLS.test(symbol.name)) return true;
  }

  // React route/layout components: any default export from a routed file
  // (pages/, app/, or routes/) is an entry point — the framework renders it
  // based on file path, not via explicit import. Without this, find_dead_code
  // flags them as unused.
  if (frameworks.has("react") || frameworks.has("nextjs")) {
    if (REACT_SPECIAL_FILE.test(symbol.file)) return true;
    if (REACT_ROUTE_FILE.test(symbol.file)) return true;
    if (REMIX_ROUTE_FILE.test(symbol.file)) return true;
  }

  // RSC boundary: "use client" / "use server" directive → framework entry point
  if (symbol.source && (frameworks.has("react") || frameworks.has("nextjs"))) {
    const head = symbol.source.slice(0, 200);
    if (/['"]use client['"]/.test(head) || /['"]use server['"]/.test(head)) return true;
  }

  return false;
}
