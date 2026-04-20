import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Boolean that also accepts "true"/"false" strings (LLMs often send strings instead of booleans) */
const zBool = () => z.union([z.boolean(), z.string().transform((s) => s === "true")]).optional();
import { wrapTool, registerShortener } from "./server-helpers.js";
import { detectProjectLanguagesSync, type ProjectLanguages } from "./utils/language-detect.js";
import { STUB_LANGUAGES } from "./parser/stub-languages.js";
import { getUsageStats, formatUsageReport } from "./storage/usage-stats.js";
import type { AuditDimension } from "./tools/nextjs-framework-audit-tools.js";
import {
  indexFolder,
  indexFile,
  indexRepo,
  listAllRepos,
  invalidateCache,
  getCodeIndex,
  searchSymbols,
  searchText,
  semanticSearch,
  getFileTree,
  getFileOutline,
  getRepoOutline,
  suggestQueries,
  getSymbol,
  getSymbols,
  findAndShow,
  findReferences,
  findReferencesBatch,
  findDeadCode,
  getContextBundle,
  formatRefsCompact,
  formatSymbolCompact,
  formatSymbolsCompact,
  formatBundleCompact,
  traceCallChain,
  traceComponentTree,
  analyzeHooks,
  analyzeRenders,
  buildContextGraph,
  auditCompilerReadiness,
  reactQuickstart,
  impactAnalysis,
  traceRoute,
  detectCommunities,
  assembleContext,
  getKnowledgeMap,
  diffOutline,
  changedSymbols,
  generateClaudeMd,
  codebaseRetrieval,
  analyzeComplexity,
  findClones,
  analyzeHotspots,
  crossRepoSearchSymbols,
  crossRepoFindReferences,
  searchPatterns,
  listPatterns,
  generateReport,
  goToDefinition,
  getTypeInfo,
  renameSymbol,
  getCallHierarchy,
  indexConversations,
  searchConversations,
  searchAllConversations,
  findConversationsForSymbol,
  scanSecrets,
  resolvePhpNamespace,
  tracePhpEvent,
  findPhpViews,
  resolvePhpService,
  phpSecurityScan,
  phpProjectAudit,
  consolidateMemories,
  readMemory,
  createAnalysisPlan,
  writeScratchpad,
  readScratchpad,
  listScratchpad,
  updateStepStatus,
  getPlan,
  listPlans,
  frequencyAnalysis,
  findExtensionFunctions,
  analyzeSealedHierarchy,
  traceSuspendChain,
  analyzeKmpDeclarations,
  traceFlowChain,
  traceHiltGraph,
  traceComposeTree,
  analyzeComposeRecomposition,
  traceRoomSchema,
  extractKotlinSerializationContract,
  astroAnalyzeIslands,
  astroHydrationAudit,
  astroRouteMap,
  astroActionsAudit,
  astroAudit,
  nextjsRouteMap,
  nextjsMetadataAudit,
  frameworkAudit,
  astroConfigAnalyze,
  astroContentCollections,
  analyzeProject,
  getExtractorVersions,
  getModelGraph,
  getTestFixtures,
  findFrameworkWiring,
  runRuff,
  parsePyproject,
  resolveConstantValue,
  effectiveDjangoViewSecurity,
  findPythonCallers,
  taintTrace,
  analyzeDjangoSettings,
  runMypy,
  runPyright,
  analyzePythonDeps,
  pythonAudit,
  traceFastAPIDepends,
  analyzeAsyncCorrectness,
  getPydanticModels,
  reviewDiff,
  auditScan,
  indexStatus,
  auditAgentConfig,
  testImpactAnalysis,
  dependencyAudit,
  migrationLint,
  planTurn,
  formatPlanTurnResult,
  astroMigrationCheck,
  analyzePrismaSchema,
  findPerfHotspots,
  fanInFanOut,
  coChangeAnalysis,
  architectureSummary,
  nestAudit,
  explainQuery,
  generateWiki,
} from "./register-tool-loaders.js";
import type { AuditScanOptions } from "./tools/audit-tools.js";
import { formatSnapshot, getContext, getSessionState } from "./storage/session-state.js";
import { formatComplexityCompact, formatComplexityCounts, formatClonesCompact, formatClonesCounts, formatHotspotsCompact, formatHotspotsCounts, formatTraceRouteCompact, formatTraceRouteCounts } from "./formatters-shortening.js";
import type { SecretSeverity } from "./tools/secret-tools.js";
import type { SymbolKind, Direction } from "./types.js";
import { formatSearchSymbols, formatFileTree, formatFileOutline, formatSearchPatterns, formatDeadCode, formatComplexity, formatClones, formatHotspots, formatRepoOutline, formatSuggestQueries, formatSecrets, formatConversations, formatRoles, formatAssembleContext, formatCommunities, formatCallTree, formatTraceRoute, formatKnowledgeMap, formatImpactAnalysis, formatDiffOutline, formatChangedSymbols, formatReviewDiff, formatPerfHotspots, formatFanInFanOut, formatCoChange, formatArchitectureSummary, formatNextjsRouteMap, formatNextjsMetadataAudit, formatFrameworkAudit } from "./formatters.js";
import { formatNextjsRouteMapCompact, formatNextjsRouteMapCounts, formatNextjsMetadataAuditCompact, formatNextjsMetadataAuditCounts, formatFrameworkAuditCompact, formatFrameworkAuditCounts } from "./formatters-shortening.js";

const zFiniteNumber = z.number().finite();

/** Coerce string→number for numeric params while rejecting NaN/empty strings. */
export const zNum = () =>
  z.union([
    zFiniteNumber,
    z.string()
      .trim()
      .min(1, "Expected a number")
      .transform((value) => Number(value))
      .pipe(zFiniteNumber),
  ]).optional();

type ToolSchemaShape = Record<string, z.ZodTypeAny>;

function lazySchema(factory: () => ToolSchemaShape): ToolSchemaShape {
  let cached: ToolSchemaShape | undefined;
  const resolve = (): ToolSchemaShape => {
    cached ??= factory();
    return cached;
  };

  return new Proxy({} as ToolSchemaShape, {
    get(_target, prop) {
      return resolve()[prop as keyof ToolSchemaShape];
    },
    has(_target, prop) {
      return prop in resolve();
    },
    ownKeys() {
      return Reflect.ownKeys(resolve());
    },
    getOwnPropertyDescriptor(_target, prop) {
      const descriptor = Object.getOwnPropertyDescriptor(resolve(), prop);
      if (descriptor) return descriptor;
      return {
        configurable: true,
        enumerable: true,
        writable: false,
        value: resolve()[prop as keyof ToolSchemaShape],
      };
    },
  });
}

// ---------------------------------------------------------------------------
// H11 — warn when symbol tools return empty for repos with text_stub languages
// ---------------------------------------------------------------------------

export const SYMBOL_TOOLS = new Set([
  "search_symbols", "get_file_outline", "get_symbol", "get_symbols",
  "find_references", "trace_call_chain", "find_dead_code", "analyze_complexity",
]);

/**
 * Build an H11 hint string from a list of FileEntry-like records. Returns
 * null when no hint is needed. Separated from `checkTextStubHint` so the
 * purely-deterministic core can be unit-tested without spinning up a real
 * index.
 *
 * A file is counted as a "stub" when its language appears in STUB_LANGUAGES
 * (queried dynamically). Languages like `kotlin` that have a real extractor
 * are automatically excluded because they live outside STUB_LANGUAGES, so
 * H11 no longer fires for Kotlin-heavy repos.
 */
export function buildH11Hint(
  files: ReadonlyArray<{ path: string; language: string }>,
): string | null {
  if (files.length === 0) return null;

  const stubFiles = files.filter((f) => STUB_LANGUAGES.has(f.language));
  if (stubFiles.length === 0) return null;

  const stubPct = Math.round((stubFiles.length / files.length) * 100);
  if (stubPct < 30) return null;

  const stubExts = [...new Set(
    stubFiles.map((f) => "." + f.path.split(".").pop())
  )].slice(0, 3).join(", ");

  return `⚡H11 No parser for ${stubExts} files (${stubPct}% of repo). Symbol tools return empty.\n` +
    `  → search_text(query) works on ALL files (uses ripgrep, not parser)\n` +
    `  → get_file_tree shows file listing\n` +
    `  → Only symbol-based tools (this one) need a parser to return results.\n`;
}

/**
 * Check if a repo has stub-language files as a dominant portion. Returns a
 * hint string to prepend to empty results, or null if no hint needed.
 */
async function checkTextStubHint(repo: string | undefined, toolName: string, resultEmpty: boolean): Promise<string | null> {
  if (!resultEmpty || !repo || !SYMBOL_TOOLS.has(toolName)) return null;

  const index = await getCodeIndex(repo);
  if (!index) return null;

  return buildH11Hint(index.files);
}

// ---------------------------------------------------------------------------
// audit_scan formatter
// ---------------------------------------------------------------------------

import type { AuditScanResult } from "./tools/audit-tools.js";

