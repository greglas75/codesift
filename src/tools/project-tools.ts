/**
 * Project Profile Analysis Tools
 *
 * Deterministic extraction of project stack, file classifications, and
 * framework-specific conventions. Produces a JSON profile conforming to
 * the zuvo project-profile schema v1.0.
 */

import { readFile, writeFile, access, readdir, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { getCodeIndex } from "./index-tools.js";
import type { CodeIndex, CodeSymbol } from "../types.js";

// ---------------------------------------------------------------------------
// Versioning — used by get_extractor_versions
// ---------------------------------------------------------------------------

export const EXTRACTOR_VERSIONS = {
  stack_detector: "1.0.0",
  file_classifier: "1.0.0",
  hono: "1.0.0",
  nestjs: "1.0.0",
  nextjs: "1.0.0",
  express: "1.0.0",
  react: "1.0.0",
  python: "1.0.0",
  php: "1.0.0",
} as const;

// ---------------------------------------------------------------------------
// Profile schema types
// ---------------------------------------------------------------------------

export interface ProjectProfile {
  version: string;
  generated_at: string;
  generated_by: {
    tool: string;
    tool_version: string;
    extractor_versions: Record<string, string>;
  };
  compatible_with: string;
  status: "complete" | "partial" | "failed";

  identity?: ProjectIdentity;
  stack?: StackInfo;
  file_classifications?: FileClassifications;
  conventions?: Conventions;
  dependency_graph?: DependencyGraph;
  test_conventions?: TestConventions;
  known_gotchas?: KnownGotchas;
  generation_metadata: GenerationMetadata;
}

export interface ProjectIdentity {
  project_name: string;
  project_type: "monorepo" | "single";
  workspace_root: string;
  git_remote: string | null;
}

export interface DependencyGraph {
  entry_points: string[];
  hub_modules: { path: string; imported_by_count: number }[];
  leaf_modules: string[];
  orphan_files: string[];
}

export interface TestConventions {
  mock_style: string | null;
  setup_files: string[];
  mock_patterns: { name: string; import_from: string; usage: string }[];
  assertion_library: string;
  file_patterns: string[];
  common_mocks: string[];
}

export interface KnownGotchas {
  auto_detected: { gotcha: string; evidence: string[]; severity: "high" | "medium" | "low" }[];
}

export interface StackInfo {
  framework: string | null;
  framework_version: string | null;
  language: string;
  language_version: string | null;
  test_runner: string | null;
  package_manager: string | null;
  build_tool: string | null;  // vite, cra, webpack, parcel, esbuild, rspack, rsbuild, turbopack
  monorepo: { tool: string | null; workspaces: string[] } | null;
  detected_from: string[];
}

export interface FileClassifications {
  critical: ClassifiedFile[];
  important: { count: number; by_type: Record<string, number>; top: ClassifiedFile[] };
  routine: { count: number; by_type: Record<string, number> };
}

export interface ClassifiedFile {
  path: string;
  code_type: string;
  reason?: string;
  dependents_count: number;
  has_tests: boolean;
}

export interface Conventions {
  middleware_chains: MiddlewareChain[];
  rate_limits: RateLimitEntry[];
  route_mounts: RouteMountEntry[];
  auth_patterns: AuthPatterns;
}

export interface MiddlewareChain {
  scope: string;
  file: string;
  chain: { name: string; line: number; order: number }[];
}

export interface RateLimitEntry {
  file: string;
  line: number;
  max: number;
  window: number;
  applied_to_path: string | null;
  method: string | null;
}

export interface RouteMountEntry {
  file: string;
  line: number;
  mount_path: string;
  imported_from: string | null;
  exported_as: string | null;
}

export interface AuthPatterns {
  auth_middleware: string | null;
  groups: Record<string, { requires_auth: boolean; middleware: string[] }>;
}

// NestJS-specific conventions
export interface NestConventions {
  modules: NestModuleEntry[];
  global_guards: NestProviderEntry[];
  global_filters: NestProviderEntry[];
  global_pipes: NestProviderEntry[];
  global_interceptors: NestProviderEntry[];
  controllers: string[];
  throttler: { ttl: number; limit: number } | null;
}

export interface NestModuleEntry {
  name: string;
  file: string;
  line: number;
  imported_from: string | null;
  is_global: boolean;
}

export interface NestProviderEntry {
  name: string;
  token: string; // APP_GUARD, APP_FILTER, etc.
  file: string;
  line: number;
  imported_from: string | null;
}

export interface DependencyHealth {
  total: number;
  prod: number;
  dev: number;
  key_versions: Record<string, string>; // framework, runtime, etc.
}

export interface GitHealth {
  total_commits: number;
  recent_commits_30d: number;
  last_commit_date: string | null;
  contributors: number;
}

export interface GenerationMetadata {
  files_analyzed: number;
  files_skipped: number;
  skip_reasons: Record<string, number>;
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// Stack Detector
// ---------------------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<any> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

export async function detectStack(projectRoot: string): Promise<StackInfo> {
  const detected_from: string[] = [];
  const pkg = await readJson(join(projectRoot, "package.json"));

  // Framework detection
  let framework: string | null = null;
  let framework_version: string | null = null;

  if (pkg) {
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    const frameworkMap: [string, string][] = [
      ["hono", "hono"],
      ["@nestjs/core", "nestjs"],
      ["next", "nextjs"],
      ["nuxt", "nuxt"],
      ["@remix-run/node", "remix"],
      ["astro", "astro"],
      ["express", "express"],
      ["fastify", "fastify"],
      ["@angular/core", "angular"],
      ["vue", "vue"],
      ["svelte", "svelte"],
    ];

    for (const [dep, name] of frameworkMap) {
      if (allDeps?.[dep]) {
        framework = name;
        framework_version = allDeps[dep]?.replace(/^[\^~>=<]/, "") ?? null;
        detected_from.push(`package.json:dependencies.${dep}`);
        break;
      }
    }

    // React detection (only if no framework found — React is often a sub-dep)
    if (!framework && allDeps?.["react"]) {
      framework = "react";
      framework_version = allDeps["react"]?.replace(/^[\^~>=<]/, "") ?? null;
      detected_from.push("package.json:dependencies.react");
    }
  }

  // Python framework detection (if no JS framework found)
  if (!framework) {
    const pyproject = await readJson(join(projectRoot, "pyproject.toml")) ?? null;
    const requirements = await readFile(join(projectRoot, "requirements.txt"), "utf-8").catch(() => "");
    const pipfile = await readFile(join(projectRoot, "Pipfile"), "utf-8").catch(() => "");
    const pyDeps = requirements + pipfile + (pyproject ? JSON.stringify(pyproject) : "");

    if (pyDeps.includes("fastapi")) {
      framework = "fastapi";
      detected_from.push("python:fastapi");
    } else if (pyDeps.includes("django")) {
      framework = "django";
      detected_from.push("python:django");
    } else if (pyDeps.includes("flask")) {
      framework = "flask";
      detected_from.push("python:flask");
    }
  }

  // PHP framework detection
  if (!framework) {
    const composer = await readJson(join(projectRoot, "composer.json"));
    if (composer) {
      const phpDeps = { ...composer.require, ...composer["require-dev"] };
      if (phpDeps?.["laravel/framework"]) {
        framework = "laravel";
        framework_version = phpDeps["laravel/framework"]?.replace(/^[\^~>=<]/, "") ?? null;
        detected_from.push("composer.json:require.laravel/framework");
      } else if (phpDeps?.["yiisoft/yii2"]) {
        framework = "yii2";
        framework_version = phpDeps["yiisoft/yii2"]?.replace(/^[\^~>=<]/, "") ?? null;
        detected_from.push("composer.json:require.yiisoft/yii2");
      } else if (phpDeps?.["symfony/framework-bundle"]) {
        framework = "symfony";
        detected_from.push("composer.json:require.symfony/framework-bundle");
      }
    }
  }

  // Language detection
  let language = "javascript";
  let language_version: string | null = null;

  // Check for Python first
  if (["fastapi", "django", "flask"].includes(framework ?? "")) {
    language = "python";
    detected_from.push("framework implies python");
  } else if (await fileExists(join(projectRoot, "pyproject.toml")) || await fileExists(join(projectRoot, "requirements.txt"))) {
    language = "python";
    detected_from.push("pyproject.toml or requirements.txt");
  }

  // Check for PHP
  if (["laravel", "symfony", "yii2"].includes(framework ?? "")) {
    language = "php";
    detected_from.push("framework implies php");
  }

  // TypeScript/JavaScript (only if not already Python/PHP)
  if (language === "javascript") {
    const tsconfig = await readJson(join(projectRoot, "tsconfig.json"));
    if (tsconfig) {
      language = "typescript";
      language_version = tsconfig?.compilerOptions?.target ?? null;
      detected_from.push("tsconfig.json");
    }
  }

  // Test runner detection
  let test_runner: string | null = null;
  if (language === "python") {
    if (await fileExists(join(projectRoot, "pytest.ini")) || await fileExists(join(projectRoot, "conftest.py"))) {
      test_runner = "pytest";
      detected_from.push("pytest.ini or conftest.py");
    }
  } else if (language === "php") {
    if (await fileExists(join(projectRoot, "phpunit.xml")) || await fileExists(join(projectRoot, "phpunit.xml.dist"))) {
      test_runner = "phpunit";
      detected_from.push("phpunit.xml");
    }
  } else if (pkg) {
    const devDeps = pkg.devDependencies ?? {};
    if (devDeps["vitest"]) {
      test_runner = "vitest";
      detected_from.push("package.json:devDependencies.vitest");
    } else if (devDeps["jest"]) {
      test_runner = "jest";
      detected_from.push("package.json:devDependencies.jest");
    } else if (devDeps["mocha"]) {
      test_runner = "mocha";
      detected_from.push("package.json:devDependencies.mocha");
    }
  }

  // Package manager detection
  let package_manager: string | null = null;
  if (await fileExists(join(projectRoot, "pnpm-lock.yaml"))) {
    package_manager = "pnpm";
    detected_from.push("pnpm-lock.yaml");
  } else if (await fileExists(join(projectRoot, "yarn.lock"))) {
    package_manager = "yarn";
    detected_from.push("yarn.lock");
  } else if (await fileExists(join(projectRoot, "package-lock.json"))) {
    package_manager = "npm";
    detected_from.push("package-lock.json");
  } else if (await fileExists(join(projectRoot, "bun.lockb"))) {
    package_manager = "bun";
    detected_from.push("bun.lockb");
  }

  // Monorepo detection
  let monorepo: StackInfo["monorepo"] = null;
  if (pkg?.workspaces) {
    const workspaces = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : pkg.workspaces.packages ?? [];
    const turboExists = await fileExists(join(projectRoot, "turbo.json"));
    const nxExists = await fileExists(join(projectRoot, "nx.json"));
    monorepo = {
      tool: turboExists ? "turborepo" : nxExists ? "nx" : "workspaces",
      workspaces,
    };
    detected_from.push("package.json:workspaces");
  } else if (await fileExists(join(projectRoot, "pnpm-workspace.yaml"))) {
    try {
      const content = await readFile(join(projectRoot, "pnpm-workspace.yaml"), "utf-8");
      const workspaces = content.match(/- ['"]?([^'"]+)['"]?/g)?.map(m => m.replace(/- ['"]?/, "").replace(/['"]$/, "")) ?? [];
      const turboExists = await fileExists(join(projectRoot, "turbo.json"));
      monorepo = { tool: turboExists ? "turborepo" : "pnpm-workspaces", workspaces };
      detected_from.push("pnpm-workspace.yaml");
    } catch { /* ignore parse errors */ }
  }

  // Monorepo workspace scanning — if root has no framework/test_runner, scan workspaces
  if (monorepo && (!framework || !test_runner || language === "javascript")) {
    const workspacePatterns = monorepo.workspaces;
    const workspaceDirs: string[] = [];

    for (const pattern of workspacePatterns) {
      // Expand simple glob patterns like "apps/*" or "packages/*"
      const base = pattern.replace(/\/?\*$/, "");
      const baseDir = join(projectRoot, base);
      try {
        const entries = await readdir(baseDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            workspaceDirs.push(join(baseDir, entry.name));
          }
        }
      } catch { /* directory doesn't exist */ }
    }

    const frameworkMap: [string, string][] = [
      ["hono", "hono"],
      ["@nestjs/core", "nestjs"],
      ["next", "nextjs"],
      ["nuxt", "nuxt"],
      ["@remix-run/node", "remix"],
      ["astro", "astro"],
      ["express", "express"],
      ["fastify", "fastify"],
    ];

    for (const wsDir of workspaceDirs) {
      const wsPkg = await readJson(join(wsDir, "package.json"));
      if (!wsPkg) continue;
      const wsDeps = { ...wsPkg.dependencies, ...wsPkg.devDependencies };
      const wsName = relative(projectRoot, wsDir);

      // Framework from workspace (prefer backend frameworks: hono, nestjs, express)
      if (!framework) {
        for (const [dep, name] of frameworkMap) {
          if (wsDeps?.[dep]) {
            framework = name;
            framework_version = wsDeps[dep]?.replace(/^[\^~>=<]/, "") ?? null;
            detected_from.push(`${wsName}/package.json:dependencies.${dep}`);
            break;
          }
        }
      }

      // Test runner from workspace
      if (!test_runner) {
        if (wsDeps?.["vitest"]) {
          test_runner = "vitest";
          detected_from.push(`${wsName}/package.json:devDependencies.vitest`);
        } else if (wsDeps?.["jest"]) {
          test_runner = "jest";
          detected_from.push(`${wsName}/package.json:devDependencies.jest`);
        }
      }

      // TypeScript from workspace
      if (language === "javascript") {
        const wsTsconfig = await readJson(join(wsDir, "tsconfig.json"));
        if (wsTsconfig) {
          language = "typescript";
          language_version = wsTsconfig?.compilerOptions?.target ?? null;
          detected_from.push(`${wsName}/tsconfig.json`);
        }
      }
    }
  }

  // Also check root tsconfig.base.json for monorepos that use base config
  if (language === "javascript") {
    const baseTsconfig = await readJson(join(projectRoot, "tsconfig.base.json"));
    if (baseTsconfig) {
      language = "typescript";
      language_version = baseTsconfig?.compilerOptions?.target ?? null;
      detected_from.push("tsconfig.base.json");
    }
  }

  // Build tool detection (Vite, CRA, webpack, Parcel, esbuild, Rspack, Turbopack)
  // Order matters: check more specific/modern tools first.
  let build_tool: string | null = null;
  if (pkg) {
    const devDeps = pkg.devDependencies ?? {};
    const deps = pkg.dependencies ?? {};
    const allDeps: Record<string, string> = { ...deps, ...devDeps };

    if (allDeps["vite"]) {
      build_tool = "vite";
      detected_from.push("package.json:vite");
    } else if (allDeps["react-scripts"]) {
      build_tool = "cra";
      detected_from.push("package.json:react-scripts");
    } else if (allDeps["@rsbuild/core"]) {
      build_tool = "rsbuild";
      detected_from.push("package.json:@rsbuild/core");
    } else if (allDeps["@rspack/cli"] || allDeps["@rspack/core"]) {
      build_tool = "rspack";
      detected_from.push("package.json:@rspack/*");
    } else if (allDeps["parcel"] || allDeps["parcel-bundler"]) {
      build_tool = "parcel";
      detected_from.push("package.json:parcel");
    } else if (allDeps["webpack"] || allDeps["webpack-cli"]) {
      build_tool = "webpack";
      detected_from.push("package.json:webpack");
    } else if (allDeps["esbuild"]) {
      build_tool = "esbuild";
      detected_from.push("package.json:esbuild");
    } else if (allDeps["turbopack"]) {
      build_tool = "turbopack";
      detected_from.push("package.json:turbopack");
    }
  }

  // Fallback: look for config files if no dep match
  if (!build_tool) {
    const configChecks: [string, string][] = [
      ["vite.config.ts", "vite"],
      ["vite.config.js", "vite"],
      ["vite.config.mjs", "vite"],
      ["webpack.config.js", "webpack"],
      ["webpack.config.ts", "webpack"],
      ["rspack.config.js", "rspack"],
      ["rsbuild.config.ts", "rsbuild"],
      [".parcelrc", "parcel"],
    ];
    for (const [file, tool] of configChecks) {
      if (await fileExists(join(projectRoot, file))) {
        build_tool = tool;
        detected_from.push(file);
        break;
      }
    }
  }

  return {
    framework,
    framework_version,
    language,
    language_version,
    test_runner,
    package_manager,
    build_tool,
    monorepo,
    detected_from,
  };
}

// ---------------------------------------------------------------------------
// File Classifier
// ---------------------------------------------------------------------------

const CRITICAL_PATH_PATTERNS = [
  /\/(app|main|server)\.(ts|js|tsx|jsx)$/,
  /\/middleware\//,
  /\/security\//,
  /\/auth\//,
  /\/crypto\//,
];

/** index.ts is critical ONLY at shallow depth (src/index.ts, apps/api/src/index.ts) — not barrel re-exports */
function isEntryPointIndex(path: string): boolean {
  if (!/\/index\.(ts|js|tsx|jsx)$/.test(path)) return false;
  // Count path depth — barrel files are deep (components/Foo/index.ts = 3+ segments after src)
  const parts = path.split("/");
  const srcIdx = parts.indexOf("src");
  if (srcIdx === -1) return parts.length <= 3; // no src dir — shallow if <=3 segments
  const depthAfterSrc = parts.length - srcIdx - 2; // segments between src/ and index.ts
  return depthAfterSrc <= 1; // src/index.ts (0) or src/app/index.ts (1) = critical
}

const IMPORTANT_PATH_PATTERNS = [
  /\/services?\//,
  /\/controllers?\//,
  /\/routes?\//,
  /\/handlers?\//,
  /\/resolvers?\//,
];

const ROUTINE_PATH_PATTERNS = [
  /\/utils?\//,
  /\/helpers?\//,
  /\/constants?\//,
  /\/types?\//,
  /\/interfaces?\//,
  /\/config\//,
  /\/dto\//,
  /\/schemas?\//,
];

function isTestFile(path: string): boolean {
  return /\.(test|spec)\.(ts|js|tsx|jsx)$/.test(path);
}

function classifyCodeType(path: string, _symbol_count: number): string {
  if (/\/(app|main|server)\.(ts|js)$/.test(path)) return "ORCHESTRATOR";
  if (/\/middleware\//.test(path)) return "GUARD";
  if (/\/auth\//.test(path)) return "GUARD";
  if (/\.(service|repository)\.(ts|js)$/.test(path)) return "SERVICE";
  if (/\.(controller|handler)\.(ts|js)$/.test(path)) return "CONTROLLER";
  if (/\.(component|page)\.(tsx|jsx)$/.test(path)) return "COMPONENT";
  if (/\/hooks?\//.test(path) || /\.hook\.(ts|js)$/.test(path)) return "HOOK";
  if (/\/utils?\//.test(path) || /\/helpers?\//.test(path)) return "PURE";
  if (/\/types?\//.test(path) || /\.d\.ts$/.test(path)) return "TYPE_DEF";
  if (/\/constants?\//.test(path)) return "CONSTANT";
  return "PURE";
}

export function classifyFiles(index: CodeIndex): FileClassifications {
  const critical: ClassifiedFile[] = [];
  const important: ClassifiedFile[] = [];
  const routineCounts: Record<string, number> = {};
  let routineCount = 0;

  // Build importer count map
  const importerCount = new Map<string, number>();
  for (const sym of index.symbols) {
    // Count how many unique files import each file
    if (sym.source?.includes("import ") || sym.source?.includes("require(")) {
      // Simplified — in production this would use the actual import graph
    }
  }

  // Build test file set for has_tests detection
  const testFiles = new Set(
    index.files
      .filter((f) => isTestFile(f.path))
      .map((f) => f.path),
  );

  function hasTests(filePath: string): boolean {
    const base = filePath.replace(/\.(ts|js|tsx|jsx)$/, "");
    return (
      testFiles.has(`${base}.test.ts`) ||
      testFiles.has(`${base}.test.tsx`) ||
      testFiles.has(`${base}.spec.ts`) ||
      testFiles.has(`${base}.spec.tsx`) ||
      testFiles.has(`${base}.test.js`) ||
      testFiles.has(`${base}.spec.js`)
    );
  }

  for (const file of index.files) {
    if (isTestFile(file.path)) continue; // skip test files
    if (/node_modules|\.d\.ts$|\.json$|\.md$|\.css$|\.scss$/.test(file.path)) continue;

    const code_type = classifyCodeType(file.path, file.symbol_count);
    const dependents = importerCount.get(file.path) ?? 0;

    // Tier assignment
    const isCritical = CRITICAL_PATH_PATTERNS.some((p) => p.test(file.path)) || isEntryPointIndex(file.path) || dependents > 5;
    const isImportant = IMPORTANT_PATH_PATTERNS.some((p) => p.test(file.path)) || file.symbol_count > 3;
    const isRoutine = ROUTINE_PATH_PATTERNS.some((p) => p.test(file.path));

    if (isCritical) {
      const reason = dependents > 5
        ? `Hub module (${dependents} importers)`
        : CRITICAL_PATH_PATTERNS.find((p) => p.test(file.path))?.source.replace(/\\\//g, "/") ?? "entry point";
      critical.push({
        path: file.path,
        code_type,
        reason,
        dependents_count: dependents,
        has_tests: hasTests(file.path),
      });
    } else if (isImportant && !isRoutine) {
      important.push({
        path: file.path,
        code_type,
        dependents_count: dependents,
        has_tests: hasTests(file.path),
      });
    } else {
      routineCount++;
      routineCounts[code_type] = (routineCounts[code_type] ?? 0) + 1;
    }
  }

  // Compact important tier: aggregate by type + keep only top 30 by dependents
  const importantCounts: Record<string, number> = {};
  for (const f of important) {
    importantCounts[f.code_type] = (importantCounts[f.code_type] ?? 0) + 1;
  }
  const topImportant = important
    .sort((a, b) => b.dependents_count - a.dependents_count)
    .slice(0, 30);

  return {
    critical,
    important: { count: important.length, by_type: importantCounts, top: topImportant },
    routine: { count: routineCount, by_type: routineCounts },
  };
}

// ---------------------------------------------------------------------------
// Hono Extractor
// ---------------------------------------------------------------------------

interface HonoCall {
  type: "use" | "route" | "get" | "post" | "put" | "delete" | "all";
  path: string | null;
  args: string;
  line: number;
}

function parseHonoCalls(source: string): HonoCall[] {
  const calls: HonoCall[] = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // Match app.use("path", handler) or app.route("path", router)
    const useMatch = line.match(/app\.(use|route|get|post|put|delete|all)\s*\(\s*["']([^"']+)["']\s*,\s*(.+)/);
    if (useMatch) {
      // Clean trailing ); but preserve function call parens like rateLimit(3, 3600)
      const args = useMatch[3]!.trim().replace(/\);?\s*$/, "").trim();
      calls.push({
        type: useMatch[1]! as HonoCall["type"],
        path: useMatch[2]!,
        args,
        line: lineNum,
      });
      continue;
    }

    // Match app.use("*", handler) — global middleware
    const globalUseMatch = line.match(/app\.use\s*\(\s*["']\*["']\s*,\s*(.+)/);
    if (globalUseMatch) {
      const args = globalUseMatch[1]!.trim().replace(/\);?\s*$/, "").trim();
      calls.push({
        type: "use",
        path: "*",
        args,
        line: lineNum,
      });
      continue;
    }

    // Match app.get("/path", (c) => ...) — inline handler
    const inlineMatch = line.match(/app\.(get|post|put|delete)\s*\(\s*["']([^"']+)["']\s*,/);
    if (inlineMatch) {
      calls.push({
        type: inlineMatch[1]! as HonoCall["type"],
        path: inlineMatch[2]!,
        args: "(inline handler)",
        line: lineNum,
      });
    }
  }

  return calls;
}

function extractMiddlewareName(args: string): string | null {
  // Handle rateLimit(3, 3600) → "rateLimit"
  const funcCall = args.match(/^(\w+)\s*\(/);
  if (funcCall) return funcCall[1]!;
  // Handle simple identifier: clerkAuth
  const simple = args.match(/^(\w+)$/);
  if (simple) return simple[1]!;
  return null;
}

function extractRateLimit(args: string): { max: number; window: number } | null {
  const match = args.match(/rateLimit\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if (match) return { max: parseInt(match[1]!), window: parseInt(match[2]!) };
  return null;
}

export function extractHonoConventions(
  source: string,
  filePath: string,
): Conventions {
  const calls = parseHonoCalls(source);

  // Build import map: variable name → import path
  const importMap = new Map<string, string>();
  for (const line of source.split("\n")) {
    // import adminContests from "./routes/admin/contests/index.js";
    const defaultImport = line.match(/import\s+(\w+)\s+from\s+["']([^"']+)["']/);
    if (defaultImport) {
      importMap.set(defaultImport[1]!, defaultImport[2]!);
    }
    // import { clerkAuth } from "./middleware/auth.js";
    const namedImport = line.match(/import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/);
    if (namedImport) {
      const names = namedImport[1]!.split(",").map((n) => n.trim().split(/\s+as\s+/).pop()!.trim());
      for (const name of names) {
        importMap.set(name, namedImport[2]!);
      }
    }
  }

  const middleware_chains: MiddlewareChain[] = [];
  const rate_limits: RateLimitEntry[] = [];
  const route_mounts: RouteMountEntry[] = [];
  const authGroups: Record<string, { requires_auth: boolean; middleware: string[] }> = {};
  let auth_middleware: string | null = null;

  // Group middleware by scope — deduplicate same middleware on different paths
  const scopeChains = new Map<string, { name: string; line: number; order: number }[]>();
  const scopeMwSeen = new Map<string, Set<string>>(); // scope → set of middleware names already in chain

  let globalOrder = 0;
  const scopeOrders = new Map<string, number>();

  for (const call of calls) {
    if (call.type === "use") {
      const mwName = extractMiddlewareName(call.args);
      const rl = extractRateLimit(call.args);

      if (rl) {
        rate_limits.push({
          file: filePath,
          line: call.line,
          max: rl.max,
          window: rl.window,
          applied_to_path: call.path !== "*" ? call.path : null,
          method: null,
        });
      } else if (mwName) {
        const scope = call.path === "*" ? "global" : inferScope(call.path ?? "");

        // Deduplicate: same middleware applied to different paths in same scope
        // e.g. publicTenantResolver on /api/contests/*, /api/translations/*, /api/r/*
        if (!scopeMwSeen.has(scope)) scopeMwSeen.set(scope, new Set());
        const seen = scopeMwSeen.get(scope)!;

        if (!seen.has(mwName)) {
          seen.add(mwName);
          const currentOrder = scope === "global"
            ? ++globalOrder
            : (scopeOrders.set(scope, (scopeOrders.get(scope) ?? 0) + 1), scopeOrders.get(scope)!);

          if (!scopeChains.has(scope)) scopeChains.set(scope, []);
          scopeChains.get(scope)!.push({ name: mwName, line: call.line, order: currentOrder });
        }

        // Detect auth middleware
        if (/auth|clerk|jwt|session|passport/i.test(mwName)) {
          auth_middleware = mwName;
          const group = inferScope(call.path ?? "");
          if (!authGroups[group]) authGroups[group] = { requires_auth: false, middleware: [] };
          authGroups[group].requires_auth = true;
          if (!authGroups[group].middleware.includes(mwName)) {
            authGroups[group].middleware.push(mwName);
          }
        } else if (scope !== "global") {
          const group = scope;
          if (!authGroups[group]) authGroups[group] = { requires_auth: false, middleware: [] };
          if (!authGroups[group].middleware.includes(mwName)) {
            authGroups[group].middleware.push(mwName);
          }
        }
      }
    } else if (call.type === "route") {
      const varName = call.args.trim();
      route_mounts.push({
        file: filePath,
        line: call.line,
        mount_path: call.path ?? "",
        imported_from: importMap.get(varName) ?? null,
        exported_as: varName,
      });

      // Infer route group for auth detection
      const group = inferScope(call.path ?? "");
      if (!authGroups[group]) authGroups[group] = { requires_auth: false, middleware: [] };
    } else if (call.type === "get" || call.type === "post" || call.type === "put" || call.type === "delete") {
      // Inline route — nothing to extract for conventions, but note for route groups
    }
  }

  // Build middleware chain array
  for (const [scope, chain] of scopeChains) {
    middleware_chains.push({ scope, file: filePath, chain });
  }

  // Build auth pattern groups — ensure all route groups are represented
  const routeGroups = new Set<string>();
  for (const mount of route_mounts) {
    routeGroups.add(inferScope(mount.mount_path));
  }
  // Add health and other direct routes
  for (const call of calls) {
    if (call.type !== "use" && call.type !== "route" && call.path) {
      routeGroups.add(inferScope(call.path));
    }
  }
  for (const group of routeGroups) {
    if (!authGroups[group]) {
      authGroups[group] = { requires_auth: false, middleware: [] };
    }
  }

  return {
    middleware_chains,
    rate_limits,
    route_mounts,
    auth_patterns: { auth_middleware, groups: authGroups },
  };
}

// ---------------------------------------------------------------------------
// NestJS Extractor
// ---------------------------------------------------------------------------

export function extractNestConventions(
  source: string,
  filePath: string,
): NestConventions {
  const lines = source.split("\n");

  // Build import map
  const importMap = new Map<string, string>();
  for (const line of lines) {
    const defaultImport = line.match(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    if (defaultImport) {
      const names = defaultImport[1]!.split(",").map((n) => n.trim().split(/\s+as\s+/).pop()!.trim());
      for (const name of names) {
        importMap.set(name, defaultImport[2]!);
      }
    }
  }

  const modules: NestModuleEntry[] = [];
  const global_guards: NestProviderEntry[] = [];
  const global_filters: NestProviderEntry[] = [];
  const global_pipes: NestProviderEntry[] = [];
  const global_interceptors: NestProviderEntry[] = [];
  const controllers: string[] = [];
  let throttler: NestConventions["throttler"] = null;

  let inImports = false;
  let inProviders = false;
  let inControllers = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // Track @Module sections
    if (/imports:\s*\[/.test(line)) inImports = true;
    if (/providers:\s*\[/.test(line)) inProviders = true;
    if (/controllers:\s*\[/.test(line)) inControllers = true;
    if (inImports && /^\s*\]/.test(line)) inImports = false;
    if (inProviders && /^\s*\]/.test(line)) inProviders = false;
    if (inControllers && /^\s*\]/.test(line)) inControllers = false;

    // Extract module imports
    if (inImports) {
      // Match: ModuleName, or ModuleName.forRoot(), or ModuleName.forRootAsync({...})
      const moduleMatch = line.match(/^\s+(\w+Module)(?:\.for(?:Root|Feature)(?:Async)?\s*\()?/);
      if (moduleMatch) {
        const name = moduleMatch[1]!;
        const isGlobal = /isGlobal:\s*true/.test(line) || /ConfigModule|SentryModule/.test(name);
        modules.push({
          name,
          file: filePath,
          line: lineNum,
          imported_from: importMap.get(name) ?? null,
          is_global: isGlobal,
        });
      }

      // Extract ThrottlerModule config
      if (/ThrottlerModule/.test(line)) {
        // Scan ahead for ttl and limit
        for (let j = i; j < Math.min(i + 15, lines.length); j++) {
          const ttlMatch = lines[j]!.match(/ttl:\s*(\d+)/);
          const limitMatch = lines[j]!.match(/limit:\s*(?:.*?:\s*)?(\d+)/);
          if (ttlMatch && !throttler) {
            throttler = { ttl: parseInt(ttlMatch[1]!), limit: 60 };
          }
          if (limitMatch && throttler) {
            // Take the production value (non-development)
            const allLimits = lines[j]!.match(/(\d+)/g);
            if (allLimits && allLimits.length > 0) {
              throttler.limit = parseInt(allLimits[allLimits.length - 1]!);
            }
          }
        }
      }
    }

    // Extract controllers
    if (inControllers) {
      const ctrlMatch = line.match(/(\w+Controller)\b/);
      if (ctrlMatch) controllers.push(ctrlMatch[1]!);
    }

    // Extract global providers (APP_GUARD, APP_FILTER, APP_PIPE)
    if (inProviders) {
      if (/provide:\s*APP_GUARD/.test(line)) {
        // Scan for useClass on next lines
        for (let j = i; j < Math.min(i + 5, lines.length); j++) {
          const useClassMatch = lines[j]!.match(/useClass:\s*(\w+)/);
          if (useClassMatch) {
            global_guards.push({
              name: useClassMatch[1]!,
              token: "APP_GUARD",
              file: filePath,
              line: j + 1,
              imported_from: importMap.get(useClassMatch[1]!) ?? null,
            });
            break;
          }
        }
      }
      if (/provide:\s*APP_FILTER/.test(line)) {
        for (let j = i; j < Math.min(i + 5, lines.length); j++) {
          const useClassMatch = lines[j]!.match(/useClass:\s*(\w+)/);
          if (useClassMatch) {
            global_filters.push({
              name: useClassMatch[1]!,
              token: "APP_FILTER",
              file: filePath,
              line: j + 1,
              imported_from: importMap.get(useClassMatch[1]!) ?? null,
            });
            break;
          }
        }
      }
      if (/provide:\s*APP_PIPE/.test(line)) {
        for (let j = i; j < Math.min(i + 5, lines.length); j++) {
          const useClassMatch = lines[j]!.match(/useClass:\s*(\w+)/);
          if (useClassMatch) {
            global_pipes.push({
              name: useClassMatch[1]!,
              token: "APP_PIPE",
              file: filePath,
              line: j + 1,
              imported_from: importMap.get(useClassMatch[1]!) ?? null,
            });
            break;
          }
        }
      }
      if (/provide:\s*APP_INTERCEPTOR/.test(line)) {
        for (let j = i; j < Math.min(i + 5, lines.length); j++) {
          const useClassMatch = lines[j]!.match(/useClass:\s*(\w+)/);
          if (useClassMatch) {
            global_interceptors.push({
              name: useClassMatch[1]!,
              token: "APP_INTERCEPTOR",
              file: filePath,
              line: j + 1,
              imported_from: importMap.get(useClassMatch[1]!) ?? null,
            });
            break;
          }
        }
      }
    }
  }

  return { modules, global_guards, global_filters, global_pipes, global_interceptors, controllers, throttler };
}

// ---------------------------------------------------------------------------
// Next.js Extractor
// ---------------------------------------------------------------------------

export interface NextConventions {
  pages: { path: string; type: "page" | "layout" | "loading" | "error" | "not-found" | "global-error" | "default" | "template" }[];
  middleware: { file: string; matchers: string[] } | null;
  api_routes: { path: string; methods: string[]; file: string }[];
  services_count: number;
  inngest_functions: string[];
  webhooks: string[];
  client_component_count: number;
  server_action_count: number;
  config: {
    app_router: boolean;
    src_dir: boolean;
    i18n: boolean;
  };
}

export function extractNextConventions(
  _projectRoot: string,
  files: { path: string }[],
): NextConventions {
  const pages: NextConventions["pages"] = [];
  const api_routes: NextConventions["api_routes"] = [];
  const inngest_functions: string[] = [];
  const webhooks: string[] = [];
  let services_count = 0;
  let client_component_count = 0;
  let server_action_count = 0;
  let middleware: NextConventions["middleware"] = null;

  const hasAppDir = files.some((f) => f.path.includes("app/"));
  const hasSrcDir = files.some((f) => f.path.startsWith("src/"));
  const hasI18n = files.some((f) => f.path.includes("[locale]") || f.path.includes("i18n"));

  for (const file of files) {
    const p = file.path;

    // Middleware
    if (/^(src\/)?middleware\.(ts|js)$/.test(p)) {
      middleware = { file: p, matchers: [] };
    }

    // App Router pages (paths from index have no leading /)
    if (/app\/.*\/page\.(tsx|jsx|ts|js)$/.test(p)) {
      pages.push({ path: p, type: "page" });
    }
    if (/app\/.*\/layout\.(tsx|jsx|ts|js)$/.test(p)) {
      pages.push({ path: p, type: "layout" });
    }
    if (/app\/.*\/loading\.(tsx|jsx|ts|js)$/.test(p)) {
      pages.push({ path: p, type: "loading" });
    }
    if (/app\/.*\/error\.(tsx|jsx|ts|js)$/.test(p)) {
      pages.push({ path: p, type: "error" });
    }
    if (/app\/.*\/not-found\.(tsx|jsx|ts|js)$/.test(p)) {
      pages.push({ path: p, type: "not-found" });
    }
    if (/app\/.*\/global-error\.(tsx|jsx|ts|js)$/.test(p)) {
      pages.push({ path: p, type: "global-error" });
    }
    if (/app\/.*\/default\.(tsx|jsx|ts|js)$/.test(p)) {
      pages.push({ path: p, type: "default" });
    }
    if (/app\/.*\/template\.(tsx|jsx|ts|js)$/.test(p)) {
      pages.push({ path: p, type: "template" });
    }

    // API routes (App Router — route.ts files under app/api/)
    if (/app\/api\/.*route\.(ts|js)$/.test(p)) {
      api_routes.push({ path: p, methods: [], file: p });
    }

    // Pages Router API routes
    if (/pages\/api\//.test(p)) {
      api_routes.push({ path: p, methods: [], file: p });
    }

    // Inngest functions
    if (/inngest\/.*\.(ts|js)$/.test(p) && !/\.test\./.test(p) && !/\.spec\./.test(p) && !/index\./.test(p)) {
      inngest_functions.push(p);
    }

    // Services
    if (/services?\/[^/]+\.(ts|js)$/.test(p) && !/\.test\./.test(p) && !/\.spec\./.test(p) && !/\.d\.ts$/.test(p) && !/index\./.test(p)) {
      services_count++;
    }

    // Webhooks
    if (/webhook/.test(p) && /route\.(ts|js)$/.test(p)) {
      webhooks.push(p);
    }

    // Directive scanning — check first line for "use client" / "use server"
    if (/\.(tsx|ts|jsx|js)$/.test(p) && /app\//.test(p)) {
      try {
        const head = readFileSync(join(_projectRoot, p), { encoding: "utf8", flag: "r" }).slice(0, 80);
        if (/['"]use client['"]/.test(head)) client_component_count++;
        if (/['"]use server['"]/.test(head)) server_action_count++;
      } catch {
        // file may have been deleted since indexing
      }
    }
  }

  return {
    pages,
    middleware,
    api_routes,
    services_count,
    client_component_count,
    server_action_count,
    inngest_functions,
    webhooks,
    config: { app_router: hasAppDir, src_dir: hasSrcDir, i18n: hasI18n },
  };
}

// ---------------------------------------------------------------------------
// Express Extractor (similar to Hono but different patterns)
// ---------------------------------------------------------------------------

export interface ExpressConventions {
  middleware: { name: string; file: string; line: number }[];
  routers: { mount_path: string; file: string; line: number; imported_from: string | null }[];
  error_handlers: { file: string; line: number }[];
}

export function extractExpressConventions(
  source: string,
  filePath: string,
): ExpressConventions {
  const lines = source.split("\n");
  const middleware: ExpressConventions["middleware"] = [];
  const routers: ExpressConventions["routers"] = [];
  const error_handlers: ExpressConventions["error_handlers"] = [];

  // Import map
  const importMap = new Map<string, string>();
  for (const line of lines) {
    const req = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (req) importMap.set(req[1]!, req[2]!);
    const imp = line.match(/import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/);
    if (imp) {
      const names = imp[1] ? imp[1].split(",").map((n) => n.trim()) : [imp[2]!];
      for (const n of names) importMap.set(n, imp[3]!);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // app.use(middleware)
    const useMatch = line.match(/app\.use\s*\(\s*(\w+)\s*\)/);
    if (useMatch) {
      middleware.push({ name: useMatch[1]!, file: filePath, line: lineNum });
      continue;
    }

    // app.use("/path", router)
    const routeMatch = line.match(/app\.use\s*\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)\s*\)/);
    if (routeMatch) {
      routers.push({
        mount_path: routeMatch[1]!,
        file: filePath,
        line: lineNum,
        imported_from: importMap.get(routeMatch[2]!) ?? null,
      });
      continue;
    }

    // Error handler: (err, req, res, next) => ...
    if (/app\.use\s*\(\s*(?:function\s*)?\(\s*err\s*,/.test(line) || /app\.use\s*\(\s*\(\s*err\s*:/.test(line)) {
      error_handlers.push({ file: filePath, line: lineNum });
    }
  }

  return { middleware, routers, error_handlers };
}

// ---------------------------------------------------------------------------
// React Extractor (component-level conventions)
// ---------------------------------------------------------------------------

export interface ReactConventions {
  state_management: string | null; // redux, zustand, context, jotai, etc.
  routing: string | null; // react-router, tanstack-router, etc.
  ui_library: string | null; // mui, chakra, shadcn, etc.
  /** File-path-based counts (coarse, matches /pages/, /components/, /hooks/ dirs) */
  component_count: { pages: number; components: number; hooks: number };
  /** Actual count from symbol kinds (requires Wave 1 extractor) */
  actual_component_count: number;
  /** Actual count from symbol kinds */
  actual_hook_count: number;
  /** Top hooks called across all components, sorted by usage */
  hook_usage: { name: string; count: number }[];
  /** Count of components wrapped in React.memo/forwardRef/lazy */
  component_patterns: { memo: number; forwardRef: number; lazy: number };
}

export function extractReactConventions(
  files: { path: string }[],
  deps: Record<string, string>,
  symbols?: CodeSymbol[],
): ReactConventions {
  // State management
  let state_management: string | null = null;
  if (deps["@reduxjs/toolkit"] || deps["redux"]) state_management = "redux";
  else if (deps["zustand"]) state_management = "zustand";
  else if (deps["jotai"]) state_management = "jotai";
  else if (deps["recoil"]) state_management = "recoil";
  else if (deps["mobx"]) state_management = "mobx";

  // Routing
  let routing: string | null = null;
  if (deps["react-router-dom"] || deps["react-router"]) routing = "react-router";
  else if (deps["@tanstack/react-router"]) routing = "tanstack-router";
  else if (deps["wouter"]) routing = "wouter";

  // UI library
  let ui_library: string | null = null;
  if (deps["@mui/material"]) ui_library = "mui";
  else if (deps["@chakra-ui/react"]) ui_library = "chakra";
  else if (deps["antd"]) ui_library = "antd";
  else if (deps["@radix-ui/react-dialog"] || deps["@radix-ui/themes"]) ui_library = "radix";
  else if (deps["tailwindcss"]) ui_library = "tailwind";

  // File-path-based component counts (legacy, coarse)
  let pages = 0, components = 0, hooks = 0;
  for (const f of files) {
    if (/\/pages?\//.test(f.path) && /\.(tsx|jsx)$/.test(f.path)) pages++;
    else if (/\/components?\//.test(f.path) && /\.(tsx|jsx)$/.test(f.path)) components++;
    if (/\/hooks?\//.test(f.path) || /\.hook\.(ts|js)$/.test(f.path)) hooks++;
  }

  // Symbol-based semantic counts (requires Wave 1 extractor)
  let actual_component_count = 0;
  let actual_hook_count = 0;
  const hookUsageMap = new Map<string, number>();
  const component_patterns = { memo: 0, forwardRef: 0, lazy: 0 };

  if (symbols) {
    // Set of stdlib hooks to exclude from "hook usage" tracking — we want
    // to highlight which library/custom hooks components consume.
    for (const sym of symbols) {
      if (sym.kind === "component") {
        actual_component_count++;
        if (sym.source) {
          // Detect wrapper patterns in component source
          if (/\b(?:React\.)?memo\s*\(/.test(sym.source)) component_patterns.memo++;
          if (/\b(?:React\.)?forwardRef\s*\(/.test(sym.source)) component_patterns.forwardRef++;
          if (/\b(?:React\.)?lazy\s*\(/.test(sym.source)) component_patterns.lazy++;
          // Count hook calls inside this component
          const hookCalls = sym.source.matchAll(/\b(use[A-Z]\w*)\s*\(/g);
          for (const m of hookCalls) {
            const hookName = m[1]!;
            hookUsageMap.set(hookName, (hookUsageMap.get(hookName) ?? 0) + 1);
          }
        }
      } else if (sym.kind === "hook") {
        actual_hook_count++;
      }
    }
  }

  const hook_usage = [...hookUsageMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  return {
    state_management,
    routing,
    ui_library,
    component_count: { pages, components, hooks },
    actual_component_count,
    actual_hook_count,
    hook_usage,
    component_patterns,
  };
}

// ---------------------------------------------------------------------------
// Python Extractor
// ---------------------------------------------------------------------------

export interface PythonConventions {
  framework_type: "fastapi" | "django" | "flask" | null;
  routers: { path: string; file: string }[];
  middleware: string[];
  models_dir: string | null;
  test_framework: string | null;
}

export function extractPythonConventions(
  files: { path: string }[],
): PythonConventions {
  const routers: PythonConventions["routers"] = [];
  const middlewareSet = new Set<string>();
  let models_dir: string | null = null;
  let framework_type: PythonConventions["framework_type"] = null;

  for (const f of files) {
    // FastAPI routers
    if (/router\.py$|routes?\.py$/.test(f.path)) {
      routers.push({ path: f.path, file: f.path });
      if (!framework_type) framework_type = "fastapi";
    }
    // Django views/urls
    if (/views\.py$|urls\.py$/.test(f.path)) {
      routers.push({ path: f.path, file: f.path });
      if (!framework_type) framework_type = "django";
    }
    // Flask blueprints
    if (/blueprint/.test(f.path)) {
      routers.push({ path: f.path, file: f.path });
      if (!framework_type) framework_type = "flask";
    }
    // Middleware
    if (/middleware/.test(f.path) && f.path.endsWith(".py")) {
      middlewareSet.add(f.path);
    }
    // Models
    if (/models?\.py$/.test(f.path) && !models_dir) {
      const dir = f.path.split("/").slice(0, -1).join("/");
      models_dir = dir || null;
    }
  }

  // Test framework detection
  let test_framework: string | null = null;
  if (files.some((f) => /conftest\.py$/.test(f.path) || /test_.*\.py$/.test(f.path))) {
    test_framework = "pytest";
  } else if (files.some((f) => /tests?\.py$/.test(f.path))) {
    test_framework = "unittest";
  }

  return {
    framework_type,
    routers,
    middleware: [...middlewareSet],
    models_dir,
    test_framework,
  };
}

// ---------------------------------------------------------------------------
// PHP/Laravel Extractor
// ---------------------------------------------------------------------------

export interface PhpConventions {
  controllers: { name: string; path: string }[];
  middleware: { name: string; path: string }[];
  models: { name: string; path: string }[];
  routes_files: string[];
  migrations_count: number;
}

export function extractPhpConventions(
  files: { path: string }[],
): PhpConventions {
  const controllers: PhpConventions["controllers"] = [];
  const middleware: PhpConventions["middleware"] = [];
  const models: PhpConventions["models"] = [];
  const routes_files: string[] = [];
  let migrations_count = 0;

  for (const f of files) {
    const name = f.path.split("/").pop()?.replace(/\.php$/, "") ?? "";

    if (/Controller\.php$/.test(f.path)) {
      controllers.push({ name, path: f.path });
    }
    if (/(^|\/)[Mm]iddleware\//.test(f.path) && f.path.endsWith(".php")) {
      middleware.push({ name, path: f.path });
    }
    if (/(^|\/)[Mm]odels?\//.test(f.path) && f.path.endsWith(".php")) {
      models.push({ name, path: f.path });
    }
    if (/(^|\/)routes\//.test(f.path) && f.path.endsWith(".php")) {
      routes_files.push(f.path);
    }
    if (/(^|\/)migrations?\//.test(f.path)) {
      migrations_count++;
    }
  }

  return { controllers, middleware, models, routes_files, migrations_count };
}

// ---------------------------------------------------------------------------
// Yii2 Convention Extractor
// ---------------------------------------------------------------------------

export interface Yii2Conventions extends PhpConventions {
  framework_type: "yii2";
  modules: { name: string; path: string }[];
  widgets: { name: string; path: string }[];
  behaviors: { name: string; path: string }[];
  components: { name: string; path: string }[];
  assets: { name: string; path: string }[];
  config_files: string[];
}

export function extractYii2Conventions(
  files: { path: string }[],
): Yii2Conventions {
  const base = extractPhpConventions(files);
  const modules: Yii2Conventions["modules"] = [];
  const widgets: Yii2Conventions["widgets"] = [];
  const behaviors: Yii2Conventions["behaviors"] = [];
  const components: Yii2Conventions["components"] = [];
  const assets: Yii2Conventions["assets"] = [];
  const config_files: string[] = [];

  for (const f of files) {
    const name = f.path.split("/").pop()?.replace(/\.php$/, "") ?? "";

    // Modules: Module.php in modules/*/ directories
    if (/(^|\/)modules\/[^/]+\/Module\.php$/.test(f.path)) {
      modules.push({ name, path: f.path });
    }

    // Widgets: files in widgets/ directories or named *Widget.php
    if ((/(^|\/)widgets\//.test(f.path) || /Widget\.php$/.test(f.path)) && f.path.endsWith(".php")) {
      widgets.push({ name, path: f.path });
    }

    // Behaviors: files in behaviors/ directories or named *Behavior.php
    if ((/(^|\/)behaviors\//.test(f.path) || /Behavior\.php$/.test(f.path)) && f.path.endsWith(".php")) {
      behaviors.push({ name, path: f.path });
    }

    // Components: files in components/ directory
    if (/(^|\/)components\//.test(f.path) && f.path.endsWith(".php")) {
      components.push({ name, path: f.path });
    }

    // Assets: files named *Asset.php in assets/ directory
    if (/(^|\/)assets\//.test(f.path) && /Asset\.php$/.test(f.path)) {
      assets.push({ name, path: f.path });
    }

    // Config files
    if (/config\/(web|console|db|params|main|test)\.php$/.test(f.path)) {
      config_files.push(f.path);
    }
  }

  return {
    ...base,
    framework_type: "yii2",
    modules,
    widgets,
    behaviors,
    components,
    assets,
    config_files,
  };
}

// ---------------------------------------------------------------------------
// Identity Extractor
// ---------------------------------------------------------------------------

async function extractIdentity(projectRoot: string): Promise<ProjectIdentity> {
  const pkg = await readJson(join(projectRoot, "package.json"));
  const projectName = pkg?.name ?? projectRoot.split("/").pop() ?? "unknown";

  // Detect monorepo
  const isMonorepo = !!(pkg?.workspaces || await fileExists(join(projectRoot, "pnpm-workspace.yaml")));

  // Git remote
  let gitRemote: string | null = null;
  try {
    gitRemote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: projectRoot, timeout: 3000,
    }).toString().trim().replace(/\.git$/, "").replace(/^git@github\.com:/, "github.com/") || null;
  } catch { /* not a git repo or no remote */ }

  return {
    project_name: projectName,
    project_type: isMonorepo ? "monorepo" : "single",
    workspace_root: projectRoot,
    git_remote: gitRemote,
  };
}

// ---------------------------------------------------------------------------
// Dependency Graph Extractor
// ---------------------------------------------------------------------------

function extractDependencyGraph(index: CodeIndex): DependencyGraph {
  // Entry points: files matching app/main/server/index at shallow depth
  const entry_points: string[] = [];
  const importCount = new Map<string, number>();

  // Count imports per file from symbols
  for (const sym of index.symbols) {
    if (sym.source) {
      const importMatches = sym.source.match(/from\s+['"]([^'"]+)['"]/g);
      if (importMatches) {
        for (const m of importMatches) {
          const path = m.replace(/from\s+['"]/, "").replace(/['"]$/, "");
          // Resolve relative imports to file paths
          if (path.startsWith(".")) {
            const resolved = join(sym.file.replace(/\/[^/]+$/, ""), path).replace(/\.(js|ts|tsx|jsx)$/, "");
            importCount.set(resolved, (importCount.get(resolved) ?? 0) + 1);
          }
        }
      }
    }
  }

  // Find entry points
  for (const f of index.files) {
    if (/\/(app|main|server)\.(ts|js|tsx)$/.test(f.path)) entry_points.push(f.path);
    if (/^(src\/)?index\.(ts|js)$/.test(f.path)) entry_points.push(f.path);
  }

  // Hub modules: files imported by many others
  const hub_modules = [...importCount.entries()]
    .filter(([, count]) => count >= 5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([path, count]) => ({ path, imported_by_count: count }));

  // Leaf modules: files that import others but are not imported themselves
  const importedFiles = new Set(importCount.keys());
  const leaf_modules = index.files
    .filter((f) => !importedFiles.has(f.path.replace(/\.(ts|js|tsx|jsx)$/, "")) && !/(test|spec)\.(ts|js)$/.test(f.path))
    .slice(0, 30)
    .map((f) => f.path);

  // Orphan files: files with no imports AND not imported
  const orphan_files = index.files
    .filter((f) => {
      const base = f.path.replace(/\.(ts|js|tsx|jsx)$/, "");
      return !importedFiles.has(base) && f.symbol_count === 0 && !/(test|spec)\.(ts|js)$/.test(f.path);
    })
    .slice(0, 20)
    .map((f) => f.path);

  return { entry_points, hub_modules, leaf_modules, orphan_files };
}

// ---------------------------------------------------------------------------
// Test Conventions Extractor
// ---------------------------------------------------------------------------

async function extractTestConventions(
  projectRoot: string,
  index: CodeIndex,
): Promise<TestConventions> {
  const testFiles = index.files.filter((f) => /(test|spec)\.(ts|js|tsx|jsx)$/.test(f.path));
  const file_patterns = [...new Set(testFiles.map((f) => {
    if (f.path.includes(".test.")) return "*.test.*";
    if (f.path.includes(".spec.")) return "*.spec.*";
    return "*.test.*";
  }))];

  // Find setup files
  const setup_files: string[] = [];
  for (const f of index.files) {
    if (/setup\.(ts|js)$/.test(f.path) && !/(node_modules|dist|\.next)/.test(f.path)) {
      setup_files.push(f.path);
    }
    if (/vitest\.setup\.(ts|js)$/.test(f.path)) setup_files.push(f.path);
    if (/jest\.setup\.(ts|js)$/.test(f.path)) setup_files.push(f.path);
  }

  // Detect mock style and common patterns by reading a few test files
  let mock_style: string | null = null;
  const mock_patterns: TestConventions["mock_patterns"] = [];
  const common_mocks_set = new Set<string>();

  // Read up to 5 test files to detect patterns
  const sampleTests = testFiles
    .filter((f) => f.path.includes("service") || f.path.includes("controller") || f.path.includes("guard"))
    .slice(0, 5);

  for (const tf of sampleTests) {
    try {
      const content = await readFile(join(projectRoot, tf.path), "utf-8");

      // Mock style
      if (!mock_style) {
        if (content.includes("vi.mock")) mock_style = "vi.mock";
        else if (content.includes("jest.mock")) mock_style = "jest.mock";
        else if (content.includes("sinon")) mock_style = "sinon";
      }

      // Common mock patterns — extract vi.mock/jest.mock calls
      const mockCalls = content.match(/(?:vi|jest)\.mock\s*\(\s*['"]([^'"]+)['"]/g);
      if (mockCalls) {
        for (const mc of mockCalls) {
          const path = mc.match(/['"]([^'"]+)['"]/)?.[1];
          if (path) common_mocks_set.add(path);
        }
      }

      // Detect specific patterns
      if (content.includes("mockPrismaClient") || content.includes("prismaMock")) {
        if (!mock_patterns.some((p) => p.name === "prisma")) {
          mock_patterns.push({ name: "prisma", import_from: "setup or inline", usage: "mockPrismaClient / prismaMock" });
        }
      }
      if (content.includes("mockDeep") || content.includes("DeepMockProxy")) {
        if (!mock_patterns.some((p) => p.name === "deep-mock")) {
          mock_patterns.push({ name: "deep-mock", import_from: "vitest-mock-extended or jest-mock-extended", usage: "mockDeep<Type>()" });
        }
      }
      if (content.includes("$transaction") && content.includes("mock")) {
        if (!mock_patterns.some((p) => p.name === "transaction")) {
          mock_patterns.push({ name: "transaction", import_from: "prisma mock", usage: "$transaction mock for DB operations" });
        }
      }
    } catch { /* skip unreadable files */ }
  }

  // Also check setup files for shared patterns
  for (const sf of setup_files) {
    try {
      const content = await readFile(join(projectRoot, sf), "utf-8");
      const exports = content.match(/export\s+(?:const|function|class)\s+(\w+)/g);
      if (exports) {
        for (const exp of exports) {
          const name = exp.match(/(\w+)$/)?.[1];
          if (name && /mock|stub|fake|fixture|factory/i.test(name)) {
            mock_patterns.push({ name, import_from: sf, usage: "shared test helper" });
          }
        }
      }
    } catch { /* skip */ }
  }

  // Determine assertion library from stack
  const pkg = await readJson(join(projectRoot, "package.json"));
  const devDeps = pkg?.devDependencies ?? {};
  let assertion_library = "expect"; // default
  if (devDeps["vitest"]) assertion_library = "vitest/expect";
  else if (devDeps["jest"]) assertion_library = "jest/expect";
  else if (devDeps["chai"]) assertion_library = "chai";

  return {
    mock_style,
    setup_files,
    mock_patterns: mock_patterns.slice(0, 10),
    assertion_library,
    file_patterns,
    common_mocks: [...common_mocks_set].slice(0, 20),
  };
}

// ---------------------------------------------------------------------------
// Known Gotchas Extractor
// ---------------------------------------------------------------------------

function extractKnownGotchas(index: CodeIndex): KnownGotchas {
  const gotchas: KnownGotchas["auto_detected"] = [];

  // Check for common gotcha patterns in symbols
  for (const sym of index.symbols) {
    if (!sym.source) continue;

    // as any casts in production code (not tests)
    if (/(test|spec)\.(ts|js)$/.test(sym.file)) continue;

    // Detect patterns that are known gotchas
    if (/process\.env\.\w+/.test(sym.source) && !/config|env\.schema|validate/.test(sym.file)) {
      if (!gotchas.some((g) => g.gotcha.includes("scattered process.env"))) {
        gotchas.push({
          gotcha: "scattered process.env access outside config module",
          evidence: [sym.file],
          severity: "medium",
        });
      }
    }
  }

  // Check for common project-level gotchas
  const hasEslintIgnore = index.files.some((f) => f.path.includes(".eslintignore"));
  if (hasEslintIgnore) {
    gotchas.push({
      gotcha: ".eslintignore present — some files bypass linting",
      evidence: [".eslintignore"],
      severity: "low",
    });
  }

  return { auto_detected: gotchas.slice(0, 10) };
}

// ---------------------------------------------------------------------------
// Dependency Health
// ---------------------------------------------------------------------------

async function extractDependencyHealth(projectRoot: string): Promise<DependencyHealth | null> {
  const pkg = await readJson(join(projectRoot, "package.json"));
  if (!pkg) {
    // Try Python
    const pyproject = await readJson(join(projectRoot, "pyproject.toml"));
    if (!pyproject) return null;
    return { total: 0, prod: 0, dev: 0, key_versions: {} };
  }

  const prod = Object.keys(pkg.dependencies ?? {});
  const dev = Object.keys(pkg.devDependencies ?? {});
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  // Extract key versions — frameworks, runtimes, major tools
  const keyPackages = [
    "react", "next", "hono", "@nestjs/core", "express", "vue", "angular",
    "typescript", "vitest", "jest", "prisma", "@prisma/client",
    "tailwindcss", "@anthropic-ai/sdk", "openai",
    "stripe", "inngest", "@clerk/nextjs", "@clerk/backend",
    "@sentry/nextjs", "@sentry/nestjs", "drizzle-orm",
  ];

  const key_versions: Record<string, string> = {};
  for (const k of keyPackages) {
    if (allDeps[k]) key_versions[k] = allDeps[k];
  }

  return {
    total: prod.length + dev.length,
    prod: prod.length,
    dev: dev.length,
    key_versions,
  };
}

// ---------------------------------------------------------------------------
// Git Health
// ---------------------------------------------------------------------------

function extractGitHealth(projectRoot: string): GitHealth | null {
  try {
    const totalStr = execFileSync("git", ["rev-list", "--count", "HEAD"], {
      cwd: projectRoot, timeout: 5000,
    }).toString().trim();

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const recentStr = execFileSync("git", ["rev-list", "--count", `--since=${thirtyDaysAgo}`, "HEAD"], {
      cwd: projectRoot, timeout: 5000,
    }).toString().trim();

    const lastCommitDate = execFileSync("git", ["log", "-1", "--format=%aI"], {
      cwd: projectRoot, timeout: 5000,
    }).toString().trim();

    const contributorsStr = execFileSync("git", ["shortlog", "-sn", "--no-merges", "HEAD"], {
      cwd: projectRoot, timeout: 10000,
    }).toString().trim();
    const contributors = contributorsStr.split("\n").filter(Boolean).length;

    return {
      total_commits: parseInt(totalStr) || 0,
      recent_commits_30d: parseInt(recentStr) || 0,
      last_commit_date: lastCommitDate || null,
      contributors,
    };
  } catch {
    return null;
  }
}

function inferScope(path: string): string {
  if (path === "*") return "global";
  if (path.includes("/admin")) return "admin";
  if (path.includes("/webhook")) return "webhook";
  if (path.includes("/health")) return "health";
  if (path.includes("/public") || path.includes("/contests") || path.includes("/translations") || path.includes("/r/")) return "public";
  // Default: extract first meaningful segment
  const segments = path.split("/").filter(Boolean);
  if (segments.length >= 2) return segments[1]!;
  return "root";
}

// ---------------------------------------------------------------------------
// Main orchestrator: analyze_project
// ---------------------------------------------------------------------------

export async function analyzeProject(
  repoName: string,
  _options: { force?: boolean | undefined } = {},
): Promise<ProfileSummary> {
  const startTime = Date.now();
  let files_analyzed = 0;
  let files_skipped = 0;
  const skip_reasons: Record<string, number> = {};

  const index = await getCodeIndex(repoName);
  if (!index) {
    const failedProfile: ProjectProfile = {
      version: "1.0",
      generated_at: new Date().toISOString(),
      generated_by: {
        tool: "codesift",
        tool_version: "1.0.0",
        extractor_versions: { ...EXTRACTOR_VERSIONS },
      },
      compatible_with: ">=1.0, <2.0",
      status: "failed",
      generation_metadata: {
        files_analyzed: 0,
        files_skipped: 0,
        skip_reasons: { no_index: 1 },
        duration_ms: Date.now() - startTime,
      },
    };
    return buildSummary(failedProfile, "(not written — no index)");
  }

  // Prefer real project root over conversation index root (~/.claude/projects/...)
  // The conversation index root points to Claude's project dir, not the actual git repo
  let projectRoot = index.root;
  if (projectRoot.includes("/.claude/projects/")) {
    // Fall back to CWD which is the actual project directory
    projectRoot = process.cwd();
  }
  files_analyzed = index.file_count;

  // Step 0: Identity
  const identity = await extractIdentity(projectRoot);

  // Step 1: Stack detection
  const stack = await detectStack(projectRoot);

  // Step 2: File classification
  const file_classifications = classifyFiles(index);

  // Step 2b: Dependency graph
  const dependency_graph = extractDependencyGraph(index);

  // Step 2c: Test conventions
  const test_conventions = await extractTestConventions(projectRoot, index);

  // Step 2d: Known gotchas
  const known_gotchas = extractKnownGotchas(index);

  // Step 3: Framework-specific convention extraction
  let conventions: Conventions | undefined;
  let nestConventions: NestConventions | undefined;
  let nextConventions: NextConventions | undefined;
  let expressConventions: ExpressConventions | undefined;
  let reactConventions: ReactConventions | undefined;
  let pythonConventions: PythonConventions | undefined;
  let phpConventions: PhpConventions | undefined;
  let status: ProjectProfile["status"] = "complete";

  const fw = stack.framework;

  try {
    if (fw === "hono") {
      const orchestratorFile = file_classifications.critical.find((f) => f.code_type === "ORCHESTRATOR");
      if (orchestratorFile) {
        const appSource = await readFile(join(projectRoot, orchestratorFile.path), "utf-8");
        conventions = extractHonoConventions(appSource, orchestratorFile.path);
      } else {
        status = "partial";
        skip_reasons["no_orchestrator_file"] = 1;
      }
    } else if (fw === "nestjs") {
      const moduleFile = index.files.find((f) => f.path.endsWith("app.module.ts"));
      if (moduleFile) {
        const moduleSource = await readFile(join(projectRoot, moduleFile.path), "utf-8");
        nestConventions = extractNestConventions(moduleSource, moduleFile.path);
      } else {
        status = "partial";
        skip_reasons["no_app_module_file"] = 1;
      }
    } else if (fw === "nextjs") {
      nextConventions = extractNextConventions(projectRoot, index.files);
    } else if (fw === "express") {
      const entryFile = file_classifications.critical.find((f) => f.code_type === "ORCHESTRATOR")
        ?? index.files.find((f) => /\/(app|server|index)\.(ts|js)$/.test(f.path));
      if (entryFile) {
        const appSource = await readFile(join(projectRoot, entryFile.path), "utf-8");
        expressConventions = extractExpressConventions(appSource, entryFile.path);
      } else {
        status = "partial";
        skip_reasons["no_entry_file"] = 1;
      }
    } else if (fw === "react") {
      const pkg = await readJson(join(projectRoot, "package.json"));
      const allDeps = { ...pkg?.dependencies, ...pkg?.devDependencies };
      reactConventions = extractReactConventions(index.files, allDeps, index.symbols);
    } else if (fw === "fastapi" || fw === "django" || fw === "flask") {
      pythonConventions = extractPythonConventions(index.files);
    } else if (fw === "yii2") {
      phpConventions = extractYii2Conventions(index.files);
    } else if (fw === "laravel" || fw === "symfony") {
      phpConventions = extractPhpConventions(index.files);
    } else {
      status = "partial";
    }
  } catch {
    status = "partial";
    skip_reasons[`${fw ?? "unknown"}_extractor_error`] = 1;
  }

  const profile: ProjectProfile = {
    version: "1.0",
    generated_at: new Date().toISOString(),
    generated_by: {
      tool: "codesift",
      tool_version: "1.0.0",
      extractor_versions: { ...EXTRACTOR_VERSIONS },
    },
    compatible_with: ">=1.0, <2.0",
    status,
    identity,
    stack,
    file_classifications,
    dependency_graph,
    test_conventions,
    known_gotchas,
    ...(conventions ? { conventions } : {}),
    ...(nestConventions ? { nest_conventions: nestConventions } : {}),
    ...(nextConventions ? { next_conventions: nextConventions } : {}),
    ...(expressConventions ? { express_conventions: expressConventions } : {}),
    ...(reactConventions ? { react_conventions: reactConventions } : {}),
    ...(pythonConventions ? { python_conventions: pythonConventions } : {}),
    ...(phpConventions ? { php_conventions: phpConventions } : {}),
    dependency_health: await extractDependencyHealth(projectRoot) ?? undefined,
    git_health: extractGitHealth(projectRoot) ?? undefined,
    generation_metadata: {
      files_analyzed,
      files_skipped,
      skip_reasons,
      duration_ms: Date.now() - startTime,
    },
  } as ProjectProfile;

  // Write full profile to disk — MCP returns only summary
  const profilePath = await writeProfileToDisk(projectRoot, profile);

  return buildSummary(profile, profilePath);
}

// ---------------------------------------------------------------------------
// Disk persistence — write profile to .zuvo/project-profile.json
// ---------------------------------------------------------------------------

async function writeProfileToDisk(projectRoot: string, profile: ProjectProfile): Promise<string> {
  const zuvoDir = join(projectRoot, ".zuvo");
  await mkdir(zuvoDir, { recursive: true });
  const profilePath = join(zuvoDir, "project-profile.json");
  await writeFile(profilePath, JSON.stringify(profile, null, 2), "utf-8");
  return profilePath;
}

// ---------------------------------------------------------------------------
// Summary — compact return value for MCP (full profile is on disk)
// ---------------------------------------------------------------------------

export interface ProfileSummary {
  status: ProjectProfile["status"];
  profile_path: string;
  stack: {
    framework: string | null;
    language: string;
    test_runner: string | null;
    package_manager: string | null;
    monorepo: boolean;
  };
  file_counts: {
    critical: number;
    important: number;
    routine: number;
    total_analyzed: number;
  };
  conventions_summary: Record<string, unknown> | null;
  dependency_health: { total: number; prod: number; dev: number; key_count: number } | null;
  git_health: GitHealth | null;
  duration_ms: number;
}

function buildConventionsSummary(profile: ProjectProfile): ProfileSummary["conventions_summary"] {
  const p = profile as any;
  if (p.conventions) return {
    middleware_chains: p.conventions.middleware_chains.length,
    rate_limits: p.conventions.rate_limits.length,
    route_mounts: p.conventions.route_mounts.length,
    auth_groups: Object.keys(p.conventions.auth_patterns.groups).length,
  };
  if (p.nest_conventions) return {
    type: "nestjs",
    modules: p.nest_conventions.modules.length,
    global_guards: p.nest_conventions.global_guards.length,
    global_filters: p.nest_conventions.global_filters.length,
    global_interceptors: p.nest_conventions.global_interceptors.length,
    controllers: p.nest_conventions.controllers.length,
    has_throttler: !!p.nest_conventions.throttler,
  };
  if (p.next_conventions) return {
    type: "nextjs",
    pages: p.next_conventions.pages.length,
    api_routes: p.next_conventions.api_routes.length,
    services: p.next_conventions.services_count,
    inngest_functions: p.next_conventions.inngest_functions.length,
    webhooks: p.next_conventions.webhooks.length,
    has_middleware: !!p.next_conventions.middleware,
    app_router: p.next_conventions.config.app_router,
    i18n: p.next_conventions.config.i18n,
  };
  if (p.express_conventions) return {
    type: "express",
    middleware: p.express_conventions.middleware.length,
    routers: p.express_conventions.routers.length,
    error_handlers: p.express_conventions.error_handlers.length,
  };
  if (p.react_conventions) return {
    type: "react",
    ...p.react_conventions.component_count,
    state_management: p.react_conventions.state_management,
    ui_library: p.react_conventions.ui_library,
  };
  if (p.python_conventions) return {
    type: "python",
    routers: p.python_conventions.routers.length,
    middleware: p.python_conventions.middleware.length,
    framework_type: p.python_conventions.framework_type,
  };
  if (p.php_conventions) return {
    type: "php",
    controllers: p.php_conventions.controllers.length,
    middleware: p.php_conventions.middleware.length,
    models: p.php_conventions.models.length,
    migrations: p.php_conventions.migrations_count,
  };
  return null;
}

function buildSummary(profile: ProjectProfile, profilePath: string): ProfileSummary {
  return {
    status: profile.status,
    profile_path: profilePath,
    stack: {
      framework: profile.stack?.framework ?? null,
      language: profile.stack?.language ?? "unknown",
      test_runner: profile.stack?.test_runner ?? null,
      package_manager: profile.stack?.package_manager ?? null,
      monorepo: !!profile.stack?.monorepo,
    },
    file_counts: {
      critical: profile.file_classifications?.critical.length ?? 0,
      important: profile.file_classifications?.important.count ?? 0,
      routine: profile.file_classifications?.routine.count ?? 0,
      total_analyzed: profile.generation_metadata.files_analyzed,
    },
    conventions_summary: buildConventionsSummary(profile),
    dependency_health: (profile as any).dependency_health ? {
      total: (profile as any).dependency_health.total,
      prod: (profile as any).dependency_health.prod,
      dev: (profile as any).dependency_health.dev,
      key_count: Object.keys((profile as any).dependency_health.key_versions).length,
    } : null,
    git_health: (profile as any).git_health ?? null,
    duration_ms: profile.generation_metadata.duration_ms,
  };
}

// ---------------------------------------------------------------------------
// get_extractor_versions — fast metadata call
// ---------------------------------------------------------------------------

/**
 * Languages with a tree-sitter parser extractor — these get symbol-level
 * indexing (search_symbols, get_file_outline, get_symbol, find_references, etc.).
 */
export const PARSER_LANGUAGES = [
  "typescript",
  "javascript",
  "python",
  "go",
  "rust",
  "php",
  "kotlin",
  "prisma",
  "markdown",
  "astro",
] as const;

/**
 * Languages indexed as FileEntry (so get_file_tree and search_text with
 * file_pattern work) but WITHOUT symbol extraction. Ripgrep-backed search_text
 * and scan_secrets work on these via filesystem. Upgrade path: add a
 * tree-sitter grammar .wasm and extractor to move a language to PARSER_LANGUAGES.
 */
export const TEXT_STUB_LANGUAGES = [
  "swift", "dart", "scala", "clojure",
  "elixir", "lua", "zig", "nim", "gradle", "sbt",
] as const;

export interface ExtractorVersionsResponse {
  /** Tree-sitter language parsers — affect symbol-based tools only */
  parser_languages: readonly string[];
  /** Indexed (file listing + text search) but no symbol extraction yet */
  text_stub_languages: readonly string[];
  /** Framework detectors used by analyze_project (project profile) */
  profile_frameworks: Record<string, string>;
  /**
   * Important note for agents: text-based tools work on ALL files regardless
   * of parser_languages. Missing a language here does NOT mean CodeSift is
   * useless for that project — it just means no symbol indexing.
   */
  note: string;
  /** Backward compat: flat version dict matching legacy shape */
  versions: Record<string, string>;
}

export function getExtractorVersions(): ExtractorVersionsResponse {
  return {
    parser_languages: PARSER_LANGUAGES,
    text_stub_languages: TEXT_STUB_LANGUAGES,
    profile_frameworks: { ...EXTRACTOR_VERSIONS },
    note:
      "search_text, get_file_tree, search_conversations, and scan_secrets work on ALL indexed files " +
      "(both parser_languages AND text_stub_languages). Only symbol-based tools (search_symbols, " +
      "get_file_outline, get_symbol, find_references, trace_call_chain) require a full parser " +
      "extractor, so they return nothing for text_stub_languages. profile_frameworks is the list " +
      "of framework detectors used by analyze_project — NOT a list of supported languages.",
    versions: { ...EXTRACTOR_VERSIONS },
  };
}
