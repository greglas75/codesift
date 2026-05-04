/**
 * Smoke runner for `detectAutoLoadTools` — manual verification of the
 * universal stack-aware tool loading against real repos.
 *
 * Usage:
 *   npx tsx scripts/debug-autoload.ts <path1> [path2] ...
 *   npx tsx scripts/debug-autoload.ts ~/DEV/translation-qa ~/DEV/zuvo-landing
 *
 * For each path, prints the matched bundle tags and the resolved tool list.
 * Does NOT assert anything — eyeball the output against expected stack.
 */
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { detectAutoLoadTools } from "../src/register-tools.js";

const TS_BASELINE = new Set(["dependency_audit", "check_boundaries", "architecture_summary"]);
const MONOREPO = new Set(["check_boundaries", "architecture_summary"]);
const PRISMA = new Set(["analyze_prisma_schema", "migration_lint"]);
const REACT = new Set([
  "trace_component_tree", "analyze_hooks", "analyze_renders",
  "analyze_context_graph", "audit_compiler_readiness", "react_quickstart",
]);
const HONO = new Set([
  "trace_context_flow", "extract_api_contract", "trace_rpc_types",
  "audit_hono_security", "visualize_hono_routes", "analyze_inline_handler",
  "extract_response_types", "detect_hono_modules", "find_dead_hono_routes",
]);
const PHP = new Set([
  "resolve_php_namespace", "trace_php_event", "find_php_views",
  "resolve_php_service", "php_security_scan", "php_project_audit",
]);
const PYTHON = new Set([
  "get_model_graph", "get_test_fixtures", "find_framework_wiring", "run_ruff",
  "find_python_callers", "analyze_django_settings", "run_mypy", "run_pyright",
  "analyze_python_deps", "trace_fastapi_depends", "analyze_async_correctness",
  "get_pydantic_models", "python_audit", "parse_pyproject",
]);
const KOTLIN = new Set([
  "find_extension_functions", "analyze_sealed_hierarchy", "trace_hilt_graph",
  "trace_suspend_chain", "analyze_kmp_declarations", "trace_compose_tree",
  "analyze_compose_recomposition", "trace_room_schema",
  "extract_kotlin_serialization_contract", "trace_flow_chain",
]);

function detectStackTags(cwd: string, tools: string[]): string[] {
  const tags = new Set<string>();
  const set = new Set(tools);

  // File / dep heuristics for tag derivation (independent of bundle membership
  // so we still tag stacks like "astro" or "nextjs" whose tools live in
  // CORE_TOOL_NAMES, not in auto-load bundles).
  const has = (rel: string) => existsSync(`${cwd}/${rel}`);
  let pkgDeps: Record<string, string> = {};
  try {
    if (has("package.json")) {
      const pkg = JSON.parse(readFileSync(`${cwd}/package.json`, "utf-8"));
      pkgDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (has("tsconfig.json")) tags.add("ts");
      else tags.add("js");
      if (Array.isArray(pkg.workspaces) ||
          (pkg.workspaces && Array.isArray(pkg.workspaces.packages))) {
        tags.add("monorepo");
      }
    }
  } catch { /* ignore */ }

  if (has("pnpm-workspace.yaml") || has("lerna.json") ||
      has("nx.json") || has("turbo.json")) tags.add("monorepo");
  if (has("composer.json")) tags.add("php");
  if (has("pyproject.toml") || has("requirements.txt")) tags.add("python");
  if (has("build.gradle.kts") || has("settings.gradle.kts") ||
      has("build.gradle")) tags.add("kotlin");

  // Bundle-derived tags
  for (const t of tools) {
    if (REACT.has(t)) tags.add("react");
    if (HONO.has(t)) tags.add("hono");
    if (PRISMA.has(t)) tags.add("prisma");
  }

  // Dep-only frameworks (no dedicated bundle yet — astro, next, nestjs, etc.)
  if (pkgDeps["astro"]) tags.add("astro");
  if (pkgDeps["next"]) tags.add("nextjs");
  if (pkgDeps["@nestjs/core"]) tags.add("nestjs");
  if (pkgDeps["fastify"]) tags.add("fastify");
  if (pkgDeps["express"]) tags.add("express");
  if (pkgDeps["@prisma/client"] || pkgDeps["prisma"]) tags.add("prisma");
  if (pkgDeps["drizzle-kit"] || pkgDeps["drizzle-orm"]) tags.add("drizzle");

  return [...tags].sort();
}

function classify(tools: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {
    ts_baseline: [], monorepo: [], prisma: [], react: [], hono: [],
    php: [], python: [], kotlin: [], other: [],
  };
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (TS_BASELINE.has(t) && !MONOREPO.has(t)) groups.ts_baseline!.push(t);
    else if (MONOREPO.has(t)) groups.monorepo!.push(t);
    else if (PRISMA.has(t)) groups.prisma!.push(t);
    else if (REACT.has(t)) groups.react!.push(t);
    else if (HONO.has(t)) groups.hono!.push(t);
    else if (PHP.has(t)) groups.php!.push(t);
    else if (PYTHON.has(t)) groups.python!.push(t);
    else if (KOTLIN.has(t)) groups.kotlin!.push(t);
    else groups.other!.push(t);
  }
  return groups;
}

async function run() {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("usage: tsx scripts/debug-autoload.ts <path> [path...]");
    process.exit(1);
  }

  for (const raw of paths) {
    const cwd = resolve(raw);
    if (!existsSync(cwd)) {
      console.log(`\n=== ${cwd}\n  (does not exist — skipping)`);
      continue;
    }
    const tools = await detectAutoLoadTools(cwd);
    const unique = [...new Set(tools)];
    const tags = detectStackTags(cwd, unique);
    const groups = classify(unique);
    const nonEmpty = Object.entries(groups).filter(([, v]) => v.length > 0);

    console.log(`\n=== ${cwd}`);
    console.log(`  stack: ${tags.join("+") || "(none)"}`);
    console.log(`  auto-loaded: ${unique.length} tools`);
    for (const [bundle, list] of nonEmpty) {
      console.log(`    ${bundle.padEnd(13)} (${list.length}): ${list.join(", ")}`);
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