function formatAuditScan(result: AuditScanResult): string {
  const lines: string[] = [];
  lines.push(`AUDIT SCAN: ${result.repo}`);
  lines.push(`Gates checked: ${result.summary.gates_checked} | Findings: ${result.summary.total_findings} (${result.summary.critical} critical, ${result.summary.warning} warning)`);
  lines.push("");

  for (const gate of result.gates) {
    const count = gate.findings.length;
    const status = count === 0 ? "✓ PASS" : `✗ ${count} finding${count > 1 ? "s" : ""}`;
    lines.push(`${gate.gate} ${status} — ${gate.description}`);
    lines.push(`  tool: ${gate.tool_used}`);

    for (const f of gate.findings.slice(0, 10)) {
      const loc = f.line ? `:${f.line}` : "";
      const sev = f.severity === "critical" ? "🔴" : "🟡";
      lines.push(`  ${sev} ${f.file}${loc} — ${f.detail}`);
    }
    if (gate.findings.length > 10) {
      lines.push(`  ... +${gate.findings.length - 10} more`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Registered tool handles — populated by registerTools(), used by describe_tools reveal
// ---------------------------------------------------------------------------

const toolHandles = new Map<string, any>();

/** Get a registered tool handle by name (for testing and describe_tools reveal) */
export function getToolHandle(name: string) {
  return toolHandles.get(name);
}

interface RegistrationContext {
  server: Pick<McpServer, "tool">;
  languages: ProjectLanguages;
}

let registrationContext: RegistrationContext | null = null;

function isToolLanguageEnabled(tool: ToolDefinition, languages: ProjectLanguages): boolean {
  if (!tool.requiresLanguage) return true;
  return languages[tool.requiresLanguage];
}

function registerToolDefinition(
  server: Pick<McpServer, "tool">,
  tool: ToolDefinition,
  languages: ProjectLanguages,
) {
  const existing = toolHandles.get(tool.name);
  if (existing) return existing;

  const handle = server.tool(
    tool.name,
    tool.description,
    tool.schema,
    async (args) => wrapTool(tool.name, args as Record<string, unknown>, () => tool.handler(args as Record<string, unknown>))(),
  );

  if (!isToolLanguageEnabled(tool, languages) && typeof handle.disable === "function") {
    handle.disable();
  }

  toolHandles.set(tool.name, handle);
  return handle;
}

function ensureToolRegistered(name: string) {
  const existing = toolHandles.get(name);
  if (existing) return existing;

  const context = registrationContext;
  if (!context) return undefined;

  const tool = TOOL_DEFINITION_MAP.get(name);
  if (!tool) return undefined;

  return registerToolDefinition(context.server, tool, context.languages);
}

export function enableToolByName(name: string): boolean {
  const handle = ensureToolRegistered(name);
  if (!handle) return false;
  if (typeof handle.enable === "function") {
    handle.enable();
  }
  return true;
}

/** Framework-specific tool bundles — auto-enabled when the framework is detected in an indexed repo */
const FRAMEWORK_TOOL_BUNDLES: Record<string, string[]> = {
  nestjs: [
    // All NestJS sub-tools absorbed into nest_audit
  ],
};

/** Track which framework bundles have been auto-enabled this session (avoid repeat work) */
const enabledFrameworkBundles = new Set<string>();

/**
 * Enable framework-specific tool bundle — called after indexing when framework is detected.
 * Idempotent: safe to call multiple times. Only enables tools that exist and are currently disabled.
 */
export function enableFrameworkToolBundle(framework: string): string[] {
  if (enabledFrameworkBundles.has(framework)) return [];
  const bundle = FRAMEWORK_TOOL_BUNDLES[framework];
  if (!bundle) return [];

  const enabled: string[] = [];
  for (const name of bundle) {
    if (enableToolByName(name)) {
      enabled.push(name);
    }
  }
  if (enabled.length > 0) enabledFrameworkBundles.add(framework);
  return enabled;
}

// ---------------------------------------------------------------------------
// Framework-specific tool auto-loading
// ---------------------------------------------------------------------------

/**
 * Tool groups that should be auto-enabled when a matching project type is detected at CWD.
 * Keys are detection signals (files at CWD root), values are tool names to enable.
 */
const FRAMEWORK_TOOL_GROUPS: Record<string, string[]> = {
  // PHP / Yii2 / Laravel — detected by composer.json
  "composer.json": [
    "resolve_php_namespace",
    // analyze_activerecord, find_php_n_plus_one, find_php_god_model absorbed into php_project_audit
    "trace_php_event",
    "find_php_views",
    "resolve_php_service",
    "php_security_scan",
    "php_project_audit",
  ],
  // Kotlin / Android / Gradle — detected by build.gradle.kts or settings.gradle.kts
  "build.gradle.kts": [
    "find_extension_functions",
    "analyze_sealed_hierarchy",
    "trace_hilt_graph",
    "trace_suspend_chain",
    "analyze_kmp_declarations",
    "trace_compose_tree",
    "analyze_compose_recomposition",
    "trace_room_schema",
    "extract_kotlin_serialization_contract",
    "trace_flow_chain",
  ],
  "settings.gradle.kts": [
    "find_extension_functions",
    "analyze_sealed_hierarchy",
    "trace_hilt_graph",
    "trace_suspend_chain",
    "analyze_kmp_declarations",
    "trace_compose_tree",
    "analyze_compose_recomposition",
    "trace_room_schema",
    "extract_kotlin_serialization_contract",
    "trace_flow_chain",
  ],
  // Fallback — Android projects with Groovy gradle but Kotlin source
  "build.gradle": [
    "find_extension_functions",
    "analyze_sealed_hierarchy",
    "trace_hilt_graph",
    "trace_suspend_chain",
    "analyze_kmp_declarations",
    "trace_compose_tree",
    "analyze_compose_recomposition",
    "trace_room_schema",
    "extract_kotlin_serialization_contract",
    "trace_flow_chain",
  ],
};

/**
 * React-specific tools — auto-enabled when a React project is detected.
 * Detection requires BOTH a package.json with react dependency AND presence
 * of .tsx/.jsx files (prevents false positives on non-UI projects that happen
 * to have react as a transitive dep).
 */
const REACT_TOOLS = [
  "trace_component_tree",
  "analyze_hooks",
  "analyze_renders",
  "analyze_context_graph",
  "audit_compiler_readiness",
  "react_quickstart",
];

/**
 * Hono-specific tools — auto-enabled when a Hono project is detected.
 * Core tools (trace_middleware_chain, analyze_hono_app) are already in
 * CORE_TOOL_NAMES. This list covers the 5 hidden tools that agents need
 * to discover via describe_tools/discover_tools otherwise.
 *
 * Detection: package.json with "hono" OR "@hono/zod-openapi" dep.
 * Content-based (not filename), so lives outside FRAMEWORK_TOOL_GROUPS.
 */

const HONO_TOOLS = [
  "trace_context_flow",
  "extract_api_contract",
  "trace_rpc_types",
  "audit_hono_security",
  "visualize_hono_routes",
  // Phase 2 additions — closes blog-API demo gaps + GitHub issues #3587/#4121/#4270
  "analyze_inline_handler",
  "extract_response_types",
  "detect_hono_modules",
  "find_dead_hono_routes",
];

const AUTO_LOAD_CACHE_TTL_MS = 5_000;
const autoLoadToolsCache = new Map<string, {
  expiresAt: number;
  value: Promise<string[]>;
}>();

/**
 * Detect project type at CWD and return list of tools that should be auto-enabled.
 * Returns empty array if no framework-specific tools apply.
 * Exported for unit testing.
 */
export async function detectAutoLoadTools(cwd: string): Promise<string[]> {
  const { existsSync, readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");

  const toEnable: string[] = [];
  for (const [signalFile, tools] of Object.entries(FRAMEWORK_TOOL_GROUPS)) {
    if (existsSync(join(cwd, signalFile))) {
      toEnable.push(...tools);
    }
  }

  // React + Hono detection: both need to read package.json for dep signals.
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

      // React: dep + .tsx/.jsx files
      const hasReact = !!(allDeps["react"] || allDeps["next"] || allDeps["@remix-run/react"]);
      if (hasReact && hasJsxFilesShallow(cwd, readdirSync)) {
        toEnable.push(...REACT_TOOLS);
      }

      // Hono: any hono package is enough — the framework is only pulled in
      // when used, and all 5 hidden tools degrade gracefully on non-Hono repos
      // so false positives are harmless (return "no Hono detected" errors).
      const hasHono = !!(
        allDeps["hono"] ||
        allDeps["@hono/zod-openapi"] ||
        allDeps["@hono/node-server"] ||
        allDeps["hono-openapi"] ||
        allDeps["chanfana"]
      );
      if (hasHono) {
        toEnable.push(...HONO_TOOLS);
      }
    } catch { /* malformed package.json */ }
  }

  return toEnable;
}

export function detectAutoLoadToolsCached(cwd: string): Promise<string[]> {
  const now = Date.now();
  const cached = autoLoadToolsCache.get(cwd);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const value = detectAutoLoadTools(cwd)
    .then((tools) => [...new Set(tools)])
    .catch((err) => {
      autoLoadToolsCache.delete(cwd);
      throw err;
    });

  autoLoadToolsCache.set(cwd, {
    expiresAt: now + AUTO_LOAD_CACHE_TTL_MS,
    value,
  });
  return value;
}

/**
 * Quick recursive scan for .tsx/.jsx files in common source dirs.
 * Limits depth to 3 and stops on first match to stay fast (<10ms on typical repos).
 * Skips node_modules, dist, build, .next, .astro, .git.
 */
function hasJsxFilesShallow(
  cwd: string,
  readdirSyncFn: typeof import("node:fs").readdirSync,
): boolean {
  const { join } = require("node:path") as typeof import("node:path");
  const IGNORE = new Set([
    "node_modules", "dist", "build", ".next", ".astro", ".git",
    "out", "coverage", ".turbo", ".vercel", ".cache",
  ]);
  const ROOTS = ["src", "app", "pages", "components", "."];

  function scan(dir: string, depth: number): boolean {
    if (depth > 3) return false;
    let entries;
    try {
      entries = readdirSyncFn(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.isFile() && /\.(tsx|jsx)$/.test(e.name)) return true;
    }
    for (const e of entries) {
      if (e.isDirectory() && !IGNORE.has(e.name) && !e.name.startsWith(".")) {
        if (scan(join(dir, e.name), depth + 1)) return true;
      }
    }
    return false;
  }

  for (const root of ROOTS) {
    const dir = root === "." ? cwd : join(cwd, root);
    try {
      if (scan(dir, 0)) return true;
    } catch { /* skip */ }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tool definition type
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
  /** Category for tool discovery grouping */
  category?: ToolCategory;
  /** Keywords for discover_tools search — helps LLM find the right tool */
  searchHint?: string;
  /** Output schema for structured validation and documentation (optional) */
  outputSchema?: z.ZodTypeAny;
  /**
   * Language gate: this tool is only enabled when the project contains
   * files of the given language. E.g. "python" disables the tool when
   * no .py files exist. Checked at server startup against process.cwd().
   */
  requiresLanguage?: "python" | "php" | "kotlin";
}

// ---------------------------------------------------------------------------
// Output schemas — typed results for structured validation & documentation
// ---------------------------------------------------------------------------

export const OutputSchemas = {
  /** search_symbols, cross_repo_search */
  searchResults: z.string().describe("Formatted search results: file:line kind name signature"),

  /** get_file_tree */
  fileTree: z.string().describe("File tree with symbol counts per file"),

  /** get_file_outline */
  fileOutline: z.string().describe("Symbol outline: line:end_line kind name"),

  /** get_symbol */
  symbol: z.string().nullable().describe("Symbol source code or null if not found"),

  /** find_references */
  references: z.string().describe("References in file:line: context format"),

  /** trace_call_chain */
  callTree: z.string().describe("Call tree hierarchy or Mermaid diagram"),

  /** impact_analysis */
  impactAnalysis: z.string().describe("Changed files and affected symbols with risk levels"),

  /** codebase_retrieval */
  batchResults: z.string().describe("Concatenated sub-query result sections"),

  /** discover_tools */
  toolDiscovery: z.object({
    query: z.string(),
    matches: z.array(z.object({
      name: z.string(),
      category: z.string(),
      description: z.string(),
      is_core: z.boolean(),
    })),
    total_tools: z.number(),
    categories: z.array(z.string()),
  }),

  /** get_call_hierarchy */
  callHierarchy: z.string().describe("Call hierarchy: symbol with incoming and outgoing calls"),

  /** analyze_complexity */
  complexity: z.string().describe("Complexity report: CC nest lines file:line name"),

  /** find_dead_code */
  deadCode: z.string().describe("Unused exported symbols list"),

  /** find_clones */
  clones: z.string().describe("Code clone pairs with similarity scores"),

  /** scan_secrets */
  secrets: z.string().describe("Secret findings with severity, type, and masked values"),

  /** go_to_definition */
  definition: z.string().nullable().describe("file:line (via lsp|index) with preview"),

  /** get_type_info */
  typeInfo: z.union([
    z.object({ type: z.string(), documentation: z.string().optional(), via: z.literal("lsp") }),
    z.object({ via: z.literal("unavailable"), hint: z.string() }),
  ]),

  /** rename_symbol */
  renameResult: z.object({
    files_changed: z.number(),
    edits: z.array(z.object({ file: z.string(), changes: z.number() })),
  }),

  /** usage_stats */
  usageStats: z.object({ report: z.string() }),

  /** list_repos */
  repoList: z.union([z.array(z.string()), z.array(z.object({ name: z.string() }).passthrough())]),
} as const;

export type ToolCategory =
  | "indexing"
  | "search"
  | "outline"
  | "symbols"
  | "graph"
  | "lsp"
  | "architecture"
  | "context"
  | "diff"
  | "analysis"
  | "patterns"
  | "conversations"
  | "security"
  | "reporting"
  | "cross-repo"
  | "nestjs"
  | "navigation"
  | "session"
  | "meta"
  | "discovery";

/** Tools visible in ListTools — core (high usage) + direct-use (agents call without discovery) */
export const CORE_TOOL_NAMES = new Set([
  // --- Top 10 by usage (91% of calls) ---
  "search_text",             // #1: 1841 calls
  "codebase_retrieval",      // #2: 574 calls
  "get_file_outline",        // #3: 351 calls
  "search_symbols",          // #4: 332 calls
  "list_repos",              // #5: 292 calls
  "get_file_tree",           // #6: 268 calls
  "index_file",              // #7: 209 calls
  "get_symbol",              // #8: 138 calls
  "search_patterns",         // #9: 135 calls
  "index_conversations",     // #10: 127 calls
  // --- Direct-use: agents call these without discovery ---
  "assemble_context",        // 64 calls, 21 sessions, 100% direct
  "get_symbols",             // 69 calls — batch symbol reads
  "find_references",         // 39 calls — symbol usage
  "find_and_show",           // 55 calls — symbol + refs
  "search_conversations",    // 37 calls, 100% direct
  "get_context_bundle",      // 36 calls, 19 sessions, 100% direct
  "analyze_complexity",      // 33 calls, 28 sessions
  "detect_communities",      // 32 calls, 24 sessions
  "search_all_conversations",// 27 calls, 100% direct
  "analyze_hotspots",        // 22 calls, 18 sessions
  "trace_call_chain",        // 15 calls, 100% direct
  "suggest_queries",         // 13 calls, 13 sessions
  "usage_stats",             // 11 calls, 100% direct
  "get_knowledge_map",       // 10 calls, 100% direct
  "get_repo_outline",        // 9 calls, 100% direct
  "trace_route",             // 9 calls, 100% direct
  "get_type_info",           // 8 calls, 100% direct
  "impact_analysis",         // 4 calls, 100% direct
  "go_to_definition",        // 4 calls, 100% direct
  // --- Composite tools ---
  "audit_scan",              // one-call audit: CQ8+CQ11+CQ13+CQ14+CQ17
  "nest_audit",              // one-class NestJS analysis: modules+DI+guards+routes+lifecycle
  // --- Essential infrastructure ---
  "index_folder",            // repo onboarding
  "discover_tools",          // meta: discovers remaining hidden tools
  "describe_tools",          // meta: full schema for hidden tools
  "plan_turn",               // meta: route query to best tools/symbols/files
  "initial_instructions",    // meta: Serena-style onboarding tool, "must call first"
  "get_session_snapshot",    // session: compaction survival
  "analyze_project",         // project profile
  "get_extractor_versions",  // cache invalidation
  "index_status",            // meta: check if repo is indexed
  // --- Astro tools (7 core) ---
  "astro_analyze_islands",
  // astro_hydration_audit: discoverable — use astro_audit for full check or call directly
  "astro_route_map",
  "astro_config_analyze",
  "astro_actions_audit",
  "astro_migration_check",
  "astro_content_collections",
  "astro_audit",
  // --- Hono tools (Task 23) ---
  "trace_middleware_chain",  // core: top Hono pain point (Discussion #4255)
  "analyze_hono_app",        // core: meta-tool, first call for any Hono project
  // --- Next.js tools ---
  "nextjs_route_map",
  "nextjs_metadata_audit",
  "framework_audit",
]);

/** Get all tool definitions (exported for testing) */
export function getToolDefinitions(): readonly ToolDefinition[] {
  return TOOL_DEFINITIONS;
}

// ---------------------------------------------------------------------------
// Tool definitions — data-driven registration (CQ14: eliminates 30× boilerplate)
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS: ToolDefinition[] = [
  // --- Indexing ---
  {
    name: "index_folder",
    category: "indexing",
    searchHint: "index local folder directory project parse symbols",
    description: "Index a local folder, extracting symbols and building the search index",
    schema: lazySchema(() => ({
      path: z.string().describe("Absolute path to the folder to index"),
      incremental: zBool().describe("Only re-index changed files"),
      include_paths: z.union([z.array(z.string()), z.string().transform((s) => JSON.parse(s) as string[])]).optional().describe("Glob patterns to include. Can be passed as JSON string."),
    })),
    handler: async (args) => {
      const result = await indexFolder(args.path as string, {
        incremental: args.incremental as boolean | undefined,
        include_paths: args.include_paths as string[] | undefined,
      });
      // Auto-enable framework tools based on indexed path (not CWD)
      try {
        const toEnable = await detectAutoLoadToolsCached(args.path as string);
        for (const name of toEnable) enableToolByName(name);
      } catch { /* best-effort — non-fatal */ }
      return result;
    },
  },
  {
    name: "index_repo",
    category: "indexing",
    searchHint: "clone remote git repository index",
    description: "Clone and index a remote git repository",
    schema: lazySchema(() => ({
      url: z.string().describe("Git clone URL"),
      branch: z.string().optional().describe("Branch to checkout"),
      include_paths: z.union([z.array(z.string()), z.string().transform((s) => JSON.parse(s) as string[])]).optional().describe("Glob patterns to include. Can be passed as JSON string."),
    })),
    handler: (args) => indexRepo(args.url as string, {
      branch: args.branch as string | undefined,
      include_paths: args.include_paths as string[] | undefined,
    }),
  },
  {
    name: "list_repos",
    category: "indexing",
    searchHint: "list indexed repositories repos available",
    outputSchema: OutputSchemas.repoList,
    description: "List indexed repos. Only needed for multi-repo discovery — single-repo tools auto-resolve from CWD. Set compact=false for full metadata.",
    schema: lazySchema(() => ({
      compact: zBool().describe("true=names only (default), false=full metadata"),
      name_contains: z.string().optional().describe("Filter repos by name substring (case-insensitive). E.g. 'tgm' matches 'local/tgm-panel'"),
    })),
    handler: (args) => {
      const opts: { compact?: boolean; name_contains?: string } = {
        compact: (args.compact as boolean | undefined) ?? true,
      };
      if (args.name_contains) opts.name_contains = args.name_contains as string;
      return listAllRepos(opts);
    },
  },
  {
    name: "invalidate_cache",
    category: "indexing",
    searchHint: "clear cache invalidate re-index refresh",
    description: "Clear the index cache for a repository, forcing full re-index on next use",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: (args) => invalidateCache(args.repo as string),
  },

  {
    name: "index_file",
    category: "indexing",
    searchHint: "re-index single file update incremental",
    description: "Re-index a single file after editing. Auto-finds repo, skips if unchanged.",
    schema: lazySchema(() => ({
      path: z.string().describe("Absolute path to the file to re-index"),
    })),
    handler: (args) => indexFile(args.path as string),
  },

  // --- Search ---
  {
    name: "search_symbols",
    category: "search",
    searchHint: "search find symbols functions classes types methods by name signature",
    outputSchema: OutputSchemas.searchResults,
    description: "Search symbols by name/signature. Supports kind, file, and decorator filters. detail_level: compact (~15 tok), standard (default), full.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      query: z.string().describe("Search query string"),
      kind: z.string().optional().describe("Filter by symbol kind (function, class, etc.)"),
      file_pattern: z.string().optional().describe("Glob pattern to filter files"),
      decorator: z.string().optional().describe("Filter by decorator metadata, e.g. login_required, @dataclass, router.get"),
      include_source: zBool().describe("Include full source code of each symbol"),
      top_k: zNum().describe("Maximum number of results to return (default 50)"),
      source_chars: zNum().describe("Truncate each symbol's source to N characters (reduces output size)"),
      detail_level: z.enum(["compact", "standard", "full"]).optional().describe("compact (~15 tok), standard (default), full (all source)"),
      token_budget: zNum().describe("Max tokens for results — greedily packs results until budget exhausted. Overrides top_k."),
      rerank: zBool().describe("Rerank results using cross-encoder model for improved relevance (requires @huggingface/transformers)"),
    })),
    handler: async (args) => {
      const results = await searchSymbols(args.repo as string, args.query as string, {
        kind: args.kind as SymbolKind | undefined,
        file_pattern: args.file_pattern as string | undefined,
        decorator: args.decorator as string | undefined,
        include_source: args.include_source as boolean | undefined,
        top_k: args.top_k as number | undefined,
        source_chars: args.source_chars as number | undefined,
        detail_level: args.detail_level as "compact" | "standard" | "full" | undefined,
        token_budget: args.token_budget as number | undefined,
        rerank: args.rerank as boolean | undefined,
      });
      const output = formatSearchSymbols(results);
      const hint = await checkTextStubHint(args.repo as string, "search_symbols", results.length === 0);
      return hint ? hint + output : output;
    },
  },
  {
    name: "ast_query",
    category: "search",
    searchHint: "AST tree-sitter query structural pattern matching code shape jsx react",
    description: "Search AST patterns via tree-sitter S-expressions. Finds code by structural shape. React examples (language='tsx'): `(jsx_element open_tag: (jsx_opening_element name: (identifier) @tag))` finds all JSX component usage; `(call_expression function: (identifier) @fn (#match? @fn \"^use[A-Z]\"))` finds all hook calls.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      query: z.string().describe("Tree-sitter query in S-expression syntax. For JSX/React use language='tsx'."),
      language: z.string().describe("Tree-sitter grammar: typescript, tsx, javascript, python, go, rust, java, ruby, php"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      max_matches: zNum().describe("Maximum matches to return (default: 50)"),
    })),
    handler: async (args) => {
      const { astQuery } = await import("./tools/ast-query-tools.js");
      return astQuery(args.repo as string, args.query as string, {
        language: args.language as string | undefined,
        file_pattern: args.file_pattern as string | undefined,
        max_matches: args.max_matches as number | undefined,
      });
    },
  },
  {
    name: "semantic_search",
    category: "search",
    searchHint: "semantic meaning intent concept embedding vector natural language",
    description: "Search code by meaning using embeddings. For intent-based queries: 'error handling', 'auth flow'. Requires indexed embeddings.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      query: z.string().describe("Natural language query describing what you're looking for"),
      top_k: zNum().describe("Number of results (default: 10)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      exclude_tests: zBool().describe("Exclude test files from results"),
      rerank: zBool().describe("Re-rank results with cross-encoder for better precision"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof semanticSearch>[2] = {};
      if (args.top_k != null) opts.top_k = args.top_k as number;
      if (args.file_pattern != null) opts.file_pattern = args.file_pattern as string;
      if (args.exclude_tests != null) opts.exclude_tests = args.exclude_tests as boolean;
      if (args.rerank != null) opts.rerank = args.rerank as boolean;
      return semanticSearch(args.repo as string, args.query as string, opts);
    },
  },
  {
    name: "search_text",
    category: "search",
    searchHint: "full-text search grep regex keyword content files",
    description: "Full-text search across all files. For conceptual queries use semantic_search.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      query: z.string().describe("Search query or regex pattern"),
      regex: zBool().describe("Treat query as a regex pattern"),
      context_lines: zNum().describe("Number of context lines around each match"),
      file_pattern: z.string().optional().describe("Glob pattern to filter files"),
      max_results: zNum().describe("Maximum number of matching lines to return (default 200)"),
      group_by_file: zBool().describe("Group by file: {file, count, lines[], first_match}. ~80% less output."),
      auto_group: zBool().describe("Auto group_by_file when >50 matches."),
      ranked: z.boolean().optional().describe("Classify hits by containing symbol and rank by centrality"),
    })),
    handler: (args) => searchText(args.repo as string, args.query as string, {
      regex: args.regex as boolean | undefined,
      context_lines: args.context_lines as number | undefined,
      file_pattern: args.file_pattern as string | undefined,
      max_results: args.max_results as number | undefined,
      group_by_file: args.group_by_file as boolean | undefined,
      auto_group: args.auto_group as boolean | undefined,
      ranked: args.ranked as boolean | undefined,
    }),
  },

  // --- Outline ---
  {
    name: "get_file_tree",
    category: "outline",
    searchHint: "file tree directory structure listing files symbols",
    outputSchema: OutputSchemas.fileTree,
    description: "File tree with symbol counts. compact=true for flat list (10-50x less output). Cached 5min.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      path_prefix: z.string().optional().describe("Filter to a subtree by path prefix"),
      name_pattern: z.string().optional().describe("Glob pattern to filter file names"),
      depth: zNum().describe("Maximum directory depth to traverse"),
      compact: zBool().describe("Return flat list of {path, symbols} instead of nested tree (much less output)"),
      min_symbols: zNum().describe("Only include files with at least this many symbols"),
    })),
    handler: async (args) => {
      const result = await getFileTree(args.repo as string, {
        path_prefix: args.path_prefix as string | undefined,
        name_pattern: args.name_pattern as string | undefined,
        depth: args.depth as number | undefined,
        compact: args.compact as boolean | undefined,
        min_symbols: args.min_symbols as number | undefined,
      });
      return formatFileTree(result as never);
    },
  },
  {
    name: "get_file_outline",
    category: "outline",
    searchHint: "file outline symbols functions classes exports single file",
    outputSchema: OutputSchemas.fileOutline,
    description: "Get the symbol outline of a single file (functions, classes, exports)",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_path: z.string().describe("Relative file path within the repository"),
    })),
    handler: async (args) => {
      const result = await getFileOutline(args.repo as string, args.file_path as string);
      const output = formatFileOutline(result as never);
      const isEmpty = !result || (Array.isArray(result) && result.length === 0);
      const hint = await checkTextStubHint(args.repo as string, "get_file_outline", isEmpty);
      return hint ? hint + output : output;
    },
  },
  {
    name: "get_repo_outline",
    category: "outline",
    searchHint: "repository outline overview directory structure high-level",
    description: "Get a high-level outline of the entire repository grouped by directory",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const result = await getRepoOutline(args.repo as string);
      return formatRepoOutline(result as never);
    },
  },

  {
    name: "suggest_queries",
    category: "outline",
    searchHint: "suggest queries explore unfamiliar repo onboarding first call",
    description: "Suggest queries for exploring a new repo. Returns top files, kind distribution, examples.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const result = await suggestQueries(args.repo as string);
      return formatSuggestQueries(result as never);
    },
  },

  // --- Symbol retrieval ---
  {
    name: "get_symbol",
    category: "symbols",
    searchHint: "get retrieve single symbol source code by ID",
    outputSchema: OutputSchemas.symbol,
    description: "Get symbol by ID with source. Auto-prefetches children for classes. For batch: get_symbols. For context: get_context_bundle.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_id: z.string().describe("Unique symbol identifier"),
      include_related: zBool().describe("Include children/related symbols (default: true)"),
    })),
    handler: async (args) => {
      const opts: { include_related?: boolean } = {};
      if (args.include_related != null) opts.include_related = args.include_related as boolean;
      const result = await getSymbol(args.repo as string, args.symbol_id as string, opts);
      if (!result) {
        const hint = await checkTextStubHint(args.repo as string, "get_symbol", true);
        return hint ?? null;
      }
      let text = await formatSymbolCompact(result.symbol);
      if (result.related && result.related.length > 0) {
        text += "\n\n--- children ---\n" + result.related.map((s) => `${s.kind} ${s.name}${s.signature ? s.signature : ""} [${s.file}:${s.start_line}]`).join("\n");
      }
      return text;
    },
  },
  {
    name: "get_symbols",
    category: "symbols",
    searchHint: "batch get multiple symbols by IDs",
    description: "Retrieve multiple symbols by ID in a single batch call",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_ids: z.union([
        z.array(z.string()),
        z.string().transform((s) => JSON.parse(s) as string[]),
      ]).describe("Array of symbol identifiers. Can be passed as JSON string."),
    })),
    handler: async (args) => {
      const syms = await getSymbols(args.repo as string, args.symbol_ids as string[]);
      const output = await formatSymbolsCompact(syms);
      const hint = await checkTextStubHint(args.repo as string, "get_symbols", syms.length === 0);
      return hint ? hint + output : output;
    },
  },
  {
    name: "find_and_show",
    category: "symbols",
    searchHint: "find symbol by name show source code references",
    description: "Find a symbol by name and show its source, optionally including references",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      query: z.string().describe("Symbol name or query to search for"),
      include_refs: zBool().describe("Include locations that reference this symbol"),
    })),
    handler: async (args) => {
      const result = await findAndShow(args.repo as string, args.query as string, args.include_refs as boolean | undefined);
      if (!result) return null;
      let text = await formatSymbolCompact(result.symbol);
      if (result.references) {
        text += `\n\n--- references ---\n${await formatRefsCompact(result.references)}`;
      }
      return text;
    },
  },
  {
    name: "get_context_bundle",
    category: "symbols",
    searchHint: "context bundle symbol imports siblings callers one call",
    description: "Symbol + imports + siblings in one call. Saves 2-3 round-trips.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().describe("Symbol name to find"),
    })),
    handler: async (args) => {
      const bundle = await getContextBundle(args.repo as string, args.symbol_name as string);
      if (!bundle) return null;
      return formatBundleCompact(bundle);
    },
  },

  // --- References & call graph ---
  {
    name: "find_references",
    category: "graph",
    searchHint: "find references usages callers who uses symbol",
    outputSchema: OutputSchemas.references,
    description: "Find all references to a symbol. Pass symbol_names array for batch search.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().optional().describe("Name of the symbol to find references for"),
      symbol_names: z.union([z.array(z.string()), z.string().transform((s) => JSON.parse(s) as string[])]).optional()
        .describe("Array of symbol names for batch search (reads each file once). Can be JSON string."),
      file_pattern: z.string().optional().describe("Glob pattern to filter files"),
    })),
    handler: async (args) => {
      const names = args.symbol_names as string[] | undefined;
      if (names && names.length > 0) {
        return findReferencesBatch(args.repo as string, names, args.file_pattern as string | undefined);
      }
      const refs = await findReferences(args.repo as string, args.symbol_name as string, args.file_pattern as string | undefined);
      const output = await formatRefsCompact(refs);
      const hint = await checkTextStubHint(args.repo as string, "find_references", refs.length === 0);
      return hint ? hint + output : output;
    },
  },
  {
    name: "trace_call_chain",
    category: "graph",
    searchHint: "trace call chain callers callees dependency graph mermaid react hooks",
    outputSchema: OutputSchemas.callTree,
    description: "Trace call chain: callers or callees. output_format='mermaid' for diagram. filter_react_hooks=true skips useState/useEffect etc. for cleaner React graphs.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().describe("Name of the symbol to trace"),
      direction: z.enum(["callers", "callees"]).describe("Trace direction"),
      depth: zNum().describe("Maximum depth to traverse the call graph (default: 1)"),
      include_source: zBool().describe("Include full source code of each symbol (default: false)"),
      include_tests: zBool().describe("Include test files in trace results (default: false)"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output format: 'json' (default) or 'mermaid' (flowchart diagram)"),
      filter_react_hooks: zBool().describe("Skip edges to React stdlib hooks (useState, useEffect, etc.) to reduce call graph noise in React codebases (default: false)"),
    })),
    handler: async (args) => {
      const result = await traceCallChain(args.repo as string, args.symbol_name as string, args.direction as Direction, {
        depth: args.depth as number | undefined,
        include_source: args.include_source as boolean | undefined,
        include_tests: args.include_tests as boolean | undefined,
        output_format: args.output_format as "json" | "mermaid" | undefined,
        filter_react_hooks: args.filter_react_hooks as boolean | undefined,
      });
      const output = formatCallTree(result as never);
      const isEmpty = typeof result === "object" && result != null && "children" in result && Array.isArray((result as { children: unknown[] }).children) && (result as { children: unknown[] }).children.length === 0;
      const hint = await checkTextStubHint(args.repo as string, "trace_call_chain", isEmpty);
      return hint ? hint + output : output;
    },
  },
  {
    name: "impact_analysis",
    category: "graph",
    searchHint: "impact analysis blast radius git changes affected symbols",
    outputSchema: OutputSchemas.impactAnalysis,
    description: "Blast radius of git changes — affected symbols and files.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      since: z.string().describe("Git ref to compare from (e.g. HEAD~3, commit SHA, branch)"),
      depth: zNum().describe("Depth of dependency traversal"),
      until: z.string().optional().describe("Git ref to compare to (defaults to HEAD)"),
      include_source: zBool().describe("Include full source code of affected symbols (default: false)"),
    })),
    handler: async (args) => {
      const result = await impactAnalysis(args.repo as string, args.since as string, {
        depth: args.depth as number | undefined,
        until: args.until as string | undefined,
        include_source: args.include_source as boolean | undefined,
      });
      return formatImpactAnalysis(result as never);
    },
  },

  {
    name: "trace_component_tree",
    category: "graph",
    searchHint: "react component tree composition render jsx parent child hierarchy",
    description: "Trace React component composition tree from a root component. Shows which components render which via JSX. React equivalent of trace_call_chain. output_format='mermaid' for diagram.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      component_name: z.string().describe("Root component name (must have kind 'component' in index)"),
      depth: zNum().describe("Maximum depth of composition tree (default: 3)"),
      include_source: zBool().describe("Include full source of each component (default: false)"),
      include_tests: zBool().describe("Include test files (default: false)"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output format: 'json' (default) or 'mermaid'"),
    })),
    handler: async (args) => {
      const result = await traceComponentTree(args.repo as string, args.component_name as string, {
        depth: args.depth as number | undefined,
        include_source: args.include_source as boolean | undefined,
        include_tests: args.include_tests as boolean | undefined,
        output_format: args.output_format as "json" | "mermaid" | undefined,
      });
      return JSON.stringify(result, null, 2);
    },
  },

  {
    name: "analyze_hooks",
    category: "analysis",
    searchHint: "react hooks analyze inventory rule of hooks violations usestate useeffect custom",
    description: "Analyze React hooks: inventory per component, Rule of Hooks violations (hook inside if/loop, hook after early return), custom hook composition, codebase-wide hook usage summary.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      component_name: z.string().optional().describe("Filter to single component/hook (default: all)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      include_tests: zBool().describe("Include test files (default: false)"),
      max_entries: zNum().describe("Max entries to return (default: 100)"),
    })),
    handler: async (args) => {
      const result = await analyzeHooks(args.repo as string, {
        component_name: args.component_name as string | undefined,
        file_pattern: args.file_pattern as string | undefined,
        include_tests: args.include_tests as boolean | undefined,
        max_entries: args.max_entries as number | undefined,
      });
      return JSON.stringify(result, null, 2);
    },
  },

  {
    name: "analyze_renders",
    category: "analysis",
    searchHint: "react render performance inline props memo useCallback useMemo re-render risk optimization",
    description: "Static re-render risk analysis for React components. Detects inline object/array/function props in JSX (new reference every render), unstable default values (= [] or = {}), and components missing React.memo that render children. Returns per-component risk level (low/medium/high) with actionable suggestions.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      component_name: z.string().optional().describe("Filter to single component (default: all)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      include_tests: zBool().describe("Include test files (default: false)"),
      max_entries: zNum().describe("Max entries to return (default: 100)"),
    })),
    handler: async (args) => {
      const result = await analyzeRenders(args.repo as string, {
        component_name: args.component_name as string | undefined,
        file_pattern: args.file_pattern as string | undefined,
        include_tests: args.include_tests as boolean | undefined,
        max_entries: args.max_entries as number | undefined,
      });
      return JSON.stringify(result, null, 2);
    },
  },

  {
    name: "analyze_context_graph",
    category: "analysis",
    searchHint: "react context createContext provider useContext consumer re-render propagation",
    description: "Map React context flows: createContext → Provider → useContext consumers. Shows which components consume each context and which provide values. Helps identify unnecessary re-renders from context value changes.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const index = await getCodeIndex(args.repo as string);
      if (!index) throw new Error(`Repository not found: ${args.repo}`);
      const result = await buildContextGraph(index.symbols);
      return JSON.stringify(result, null, 2);
    },
  },

  {
    name: "audit_compiler_readiness",
    category: "analysis",
    searchHint: "react compiler forget memoization bailout readiness migration adoption auto-memo",
    description: "Audit React Compiler (v1.0) adoption readiness. Scans all components for patterns that cause silent bailout (side effects in render, ref reads, prop/state mutation, try/catch). Returns readiness score (0-100), prioritized fix list, and count of redundant manual memoization safe to remove post-adoption. No competitor offers codebase-wide compiler readiness analysis.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      include_tests: zBool().describe("Include test files (default: false)"),
    })),
    handler: async (args) => {
      const result = await auditCompilerReadiness(args.repo as string, {
        file_pattern: args.file_pattern as string | undefined,
        include_tests: args.include_tests as boolean | undefined,
      });
      return JSON.stringify(result, null, 2);
    },
  },

  {
    name: "react_quickstart",
    category: "analysis",
    searchHint: "react onboarding day-1 overview stack inventory components hooks critical issues",
    description: "Day-1 onboarding composite for React projects. Single call returns: component/hook inventory, stack detection (state mgmt, routing, UI lib, form lib, build tool), critical pattern scan (XSS, Rule of Hooks, memory leaks), top hook usage, and suggested next queries. Replaces 5-6 manual tool calls. First tool to run on an unfamiliar React codebase.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const result = await reactQuickstart(args.repo as string);
      return JSON.stringify(result, null, 2);
    },
  },

  {
    name: "trace_route",
    category: "graph",
    searchHint: "trace HTTP route handler API endpoint service database NestJS Express Next.js",
    description: "Trace HTTP route → handler → service → DB. NestJS, Next.js, Express.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      path: z.string().describe("URL path to trace (e.g. '/api/users', '/api/projects/:id')"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output format: 'json' (default) or 'mermaid' (sequence diagram)"),
    })),
    handler: async (args) => {
      const result = await traceRoute(args.repo as string, args.path as string, args.output_format as "json" | "mermaid" | undefined);
      return formatTraceRoute(result as never);
    },
  },

  {
    name: "go_to_definition",
    category: "lsp",
    searchHint: "go to definition jump navigate LSP language server",
    outputSchema: OutputSchemas.definition,
    description: "Go to the definition of a symbol. Uses LSP when available for type-safe precision, falls back to index search.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().describe("Symbol name to find definition of"),
      file_path: z.string().optional().describe("File containing the symbol reference (for LSP precision)"),
      line: zNum().describe("0-based line number of the reference"),
      character: zNum().describe("0-based column of the reference"),
    })),
    handler: async (args) => {
      const result = await goToDefinition(
        args.repo as string,
        args.symbol_name as string,
        args.file_path as string | undefined,
        args.line as number | undefined,
        args.character as number | undefined,
      );
      if (!result) return null;
      const preview = result.preview ? `\n${result.preview}` : "";
      return `${result.file}:${result.line + 1} (via ${result.via})${preview}`;
    },
  },

  {
    name: "get_type_info",
    category: "lsp",
    searchHint: "type information hover documentation return type parameters LSP",
    outputSchema: OutputSchemas.typeInfo,
    description: "Get type info via LSP hover (return type, params, docs). Hint if LSP unavailable.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().describe("Symbol name to get type info for"),
      file_path: z.string().optional().describe("File containing the symbol"),
      line: zNum().describe("0-based line number"),
      character: zNum().describe("0-based column"),
    })),
    handler: (args) => getTypeInfo(
      args.repo as string,
      args.symbol_name as string,
      args.file_path as string | undefined,
      args.line as number | undefined,
      args.character as number | undefined,
    ),
  },

  {
    name: "rename_symbol",
    category: "lsp",
    searchHint: "rename symbol refactor LSP type-safe all files",
    outputSchema: OutputSchemas.renameResult,
    description: "Rename symbol across all files via LSP. Type-safe, updates imports/refs.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().describe("Current name of the symbol to rename"),
      new_name: z.string().describe("New name for the symbol"),
      file_path: z.string().optional().describe("File containing the symbol"),
      line: zNum().describe("0-based line number"),
      character: zNum().describe("0-based column"),
    })),
    handler: (args) => renameSymbol(
      args.repo as string,
      args.symbol_name as string,
      args.new_name as string,
      args.file_path as string | undefined,
      args.line as number | undefined,
      args.character as number | undefined,
    ),
  },

  {
    name: "get_call_hierarchy",
    category: "lsp",
    searchHint: "call hierarchy incoming outgoing calls who calls what calls LSP callers callees",
    outputSchema: OutputSchemas.callHierarchy,
    description: "LSP call hierarchy: incoming + outgoing calls. Complements trace_call_chain.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().describe("Symbol name to get call hierarchy for"),
      file_path: z.string().optional().describe("File containing the symbol (for LSP precision)"),
      line: zNum().describe("0-based line number"),
      character: zNum().describe("0-based column"),
    })),
    handler: async (args) => {
      const result = await getCallHierarchy(
        args.repo as string,
        args.symbol_name as string,
        args.file_path as string | undefined,
        args.line as number | undefined,
        args.character as number | undefined,
      );

      if (result.via === "unavailable") {
        return { ...result };
      }

      // Compact text format
      const lines: string[] = [];
      lines.push(`${result.symbol.kind} ${result.symbol.name} (${result.symbol.file}:${result.symbol.line})`);

      if (result.incoming.length > 0) {
        lines.push(`\n--- incoming calls (${result.incoming.length}) ---`);
        for (const c of result.incoming) {
          lines.push(`  ${c.kind} ${c.name} (${c.file}:${c.line})`);
        }
      }

      if (result.outgoing.length > 0) {
        lines.push(`\n--- outgoing calls (${result.outgoing.length}) ---`);
        for (const c of result.outgoing) {
          lines.push(`  ${c.kind} ${c.name} (${c.file}:${c.line})`);
        }
      }

      if (result.incoming.length === 0 && result.outgoing.length === 0) {
        lines.push("\nNo incoming or outgoing calls found.");
      }

      return lines.join("\n");
    },
  },

  {
    name: "detect_communities",
    category: "architecture",
    searchHint: "community detection clusters modules Louvain import graph boundaries",
    description: "Louvain community detection on import graph. Discovers module boundaries.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      focus: z.string().optional().describe("Path substring to filter files (e.g. 'src/lib')"),
      resolution: zNum().describe("Louvain resolution: higher = more smaller communities, lower = fewer larger (default: 1.0)"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output format: 'json' (default) or 'mermaid' (graph diagram)"),
    })),
    handler: async (args) => {
      const result = await detectCommunities(
        args.repo as string,
        args.focus as string | undefined,
        args.resolution as number | undefined,
        args.output_format as "json" | "mermaid" | undefined,
      );
      return formatCommunities(result as never);
    },
  },

  {
    name: "find_circular_deps",
    category: "architecture",
    searchHint: "circular dependency cycle import loop detection",
    description: "Detect circular dependencies in the import graph via DFS. Returns file-level cycles.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      max_cycles: zNum().describe("Maximum cycles to report (default: 50)"),
    })),
    handler: async (args) => {
      const { findCircularDeps } = await import("./tools/graph-tools.js");
      const opts: Parameters<typeof findCircularDeps>[1] = {};
      if (args.file_pattern != null) opts.file_pattern = args.file_pattern as string;
      if (args.max_cycles != null) opts.max_cycles = args.max_cycles as number;
      const result = await findCircularDeps(args.repo as string, opts);
      if (result.cycles.length === 0) {
        return `No circular dependencies found (scanned ${result.total_files} files, ${result.total_edges} edges)`;
      }
      const lines = [`${result.cycles.length} circular dependencies found (${result.total_files} files, ${result.total_edges} edges):\n`];
      for (const c of result.cycles) {
        lines.push(`  ${c.cycle.join(" → ")}`);
      }
      return lines.join("\n");
    },
  },
  {
    name: "check_boundaries",
    category: "architecture",
    searchHint: "boundary rules architecture enforcement imports CI gate hexagonal onion",
    description: "Check architecture boundary rules against imports. Path substring matching.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      rules: z.union([
        z.array(z.object({
          from: z.string().describe("Path substring matching source files (e.g. 'src/domain')"),
          cannot_import: z.array(z.string()).optional().describe("Path patterns that matched files must NOT import"),
          can_only_import: z.array(z.string()).optional().describe("Path patterns that matched files may ONLY import (allowlist)"),
        })),
        z.string().transform((s) => JSON.parse(s) as Array<{ from: string; cannot_import?: string[]; can_only_import?: string[] }>),
      ]).describe("Array of boundary rules to check. JSON string OK."),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
    })),
    handler: async (args) => {
      const { checkBoundaries } = await import("./tools/boundary-tools.js");
      return checkBoundaries(
        args.repo as string,
        args.rules as Array<{ from: string; cannot_import?: string[]; can_only_import?: string[] }>,
        { file_pattern: args.file_pattern as string | undefined },
      );
    },
  },
  {
    name: "classify_roles",
    category: "architecture",
    searchHint: "classify roles entry core utility dead leaf symbol architecture",
    description: "Classify symbol roles (entry/core/utility/dead/leaf) by call graph connectivity.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      include_tests: zBool().describe("Include test files (default: false)"),
      top_n: zNum().describe("Maximum number of symbols to return (default: 100)"),
    })),
    handler: async (args) => {
      const { classifySymbolRoles } = await import("./tools/graph-tools.js");
      const result = await classifySymbolRoles(args.repo as string, {
        file_pattern: args.file_pattern as string | undefined,
        include_tests: args.include_tests as boolean | undefined,
        top_n: args.top_n as number | undefined,
      });
      return formatRoles(result as never);
    },
  },

  // --- Context & knowledge ---
  {
    name: "assemble_context",
    category: "context",
    searchHint: "assemble context token budget L0 L1 L2 L3 source signatures summaries",
    description: "Assemble code context within token budget. L0=source, L1=signatures, L2=files, L3=dirs.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      query: z.string().describe("Natural language query describing what context is needed"),
      token_budget: zNum().describe("Maximum tokens for the assembled context"),
      level: z.enum(["L0", "L1", "L2", "L3"]).optional().describe("L0=source (default), L1=signatures, L2=files, L3=dirs"),
      rerank: zBool().describe("Rerank results using cross-encoder model for improved relevance (requires @huggingface/transformers)"),
    })),
    handler: async (args) => {
      const result = await assembleContext(
        args.repo as string,
        args.query as string,
        args.token_budget as number | undefined,
        args.level as "L0" | "L1" | "L2" | "L3" | undefined,
        args.rerank as boolean | undefined,
      );
      return formatAssembleContext(result as never);
    },
  },
  {
    name: "get_knowledge_map",
    category: "context",
    searchHint: "knowledge map module dependency graph architecture overview mermaid",
    description: "Get the module dependency map showing how files and directories relate",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      focus: z.string().optional().describe("Focus on a specific module or directory"),
      depth: zNum().describe("Maximum depth of the dependency graph"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output format: 'json' (default) or 'mermaid' (dependency diagram)"),
    })),
    handler: async (args) => {
      const result = await getKnowledgeMap(args.repo as string, args.focus as string | undefined, args.depth as number | undefined, args.output_format as "json" | "mermaid" | undefined);
      return formatKnowledgeMap(result as never);
    },
  },

  // --- Diff ---
  {
    name: "diff_outline",
    category: "diff",
    searchHint: "diff outline structural changes git refs compare",
    description: "Get a structural outline of what changed between two git refs",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      since: z.string().describe("Git ref to compare from"),
      until: z.string().optional().describe("Git ref to compare to (defaults to HEAD)"),
    })),
    handler: async (args) => {
      const result = await diffOutline(args.repo as string, args.since as string, args.until as string | undefined);
      return formatDiffOutline(result as never);
    },
  },
  {
    name: "changed_symbols",
    category: "diff",
    searchHint: "changed symbols added modified removed git diff",
    description: "List symbols that were added, modified, or removed between two git refs",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      since: z.string().describe("Git ref to compare from"),
      until: z.string().optional().describe("Git ref to compare to (defaults to HEAD)"),
      include_diff: zBool().describe("Include unified diff per changed file (truncated to 500 chars)"),
    })),
    handler: async (args) => {
      const opts: { include_diff?: boolean } = {};
      if (args.include_diff === true) opts.include_diff = true;
      const result = await changedSymbols(args.repo as string, args.since as string, args.until as string | undefined, opts);
      return formatChangedSymbols(result as never);
    },
  },

  // --- Generation ---
  {
    name: "generate_claude_md",
    category: "reporting",
    searchHint: "generate CLAUDE.md project summary documentation",
    description: "Generate a CLAUDE.md project summary file from the repository index",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      output_path: z.string().optional().describe("Custom output file path"),
    })),
    handler: (args) => generateClaudeMd(args.repo as string, args.output_path as string | undefined),
  },

  // --- Batch retrieval ---
  {
    name: "codebase_retrieval",
    category: "search",
    searchHint: "batch retrieval multi-query semantic hybrid token budget",
    outputSchema: OutputSchemas.batchResults,
    description: "Batch multi-query retrieval with shared token budget. Supports symbols/text/semantic/hybrid.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      queries: z
        .union([
          z.array(z.object({ type: z.string() }).passthrough()),
          z.string().transform((s) => JSON.parse(s) as Array<{ type: string } & Record<string, unknown>>),
        ])
        .describe("Sub-queries array (symbols/text/file_tree/outline/references/call_chain/impact/context/knowledge_map). JSON string OK."),
      token_budget: zNum().describe("Maximum total tokens across all sub-query results"),
    })),
    handler: async (args) => {
      const result = await codebaseRetrieval(
        args.repo as string,
        args.queries as Array<{ type: string } & Record<string, unknown>>,
        args.token_budget as number | undefined,
      );
      // Format as text sections instead of JSON envelope
      const sections = result.results.map((r) => {
        const dataStr = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
        return `--- ${r.type} ---\n${dataStr}`;
      });
      let output = sections.join("\n\n");
      if (result.truncated) output += "\n\n(truncated: token budget exceeded)";
      return output;
    },
  },

  // --- Analysis ---
  {
    name: "find_dead_code",
    category: "analysis",
    searchHint: "dead code unused exports unreferenced symbols cleanup",
    outputSchema: OutputSchemas.deadCode,
    description: "Find dead code: exported symbols with zero external references.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      include_tests: zBool().describe("Include test files in scan (default: false)"),
    })),
    handler: async (args) => {
      const result = await findDeadCode(args.repo as string, {
        file_pattern: args.file_pattern as string | undefined,
        include_tests: args.include_tests as boolean | undefined,
      });
      const output = formatDeadCode(result as never);
      const isEmpty = !result || ((result as { candidates: unknown[] }).candidates?.length ?? 0) === 0;
      const hint = await checkTextStubHint(args.repo as string, "find_dead_code", isEmpty);
      return hint ? hint + output : output;
    },
  },
  {
    name: "find_unused_imports",
    category: "analysis",
    searchHint: "unused imports dead cleanup lint",
    description: "Find imported names never referenced in the file body. Complements find_dead_code.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      include_tests: zBool().describe("Include test files in scan (default: false)"),
    })),
    handler: async (args) => {
      const { findUnusedImports } = await import("./tools/symbol-tools.js");
      const opts: Parameters<typeof findUnusedImports>[1] = {};
      if (args.file_pattern != null) opts.file_pattern = args.file_pattern as string;
      if (args.include_tests != null) opts.include_tests = args.include_tests as boolean;
      const result = await findUnusedImports(args.repo as string, opts);
      if (result.unused.length === 0) {
        return `No unused imports found (scanned ${result.scanned_files} files)`;
      }
      const lines = [`${result.unused.length} unused imports (${result.scanned_files} files scanned)${result.truncated ? " [truncated]" : ""}:\n`];
      for (const u of result.unused) {
        lines.push(`  ${u.file}:${u.line} — "${u.imported_name}"`);
      }
      return lines.join("\n");
    },
  },
  {
    name: "analyze_complexity",
    category: "analysis",
    searchHint: "complexity cyclomatic nesting refactoring functions",
    outputSchema: OutputSchemas.complexity,
    description: "Top N most complex functions by cyclomatic complexity, nesting, lines.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      top_n: zNum().describe("Return top N most complex functions (default: 30)"),
      min_complexity: zNum().describe("Minimum cyclomatic complexity to include (default: 1)"),
      include_tests: zBool().describe("Include test files (default: false)"),
    })),
    handler: async (args) => {
      const result = await analyzeComplexity(args.repo as string, {
        file_pattern: args.file_pattern as string | undefined,
        top_n: args.top_n as number | undefined,
        min_complexity: args.min_complexity as number | undefined,
        include_tests: args.include_tests as boolean | undefined,
      });
      const output = formatComplexity(result as never);
      const isEmpty = !result || ((result as { functions: unknown[] }).functions?.length ?? 0) === 0;
      const hint = await checkTextStubHint(args.repo as string, "analyze_complexity", isEmpty);
      return hint ? hint + output : output;
    },
  },
  {
    name: "find_clones",
    category: "analysis",
    searchHint: "code clones duplicates copy-paste detection similar functions",
    outputSchema: OutputSchemas.clones,
    description: "Find code clones: similar function pairs via hash bucketing + line-similarity.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      min_similarity: zNum().describe("Minimum similarity threshold 0-1 (default: 0.7)"),
      min_lines: zNum().describe("Minimum normalized lines to consider (default: 10)"),
      include_tests: zBool().describe("Include test files (default: false)"),
    })),
    handler: async (args) => {
      const result = await findClones(args.repo as string, {
        file_pattern: args.file_pattern as string | undefined,
        min_similarity: args.min_similarity as number | undefined,
        min_lines: args.min_lines as number | undefined,
        include_tests: args.include_tests as boolean | undefined,
      });
      return formatClones(result as never);
    },
  },
  {
    name: "frequency_analysis",
    category: "analysis",
    searchHint: "frequency analysis common patterns AST shape clusters",
    description: "Group functions by normalized AST shape. Finds emergent patterns invisible to regex.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      top_n: zNum().optional().describe("Number of clusters to return (default: 30)"),
      min_nodes: zNum().optional().describe("Minimum AST nodes in a subtree to include (default: 5)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      kind: z.string().optional().describe("Filter by symbol kind, comma-separated (default: function,method)"),
      include_tests: zBool().describe("Include test files (default: false)"),
      token_budget: zNum().optional().describe("Max tokens for response"),
    })),
    handler: async (args) => frequencyAnalysis(
      args.repo as string,
      {
        top_n: args.top_n as number | undefined,
        min_nodes: args.min_nodes as number | undefined,
        file_pattern: args.file_pattern as string | undefined,
        kind: args.kind as string | undefined,
        include_tests: args.include_tests as boolean | undefined,
        token_budget: args.token_budget as number | undefined,
      },
    ),
  },
  {
    name: "analyze_hotspots",
    category: "analysis",
    searchHint: "hotspots git churn bug-prone change frequency complexity",
    description: "Git churn hotspots: change frequency × complexity. Higher score = more bug-prone.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      since_days: zNum().describe("Look back N days (default: 90)"),
      top_n: zNum().describe("Return top N hotspots (default: 30)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
    })),
    handler: async (args) => {
      const result = await analyzeHotspots(args.repo as string, {
        since_days: args.since_days as number | undefined,
        top_n: args.top_n as number | undefined,
        file_pattern: args.file_pattern as string | undefined,
      });
      return formatHotspots(result as never);
    },
  },

  // --- Cross-repo ---
  {
    name: "cross_repo_search",
    category: "cross-repo",
    searchHint: "cross-repo search symbols across all repositories monorepo microservice",
    description: "Search symbols across ALL indexed repositories. Useful for monorepos and microservice architectures.",
    schema: lazySchema(() => ({
      query: z.string().describe("Symbol search query"),
      repo_pattern: z.string().optional().describe("Filter repos by name pattern (e.g. 'local/tgm')"),
      kind: z.string().optional().describe("Filter by symbol kind"),
      top_k: zNum().describe("Max results per repo (default: 10)"),
      include_source: zBool().describe("Include source code"),
    })),
    handler: (args) => crossRepoSearchSymbols(args.query as string, {
      repo_pattern: args.repo_pattern as string | undefined,
      kind: args.kind as SymbolKind | undefined,
      top_k: args.top_k as number | undefined,
      include_source: args.include_source as boolean | undefined,
    }),
  },
  {
    name: "cross_repo_refs",
    category: "cross-repo",
    searchHint: "cross-repo references symbol across all repositories",
    description: "Find references to a symbol across ALL indexed repositories.",
    schema: lazySchema(() => ({
      symbol_name: z.string().describe("Symbol name to find references for"),
      repo_pattern: z.string().optional().describe("Filter repos by name pattern"),
      file_pattern: z.string().optional().describe("Filter files by glob pattern"),
    })),
    handler: (args) => crossRepoFindReferences(args.symbol_name as string, {
      repo_pattern: args.repo_pattern as string | undefined,
      file_pattern: args.file_pattern as string | undefined,
    }),
  },

  // --- Patterns ---
  {
    name: "search_patterns",
    category: "patterns",
    searchHint: "search patterns anti-patterns CQ violations useEffect empty-catch console-log",
    description: "Search structural patterns/anti-patterns. Built-in or custom regex.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      pattern: z.string().describe("Built-in pattern name or custom regex"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      include_tests: zBool().describe("Include test files (default: false)"),
      max_results: zNum().describe("Max results (default: 50)"),
    })),
    handler: async (args) => {
      const result = await searchPatterns(args.repo as string, args.pattern as string, {
        file_pattern: args.file_pattern as string | undefined,
        include_tests: args.include_tests as boolean | undefined,
        max_results: args.max_results as number | undefined,
      });
      return formatSearchPatterns(result as never);
    },
  },
  {
    name: "list_patterns",
    category: "patterns",
    searchHint: "list available built-in patterns anti-patterns",
    description: "List all available built-in structural code patterns for search_patterns.",
    schema: lazySchema(() => ({})),
    handler: async () => listPatterns(),
  },

  // --- Report ---
  {
    name: "generate_report",
    category: "reporting",
    searchHint: "generate HTML report complexity dead code hotspots architecture browser",
    description: "Generate a standalone HTML report with complexity, dead code, hotspots, and architecture. Opens in any browser.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: (args) => generateReport(args.repo as string),
  },

  {
    name: "generate_wiki",
    category: "reporting",
    searchHint: "generate wiki markdown community hub architecture documentation",
    description: "Generate wiki pages and optional Lens HTML dashboard from code topology (communities, hubs, surprises, hotspots).",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      focus: z.string().optional().describe("Scope to directory (e.g., 'src/tools')"),
      output_dir: z.string().optional().describe("Output directory (default: {repo_root}/.codesift/wiki)"),
    })),
    handler: async (args) => {
      const opts: { focus?: string; output_dir?: string } = {};
      if (args.focus !== undefined) opts.focus = args.focus as string;
      if (args.output_dir !== undefined) opts.output_dir = args.output_dir as string;
      const result = await generateWiki(args.repo as string, opts);
      return JSON.stringify(result, null, 2);
    },
  },

  // --- Conversations ---
  {
    name: "index_conversations",
    category: "conversations",
    searchHint: "index conversations Claude Code history JSONL",
    description: "Index Claude Code conversation history for search. Scans JSONL files in ~/.claude/projects/ for the given project path.",
    schema: lazySchema(() => ({
      project_path: z.string().optional().describe("Path to the Claude project conversations directory. Auto-detects from cwd if omitted."),
      quiet: zBool().describe("Suppress output (used by session-end hook)"),
    })),
    handler: async (args) => indexConversations(args.project_path as string | undefined),
  },
  {
    name: "search_conversations",
    category: "conversations",
    searchHint: "search conversations past sessions history BM25 semantic",
    description: "Search conversations in one project (BM25+semantic). For all projects: search_all_conversations.",
    schema: lazySchema(() => ({
      query: z.string().describe("Search query — keywords or natural language"),
      project: z.string().optional().describe("Project path to search (default: current project)"),
      limit: zNum().optional().describe("Maximum results to return (default: 10, max: 50)"),
    })),
    handler: async (args) => {
      const result = await searchConversations(args.query as string, args.project as string | undefined, args.limit as number | undefined);
      return formatConversations(result as never);
    },
  },
  {
    name: "find_conversations_for_symbol",
    category: "conversations",
    searchHint: "find conversations symbol discussion cross-reference code",
    description: "Find conversations that discussed a code symbol. Cross-refs code + history.",
    schema: lazySchema(() => ({
      symbol_name: z.string().describe("Name of the code symbol to search for in conversations"),
      repo: z.string().describe("Code repository to resolve the symbol from (e.g., 'local/my-project')"),
      limit: zNum().optional().describe("Maximum conversation results (default: 5)"),
    })),
    handler: async (args) => {
      const result = await findConversationsForSymbol(args.symbol_name as string, args.repo as string, args.limit as number | undefined);
      return formatConversations(result as never);
    },
  },

  {
    name: "search_all_conversations",
    category: "conversations",
    searchHint: "search all conversations every project cross-project",
    description: "Search ALL conversation projects at once, ranked by relevance.",
    schema: lazySchema(() => ({
      query: z.string().describe("Search query — keywords, natural language, or concept"),
      limit: zNum().optional().describe("Maximum results across all projects (default: 10)"),
    })),
    handler: async (args) => {
      const result = await searchAllConversations(args.query as string, args.limit as number | undefined);
      return formatConversations(result as never);
    },
  },

  // --- Security ---
  {
    name: "scan_secrets",
    category: "security",
    searchHint: "scan secrets API keys tokens passwords credentials security",
    outputSchema: OutputSchemas.secrets,
    description: "Scan for hardcoded secrets (API keys, tokens, passwords). ~1,100 rules.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Glob pattern to filter scanned files"),
      min_confidence: z.enum(["high", "medium", "low"]).optional().describe("Minimum confidence level (default: medium)"),
      exclude_tests: zBool().describe("Exclude test file findings (default: true)"),
      severity: z.enum(["critical", "high", "medium", "low"]).optional().describe("Minimum severity level"),
    })),
    handler: async (args) => {
      const result = await scanSecrets(args.repo as string, {
        file_pattern: args.file_pattern as string | undefined,
        min_confidence: args.min_confidence as "high" | "medium" | "low" | undefined,
        exclude_tests: args.exclude_tests as boolean | undefined,
        severity: args.severity as SecretSeverity | undefined,
      });
      return formatSecrets(result as never);
    },
  },

  // --- Kotlin tools (discoverable via discover_tools(query="kotlin")) ---
  {
    name: "find_extension_functions",
    category: "analysis",
    requiresLanguage: "kotlin",
    searchHint: "kotlin extension function receiver type method discovery",
    description: "Find all Kotlin extension functions for a given receiver type. Scans indexed symbols for signatures matching 'ReceiverType.' prefix.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      receiver_type: z.string().describe("Receiver type name, e.g. 'String', 'List', 'User'"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
    })),
    handler: async (args) => {
      const opts: { file_pattern?: string } = {};
      if (typeof args.file_pattern === "string") opts.file_pattern = args.file_pattern;
      return await findExtensionFunctions(args.repo as string, args.receiver_type as string, opts);
    },
  },
  {
    name: "analyze_sealed_hierarchy",
    category: "analysis",
    requiresLanguage: "kotlin",
    searchHint: "kotlin sealed class interface subtype when exhaustive branch missing hierarchy",
    description: "Analyze a Kotlin sealed class/interface: find all subtypes and check when() blocks for exhaustiveness (missing branches).",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      sealed_class: z.string().describe("Name of the sealed class or interface to analyze"),
    })),
    handler: async (args) => {
      return await analyzeSealedHierarchy(args.repo as string, args.sealed_class as string);
    },
  },
  {
    name: "trace_hilt_graph",
    category: "analysis",
    searchHint: "hilt dagger DI dependency injection viewmodel inject module provides binds android kotlin graph",
    description: "Trace a Hilt DI dependency tree rooted at a class annotated with @HiltViewModel / @AndroidEntryPoint / @HiltAndroidApp. Returns constructor dependencies with matching @Provides/@Binds providers and their module. Unresolved deps are flagged.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      class_name: z.string().describe("Name of the Hilt-annotated class (e.g. 'UserViewModel')"),
      depth: z.number().optional().describe("Max traversal depth (default: 1)"),
    })),
    handler: async (args) => {
      const opts: { depth?: number } = {};
      if (typeof args.depth === "number") opts.depth = args.depth;
      return await traceHiltGraph(args.repo as string, args.class_name as string, opts);
    },
  },
  {
    name: "trace_suspend_chain",
    category: "analysis",
    searchHint: "kotlin coroutine suspend dispatcher withContext runBlocking Thread.sleep blocking chain trace anti-pattern",
    description: "Trace the call chain of a Kotlin suspend function, emitting dispatcher transitions (withContext(Dispatchers.X)) and warnings for coroutine anti-patterns: runBlocking inside suspend, Thread.sleep, non-cancellable while(true) loops. Lexical walk — follows callee names found in the source, filtered to suspend-only functions.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      function_name: z.string().describe("Name of the suspend function to trace"),
      depth: z.number().optional().describe("Max chain depth (default: 3)"),
    })),
    handler: async (args) => {
      const opts: { depth?: number } = {};
      if (typeof args.depth === "number") opts.depth = args.depth;
      return await traceSuspendChain(args.repo as string, args.function_name as string, opts);
    },
  },
  {
    name: "analyze_kmp_declarations",
    category: "analysis",
    searchHint: "kotlin multiplatform kmp expect actual source set common main android ios jvm js missing orphan",
    description: "Validate Kotlin Multiplatform expect/actual declarations across source sets. For each `expect` in commonMain, check every platform source set (androidMain/iosMain/jvmMain/jsMain/etc. discovered from the repo layout) for a matching `actual`. Reports fully matched pairs, expects missing on a platform, and orphan actuals with no corresponding expect.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      return await analyzeKmpDeclarations(args.repo as string);
    },
  },

  // --- Kotlin Wave 3 tools ---
  {
    name: "trace_compose_tree",
    category: "analysis",
    searchHint: "kotlin compose composable component tree hierarchy ui call graph jetpack preview",
    description: "Build a Jetpack Compose component hierarchy rooted at a @Composable function. Traces PascalCase calls matching indexed composables, excludes @Preview. Reports tree depth, leaf components, and total component count.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      root_name: z.string().describe("Name of the root @Composable function (e.g. 'HomeScreen')"),
      depth: z.number().optional().describe("Max tree depth (default: 10)"),
    })),
    handler: async (args) => {
      const opts: { depth?: number } = {};
      if (typeof args.depth === "number") opts.depth = args.depth;
      return await traceComposeTree(args.repo as string, args.root_name as string, opts);
    },
  },
  {
    name: "analyze_compose_recomposition",
    category: "analysis",
    searchHint: "kotlin compose recomposition unstable remember mutableStateOf performance skip lambda collection",
    description: "Detect recomposition hazards in @Composable functions: mutableStateOf without remember (critical), unstable collection parameters (List/Map/Set), excessive function-type params. Scans all indexed composables, skipping @Preview.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
    })),
    handler: async (args) => {
      const opts: { file_pattern?: string } = {};
      if (typeof args.file_pattern === "string") opts.file_pattern = args.file_pattern;
      return await analyzeComposeRecomposition(args.repo as string, opts);
    },
  },
  {
    name: "trace_room_schema",
    category: "analysis",
    searchHint: "kotlin room database entity dao query insert update delete schema sqlite persistence android",
    description: "Build a Room persistence schema graph: @Entity classes (with table names, primary keys), @Dao interfaces (with @Query SQL extraction), @Database declarations (with entity refs and version). Index-only.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      return await traceRoomSchema(args.repo as string);
    },
  },
  {
    name: "extract_kotlin_serialization_contract",
    category: "analysis",
    searchHint: "kotlin serialization serializable json schema serialname field type api contract data class",
    description: "Derive JSON field schema from @Serializable data classes. Extracts field names, types, @SerialName remapping, nullable flags, and defaults.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      class_name: z.string().optional().describe("Filter to a single class by name"),
    })),
    handler: async (args) => {
      const opts: { file_pattern?: string; class_name?: string } = {};
      if (typeof args.file_pattern === "string") opts.file_pattern = args.file_pattern;
      if (typeof args.class_name === "string") opts.class_name = args.class_name;
      return await extractKotlinSerializationContract(args.repo as string, opts);
    },
  },
  {
    name: "trace_flow_chain",
    category: "analysis",
    searchHint: "kotlin flow coroutine operator map filter collect stateIn shareIn catch chain pipeline reactive",
    description: "Analyze a Kotlin Flow<T> operator chain: detects 50+ operators, reports ordered list, warns about .collect without .catch and .stateIn without lifecycle scope.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().describe("Name of the function or property containing the Flow chain"),
    })),
    handler: async (args) => {
      return await traceFlowChain(args.repo as string, args.symbol_name as string);
    },
  },

  // --- Python tools (all discoverable via discover_tools(query="python")) ---
  {
    name: "get_model_graph",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python django sqlalchemy orm model relationship foreignkey manytomany entity graph mermaid",
    description: "Extract ORM model relationships (Django ForeignKey/M2M/O2O, SQLAlchemy relationship). JSON or mermaid erDiagram.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output as structured JSON or mermaid erDiagram"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof getModelGraph>[1] = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.output_format != null) opts!.output_format = args.output_format as "json" | "mermaid";
      return await getModelGraph(args.repo as string, opts);
    },
  },
  {
    name: "get_test_fixtures",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python pytest fixture conftest scope autouse dependency graph session function",
    description: "Extract pytest fixture dependency graph: conftest hierarchy, scope, autouse, fixture-to-fixture deps.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof getTestFixtures>[1] = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      return await getTestFixtures(args.repo as string, opts);
    },
  },
  {
    name: "find_framework_wiring",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python django signal receiver celery task middleware management command flask fastapi event wiring",
    description: "Discover implicit control flow: Django signals, Celery tasks/.delay() calls, middleware, management commands, Flask init_app, FastAPI events.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof findFrameworkWiring>[1] = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      return await findFrameworkWiring(args.repo as string, opts);
    },
  },
  {
    name: "run_ruff",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python ruff lint check bugbear performance simplify security async unused argument",
    description: "Run ruff linter with symbol graph correlation. Configurable rule categories (B, PERF, SIM, UP, S, ASYNC, RET, ARG).",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      categories: z.array(z.string()).optional().describe("Rule categories to enable (default: B,PERF,SIM,UP,S,ASYNC,RET,ARG)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      max_results: zFiniteNumber.optional().describe("Max findings to return (default: 100)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof runRuff>[1] = {};
      if (args.categories != null) opts!.categories = args.categories as string[];
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.max_results != null) opts!.max_results = args.max_results as number;
      return await runRuff(args.repo as string, opts);
    },
  },
  {
    name: "parse_pyproject",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python pyproject toml dependencies version build system entry points scripts tools ruff pytest mypy",
    description: "Parse pyproject.toml: name, version, Python version, build system, dependencies, optional groups, entry points, configured tools.",
    schema: lazySchema(() => ({ repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)") })),
    handler: async (args) => { return await parsePyproject(args.repo as string); },
  },
  {
    name: "resolve_constant_value",
    category: "analysis",
    searchHint: "python typescript nestjs resolve constant value literal alias import default parameter propagation",
    description: "Resolve Python or TypeScript constants and function default values through simple aliases and import chains. Returns literals or explicit unresolved reasons.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().describe("Constant, function, or method name to resolve"),
      file_pattern: z.string().optional().describe("Filter candidate symbols by file path substring"),
      language: z.enum(["python", "typescript"]).optional().describe("Force resolver language instead of auto-inference"),
      max_depth: zFiniteNumber.optional().describe("Maximum alias/import resolution depth (default: 8)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof resolveConstantValue>[2] & {
        language?: "python" | "typescript";
      } = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.language != null) opts!.language = args.language as "python" | "typescript";
      if (args.max_depth != null) opts!.max_depth = args.max_depth as number;
      return await resolveConstantValue(args.repo as string, args.symbol_name as string, opts);
    },
  },
  {
    name: "effective_django_view_security",
    category: "security",
    requiresLanguage: "python",
    searchHint: "python django view auth csrf login_required middleware mixin route security posture",
    description: "Assess effective Django view security from decorators, mixins, settings middleware, and optional route resolution.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      path: z.string().optional().describe("Django route path to resolve first, e.g. /settings/"),
      symbol_name: z.string().optional().describe("View function/class/method name when you already know the symbol"),
      file_pattern: z.string().optional().describe("Filter candidate symbols by file path substring"),
      settings_file: z.string().optional().describe("Explicit Django settings file path (auto-detects if omitted)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof effectiveDjangoViewSecurity>[1] = {};
      if (args.path != null) opts.path = args.path as string;
      if (args.symbol_name != null) opts.symbol_name = args.symbol_name as string;
      if (args.file_pattern != null) opts.file_pattern = args.file_pattern as string;
      if (args.settings_file != null) opts.settings_file = args.settings_file as string;
      return await effectiveDjangoViewSecurity(args.repo as string, opts);
    },
  },
  {
    name: "taint_trace",
    category: "security",
    requiresLanguage: "python",
    searchHint: "python django taint data flow source sink request get post redirect mark_safe cursor execute subprocess session trace",
    description: "Trace Python/Django user-controlled data from request sources to security sinks like redirect, mark_safe, cursor.execute, subprocess, requests/httpx, open, or session writes.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      framework: z.enum(["python-django"]).optional().describe("Currently only python-django is implemented"),
      file_pattern: z.string().optional().describe("Restrict analysis to matching Python files"),
      source_patterns: z.array(z.string()).optional().describe("Optional source pattern allowlist (defaults to request.* presets)"),
      sink_patterns: z.array(z.string()).optional().describe("Optional sink pattern allowlist (defaults to built-in security sinks)"),
      max_depth: zFiniteNumber.optional().describe("Maximum interprocedural helper depth (default: 4)"),
      max_traces: zFiniteNumber.optional().describe("Maximum traces to return before truncation (default: 50)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof taintTrace>[1] = {};
      if (args.framework != null) opts.framework = args.framework as "python-django";
      if (args.file_pattern != null) opts.file_pattern = args.file_pattern as string;
      if (args.source_patterns != null) opts.source_patterns = args.source_patterns as string[];
      if (args.sink_patterns != null) opts.sink_patterns = args.sink_patterns as string[];
      if (args.max_depth != null) opts.max_depth = args.max_depth as number;
      if (args.max_traces != null) opts.max_traces = args.max_traces as number;
      return await taintTrace(args.repo as string, opts);
    },
  },
  {
    name: "find_python_callers",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python callers call site usage trace cross module import delay apply_async constructor",
    description: "Find all call sites of a Python symbol: direct calls, method calls, Celery .delay()/.apply_async(), constructor, references.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      target_name: z.string().describe("Name of the target function/class/method"),
      target_file: z.string().optional().describe("Disambiguate target by file path substring"),
      file_pattern: z.string().optional().describe("Restrict caller search scope"),
      max_results: zFiniteNumber.optional().describe("Max callers to return (default: 100)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof findPythonCallers>[2] = {};
      if (args.target_file != null) opts!.target_file = args.target_file as string;
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.max_results != null) opts!.max_results = args.max_results as number;
      return await findPythonCallers(args.repo as string, args.target_name as string, opts);
    },
  },
  {
    name: "analyze_django_settings",
    category: "security",
    requiresLanguage: "python",
    searchHint: "python django settings security debug secret key allowed hosts csrf middleware cookie hsts cors",
    description: "Audit Django settings.py: 15 security/config checks (DEBUG, SECRET_KEY, CSRF, CORS, HSTS, cookies, sqlite, middleware).",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      settings_file: z.string().optional().describe("Explicit settings file path (auto-detects if omitted)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof analyzeDjangoSettings>[1] = {};
      if (args.settings_file != null) opts!.settings_file = args.settings_file as string;
      return await analyzeDjangoSettings(args.repo as string, opts);
    },
  },
  {
    name: "run_mypy",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python mypy type check error strict return incompatible argument missing",
    description: "Run mypy type checker with symbol correlation. Parses error codes, maps to containing symbols.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      strict: zBool().describe("Enable mypy --strict mode"),
      max_results: zFiniteNumber.optional().describe("Max findings (default: 100)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof runMypy>[1] = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.strict != null) opts!.strict = args.strict as boolean;
      if (args.max_results != null) opts!.max_results = args.max_results as number;
      return await runMypy(args.repo as string, opts);
    },
  },
  {
    name: "run_pyright",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python pyright type check reportMissingImports reportGeneralTypeIssues",
    description: "Run pyright type checker with symbol correlation. Parses JSON diagnostics, maps to containing symbols.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      strict: zBool().describe("Enable strict level"),
      max_results: zFiniteNumber.optional().describe("Max findings (default: 100)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof runPyright>[1] = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.strict != null) opts!.strict = args.strict as boolean;
      if (args.max_results != null) opts!.max_results = args.max_results as number;
      return await runPyright(args.repo as string, opts);
    },
  },
  {
    name: "analyze_python_deps",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python dependency version outdated vulnerable CVE pypi osv requirements pyproject",
    description: "Python dependency analysis: parse pyproject.toml/requirements.txt, detect unpinned deps, optional PyPI freshness, optional OSV.dev CVE scan.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      check_pypi: zBool().describe("Check PyPI for latest versions (network, opt-in)"),
      check_vulns: zBool().describe("Check OSV.dev for CVEs (network, opt-in)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof analyzePythonDeps>[1] = {};
      if (args.check_pypi != null) opts!.check_pypi = args.check_pypi as boolean;
      if (args.check_vulns != null) opts!.check_vulns = args.check_vulns as boolean;
      return await analyzePythonDeps(args.repo as string, opts);
    },
  },
  {
    name: "trace_fastapi_depends",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python fastapi depends dependency injection security scopes oauth2 authentication auth endpoint",
    description: "Trace FastAPI Depends()/Security() dependency injection chains recursively from route handlers. Detects yield deps (resource cleanup), Security() with scopes, shared deps across endpoints, endpoints without auth.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      endpoint: z.string().optional().describe("Focus on a specific endpoint function name"),
      max_depth: zFiniteNumber.optional().describe("Max dependency tree depth (default: 5)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof traceFastAPIDepends>[1] = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.endpoint != null) opts!.endpoint = args.endpoint as string;
      if (args.max_depth != null) opts!.max_depth = args.max_depth as number;
      return await traceFastAPIDepends(args.repo as string, opts);
    },
  },
  {
    name: "analyze_async_correctness",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python async await asyncio blocking sync requests sleep subprocess django sqlalchemy ORM coroutine fastapi",
    description: "Detect 8 asyncio pitfalls in async def: blocking requests/sleep/IO/subprocess, sync SQLAlchemy/Django ORM in async views, async without await, asyncio.create_task without ref storage.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      rules: z.array(z.string()).optional().describe("Subset of rules to run"),
      max_results: zFiniteNumber.optional().describe("Max findings (default: 200)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof analyzeAsyncCorrectness>[1] = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.rules != null) opts!.rules = args.rules as string[];
      if (args.max_results != null) opts!.max_results = args.max_results as number;
      return await analyzeAsyncCorrectness(args.repo as string, opts);
    },
  },
  {
    name: "get_pydantic_models",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python pydantic basemodel fastapi schema request response contract validator field constraint type classdiagram",
    description: "Extract Pydantic models: fields with types, validators, Field() constraints, model_config, cross-model references (list[X], Optional[Y]), inheritance. JSON or mermaid classDiagram.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output as structured JSON or mermaid classDiagram"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof getPydanticModels>[1] = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.output_format != null) opts!.output_format = args.output_format as "json" | "mermaid";
      return await getPydanticModels(args.repo as string, opts);
    },
  },
  {
    name: "python_audit",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python audit health score compound project review django security circular patterns celery dependencies dead code task shared_task delay apply_async chain group chord canvas retry orphan queue import cycle ImportError TYPE_CHECKING DFS",
    description: "Compound Python project health audit: circular imports + Django settings + anti-patterns (17) + framework wiring + Celery orphans + pytest fixtures + deps + dead code. Runs in parallel, returns unified health score (0-100) + severity counts + prioritized top_risks list.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      checks: z.array(z.string()).optional().describe("Subset of checks: circular_imports, django_settings, anti_patterns, framework_wiring, celery, pytest_fixtures, dependencies, dead_code"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof pythonAudit>[1] = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.checks != null) opts!.checks = args.checks as string[];
      return await pythonAudit(args.repo as string, opts);
    },
  },

  // --- PHP / Yii2 tools (all discoverable via discover_tools(query="php")) ---
  {
    name: "resolve_php_namespace",
    category: "analysis",
    requiresLanguage: "php",
    searchHint: "php namespace resolve PSR-4 autoload composer class file path yii2 laravel symfony",
    description: "Resolve a PHP FQCN to file path via composer.json PSR-4 autoload mapping.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      class_name: z.string().describe("Fully-qualified class name, e.g. 'App\\\\Models\\\\User'"),
    })),
    handler: async (args) => {
      return await resolvePhpNamespace(args.repo as string, args.class_name as string);
    },
  },
  {
    name: "trace_php_event",
    category: "analysis",
    requiresLanguage: "php",
    searchHint: "php event listener trigger handler chain yii2 laravel observer dispatch",
    description: "Trace PHP event → listener chains: find trigger() calls and matching on() handlers.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      event_name: z.string().optional().describe("Filter by specific event name"),
    })),
    handler: async (args) => {
      const opts: { event_name?: string } = {};
      if (typeof args.event_name === "string") opts.event_name = args.event_name;
      return await tracePhpEvent(args.repo as string, opts);
    },
  },
  {
    name: "find_php_views",
    category: "analysis",
    requiresLanguage: "php",
    searchHint: "php view render template controller widget yii2 laravel blade",
    description: "Map PHP controller render() calls to view files. Yii2/Laravel convention-aware.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      controller: z.string().optional().describe("Filter by controller class name"),
    })),
    handler: async (args) => {
      const opts: { controller?: string } = {};
      if (typeof args.controller === "string") opts.controller = args.controller;
      return await findPhpViews(args.repo as string, opts);
    },
  },
  {
    name: "resolve_php_service",
    category: "analysis",
    requiresLanguage: "php",
    searchHint: "php service locator DI container component resolve yii2 laravel facade provider",
    description: "Resolve PHP service locator references (Yii::$app->X, Laravel facades) to concrete classes via config parsing.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      service_name: z.string().optional().describe("Filter by specific service name (e.g. 'db', 'user', 'cache')"),
    })),
    handler: async (args) => {
      const opts: { service_name?: string } = {};
      if (typeof args.service_name === "string") opts.service_name = args.service_name;
      return await resolvePhpService(args.repo as string, opts);
    },
  },
  {
    name: "php_security_scan",
    category: "security",
    requiresLanguage: "php",
    searchHint: "php security scan audit vulnerability injection XSS CSRF SQL eval exec unserialize",
    description: "Scan PHP code for security vulnerabilities: SQL injection, XSS, eval, exec, unserialize, file inclusion. Parallel pattern checks.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Glob pattern to filter scanned files (default: '*.php')"),
      checks: z.array(z.string()).optional().describe("Subset of checks to run: sql-injection-php, xss-php, eval-php, exec-php, unserialize-php, file-include-var, unescaped-yii-view, raw-query-yii"),
    })),
    handler: async (args) => {
      const opts: { file_pattern?: string; checks?: string[] } = {};
      if (typeof args.file_pattern === "string") opts.file_pattern = args.file_pattern;
      if (Array.isArray(args.checks)) opts.checks = args.checks as string[];
      return await phpSecurityScan(args.repo as string, opts);
    },
  },
  {
    name: "php_project_audit",
    category: "analysis",
    requiresLanguage: "php",
    searchHint: "php project audit health quality technical debt code review comprehensive yii2 laravel activerecord eloquent model schema relations rules behaviors table orm n+1 query foreach eager loading relation god class anti-pattern too many methods oversized",
    description: "Compound PHP project audit: security scan + ActiveRecord analysis + N+1 detection + god model detection + health score. Runs checks in parallel.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Glob pattern to filter analyzed files"),
      checks: z.string().optional().describe("Comma-separated checks: n_plus_one, god_model, activerecord, security, events, views, services, namespace. Default: all"),
    })),
    handler: async (args) => {
      const opts: { file_pattern?: string; checks?: string[] } = {};
      if (typeof args.file_pattern === "string") opts.file_pattern = args.file_pattern;
      if (typeof args.checks === "string" && args.checks.trim()) {
        opts.checks = args.checks.split(",").map((c) => c.trim()).filter(Boolean);
      }
      return await phpProjectAudit(args.repo as string, opts);
    },
  },

  // --- Memory consolidation ---
  {
    name: "consolidate_memories",
    category: "conversations",
    searchHint: "consolidate memories dream knowledge MEMORY.md decisions solutions patterns",
    description: "Consolidate conversations into MEMORY.md — decisions, solutions, patterns.",
    schema: lazySchema(() => ({
      project_path: z.string().optional().describe("Project path (auto-detects from cwd if omitted)"),
      output_path: z.string().optional().describe("Custom output file path (default: MEMORY.md in project root)"),
      min_confidence: z.enum(["high", "medium", "low"]).optional().describe("Minimum confidence level for extracted memories (default: low)"),
    })),
    handler: async (args) => {
      const opts: { output_path?: string; min_confidence?: "high" | "medium" | "low" } = {};
      if (typeof args.output_path === "string") opts.output_path = args.output_path;
      if (typeof args.min_confidence === "string") opts.min_confidence = args.min_confidence as "high" | "medium" | "low";
      const result = await consolidateMemories(args.project_path as string | undefined, opts);
      return result;
    },
  },
  {
    name: "read_memory",
    category: "conversations",
    searchHint: "read memory MEMORY.md institutional knowledge past decisions",
    description: "Read MEMORY.md knowledge file with past decisions and patterns.",
    schema: lazySchema(() => ({
      project_path: z.string().optional().describe("Project path (default: current directory)"),
    })),
    handler: async (args) => {
      const result = await readMemory(args.project_path as string | undefined);
      if (!result) return { error: "No MEMORY.md found. Run consolidate_memories first." };
      return result.content;
    },
  },

  // --- Coordinator ---
  {
    name: "create_analysis_plan",
    category: "meta",
    searchHint: "create plan multi-step analysis workflow coordinator scratchpad",
    description: "Create multi-step analysis plan with shared scratchpad and dependencies.",
    schema: lazySchema(() => ({
      title: z.string().describe("Plan title describing the analysis goal"),
      steps: z.union([
        z.array(z.object({
          description: z.string(),
          tool: z.string(),
          args: z.record(z.string(), z.unknown()),
          result_key: z.string().optional(),
          depends_on: z.array(z.string()).optional(),
        })),
        z.string().transform((s) => JSON.parse(s) as Array<{ description: string; tool: string; args: Record<string, unknown>; result_key?: string; depends_on?: string[] }>),
      ]).describe("Steps array: {description, tool, args, result_key?, depends_on?}. JSON string OK."),
    })),
    handler: async (args) => {
      const result = await createAnalysisPlan(
        args.title as string,
        args.steps as Array<{ description: string; tool: string; args: Record<string, unknown>; result_key?: string; depends_on?: string[] }>,
      );
      return result;
    },
  },
  {
    name: "scratchpad_write",
    category: "meta",
    searchHint: "scratchpad write store knowledge cross-step data persist",
    description: "Write key-value to plan scratchpad for cross-step knowledge sharing.",
    schema: lazySchema(() => ({
      plan_id: z.string().describe("Analysis plan identifier"),
      key: z.string().describe("Key name for the entry"),
      value: z.string().describe("Value to store"),
    })),
    handler: async (args) => writeScratchpad(args.plan_id as string, args.key as string, args.value as string),
  },
  {
    name: "scratchpad_read",
    category: "meta",
    searchHint: "scratchpad read retrieve knowledge entry",
    description: "Read a key from a plan's scratchpad. Returns the stored value or null if not found.",
    schema: lazySchema(() => ({
      plan_id: z.string().describe("Analysis plan identifier"),
      key: z.string().describe("Key name to read"),
    })),
    handler: async (args) => {
      const result = await readScratchpad(args.plan_id as string, args.key as string);
      return result ?? { error: "Key not found in scratchpad" };
    },
  },
  {
    name: "scratchpad_list",
    category: "meta",
    searchHint: "scratchpad list entries keys",
    description: "List all entries in a plan's scratchpad with their sizes.",
    schema: lazySchema(() => ({
      plan_id: z.string().describe("Analysis plan identifier"),
    })),
    handler: (args) => listScratchpad(args.plan_id as string),
  },
  {
    name: "update_step_status",
    category: "meta",
    searchHint: "update step status plan progress completed failed",
    description: "Update step status in plan. Auto-updates plan status on completion.",
    schema: lazySchema(() => ({
      plan_id: z.string().describe("Analysis plan identifier"),
      step_id: z.string().describe("Step identifier (e.g. step_1)"),
      status: z.enum(["pending", "in_progress", "completed", "failed", "skipped"]).describe("New status for the step"),
      error: z.string().optional().describe("Error message if status is 'failed'"),
    })),
    handler: async (args) => {
      const result = await updateStepStatus(
        args.plan_id as string,
        args.step_id as string,
        args.status as "pending" | "in_progress" | "completed" | "failed" | "skipped",
        args.error as string | undefined,
      );
      return result;
    },
  },
  {
    name: "get_analysis_plan",
    category: "meta",
    searchHint: "get plan status steps progress",
    description: "Get the current state of an analysis plan including all step statuses.",
    schema: lazySchema(() => ({
      plan_id: z.string().describe("Analysis plan identifier"),
    })),
    handler: async (args) => {
      const plan = getPlan(args.plan_id as string);
      return plan ?? { error: "Plan not found" };
    },
  },
  {
    name: "list_analysis_plans",
    category: "meta",
    searchHint: "list plans active analysis workflows",
    description: "List all active analysis plans with their completion status.",
    schema: lazySchema(() => ({})),
    handler: async () => listPlans(),
  },

  // --- Review diff ---
  {
    name: "review_diff",
    category: "diff",
    searchHint: "review diff static analysis git changes secrets breaking-changes complexity dead-code blast-radius",
    description: "Run 9 parallel static analysis checks on a git diff: secrets, breaking changes, coupling gaps, complexity, dead-code, blast-radius, bug-patterns, test-gaps, hotspots. Returns a scored verdict (pass/warn/fail) with tiered findings.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      since: z.string().optional().describe("Base git ref (default: HEAD~1)"),
      until: z.string().optional().describe("Target ref. Default: HEAD. Special: WORKING, STAGED"),
      checks: z.string().optional().describe("Comma-separated check names (default: all)"),
      exclude_patterns: z.string().optional().describe("Comma-separated globs to exclude"),
      token_budget: zNum().describe("Max tokens (default: 15000)"),
      max_files: zNum().describe("Warn above N files (default: 50)"),
      check_timeout_ms: zNum().describe("Per-check timeout ms (default: 8000)"),
    })),
    handler: async (args) => {
      const checksArr = args.checks
        ? (args.checks as string).split(",").map((c) => c.trim()).filter(Boolean)
        : undefined;
      const excludeArr = args.exclude_patterns
        ? (args.exclude_patterns as string).split(",").map((p) => p.trim()).filter(Boolean)
        : undefined;
      const opts: import("./tools/review-diff-tools.js").ReviewDiffOptions = {
        repo: args.repo as string,
      };
      if (args.since != null) opts.since = args.since as string;
      if (args.until != null) opts.until = args.until as string;
      if (checksArr != null) opts.checks = checksArr.join(",");
      if (excludeArr != null) opts.exclude_patterns = excludeArr;
      if (args.token_budget != null) opts.token_budget = args.token_budget as number;
      if (args.max_files != null) opts.max_files = args.max_files as number;
      if (args.check_timeout_ms != null) opts.check_timeout_ms = args.check_timeout_ms as number;
      const result = await reviewDiff(args.repo as string, opts);
      return formatReviewDiff(result);
    },
  },

  // --- Stats ---
  {
    name: "usage_stats",
    category: "meta",
    searchHint: "usage statistics tool calls tokens timing metrics",
    outputSchema: OutputSchemas.usageStats,
    description: "Show usage statistics for all CodeSift tool calls (call counts, tokens, timing, repos)",
    schema: lazySchema(() => ({})),
    handler: async () => {
      const stats = await getUsageStats();
      const { createRequire } = await import("node:module");
      const req = createRequire(import.meta.url);
      const pkgVersion: string = (req("../package.json") as { version: string }).version;
      return { version: pkgVersion, report: formatUsageReport(stats) };
    },
  },

  // ── Session context tools ───────────────────────────────────────────────
  {
    name: "get_session_snapshot",
    category: "session",
    searchHint: "session context snapshot compaction summary explored symbols files queries",
    description: "Get a compact ~200 token snapshot of what was explored in this session. Designed to survive context compaction. Call proactively before long tasks.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Filter to specific repo. Default: most recent repo."),
    })),
    handler: async (args: { repo?: string }) => {
      return formatSnapshot(getSessionState(), args.repo);
    },
  },
  {
    name: "get_session_context",
    category: "session",
    searchHint: "session context full explored symbols files queries negative evidence",
    description: "Get full session context: explored symbols, files, queries, and negative evidence (searched but not found). Use get_session_snapshot for a compact version.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Filter to specific repo"),
      include_stale: zBool().describe("Include stale negative evidence entries (default: false)"),
    })),
    handler: async (args: { repo?: string; include_stale?: boolean | string }) => {
      const includeStale = args.include_stale === true || args.include_stale === "true";
      return getContext(args.repo, includeStale);
    },
  },

  // --- Project Analysis ---
  {
    name: "analyze_project",
    category: "analysis",
    searchHint: "project profile stack conventions middleware routes rate-limits auth detection",
    description: "Analyze a repository to extract stack, file classifications, and framework-specific conventions. Returns a structured project profile (schema v1.0) with file:line evidence for convention-level facts.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      force: zBool().describe("Ignore cached results and re-analyze"),
    })),
    handler: async (args) => {
      const result = await analyzeProject(args.repo as string, {
        force: args.force as boolean | undefined,
      });
      return result;
    },
  },
  {
    name: "get_extractor_versions",
    category: "meta",
    searchHint: "extractor version cache invalidation profile parser languages",
    description: "Return parser_languages (tree-sitter symbol extractors) and profile_frameworks (analyze_project detectors). Text tools (search_text, get_file_tree) work on ALL files regardless — use this only for cache invalidation or to check symbol support for a specific language.",
    schema: lazySchema(() => ({})),
    handler: async () => getExtractorVersions(),
  },
  // --- Composite tools ---
  {
    name: "audit_scan",
    category: "analysis",
    searchHint: "audit scan code quality CQ gates dead code clones complexity patterns",
    description: "Run 5 analysis tools in parallel, return findings keyed by CQ gate. One call replaces sequential find_dead_code + search_patterns + find_clones + analyze_complexity + analyze_hotspots. Returns: CQ8 (empty catch), CQ11 (complexity), CQ13 (dead code), CQ14 (clones), CQ17 (perf anti-patterns).",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      include_tests: zBool().describe("Include test files (default: false)"),
      checks: z.string().optional().describe("Comma-separated CQ gates to check (default: all). E.g. 'CQ8,CQ11,CQ14'"),
    })),
    handler: async (args) => {
      const checks = args.checks ? (args.checks as string).split(",").map(s => s.trim()) : undefined;
      const opts: AuditScanOptions = {};
      if (args.file_pattern) opts.file_pattern = args.file_pattern as string;
      if (args.include_tests) opts.include_tests = args.include_tests as boolean;
      if (checks) opts.checks = checks;
      const result = await auditScan(args.repo as string, opts);
      return formatAuditScan(result);
    },
  },

  // --- New tools (agent-requested) ---
  {
    name: "index_status",
    category: "meta",
    searchHint: "index status indexed repo check files symbols languages",
    description: "Check whether a repository is indexed and return index metadata: file count, symbol count, language breakdown, text_stub languages (no parser). Use this before calling symbol-based tools on unfamiliar repos.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const result = await indexStatus(args.repo as string);
      if (!result.indexed) {
        // If no repo specified, list available repos so the agent can pick one
        if (!args.repo) {
          const { listAllRepos } = await import("./tools/index-tools.js");
          const repos = await listAllRepos();
          const localRepos = repos.filter((r) => (typeof r === "string" ? r : r.name).startsWith("local/")).map((r) => typeof r === "string" ? r : r.name);
          if (localRepos.length > 0) {
            return `index_status: repo not auto-detected (CWD mismatch). ${localRepos.length} repos available. Pass repo= explicitly. Available: ${localRepos.join(", ")}`;
          }
        }
        return "index_status: NOT INDEXED — run index_folder first";
      }
      const langs = Object.entries(result.language_breakdown ?? {})
        .sort(([, a], [, b]) => b - a)
        .map(([lang, count]) => `${lang}(${count})`)
        .join(", ");
      const parts = [
        `index_status: indexed=true`,
        `files: ${result.file_count} | symbols: ${result.symbol_count} | last_indexed: ${result.last_indexed}`,
        `languages: ${langs}`,
      ];
      if (result.text_stub_languages) {
        parts.push(`text_stub (no parser): ${result.text_stub_languages.join(", ")}`);
      }
      return parts.join("\n");
    },
  },
  {
    name: "find_perf_hotspots",
    category: "analysis",
    searchHint: "performance perf hotspot N+1 unbounded query sync handler pagination findMany pLimit",
    description: "Scan for 6 performance anti-patterns: unbounded DB queries, sync I/O in handlers, N+1 loops, unbounded Promise.all, missing pagination, expensive recompute. Returns findings grouped by severity (high/medium/low) with fix hints.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      patterns: z.string().optional().describe("Comma-separated pattern names to check (default: all). Options: unbounded-query, sync-in-handler, n-plus-one, unbounded-parallel, missing-pagination, expensive-recompute"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      include_tests: zBool().describe("Include test files (default: false)"),
      max_results: zNum().describe("Max findings to return (default: 50)"),
    })),
    handler: async (args) => {
      const patterns = args.patterns
        ? (args.patterns as string).split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
      const opts: Parameters<typeof findPerfHotspots>[1] = {};
      if (patterns) opts!.patterns = patterns;
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.include_tests != null) opts!.include_tests = args.include_tests as boolean;
      if (args.max_results != null) opts!.max_results = args.max_results as number;
      const result = await findPerfHotspots(args.repo as string, opts);
      return formatPerfHotspots(result);
    },
  },
  {
    name: "fan_in_fan_out",
    category: "architecture",
    searchHint: "fan-in fan-out coupling dependencies imports hub afferent efferent instability threshold",
    description: "Analyze import graph to find most-imported files (fan-in), most-dependent files (fan-out), and hub files (high both — instability risk). Returns coupling score 0-100. Use min_fan_in/min_fan_out for threshold-based audits ('all files with fan_in > 50') instead of top_n cap.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      path: z.string().optional().describe("Focus on files in this directory"),
      top_n: zNum().describe("How many entries per list (default: 20)"),
      min_fan_in: zNum().describe("Only return files with fan_in >= this value (default: 0). Use for audits."),
      min_fan_out: zNum().describe("Only return files with fan_out >= this value (default: 0). Use for audits."),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof fanInFanOut>[1] = {};
      if (args.path != null) opts!.path = args.path as string;
      if (args.top_n != null) opts!.top_n = args.top_n as number;
      if (args.min_fan_in != null) opts!.min_fan_in = args.min_fan_in as number;
      if (args.min_fan_out != null) opts!.min_fan_out = args.min_fan_out as number;
      const result = await fanInFanOut(args.repo as string, opts);
      return formatFanInFanOut(result);
    },
  },
  {
    name: "co_change_analysis",
    category: "architecture",
    searchHint: "co-change temporal coupling git history Jaccard co-commit correlation cluster",
    description: "Analyze git history to find files that frequently change together (temporal coupling). Returns file pairs ranked by Jaccard similarity, plus clusters of always-co-changed files. Useful for detecting hidden dependencies.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      since_days: zNum().describe("Analyze last N days of history (default: 180)"),
      min_support: zNum().describe("Minimum co-commits to include a pair (default: 3)"),
      min_jaccard: zNum().describe("Minimum Jaccard similarity threshold (default: 0.3)"),
      path: z.string().optional().describe("Focus on files in this directory"),
      top_n: zNum().describe("Max pairs to return (default: 30)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof coChangeAnalysis>[1] = {};
      if (args.since_days != null) opts!.since_days = args.since_days as number;
      if (args.min_support != null) opts!.min_support = args.min_support as number;
      if (args.min_jaccard != null) opts!.min_jaccard = args.min_jaccard as number;
      if (args.path != null) opts!.path = args.path as string;
      if (args.top_n != null) opts!.top_n = args.top_n as number;
      const result = await coChangeAnalysis(args.repo as string, opts);
      return formatCoChange(result);
    },
  },
  {
    name: "architecture_summary",
    category: "architecture",
    searchHint: "architecture summary overview structure stack framework communities coupling circular dependencies entry points",
    description: "One-call architecture profile: stack detection, module communities, coupling hotspots, circular dependencies, LOC distribution, and entry points. Runs 5 analyses in parallel. Supports Mermaid diagram output.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      focus: z.string().optional().describe("Focus on this directory path"),
      output_format: z.enum(["text", "mermaid"]).optional().describe("Output format (default: text)"),
      token_budget: zNum().describe("Max tokens for output"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof architectureSummary>[1] = {};
      if (args.focus != null) opts!.focus = args.focus as string;
      if (args.output_format != null) opts!.output_format = args.output_format as "text" | "mermaid";
      if (args.token_budget != null) opts!.token_budget = args.token_budget as number;
      const result = await architectureSummary(args.repo as string, opts);
      return formatArchitectureSummary(result);
    },
  },
  {
    name: "explain_query",
    category: "analysis",
    searchHint: "explain query SQL Prisma ORM database performance EXPLAIN ANALYZE findMany pagination index",
    description: "Parse a Prisma call and generate approximate SQL with EXPLAIN ANALYZE. Detects: unbounded queries, N+1 risks from includes, missing indexes. MVP: Prisma only. Supports postgresql/mysql/sqlite dialects.",
    schema: lazySchema(() => ({
      code: z.string().describe("Prisma code snippet (e.g. prisma.user.findMany({...}))"),
      dialect: z.enum(["postgresql", "mysql", "sqlite"]).optional().describe("SQL dialect (default: postgresql)"),
    })),
    handler: async (args) => {
      const eqOpts: Parameters<typeof explainQuery>[1] = {};
      if (args.dialect != null) eqOpts!.dialect = args.dialect as "postgresql" | "mysql" | "sqlite";
      const result = explainQuery(args.code as string, eqOpts);
      const parts = [
        `explain_query: prisma.${result.parsed.model}.${result.parsed.method}`,
        `─── Generated SQL (${args.dialect ?? "postgresql"}) ───`,
        `  ${result.sql}`,
        `─── EXPLAIN command ───`,
        `  ${result.explain_command}`,
      ];
      if (result.warnings.length > 0) {
        parts.push("─── Warnings ───");
        for (const w of result.warnings) parts.push(`  ⚠ ${w}`);
      }
      if (result.optimization_hints.length > 0) {
        parts.push("─── Optimization hints ───");
        for (const h of result.optimization_hints) parts.push(`  → ${h}`);
      }
      return parts.join("\n");
    },
  },
  // --- NestJS analysis tools (sub-tools absorbed into nest_audit) ---
  {
    name: "nest_audit",
    category: "nestjs",
    searchHint: "nestjs audit analysis comprehensive module di guard route lifecycle pattern graphql websocket schedule typeorm microservice hook onModuleInit onApplicationBootstrap shutdown dependency graph circular import boundary injection provider constructor inject cycle interceptor pipe filter middleware chain security endpoint api map inventory list all params resolver query mutation subscription apollo gateway subscribemessage socketio realtime event cron interval timeout scheduled job task onevent listener entity relation onetomany manytoone database schema messagepattern eventpattern kafka rabbitmq nats transport request pipeline handler execution flow visualization bull bullmq queue processor process background worker scope transient singleton performance escalation swagger openapi documentation apiproperty apioperation apiresponse contract extract",
    description: "One-call NestJS architecture audit: modules, DI, guards, routes, lifecycle, patterns, GraphQL, WebSocket, schedule, TypeORM, microservices.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      checks: z.string().optional().describe("Comma-separated checks (default: all). Options: modules,routes,di,guards,lifecycle,patterns,graphql,websocket,schedule,typeorm,microservice"),
    })),
    handler: async (args: { repo?: string; checks?: string }) => {
      const checks = args.checks?.split(",").map((s) => s.trim()).filter(Boolean);
      return nestAudit(args.repo ?? "", checks ? { checks } : undefined);
    },
  },

  // --- Agent config audit ---
  {
    name: "audit_agent_config",
    category: "meta",
    searchHint: "audit agent config CLAUDE.md cursorrules stale symbols dead paths token waste redundancy",
    description: "Scan a config file (CLAUDE.md, .cursorrules) for stale symbol references, dead file paths, token cost, and redundancy. Cross-references against the CodeSift index. Optionally compares two config files for redundant content blocks.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      config_path: z.string().optional().describe("Path to config file (default: CLAUDE.md in repo root)"),
      compare_with: z.string().optional().describe("Path to second config file for redundancy detection"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof auditAgentConfig>[1] = {};
      if (args.config_path != null) opts!.config_path = args.config_path as string;
      if (args.compare_with != null) opts!.compare_with = args.compare_with as string;
      const result = await auditAgentConfig(args.repo as string, opts);
      const parts = [`audit_agent_config: ${result.config_path}`, `token_cost: ~${result.token_cost} tokens`];
      if (result.stale_symbols.length > 0) {
        parts.push(`\n─── Stale Symbols (${result.stale_symbols.length}) ───`);
        for (const s of result.stale_symbols) parts.push(`  line ${s.line}: \`${s.symbol}\` — not found in index`);
      }
      if (result.dead_paths.length > 0) {
        parts.push(`\n─── Dead Paths (${result.dead_paths.length}) ───`);
        for (const p of result.dead_paths) parts.push(`  line ${p.line}: ${p.path} — file not in index`);
      }
      if (result.redundant_blocks.length > 0) {
        parts.push(`\n─── Redundant Blocks (${result.redundant_blocks.length}) ───`);
        for (const b of result.redundant_blocks) parts.push(`  "${b.text.slice(0, 60)}..." found in: ${b.found_in.join(", ")}`);
      }
      if (result.findings.length > 0) {
        parts.push(`\n─── Findings ───`);
        for (const f of result.findings) parts.push(`  ${f}`);
      }
      if (result.stale_symbols.length === 0 && result.dead_paths.length === 0 && result.redundant_blocks.length === 0) {
        parts.push("\nAll references valid. No issues found.");
      }
      return parts.join("\n");
    },
  },

  // --- Test impact analysis ---
  {
    name: "test_impact_analysis",
    category: "analysis",
    searchHint: "test impact analysis affected tests changed files CI confidence which tests to run",
    description: "Determine which tests to run based on changed files. Uses impact analysis, co-change correlation, and naming convention matching. Returns prioritized test list with confidence scores and a suggested test command.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      since: z.string().optional().describe("Git ref to compare from (default: HEAD~1)"),
      until: z.string().optional().describe("Git ref to compare to (default: HEAD)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof testImpactAnalysis>[1] = {};
      if (args.since != null) opts!.since = args.since as string;
      if (args.until != null) opts!.until = args.until as string;
      const result = await testImpactAnalysis(args.repo as string, opts);
      const parts = [`test_impact: ${result.affected_tests.length} tests affected | ${result.changed_files.length} files changed`];
      if (result.suggested_command) parts.push(`\nRun: ${result.suggested_command}`);
      if (result.affected_tests.length > 0) {
        parts.push("\n─── Affected Tests ───");
        for (const t of result.affected_tests) {
          parts.push(`  ${t.test_file} (confidence: ${t.confidence.toFixed(2)}) — ${t.reasons.join(", ")}`);
        }
      } else {
        parts.push("\nNo affected tests found.");
      }
      return parts.join("\n");
    },
  },

  // --- Dependency audit (composite) ---
  {
    name: "dependency_audit",
    category: "analysis",
    searchHint: "dependency audit npm vulnerabilities CVE licenses outdated freshness lockfile drift supply chain",
    description: "Composite dependency health check: vulnerabilities (npm/pnpm/yarn audit), licenses (problematic copyleft detection), freshness (outdated count + major gaps), lockfile integrity (drift, duplicates). Runs 4 sub-checks in parallel. Replaces ~40 manual bash calls for D1-D5 audit dimensions.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      workspace_path: z.string().optional().describe("Workspace path (default: index root)"),
      skip_licenses: zBool().describe("Skip license check (faster, default: false)"),
      min_severity: z.enum(["low", "moderate", "high", "critical"]).optional().describe("Filter vulnerabilities by minimum severity"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof dependencyAudit>[1] = {};
      if (args.workspace_path != null) opts!.workspace_path = args.workspace_path as string;
      if (args.skip_licenses != null) opts!.skip_licenses = args.skip_licenses as boolean;
      if (args.min_severity != null) opts!.min_severity = args.min_severity as "low" | "moderate" | "high" | "critical";
      const result = await dependencyAudit(args.repo as string, opts);
      const parts = [
        `dependency_audit: ${result.workspace} (${result.package_manager}) — ${result.duration_ms}ms`,
        `\n─── Vulnerabilities (${result.vulnerabilities.total}) ───`,
        `  critical: ${result.vulnerabilities.by_severity.critical} | high: ${result.vulnerabilities.by_severity.high} | moderate: ${result.vulnerabilities.by_severity.moderate} | low: ${result.vulnerabilities.by_severity.low}`,
      ];
      for (const v of result.vulnerabilities.findings.slice(0, 10)) {
        parts.push(`  [${v.severity}] ${v.package}${v.fix_available ? " (fix available)" : ""}`);
      }
      parts.push(`\n─── Licenses (${result.licenses.total}) ───`);
      if (result.licenses.problematic.length > 0) {
        parts.push(`  ⚠ Problematic: ${result.licenses.problematic.length}`);
        for (const l of result.licenses.problematic.slice(0, 10)) parts.push(`    ${l.package}: ${l.license}`);
      }
      parts.push(`\n─── Freshness (${result.freshness.outdated_count} outdated) ───`);
      for (const o of result.freshness.major_gaps.slice(0, 10)) {
        parts.push(`  ${o.package}: ${o.current} → ${o.latest} (${o.major_gap} major)`);
      }
      parts.push(`\n─── Lockfile ───`);
      parts.push(`  present: ${result.lockfile.present} | issues: ${result.lockfile.issues.length}`);
      for (const i of result.lockfile.issues.slice(0, 5)) parts.push(`    ${i.type}: ${i.message}`);
      if (result.errors.length > 0) {
        parts.push(`\n─── Sub-check errors (${result.errors.length}) ───`);
        for (const e of result.errors) parts.push(`  ${e}`);
      }
      return parts.join("\n");
    },
  },

  // --- Migration safety linter (squawk wrapper) ---
  {
    name: "migration_lint",
    category: "analysis",
    searchHint: "migration lint squawk SQL postgresql safety linter unsafe-migration not-null drop-column alter-column-type concurrently",
    description: "PostgreSQL migration safety linter via squawk wrapper. Detects 30+ anti-patterns: NOT NULL without default, DROP COLUMN, ALTER COLUMN TYPE, CREATE INDEX without CONCURRENTLY, etc. Requires squawk CLI installed (brew install squawk OR cargo install squawk-cli). Auto-discovers prisma/migrations, migrations/, db/migrate, drizzle/.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      migration_glob: z.string().optional().describe("Custom migration file glob pattern"),
      excluded_rules: z.union([z.array(z.string()), z.string().transform((s) => s.split(",").map((x) => x.trim()))]).optional().describe("Squawk rules to exclude (comma-sep or array)"),
      pg_version: z.string().optional().describe("PostgreSQL version for version-aware rules (e.g. '13')"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof migrationLint>[1] = {};
      if (args.migration_glob != null) opts!.migration_glob = args.migration_glob as string;
      if (args.excluded_rules != null) opts!.excluded_rules = args.excluded_rules as string[];
      if (args.pg_version != null) opts!.pg_version = args.pg_version as string;
      const result = await migrationLint(args.repo as string, opts);
      if (!result.squawk_installed) {
        return `migration_lint: squawk not installed.\n${result.install_hint}\n${result.files_checked} migration files would be checked.`;
      }
      const parts = [
        `migration_lint: squawk ${result.squawk_version ?? "unknown"} — ${result.files_checked} files checked`,
        `errors: ${result.by_severity.error} | warnings: ${result.by_severity.warning}`,
      ];
      if (result.findings.length > 0) {
        parts.push("\n─── Findings ───");
        for (const f of result.findings.slice(0, 30)) {
          parts.push(`  [${f.level}] ${f.file}:${f.line} ${f.rule} — ${f.message}`);
        }
      } else {
        parts.push("\nNo issues found.");
      }
      return parts.join("\n");
    },
  },

  // --- Prisma schema analyzer ---
  {
    name: "analyze_prisma_schema",
    category: "analysis",
    searchHint: "prisma schema analyze ast model field index foreign-key relation soft-delete enum coverage",
    description: "Parse schema.prisma into structured AST. Returns model coverage: fields, indexes, FKs, relations, soft-delete detection, FK index coverage %, unindexed FKs (audit warning), status-as-String suggestions. Uses @mrleebo/prisma-ast for proper AST parsing (vs regex-only extractor).",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      schema_path: z.string().optional().describe("Path to schema.prisma (default: auto-detected)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof analyzePrismaSchema>[1] = {};
      if (args.schema_path != null) opts!.schema_path = args.schema_path as string;
      const result = await analyzePrismaSchema(args.repo as string, opts);
      const parts = [
        `analyze_prisma_schema: ${result.schema_path}`,
        `models: ${result.model_count} | enums: ${result.enum_count}`,
        `\n─── FK Index Coverage ───`,
        `  ${result.totals.fk_with_index}/${result.totals.fk_columns} FKs indexed (${result.totals.fk_index_coverage_pct.toFixed(1)}%)`,
        `  unindexed FKs: ${result.totals.fk_without_index}`,
        `  soft-delete models: ${result.totals.soft_delete_models}`,
        `  composite indexes: ${result.totals.composite_indexes} | single indexes: ${result.totals.single_indexes}`,
      ];
      if (result.warnings.length > 0) {
        parts.push(`\n─── Warnings (${result.warnings.length}) ───`);
        for (const w of result.warnings.slice(0, 20)) parts.push(`  ⚠ ${w}`);
      }
      // List models with audit issues
      const auditModels = result.models.filter((m) => m.fk_columns_without_index.length > 0 || m.status_like_string_fields.length > 0);
      if (auditModels.length > 0) {
        parts.push(`\n─── Models with issues (${auditModels.length}) ───`);
        for (const m of auditModels.slice(0, 15)) {
          const issues: string[] = [];
          if (m.fk_columns_without_index.length > 0) issues.push(`unindexed FKs: ${m.fk_columns_without_index.join(",")}`);
          if (m.status_like_string_fields.length > 0) issues.push(`status-as-String: ${m.status_like_string_fields.join(",")}`);
          parts.push(`  ${m.name} — ${issues.join(" | ")}`);
        }
      }
      return parts.join("\n");
    },
  },

  // --- Astro tools ---
  {
    name: "astro_analyze_islands",
    category: "analysis",
    searchHint: "astro islands client hydration directives framework",
    description: "Analyze Astro islands (client:* directives) in a repo. Finds all interactive components with hydration directives, lists server islands with fallback status, and optionally generates optimization recommendations.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      path_prefix: z.string().optional().describe("Only scan files under this path prefix"),
      include_recommendations: z.boolean().default(true).describe("Include optimization recommendations (default: true)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof astroAnalyzeIslands>[0] = {};
      if (args.repo != null) opts.repo = args.repo as string;
      if (args.path_prefix != null) opts.path_prefix = args.path_prefix as string;
      if (args.include_recommendations != null) opts.include_recommendations = args.include_recommendations as boolean;
      return await astroAnalyzeIslands(opts);
    },
  },
  {
    name: "astro_hydration_audit",
    category: "analysis",
    searchHint: "astro hydration audit anti-patterns client load",
    description: "Audit Astro hydration usage for anti-patterns such as client:load on heavy components, missing client directives, or suboptimal hydration strategies. Returns issues grouped by severity with a letter grade.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      severity: z.enum(["all", "warnings", "errors"]).default("all").describe("Filter issues by severity (default: all)"),
      path_prefix: z.string().optional().describe("Only scan files under this path prefix"),
      fail_on: z.enum(["error", "warning", "info"]).optional().describe("Set exit_code gate: 'error' exits 1 on any errors; 'warning' exits 2 on warnings; 'info' exits 2 on info or warnings"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof astroHydrationAudit>[0] = {};
      if (args.repo != null) opts.repo = args.repo as string;
      if (args.severity != null) opts.severity = args.severity as "all" | "warnings" | "errors";
      if (args.path_prefix != null) opts.path_prefix = args.path_prefix as string;
      if (args.fail_on != null) opts.fail_on = args.fail_on as "error" | "warning" | "info";
      return await astroHydrationAudit(opts);
    },
  },
  {
    name: "astro_route_map",
    category: "navigation",
    searchHint: "astro routes pages endpoints file-based routing",
    description: "Map all Astro routes (pages + API endpoints) discovered from the file-based routing structure. Returns routes with type, dynamic params, and handler symbols. Supports json/tree/table output formats.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      include_endpoints: z.boolean().default(true).describe("Include API endpoint routes (default: true)"),
      output_format: z.enum(["json", "tree", "table"]).default("json").describe("Output format: json | tree | table (default: json)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof astroRouteMap>[0] = {};
      if (args.repo != null) opts.repo = args.repo as string;
      if (args.include_endpoints != null) opts.include_endpoints = args.include_endpoints as boolean;
      if (args.output_format != null) opts.output_format = args.output_format as "json" | "tree" | "table";
      return await astroRouteMap(opts);
    },
  },
  {
    name: "astro_config_analyze",
    category: "analysis",
    searchHint: "astro config integrations adapter output mode",
    description: "Analyze an Astro project's configuration file (astro.config.mjs/ts/js). Extracts output mode (static/server/hybrid), adapter, integrations, site URL, and base path. Identifies dynamic/unresolved config.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const index = await getCodeIndex(args.repo as string ?? "");
      if (!index) throw new Error("Repository not found — run index_folder first");
      return await astroConfigAnalyze({ project_root: index.root });
    },
  },
  {
    name: "astro_actions_audit",
    category: "analysis",
    searchHint: "astro actions defineAction zod refine passthrough multipart file enctype audit",
    description: "Audit Astro Actions (src/actions/index.ts) for 6 known anti-patterns (AA01-AA06): missing handler return, top-level .refine() (Astro issue #11641), .passthrough() usage (issue #11693), File schema without multipart form, server-side invocation via actions.xxx(), and client calls to unknown actions. Returns issues grouped by severity with an A/B/C/D score.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      severity: z.enum(["all", "warnings", "errors"]).default("all").describe("Filter issues by severity (default: all)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof astroActionsAudit>[0] = {};
      if (args.repo != null) opts.repo = args.repo as string;
      if (args.severity != null) opts.severity = args.severity as "all" | "warnings" | "errors";
      return await astroActionsAudit(opts);
    },
  },
  {
    name: "astro_content_collections",
    category: "analysis",
    searchHint: "astro content collections defineCollection zod schema reference glob loader frontmatter",
    description: "Parse an Astro content collections config (src/content.config.ts or legacy src/content/config.ts), extract each collection's loader + Zod schema fields, build a reference() graph, and optionally validate entry frontmatter against required fields.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      validate_entries: z.boolean().default(true).describe("Validate entry frontmatter against required schema fields (default: true)"),
    })),
    handler: async (args) => {
      const index = await getCodeIndex(args.repo as string ?? "");
      if (!index) throw new Error("Repository not found — run index_folder first");
      const opts: Parameters<typeof astroContentCollections>[0] = { project_root: index.root };
      if (args.validate_entries != null) opts.validate_entries = args.validate_entries as boolean;
      return await astroContentCollections(opts);
    },
  },
  {
    name: "astro_audit",
    category: "analysis",
    searchHint: "astro meta audit full health check score gates recommendations islands hydration routes config actions content migration patterns",
    description: "One-call Astro project health check: runs all 7 Astro tools + 13 Astro patterns in parallel, returns unified {score, gates, sections, recommendations}. Mirrors react_quickstart pattern.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      skip: z.array(z.string()).optional().describe("Sections to skip: config, hydration, routes, actions, content, migration, patterns"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof astroAudit>[0] = {};
      if (args.repo != null) opts.repo = args.repo as string;
      if (args.skip != null) opts.skip = args.skip as string[];
      return await astroAudit(opts);
    },
  },

  // --- Hono framework tools (Task 23) ---
  {
    name: "trace_middleware_chain",
    category: "graph",
    searchHint: "hono middleware chain trace order scope auth use conditional applied_when if method header path basicAuth gated",
    description: "Hono middleware introspection. Three query modes: (1) route mode — pass path (+optional method) to get the chain effective for that route; (2) scope mode — pass scope literal (e.g. '/posts/*') to get that specific app.use chain; (3) app-wide mode — omit path and scope to get every chain flattened. Any mode supports only_conditional=true to filter to entries with applied_when populated, so the blog-API pattern (basicAuth wrapped in `if (method !== 'GET')`) is surfaced as gated rather than missed. Absorbs the former trace_conditional_middleware tool.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      path: z.string().optional().describe("Route path to look up (e.g. '/api/users/:id'). Omit for scope or app-wide query."),
      method: z.string().optional().describe("HTTP method filter (GET, POST, etc.). Only used in route mode."),
      scope: z.string().optional().describe("Exact middleware scope literal (e.g. '/posts/*'). Mutually exclusive with path."),
      only_conditional: z.boolean().optional().describe("Filter entries to those whose applied_when field is populated (conditional middleware)."),
    })),
    handler: async (args) => {
      const { traceMiddlewareChain } = await import("./tools/hono-middleware-chain.js");
      const opts: Record<string, unknown> = {};
      if (args.scope !== undefined) opts.scope = args.scope;
      if (args.only_conditional !== undefined) opts.only_conditional = args.only_conditional;
      return await traceMiddlewareChain(
        args.repo as string,
        args.path as string | undefined,
        args.method as string | undefined,
        Object.keys(opts).length > 0 ? opts : undefined,
      );
    },
  },
  {
    name: "analyze_hono_app",
    category: "analysis",
    searchHint: "hono overview analyze app routes middleware runtime env bindings rpc",
    description: "Complete Hono application overview: routes grouped by method/scope, middleware map, context vars, OpenAPI status, RPC exports (flags Issue #3869 slow pattern), runtime, env bindings. One call for full project analysis.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      entry_file: z.string().optional().describe("Hono entry file (auto-detected if omitted)"),
      force_refresh: z.boolean().optional().describe("Clear cache and rebuild"),
    })),
    handler: async (args) => {
      const { analyzeHonoApp } = await import("./tools/hono-analyze-app.js");
      return await analyzeHonoApp(
        args.repo as string,
        args.entry_file as string | undefined,
        args.force_refresh as boolean | undefined,
      );
    },
  },
  {
    name: "trace_context_flow",
    category: "analysis",
    searchHint: "hono context flow c.set c.get c.var c.env middleware variable unguarded",
    description: "Trace Hono context variable flow (c.set/c.get/c.var/c.env). Detects MISSING_CONTEXT_VARIABLE findings where routes access variables that no middleware in their scope sets.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      variable: z.string().optional().describe("Specific variable name to trace (default: all)"),
    })),
    handler: async (args) => {
      const { traceContextFlow } = await import("./tools/hono-context-flow.js");
      return await traceContextFlow(
        args.repo as string,
        args.variable as string | undefined,
      );
    },
  },
  {
    name: "extract_api_contract",
    category: "analysis",
    searchHint: "hono openapi contract api schema createRoute zValidator",
    description: "Extract OpenAPI-style API contract from a Hono app. Uses explicit createRoute() definitions when available, infers from regular routes otherwise. Format: 'openapi' (paths object) or 'summary' (table).",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      entry_file: z.string().optional().describe("Hono entry file (auto-detected if omitted)"),
      format: z.enum(["openapi", "summary"]).optional().describe("Output format (default: openapi)"),
    })),
    handler: async (args) => {
      const { extractApiContract } = await import("./tools/hono-api-contract.js");
      return await extractApiContract(
        args.repo as string,
        args.entry_file as string | undefined,
        args.format as "openapi" | "summary" | undefined,
      );
    },
  },
  {
    name: "trace_rpc_types",
    category: "analysis",
    searchHint: "hono rpc client type export typeof slow pattern Issue 3869 compile time",
    description: "Analyze Hono RPC type exports. Detects the slow `export type X = typeof app` pattern from Issue #3869 (8-min CI compile time) and recommends splitting into per-route-group types.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const { traceRpcTypes } = await import("./tools/hono-rpc-types.js");
      return await traceRpcTypes(args.repo as string);
    },
  },
  {
    name: "audit_hono_security",
    category: "security",
    searchHint: "hono security audit rate limit secure headers auth order csrf env regression createMiddleware BlankEnv Issue 3587",
    description: "Security + type-safety audit of a Hono app. Rules: missing-secure-headers (global), missing-rate-limit + missing-auth (mutation routes, conditional-middleware aware via applied_when), auth-ordering (auth after non-auth in chain), env-regression (plain createMiddleware in 3+ chains — Hono Issue #3587, absorbed from the former detect_middleware_env_regression tool). Returns prioritized findings plus heuristic disclaimers via `notes` field for best-effort rules.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const { auditHonoSecurity } = await import("./tools/hono-security.js");
      return await auditHonoSecurity(args.repo as string);
    },
  },
  {
    name: "visualize_hono_routes",
    category: "reporting",
    searchHint: "hono routes visualize mermaid tree diagram documentation",
    description: "Produce a visualization of Hono routing topology. Supports 'mermaid' (diagram) and 'tree' (ASCII) formats.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      format: z.enum(["mermaid", "tree"]).optional().describe("Output format (default: tree)"),
    })),
    handler: async (args) => {
      const { visualizeHonoRoutes } = await import("./tools/hono-visualize.js");
      return await visualizeHonoRoutes(
        args.repo as string,
        args.format as "mermaid" | "tree" | undefined,
      );
    },
  },

  // --- Hono Phase 2 tools (T13) ---
  {
    name: "analyze_inline_handler",
    category: "analysis",
    searchHint: "hono inline handler analyze c.json c.text status response error db fetch context",
    description: "Structured body analysis for each Hono inline handler: responses (c.json/text/html/redirect/newResponse with status + shape_hint), errors (throw new HTTPException/Error), db calls (prisma/db/knex/drizzle/mongoose/supabase), fetch calls, c.set/get/var/env access, inline validators, has_try_catch. Optional method + path filter. Named-handler routes return empty.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      method: z.string().optional().describe("HTTP method filter (case-insensitive)"),
      path: z.string().optional().describe("Route path filter (exact match, e.g. '/users/:id')"),
    })),
    handler: async (args) => {
      const { analyzeInlineHandler } = await import("./tools/hono-inline-analyze.js");
      return await analyzeInlineHandler(
        args.repo as string,
        args.method as string | undefined,
        args.path as string | undefined,
      );
    },
  },
  {
    name: "extract_response_types",
    category: "analysis",
    searchHint: "hono response types status codes error paths RPC client InferResponseType Issue 4270",
    description: "Aggregate statically-knowable response types per route: c.json/text/html/body/redirect/newResponse emissions + throw new HTTPException/Error entries with status codes. Closes Hono Issue #4270 — RPC clients can generate types that include error paths. Returns routes[] plus total_statuses across the app.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const { extractResponseTypes } = await import("./tools/hono-response-types.js");
      return await extractResponseTypes(args.repo as string);
    },
  },
  {
    name: "detect_hono_modules",
    category: "analysis",
    searchHint: "hono modules architecture cluster path prefix middleware bindings enterprise Issue 4121",
    description: "Cluster Hono routes into logical modules by 2-segment path prefix, rolling up middleware chains, env bindings (from inline_analysis context_access), and source files per module. Closes Hono Issue #4121 — surfaces the implicit module structure for architecture review of enterprise apps. No new AST walking; post-processes the existing HonoAppModel.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const { detectHonoModules } = await import("./tools/hono-modules.js");
      return await detectHonoModules(args.repo as string);
    },
  },
  {
    name: "find_dead_hono_routes",
    category: "analysis",
    searchHint: "hono dead routes unused RPC client caller refactor monorepo cleanup",
    description: "Heuristically flag Hono server routes whose path segments do not appear in any non-server .ts/.tsx/.js/.jsx source file in the repo. Useful in monorepos to identify server endpoints that no Hono RPC client calls after refactors. Fully-dynamic routes (`/:id` only) are skipped. Documented as best-effort via the result note field.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const { findDeadHonoRoutes } = await import("./tools/hono-dead-routes.js");
      return await findDeadHonoRoutes(args.repo as string);
    },
  },

  // --- Next.js framework tools ---
  {
    name: "nextjs_route_map",
    category: "analysis",
    searchHint: "nextjs next.js route map app router pages router rendering strategy SSG SSR ISR edge middleware",
    description: "Complete Next.js route map with rendering strategy per route. Enumerates App Router and Pages Router conventions, reads route segment config exports (dynamic/revalidate/runtime), classifies each route as static/ssr/isr/edge/client, detects metadata exports, computes layout chain, and flags hybrid conflicts where the same URL is served by both routers.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      workspace: z.string().optional().describe("Monorepo workspace path, e.g. 'apps/web'"),
      router: z.enum(["app", "pages", "both"]).optional().describe("Which routers to scan (default 'both')"),
      include_metadata: z.boolean().optional().describe("Include metadata export detection (default true)"),
      max_routes: z.number().int().positive().optional().describe("Max routes to process (default 1000)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof nextjsRouteMap>[1] = {};
      if (args.workspace != null) opts.workspace = args.workspace as string;
      if (args.router != null) opts.router = args.router as "app" | "pages" | "both";
      if (args.include_metadata != null) opts.include_metadata = args.include_metadata as boolean;
      if (args.max_routes != null) opts.max_routes = args.max_routes as number;
      const result = await nextjsRouteMap(args.repo as string ?? "", opts);
      return formatNextjsRouteMap(result);
    },
  },
  {
    name: "nextjs_metadata_audit",
    category: "analysis" as ToolCategory,
    searchHint: "nextjs seo metadata title description og image audit canonical twitter json-ld",
    description: "Audit Next.js page metadata for SEO completeness with per-route scoring. Walks app/page.tsx files, extracts title/description/openGraph/canonical/twitter/JSON-LD via tree-sitter, scores each route 0-100 with a weighted formula, and aggregates a per-grade distribution + top issue list.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      workspace: z.string().optional().describe("Monorepo workspace path, e.g. 'apps/web'"),
      max_routes: z.number().int().positive().optional().describe("Max routes to process (default 1000)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof nextjsMetadataAudit>[1] = {};
      if (args.workspace != null) opts.workspace = args.workspace as string;
      if (args.max_routes != null) opts.max_routes = args.max_routes as number;
      const result = await nextjsMetadataAudit(args.repo as string ?? "", opts);
      return formatNextjsMetadataAudit(result);
    },
  },
  {
    name: "framework_audit",
    category: "analysis" as ToolCategory,
    searchHint: "nextjs next.js framework audit meta-tool overall score security metadata routes components classifier use client use server hooks server actions auth validation rate limit zod api contract route handler openapi method body schema response client boundary bundle imports loc link integrity broken navigation href router push 404 data flow fetch waterfall cache cookies headers ssr revalidate middleware coverage protected admin matcher",
    description: "Run all Next.js sub-audits (components, routes, metadata, security, api_contract, boundary, links, data_flow, middleware_coverage) and aggregate into a unified weighted overall score with grade. Use as a single first-call for any Next.js project.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      workspace: z.string().optional().describe("Monorepo workspace path, e.g. 'apps/web'"),
      tools: z.array(z.string()).optional().describe("Subset of tools to run (default: all 9). Names: components, routes, metadata, security, api_contract, boundary, links, data_flow, middleware_coverage"),
      mode: z.enum(["full", "priority"]).optional().describe("Output mode: 'full' returns per-tool results + aggregated summary; 'priority' returns a single unified top-N actionable findings list sorted by severity × cross-tool occurrences"),
      priority_limit: z.number().int().positive().optional().describe("Max findings in priority mode (default: 20)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof frameworkAudit>[1] = {};
      if (args.workspace != null) opts.workspace = args.workspace as string;
      if (args.tools != null) opts.tools = args.tools as AuditDimension[];
      if (args.mode != null) opts.mode = args.mode as "full" | "priority";
      if (args.priority_limit != null) opts.priority_limit = args.priority_limit as number;
      const result = await frameworkAudit(args.repo as string ?? "", opts);
      return formatFrameworkAudit(result);
    },
  },

  // ── SQL analysis tools (hidden/discoverable) ─────────────
  {
    name: "analyze_schema",
    category: "analysis" as ToolCategory,
    searchHint: "SQL schema ERD entity relationship tables views columns foreign key database migration",
    description: "Analyze SQL schema: tables, views, columns, foreign keys, relationships. Output as JSON or Mermaid ERD.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter SQL files by pattern (e.g. 'migrations/')"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output format (default: json)"),
      include_columns: zBool().describe("Include column details in output (default: true)"),
    })),
    handler: async (args: Record<string, unknown>) => {
      const { analyzeSchema } = await import("./tools/sql-tools.js");
      const opts: Parameters<typeof analyzeSchema>[1] = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.output_format != null) opts!.output_format = args.output_format as "json" | "mermaid";
      if (args.include_columns != null) opts!.include_columns = args.include_columns as boolean;
      const result = await analyzeSchema(args.repo as string, opts);
      const parts: string[] = [];
      parts.push(`Tables: ${result.tables.length} | Views: ${result.views.length} | Relationships: ${result.relationships.length}`);
      if (result.warnings.length > 0) parts.push(`Warnings: ${result.warnings.join("; ")}`);
      if (result.mermaid) {
        parts.push("");
        parts.push(result.mermaid);
      } else {
        for (const t of result.tables) {
          const cols = t.columns.map((c) => `${c.name} ${c.type}`).join(", ");
          parts.push(`  ${t.name} (${t.file}:${t.line}) — ${cols || "(no columns)"}`);
        }
        for (const v of result.views) {
          parts.push(`  VIEW ${v.name} (${v.file}:${v.line})`);
        }
        if (result.relationships.length > 0) {
          parts.push("Relationships:");
          for (const r of result.relationships) {
            parts.push(`  ${r.from_table}.${r.from_column} → ${r.to_table}.${r.to_column} [${r.type}]`);
          }
        }
      }
      return parts.join("\n");
    },
  },
  {
    name: "trace_query",
    category: "analysis" as ToolCategory,
    searchHint: "SQL table query trace references cross-language ORM Prisma Drizzle migration",
    description: "Trace SQL table references across the codebase: DDL, DML, FK, and ORM models (Prisma, Drizzle).",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      table: z.string().describe("Table name to trace (required)"),
      include_orm: zBool().describe("Check Prisma/Drizzle ORM models (default: true)"),
      file_pattern: z.string().optional().describe("Scope search to files matching pattern"),
      max_references: zNum().describe("Maximum references to return (default: 500)"),
    })),
    handler: async (args: Record<string, unknown>) => {
      const { traceQuery } = await import("./tools/sql-tools.js");
      const opts: Parameters<typeof traceQuery>[1] = {
        table: args.table as string,
      };
      if (args.include_orm != null) opts!.include_orm = args.include_orm as boolean;
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.max_references != null) opts!.max_references = args.max_references as number;
      const result = await traceQuery(args.repo as string, opts);
      const parts: string[] = [];
      if (result.table_definition) {
        parts.push(`Definition: ${result.table_definition.file}:${result.table_definition.line} [${result.table_definition.kind}]`);
      } else {
        parts.push(`Definition: not found in index`);
      }
      parts.push(`SQL references: ${result.sql_references.length}${result.truncated ? " (truncated)" : ""}`);
      for (const ref of result.sql_references.slice(0, 50)) {
        parts.push(`  ${ref.file}:${ref.line} [${ref.type}] ${ref.context}`);
      }
      if (result.orm_references.length > 0) {
        parts.push(`ORM references: ${result.orm_references.length}`);
        for (const ref of result.orm_references) {
          parts.push(`  ${ref.file}:${ref.line} [${ref.orm}] model ${ref.model_name}`);
        }
      }
      if (result.warnings.length > 0) {
        parts.push(`Warnings: ${result.warnings.join("; ")}`);
      }
      return parts.join("\n");
    },
  },
  {
    name: "sql_audit",
    category: "analysis" as ToolCategory,
    searchHint: "SQL audit composite drift orphan lint DML safety complexity god table schema diagnostic",
    description: "Composite SQL audit — runs 5 diagnostic gates (drift, orphan, lint, dml, complexity) in one call. Use this instead of calling the individual gate functions separately.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      checks: z.array(z.enum(["drift", "orphan", "lint", "dml", "complexity"])).optional().describe("Subset of gates to run (default: all 5)"),
      file_pattern: z.string().optional().describe("Scope to files matching pattern"),
      max_results: zNum().describe("Max DML findings per pattern (default: 200)"),
    })),
    handler: async (args: Record<string, unknown>) => {
      const { sqlAudit } = await import("./tools/sql-tools.js");
      const opts: Parameters<typeof sqlAudit>[1] = {};
      if (args.checks != null) opts.checks = args.checks as ("drift" | "orphan" | "lint" | "dml" | "complexity")[];
      if (args.file_pattern != null) opts.file_pattern = args.file_pattern as string;
      if (args.max_results != null) opts.max_results = args.max_results as number;
      const result = await sqlAudit(args.repo as string, opts);
      const parts: string[] = [];
      parts.push(`SQL audit: ${result.summary.gates_run} gates run, ${result.summary.gates_passed} passed, ${result.summary.gates_failed} failed`);
      parts.push(`  Total findings:    ${result.summary.total_findings}`);
      parts.push(`  Critical findings: ${result.summary.critical_findings}`);
      parts.push("");
      for (const g of result.gates) {
        const icon = g.pass ? "✓" : (g.critical ? "✗ CRITICAL" : "⚠");
        parts.push(`${icon} ${g.check}: ${g.summary}`);
      }
      if (result.warnings.length > 0) {
        parts.push("");
        parts.push("─── Warnings ───");
        for (const w of result.warnings) parts.push(`  ⚠ ${w}`);
      }
      return parts.join("\n");
    },
  },
  {
    name: "diff_migrations",
    category: "analysis" as ToolCategory,
    searchHint: "migration diff SQL destructive DROP ALTER ADD schema change deploy risk",
    description: "Scan SQL migration files and classify operations as additive (CREATE TABLE), modifying (ALTER ADD), or destructive (DROP TABLE, DROP COLUMN, TRUNCATE). Flags deploy risks.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Scope to migration files matching pattern"),
    })),
    handler: async (args: Record<string, unknown>) => {
      const { diffMigrations } = await import("./tools/sql-tools.js");
      const opts: Parameters<typeof diffMigrations>[1] = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      const result = await diffMigrations(args.repo as string, opts);
      const parts: string[] = [];
      parts.push(`Migration ops: ${result.summary.additive + result.summary.modifying + result.summary.destructive} across ${result.summary.total_files} files`);
      parts.push(`  additive:    ${result.summary.additive}`);
      parts.push(`  modifying:   ${result.summary.modifying}`);
      parts.push(`  destructive: ${result.summary.destructive}`);
      if (result.destructive.length > 0) {
        parts.push("\n⚠ DESTRUCTIVE:");
        for (const d of result.destructive) {
          parts.push(`  [${d.severity.toUpperCase()}] ${d.operation} ${d.target}  (${d.file}:${d.line})`);
        }
      }
      if (result.modifying.length > 0) {
        parts.push("\nModifying:");
        for (const m of result.modifying.slice(0, 20)) {
          parts.push(`  ${m.operation} ${m.target}  (${m.file}:${m.line})`);
        }
      }
      return parts.join("\n");
    },
  },
  {
    name: "search_columns",
    category: "search" as ToolCategory,
    searchHint: "search column SQL table field name type database schema find",
    description: "Search SQL columns across all tables by name (substring), type (int/string/float/...), or parent table. Returns column name, type, table, file, and line. Like search_symbols but scoped to SQL fields.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      query: z.string().describe("Column name substring to match (case-insensitive). Empty = no name filter."),
      type: z.string().optional().describe("Filter by normalized type: int, string, float, bool, datetime, json, uuid, bytes"),
      table: z.string().optional().describe("Filter by table name substring"),
      file_pattern: z.string().optional().describe("Scope to files matching pattern"),
      max_results: zNum().describe("Max columns to return (default: 100)"),
    })),
    handler: async (args: Record<string, unknown>) => {
      const { searchColumns } = await import("./tools/sql-tools.js");
      const opts: Parameters<typeof searchColumns>[1] = {
        query: (args.query as string) ?? "",
      };
      if (args.type != null) opts!.type = args.type as string;
      if (args.table != null) opts!.table = args.table as string;
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.max_results != null) opts!.max_results = args.max_results as number;
      const result = await searchColumns(args.repo as string, opts);
      const parts: string[] = [];
      parts.push(`Columns: ${result.columns.length}${result.truncated ? `/${result.total} (truncated)` : ""}`);
      for (const c of result.columns) {
        parts.push(`  ${c.table}.${c.name.padEnd(24)} ${c.normalized_type.padEnd(10)} ${c.file}:${c.line}`);
      }
      return parts.join("\n");
    },
  },
  // --- Astro v6 migration check ---
  {
    name: "astro_migration_check",
    category: "analysis" as ToolCategory,
    searchHint: "astro v6 migration upgrade breaking changes compatibility check AM01 AM10 content collections ViewTransitions",
    description: "Scan an Astro project for v5→v6 breaking changes. Detects 10 issues (AM01–AM10): removed APIs (Astro.glob, emitESMImage), component renames (ViewTransitions→ClientRouter), content collection config changes, Node.js version requirements, Zod 4 deprecations, hybrid output mode, and removed integrations (@astrojs/lit). Returns a migration report with per-issue effort estimates.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      target_version: z.enum(["6"]).optional().describe("Target Astro version (default: '6')"),
    })),
    handler: async (args) => {
      const mcArgs: Parameters<typeof astroMigrationCheck>[0] = {};
      if (args.repo != null) mcArgs.repo = args.repo as string;
      if (args.target_version != null) mcArgs.target_version = args.target_version as "6";
      const result = await astroMigrationCheck(mcArgs);
      const lines: string[] = [];
      lines.push(`ASTRO MIGRATION CHECK: v${result.current_version ?? "unknown"} → v${result.target_version}`);
      lines.push(`Issues: ${result.summary.total_issues} | Estimated: ${result.summary.estimated_migration_hours}`);
      if (Object.keys(result.summary.by_effort).length > 0) {
        const effortStr = Object.entries(result.summary.by_effort)
          .map(([k, v]) => `${v}×${k}`)
          .join(", ");
        lines.push(`Effort: ${effortStr}`);
      }
      if (result.breaking_changes.length === 0) {
        lines.push("\n✓ No v6 breaking changes detected.");
      } else {
        lines.push("");
        for (const issue of result.breaking_changes) {
          const sev = issue.severity === "error" ? "✗" : issue.severity === "warning" ? "⚠" : "ℹ";
          lines.push(`${sev} ${issue.code} [${issue.category}] — ${issue.message}`);
          lines.push(`  effort: ${issue.effort} | files: ${issue.files.slice(0, 3).join(", ")}${issue.files.length > 3 ? ` +${issue.files.length - 3} more` : ""}`);
          if (issue.migration_guide) lines.push(`  guide: ${issue.migration_guide}`);
        }
      }
      return lines.join("\n");
    },
  },

  // --- Discovery / concierge ---
  {
    name: "initial_instructions",
    category: "meta",
    searchHint: "initial instructions onboarding setup start session",
    description: "IMPORTANT: Call this tool IMMEDIATELY after the user gives you a task, BEFORE any other tool calls. Returns CodeSift's full instruction manual which critically informs how to use the 146 code intelligence tools. Skipping this tool causes the agent to miss CodeSift's pre-built BM25 + semantic index and waste tokens on Grep/Read instead.",
    schema: lazySchema(() => ({})),
    handler: async () => {
      const { CODESIFT_INSTRUCTIONS } = await import("./instructions.js");
      return CODESIFT_INSTRUCTIONS;
    },
  },
  {
    name: "plan_turn",
    category: "discovery",
    searchHint: "plan turn routing recommend tools symbols files gap analysis session aware concierge",
    description: "Routes a natural-language query to the most relevant CodeSift tools, symbols, and files. Uses hybrid BM25+semantic ranking with session-aware dedup. Call at the start of a task to get a prioritized action list.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      query: z.string().describe("Natural-language description of what you want to do"),
      max_results: z.number().optional().describe("Max tools to return (default 10)"),
      skip_session: z.boolean().optional().describe("Skip session state checks (default false)"),
    })),
    handler: async (args) => {
      const { query, max_results, skip_session } = args as { query: string; max_results?: number; skip_session?: boolean };
      const opts: { max_results?: number; skip_session?: boolean } = {};
      if (max_results !== undefined) opts.max_results = max_results;
      if (skip_session !== undefined) opts.skip_session = skip_session;
      const result = await planTurn(args.repo as string, query, opts);
      for (const name of result.reveal_required) {
        enableToolByName(name);
      }
      return formatPlanTurnResult(result);
    },
  },
];

