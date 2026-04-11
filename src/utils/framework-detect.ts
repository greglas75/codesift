import type { CodeIndex, CodeSymbol } from "../types.js";

export type Framework = "react" | "nestjs" | "nextjs" | "express" | "test";

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
const NESTJS_LIFECYCLE = /^(onModuleInit|onModuleDestroy|onApplicationBootstrap|onApplicationShutdown|beforeApplicationShutdown|handleCron|handleInterval|handleTimeout|handleEvent)$/;
const NESTJS_ENTRY_FILE = /\.(controller|resolver|gateway|guard|interceptor|pipe|filter)\.[jt]sx?$/;
const NESTJS_MAIN_FILE = /(^|\/)main\.[jt]sx?$/;

export function detectFrameworks(index: CodeIndex): Set<Framework> {
  const frameworks = new Set<Framework>();
  // Sample first 200 symbols' source for framework indicators
  const sources = index.symbols.slice(0, 200).map((s) => s.source ?? "").join("\n");

  if (sources.includes("@nestjs/") || sources.includes("NestFactory")) frameworks.add("nestjs");
  if (sources.includes("from 'react'") || sources.includes('from "react"') || sources.includes("useState")) frameworks.add("react");
  if (index.files.some((f) => f.path.includes("app/api/") && f.path.endsWith("route.ts"))) frameworks.add("nextjs");
  if (sources.includes("express()") || sources.includes("Router()")) frameworks.add("express");
  frameworks.add("test"); // always include test patterns

  return frameworks;
}

export function isFrameworkEntryPoint(
  symbol: Pick<CodeSymbol, "name" | "file">,
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
    if (NESTJS_ENTRY_FILE.test(symbol.file)) return true;
    if (NESTJS_MAIN_FILE.test(symbol.file) && symbol.name === "bootstrap") return true;
  }

  return false;
}
