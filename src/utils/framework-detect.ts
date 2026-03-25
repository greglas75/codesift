import type { CodeIndex } from "../types.js";

export type Framework = "react" | "nestjs" | "nextjs" | "express" | "test";

const FRAMEWORK_ENTRY_POINTS: Record<Framework, RegExp[]> = {
  react: [/^use[A-Z]/],
  nestjs: [
    /^(onModuleInit|onModuleDestroy|onApplicationBootstrap|onApplicationShutdown)$/,
    /^(canActivate|intercept|transform|catch|use)$/,
  ],
  nextjs: [
    /^(getServerSideProps|getStaticProps|getStaticPaths|generateMetadata|generateStaticParams)$/,
    /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/,
    /^(middleware|default)$/,
  ],
  express: [/^(get|post|put|delete|patch|use|all|param)$/],
  test: [/^(describe|it|test|beforeEach|afterEach|beforeAll|afterAll)$/],
};

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

export function isFrameworkEntryPoint(symbolName: string, frameworks: Set<Framework>): boolean {
  for (const fw of frameworks) {
    const patterns = FRAMEWORK_ENTRY_POINTS[fw];
    if (patterns?.some((p) => p.test(symbolName))) return true;
  }
  return false;
}