const TOOL_DEFINITION_MAP = new Map<string, ToolDefinition>(
  TOOL_DEFINITIONS.map((tool) => [tool.name, tool]),
);

const TOOL_SUMMARIES: ToolSummary[] = TOOL_DEFINITIONS.map((tool) => ({
  name: tool.name,
  category: tool.category,
  description: tool.description,
  searchHint: tool.searchHint,
}));

const TOOL_CATEGORIES = [...new Set(
  TOOL_SUMMARIES.map((summary) => summary.category).filter(Boolean),
)] as string[];

const TOOL_PARAMS_CACHE = new Map<string, Array<{ name: string; required: boolean; description: string }>>();

// ---------------------------------------------------------------------------
// Tool discovery — lets LLM find deferred tools by keyword search
// ---------------------------------------------------------------------------

interface ToolSummary {
  name: string;
  category: ToolCategory | undefined;
  description: string;
  searchHint: string | undefined;
}

function buildToolSummaries(): ToolSummary[] {
  return TOOL_SUMMARIES;
}

/**
 * Extract structured param info from a ToolDefinition's Zod schema.
 */
export function extractToolParams(def: ToolDefinition): Array<{ name: string; required: boolean; description: string }> {
  const cached = TOOL_PARAMS_CACHE.get(def.name);
  if (cached) return cached;

  const params = Object.entries(def.schema).map(([key, val]) => {
    const zodVal = val as z.ZodTypeAny;
    const isOptional = zodVal.isOptional?.() ?? false;
    return {
      name: key,
      required: !isOptional,
      description: zodVal.description ?? "",
    };
  });
  TOOL_PARAMS_CACHE.set(def.name, params);
  return params;
}

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITION_MAP.get(name);
}

