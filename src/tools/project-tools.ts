/**
 * Project Profile Analysis Tools
 *
 * Deterministic extraction of project stack, file classifications, and
 * framework-specific conventions. Produces a JSON profile conforming to
 * the zuvo project-profile schema v1.0.
 */

import { readFile, writeFile, access, readdir, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { getCodeIndex } from "./index-tools.js";
import type { CodeIndex } from "../types.js";

// ---------------------------------------------------------------------------
// Versioning — used by get_extractor_versions
// ---------------------------------------------------------------------------

export const EXTRACTOR_VERSIONS = {
  stack_detector: "1.0.0",
  file_classifier: "1.0.0",
  hono: "1.0.0",
  nestjs: "1.0.0",
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

// NestJS-specific conventions
export interface NestConventions {
  modules: NestModuleEntry[];
  global_guards: NestProviderEntry[];
  global_filters: NestProviderEntry[];
  global_pipes: NestProviderEntry[];
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
    }
  }

  return { modules, global_guards, global_filters, global_pipes, controllers, throttler };
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

  // Step 1: Stack detection
  const stack = await detectStack(projectRoot);

  // Step 2: File classification
  const file_classifications = classifyFiles(index);

  // Step 3: Framework-specific convention extraction
  let conventions: Conventions | undefined;
  let nestConventions: NestConventions | undefined;
  let status: ProjectProfile["status"] = "complete";

  if (stack.framework === "hono") {
    const orchestratorFile = file_classifications.critical.find(
      (f) => f.code_type === "ORCHESTRATOR",
    );
    if (orchestratorFile) {
      try {
        const appSource = await readFile(join(projectRoot, orchestratorFile.path), "utf-8");
        conventions = extractHonoConventions(appSource, orchestratorFile.path);
      } catch {
        status = "partial";
        skip_reasons["hono_extractor_error"] = 1;
      }
    } else {
      status = "partial";
      skip_reasons["no_orchestrator_file"] = 1;
    }
  } else if (stack.framework === "nestjs") {
    // Find app.module.ts
    const moduleFile = index.files.find((f) => f.path.endsWith("app.module.ts"));
    if (moduleFile) {
      try {
        const moduleSource = await readFile(join(projectRoot, moduleFile.path), "utf-8");
        nestConventions = extractNestConventions(moduleSource, moduleFile.path);
      } catch {
        status = "partial";
        skip_reasons["nestjs_extractor_error"] = 1;
      }
    } else {
      status = "partial";
      skip_reasons["no_app_module_file"] = 1;
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
    ...(nestConventions ? { nest_conventions: nestConventions } : {}),
    generation_metadata: {
      files_analyzed,
      files_skipped,
      skip_reasons,
      duration_ms: Date.now() - startTime,
    },
  };

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
  conventions_summary: {
    middleware_chains: number;
    rate_limits: number;
    route_mounts: number;
    auth_groups: number;
  } | {
    modules: number;
    global_guards: number;
    global_filters: number;
    controllers: number;
    has_throttler: boolean;
  } | null;
  duration_ms: number;
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
      important: profile.file_classifications?.important.length ?? 0,
      routine: profile.file_classifications?.routine.count ?? 0,
      total_analyzed: profile.generation_metadata.files_analyzed,
    },
    conventions_summary: profile.conventions ? {
      middleware_chains: profile.conventions.middleware_chains.length,
      rate_limits: profile.conventions.rate_limits.length,
      route_mounts: profile.conventions.route_mounts.length,
      auth_groups: Object.keys(profile.conventions.auth_patterns.groups).length,
    } : (profile as any).nest_conventions ? {
      modules: (profile as any).nest_conventions.modules.length,
      global_guards: (profile as any).nest_conventions.global_guards.length,
      global_filters: (profile as any).nest_conventions.global_filters.length,
      controllers: (profile as any).nest_conventions.controllers.length,
      has_throttler: !!(profile as any).nest_conventions.throttler,
    } : null,
    duration_ms: profile.generation_metadata.duration_ms,
  };
}

// ---------------------------------------------------------------------------
// get_extractor_versions — fast metadata call
// ---------------------------------------------------------------------------

export function getExtractorVersions(): Record<string, string> {
  return { ...EXTRACTOR_VERSIONS };
}
