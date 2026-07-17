/**
 * Project Profile Analysis Tools
 *
 * Deterministic extraction of project stack, file classifications, and
 * framework-specific conventions. Produces a JSON profile conforming to
 * the zuvo project-profile schema v1.0.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { EXTRACTOR_VERSIONS } from "./index-shared.js";
import type { CodeIndex } from "../types.js";
import { extractAstroConventions } from "./astro-config.js";
import type { AstroConventions } from "./astro-config.js";
import {
  extractDependencyGraph,
  extractDependencyHealth,
  extractGitHealth,
  extractIdentity,
  extractKnownGotchas,
  extractTestConventions,
} from "./project-profile-extractors.js";
import { readJson } from "./project-profile-fs.js";
import { buildImporterCount, buildImporterCountFromSources } from "./project-profile-imports.js";
import { writeProfileToDisk } from "./project-profile-persistence.js";
import { buildSummary } from "./project-profile-summary.js";
import type { ProfileSummary } from "./project-profile-summary.js";
import { detectStack } from "./project-profile-stack.js";
import { extractHonoConventions, getHonoFallbackCount } from "./project-profile-hono.js";
import { extractNestConventions, parseMiddlewareChains } from "./project-profile-nest.js";
import { extractNextConventions } from "./project-profile-next.js";
import { extractExpressConventions } from "./project-profile-express.js";
import { extractReactConventions } from "./project-profile-react.js";
import { extractPythonConventions } from "./project-profile-python.js";
import { extractPhpConventions, extractYii2Conventions } from "./project-profile-php.js";
import type {
  ClassifiedFile,
  Conventions,
  ExpressConventions,
  FileClassifications,
  NestConventions,
  NextConventions,
  PhpConventions,
  ProjectProfile,
  PythonConventions,
  ReactConventions,
} from "./project-profile-types.js";

// ---------------------------------------------------------------------------
// Versioning — used by get_extractor_versions
// ---------------------------------------------------------------------------

export { EXTRACTOR_VERSIONS } from "./index-shared.js";
export { buildConventionsSummary } from "./project-profile-summary.js";
export type { ProfileSummary } from "./project-profile-summary.js";
export type {
  AuthPatterns,
  ClassifiedFile,
  Conventions,
  DependencyGraph,
  DependencyHealth,
  ExpressConventions,
  FileClassifications,
  GenerationMetadata,
  GitHealth,
  KnownGotchas,
  MiddlewareChain,
  MiddlewareChainEntry,
  NestConventions,
  NestModuleEntry,
  NestProviderEntry,
  NextConventions,
  PhpConventions,
  ProjectIdentity,
  ProjectProfile,
  PythonConventions,
  RateLimitEntry,
  ReactConventions,
  RouteMountEntry,
  StackInfo,
  TestConventions,
  Yii2Conventions,
} from "./project-profile-types.js";
export {
  detectStack,
  extractHonoConventions,
  getHonoFallbackCount,
  extractNestConventions,
  parseMiddlewareChains,
  extractNextConventions,
  extractExpressConventions,
  extractReactConventions,
  extractPythonConventions,
  extractPhpConventions,
  extractYii2Conventions,
};

// ---------------------------------------------------------------------------
// File Classifier
// ---------------------------------------------------------------------------

const CRITICAL_PATH_PATTERNS = [
  /(^|\/)(app|main|server)\.(ts|js|tsx|jsx)$/,
  /\/middleware\//,
  /\/security\//,
  /\/auth\//,
  /\/crypto\//,
];

/** index.ts is critical ONLY at shallow depth (src/index.ts, apps/api/src/index.ts) — not barrel re-exports */
function isEntryPointIndex(path: string): boolean {
  if (!/(^|\/)index\.(ts|js|tsx|jsx)$/.test(path)) return false;
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
  if (/(^|\/)(app|main|server)\.(ts|js)$/.test(path)) return "ORCHESTRATOR";
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

export function classifyFiles(
  index: CodeIndex,
  importerCount: Map<string, number> = buildImporterCountFromSources(index),
): FileClassifications {
  const critical: ClassifiedFile[] = [];
  const important: ClassifiedFile[] = [];
  const routineCounts: Record<string, number> = {};
  let routineCount = 0;

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

// Main orchestrator: analyze_project
// ---------------------------------------------------------------------------

// Cache for analyzeProject results, keyed by repoName. Invalidates whenever
// the underlying CodeIndex `updated_at` advances — i.e. whenever a file is
// re-indexed or indexFolder runs again. Telemetry showed 264 calls with p95
// of 30s; many calls are agents using analyze_project as a status check.
// Keyed by repoName so two repos in the same process don't share state.
interface AnalyzeProjectCacheEntry {
  updatedAt: number;
  profile: ProfileSummary;
}
const analyzeProjectCache = new Map<string, AnalyzeProjectCacheEntry>();

/** Test-only — clear the analyzeProject cache. */
export function resetAnalyzeProjectCacheForTesting(): void {
  analyzeProjectCache.clear();
}

async function getProjectCodeIndex(repoName: string): Promise<CodeIndex | null> {
  const { getCodeIndex } = await import("./index-tools.js");
  return getCodeIndex(repoName);
}

export async function analyzeProject(
  repoName: string,
  options: { force?: boolean | undefined } = {},
): Promise<ProfileSummary> {
  const startTime = Date.now();
  let files_analyzed = 0;
  let files_skipped = 0;
  const skip_reasons: Record<string, number> = {};

  const index = await getProjectCodeIndex(repoName);
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

  // Cache hit: reuse previous profile when the underlying index hasn't been
  // touched since we last computed. force=true bypasses (callers needing
  // fresh analysis even on an unchanged index, e.g. wiki regeneration).
  if (!options.force) {
    const cached = analyzeProjectCache.get(repoName);
    if (cached && cached.updatedAt === index.updated_at) {
      return cached.profile;
    }
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
  const importerCount = await buildImporterCount(index);
  const file_classifications = classifyFiles(index, importerCount);

  // Step 2b: Dependency graph
  const dependency_graph = extractDependencyGraph(index, importerCount);

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
  let astroConventions: AstroConventions | undefined;
  let status: ProjectProfile["status"] = "complete";

  const fw = stack.framework;

  try {
    if (fw === "hono") {
      const orchestratorFile = file_classifications.critical.find((f) => f.code_type === "ORCHESTRATOR");
      if (orchestratorFile) {
        const appSource = await readFile(join(projectRoot, orchestratorFile.path), "utf-8");
        conventions = await extractHonoConventions(appSource, orchestratorFile.path);
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
    } else if (fw === "astro") {
      const astroResult = await extractAstroConventions(index.files.map((f) => f.path), projectRoot);
      astroConventions = astroResult.conventions;
      status = "complete";
    } else {
      status = "partial";
    }
  } catch {
    status = "partial";
    skip_reasons[`${fw ?? "unknown"}_extractor_error`] = 1;
  }

  const dependencyHealth = await extractDependencyHealth(projectRoot);
  const gitHealth = await extractGitHealth(projectRoot);

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
    ...(astroConventions ? { astro_conventions: astroConventions } : {}),
    ...(dependencyHealth ? { dependency_health: dependencyHealth } : {}),
    ...(gitHealth ? { git_health: gitHealth } : {}),
    generation_metadata: {
      files_analyzed,
      files_skipped,
      skip_reasons,
      duration_ms: Date.now() - startTime,
    },
  };

  // Write full profile to disk — MCP returns only summary
  const profilePath = await writeProfileToDisk(projectRoot, profile);

  const summary = buildSummary(profile, profilePath);
  analyzeProjectCache.set(repoName, { updatedAt: index.updated_at, profile: summary });
  return summary;
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
  "sql",
  "sql-jinja",
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