interface DescribeToolsResult {
  tools: Array<{
    name: string;
    category: string;
    description: string;
    is_core: boolean;
    params: Array<{ name: string; required: boolean; description: string }>;
  }>;
  not_found: string[];
}

/**
 * Return full param details for a specific list of tool names.
 * Unknown names are collected in not_found.
 */
export function describeTools(names: string[]): DescribeToolsResult {
  const capped = names.slice(0, 100); // CQ6 cap
  const tools: DescribeToolsResult["tools"] = [];
  const not_found: string[] = [];

  for (const name of capped) {
    const def = TOOL_DEFINITION_MAP.get(name);
    if (!def) {
      not_found.push(name);
      continue;
    }
    tools.push({
      name: def.name,
      category: def.category ?? "uncategorized",
      description: def.description,
      is_core: CORE_TOOL_NAMES.has(def.name),
      params: extractToolParams(def),
    });
  }

  return { tools, not_found };
}

/**
 * Search tool catalog by keyword. Returns matching tools with descriptions.
 * Uses simple token matching against name + description + searchHint + category.
 */
export function discoverTools(query: string, category?: string): {
  query: string;
  matches: Array<{ name: string; category: string; description: string; is_core: boolean }>;
  total_tools: number;
  categories: string[];
} {
  const summaries = buildToolSummaries();
  const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const categories = TOOL_CATEGORIES;

  let filtered = summaries;
  if (category) {
    filtered = filtered.filter((s) => s.category === category);
  }

  // Score each tool by keyword match
  const scored = filtered.map((tool) => {
    const searchable = `${tool.name} ${tool.description} ${tool.searchHint ?? ""} ${tool.category ?? ""}`.toLowerCase();
    let score = 0;
    for (const token of queryTokens) {
      if (searchable.includes(token)) score++;
      // Bonus for name match
      if (tool.name.includes(token)) score += 2;
    }
    // If no query tokens, match everything (category-only filter)
    if (queryTokens.length === 0) score = 1;
    return { tool, score };
  });

  const matches = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15)
    .map((s) => {
      // Look up full definition to extract param info for deferred tools
      const fullDef = TOOL_DEFINITION_MAP.get(s.tool.name);
      const params = fullDef
        ? extractToolParams(fullDef).map(
            (p) => `${p.name}${p.required ? "" : "?"}: ${p.description || "string"}`,
          )
        : [];
      return {
        name: s.tool.name,
        category: s.tool.category ?? "uncategorized",
        description: s.tool.description.slice(0, 200),
        params: params.length > 0 ? params : undefined,
        is_core: CORE_TOOL_NAMES.has(s.tool.name),
      };
    });

  return {
    query,
    matches,
    total_tools: TOOL_DEFINITIONS.length,
    categories,
  };
}

