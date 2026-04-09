/**
 * Project Profile Analysis Tools
 *
 * Deterministic extraction of project stack, file classifications, and
 * framework-specific conventions. Produces a JSON profile conforming to
 * the zuvo project-profile schema v1.0.
 */

import { readFile, stat, access } from "node:fs/promises";
import { join, basename, dirname, relative, extname } from "node:path";
import { getCodeIndex, listAllRepos } from "./index-tools.js";
import type { CodeIndex, CodeSymbol, FileEntry } from "../types.js";

// ---------------------------------------------------------------------------
// Versioning — used by get_extractor_versions
// ---------------------------------------------------------------------------

export const EXTRACTOR_VERSIONS = {
  stack_detector: "1.0.0",
  file_classifier: "1.0.0",
  hono: "1.0.0",
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

  stack?: StackInfo;
  file_classifications?: FileClassifications;
  conventions?: Conventions;
  generation_metadata: GenerationMetadata;
}

export interface StackInfo {
  framework: string | null;
  framework_version: string | null;
  language: string;
  language_version: string | null;
  test_runner: string | null;
  package_manager: string | null;
  monorepo: { tool: string | null; workspaces: string[] } | null;
  detected_from: string[];
}

export interface FileClassifications {
  critical: ClassifiedFile[];
  important: ClassifiedFile[];
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

  // Language detection
  let language = "javascript";
  let language_version: string | null = null;
  const tsconfig = await readJson(join(projectRoot, "tsconfig.json"));
  if (tsconfig) {
    language = "typescript";
    language_version = tsconfig?.compilerOptions?.target ?? null;
    detected_from.push("tsconfig.json");
  }