// ---------------------------------------------------------------------------
// Registration loop
// ---------------------------------------------------------------------------

export function registerTools(
  server: McpServer,
  options?: { deferNonCore?: boolean; projectRoot?: string },
): void {
  const deferNonCore = options?.deferNonCore ?? false;
  const projectRoot = options?.projectRoot ?? process.cwd();

  // Detect which languages the project actually uses — drives language-gated
  // tool registration. Tools with requiresLanguage="python" are only surfaced
  // when .py files exist, same for PHP and Kotlin.
  let languages: ProjectLanguages;
  try {
    languages = detectProjectLanguagesSync(projectRoot);
  } catch {
    // On failure, enable everything — conservative fallback
    languages = {
      python: true, php: true, typescript: true, javascript: true,
      kotlin: true, go: true, rust: true, ruby: true,
    };
  }

  // Clear handles from any previous registration (e.g. tests calling registerTools multiple times)
  toolHandles.clear();
  enabledFrameworkBundles.clear();
  registrationContext = { server, languages };

  // Register either the full catalog or only core tools. In deferred mode the
  // remaining tools are registered lazily via describe_tools(reveal=true),
  // plan_turn auto-reveal, or framework auto-load.
  for (const tool of TOOL_DEFINITIONS) {
    if (deferNonCore && !CORE_TOOL_NAMES.has(tool.name)) {
      continue;
    }
    registerToolDefinition(server, tool, languages);
  }

  // Always register discover_tools meta-tool
  const discoverHandle = server.tool(
    "discover_tools",
    "Search tool catalog by keyword or category. Returns matching tools with descriptions.",
    {
      query: z.string().describe("Keywords to search for (e.g. 'dead code', 'complexity', 'rename', 'secrets')"),
      category: z.string().optional().describe("Filter by category (e.g. 'analysis', 'lsp', 'architecture')"),
    },
    async (args) => wrapTool("discover_tools", args as Record<string, unknown>, async () => {
      return discoverTools(args.query as string, args.category as string | undefined);
    })(),
  );
  toolHandles.set("discover_tools", discoverHandle);

  // Register describe_tools meta-tool — returns full schema for specific tools by name
  const describeHandle = server.tool(
    "describe_tools",
    "Get full schema for specific tools by name. Use after discover_tools to see params before calling.",
    {
      names: z.union([z.array(z.string()), z.string().transform((s) => JSON.parse(s) as string[])]).describe("Tool names to describe"),
      reveal: zBool().describe("If true, enable tools in ListTools so the LLM can call them"),
    },
    async (args) => wrapTool("describe_tools", args as Record<string, unknown>, async () => {
      const result = describeTools(args.names as string[]);
      if (args.reveal === true) {
        for (const t of result.tools) {
          enableToolByName(t.name);
        }
      }
      return result;
    })(),
  );
  toolHandles.set("describe_tools", describeHandle);

  if (deferNonCore) {
    // Auto-enable framework-specific tools when project type is detected at CWD.
    // E.g. composer.json → enable PHP/Yii2 tools automatically.
    detectAutoLoadToolsCached(process.cwd())
      .then((toEnable) => {
        for (const name of toEnable) {
          enableToolByName(name);
        }
        if (toEnable.length > 0) {
          console.error(`[codesift] Auto-loaded ${toEnable.length} framework tools for detected project type: ${toEnable.join(", ")}`);
        }
      })
      .catch(() => {
        // Silently ignore — auto-detection is best-effort
      });
  }

  // Register progressive shorteners for analysis tools with large outputs
  registerShortener("analyze_complexity", { compact: formatComplexityCompact, counts: formatComplexityCounts });
  registerShortener("find_clones", { compact: formatClonesCompact, counts: formatClonesCounts });
  registerShortener("analyze_hotspots", { compact: formatHotspotsCompact, counts: formatHotspotsCounts });
  registerShortener("trace_route", { compact: formatTraceRouteCompact, counts: formatTraceRouteCounts });
  registerShortener("nextjs_route_map", { compact: formatNextjsRouteMapCompact, counts: formatNextjsRouteMapCounts });
  registerShortener("nextjs_metadata_audit", { compact: formatNextjsMetadataAuditCompact, counts: formatNextjsMetadataAuditCounts });
  registerShortener("framework_audit", { compact: formatFrameworkAuditCompact, counts: formatFrameworkAuditCounts });
  registerShortener("get_session_context", {
    compact: (raw: unknown) => {
      const text = typeof raw === "string" ? raw : JSON.stringify(raw);
      try {
        const data = JSON.parse(text);
        return `session:${data.session_id?.slice(0, 8)} calls:${data.call_count} files:${data.explored_files?.count} symbols:${data.explored_symbols?.count} queries:${data.queries?.count} neg:${data.negative_evidence?.count}`;
      } catch { return text.slice(0, 500); }
    },
    counts: (raw: unknown) => {
      const text = typeof raw === "string" ? raw : JSON.stringify(raw);
      try {
        const data = JSON.parse(text);
        return `files:${data.explored_files?.count} symbols:${data.explored_symbols?.count} queries:${data.queries?.count} neg:${data.negative_evidence?.count}`;
      } catch { return "parse error"; }
    },
  });
}