  // Test runner detection
  let test_runner: string | null = null;
  if (pkg) {
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

  return {
    framework,
    framework_version,
    language,
    language_version,
    test_runner,
    package_manager,
    monorepo,
    detected_from,
  };
}

// ---------------------------------------------------------------------------
// File Classifier
// ---------------------------------------------------------------------------

const CRITICAL_PATH_PATTERNS = [
  /\/(app|main|server|index)\.(ts|js|tsx|jsx)$/,
  /\/middleware\//,
  /\/security\//,
  /\/auth\//,
  /\/crypto\//,
];

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

function classifyCodeType(path: string, symbol_count: number): string {
  const base = basename(path);
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
    const isCritical = CRITICAL_PATH_PATTERNS.some((p) => p.test(file.path)) || dependents > 5;
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

  return {
    critical,
    important,
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
    const line = lines[i];
    const lineNum = i + 1;

    // Match app.use("path", handler) or app.route("path", router)
    const useMatch = line.match(/app\.(use|route|get|post|put|delete|all)\s*\(\s*["']([^"']+)["']\s*,\s*(.+)/);
    if (useMatch) {
      // Clean trailing ); but preserve function call parens like rateLimit(3, 3600)
      let args = useMatch[3].trim().replace(/\);?\s*$/, "").trim();
      calls.push({
        type: useMatch[1] as HonoCall["type"],
        path: useMatch[2],
        args,
        line: lineNum,
      });
      continue;
    }

    // Match app.use("*", handler) — global middleware
    const globalUseMatch = line.match(/app\.use\s*\(\s*["']\*["']\s*,\s*(.+)/);
    if (globalUseMatch) {
      let args = globalUseMatch[1].trim().replace(/\);?\s*$/, "").trim();
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
        type: inlineMatch[1] as HonoCall["type"],
        path: inlineMatch[2],
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
  if (funcCall) return funcCall[1];
  // Handle simple identifier: clerkAuth
  const simple = args.match(/^(\w+)$/);
  if (simple) return simple[1];
  return null;
}

function extractRateLimit(args: string): { max: number; window: number } | null {
  const match = args.match(/rateLimit\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if (match) return { max: parseInt(match[1]), window: parseInt(match[2]) };
  return null;
}

export function extractHonoConventions(
  source: string,
  filePath: string,
): Conventions {
  const calls = parseHonoCalls(source);

  const middleware_chains: MiddlewareChain[] = [];
  const rate_limits: RateLimitEntry[] = [];
  const route_mounts: RouteMountEntry[] = [];
  const authGroups: Record<string, { requires_auth: boolean; middleware: string[] }> = {};
  let auth_middleware: string | null = null;

  // Group middleware by scope
  const scopeChains = new Map<string, { name: string; line: number; order: number }[]>();

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
          method: null, // .use() doesn't bind to a specific method
        });
      } else if (mwName) {
        const scope = call.path === "*" ? "global" : inferScope(call.path ?? "");
        const currentOrder = scope === "global"
          ? ++globalOrder
          : (scopeOrders.set(scope, (scopeOrders.get(scope) ?? 0) + 1), scopeOrders.get(scope)!);

        if (!scopeChains.has(scope)) scopeChains.set(scope, []);
        scopeChains.get(scope)!.push({ name: mwName, line: call.line, order: currentOrder });

        // Detect auth middleware
        if (/auth|clerk|jwt|session|passport/i.test(mwName)) {
          auth_middleware = mwName;
          const group = inferScope(call.path ?? "");
          if (!authGroups[group]) authGroups[group] = { requires_auth: false, middleware: [] };
          authGroups[group].requires_auth = true;
          authGroups[group].middleware.push(mwName);
        } else if (scope !== "global") {
          const group = scope;
          if (!authGroups[group]) authGroups[group] = { requires_auth: false, middleware: [] };
          authGroups[group].middleware.push(mwName);
        }
      }
    } else if (call.type === "route") {
      route_mounts.push({
        file: filePath,
        line: call.line,
        mount_path: call.path ?? "",
        imported_from: call.args.includes("/") ? call.args : null,
        exported_as: call.args.includes("/") ? null : call.args,
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

function inferScope(path: string): string {
  if (path === "*") return "global";
  if (path.includes("/admin")) return "admin";
  if (path.includes("/webhook")) return "webhook";
  if (path.includes("/health")) return "health";
  if (path.includes("/public") || path.includes("/contests") || path.includes("/translations") || path.includes("/r/")) return "public";
  // Default: extract first meaningful segment
  const segments = path.split("/").filter(Boolean);
  if (segments.length >= 2) return segments[1];
  return "root";
}

// ---------------------------------------------------------------------------
// Main orchestrator: analyze_project
// ---------------------------------------------------------------------------

export async function analyzeProject(
  repoName: string,
  options: { force?: boolean } = {},
): Promise<ProjectProfile> {
  const startTime = Date.now();
  let files_analyzed = 0;
  let files_skipped = 0;
  const skip_reasons: Record<string, number> = {};

  const index = await getCodeIndex(repoName);
  if (!index) {
    return {
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
  }

  const projectRoot = index.root;
  files_analyzed = index.file_count;

  // Step 1: Stack detection
  const stack = await detectStack(projectRoot);

  // Step 2: File classification
  const file_classifications = classifyFiles(index);

  // Step 3: Framework-specific convention extraction
  let conventions: Conventions | undefined;
  let status: ProjectProfile["status"] = "complete";

  if (stack.framework === "hono") {
    // Find the ORCHESTRATOR file from critical tier
    const orchestratorFile = file_classifications.critical.find(
      (f) => f.code_type === "ORCHESTRATOR",
    );

    if (orchestratorFile) {
      try {
        const appSource = await readFile(
          join(projectRoot, orchestratorFile.path),
          "utf-8",
        );
        conventions = extractHonoConventions(appSource, orchestratorFile.path);
      } catch (err) {
        status = "partial";
        skip_reasons["hono_extractor_error"] = 1;
      }
    } else {
      status = "partial";
      skip_reasons["no_orchestrator_file"] = 1;
    }
  } else {
    // No framework-specific extractor available
    status = "partial";
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
    stack,
    file_classifications,
    ...(conventions ? { conventions } : {}),
    generation_metadata: {
      files_analyzed,
      files_skipped,
      skip_reasons,
      duration_ms: Date.now() - startTime,
    },
  };

  return profile;
}

// ---------------------------------------------------------------------------
// get_extractor_versions — fast metadata call
// ---------------------------------------------------------------------------

export function getExtractorVersions(): Record<string, string> {
  return { ...EXTRACTOR_VERSIONS };
}
