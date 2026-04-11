import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Boolean that also accepts "true"/"false" strings (LLMs often send strings instead of booleans) */
const zBool = () => z.union([z.boolean(), z.string().transform((s) => s === "true")]).optional();
import { wrapTool, registerShortener } from "./server-helpers.js";
import { indexFolder, indexFile, indexRepo, listAllRepos, invalidateCache, getCodeIndex } from "./tools/index-tools.js";
import { searchSymbols, searchText, semanticSearch } from "./tools/search-tools.js";
import { getFileTree, getFileOutline, getRepoOutline, suggestQueries } from "./tools/outline-tools.js";
import { getSymbol, getSymbols, findAndShow, findReferences, findReferencesBatch, findDeadCode, getContextBundle, formatRefsCompact, formatSymbolCompact, formatSymbolsCompact, formatBundleCompact } from "./tools/symbol-tools.js";
import { traceCallChain } from "./tools/graph-tools.js";
import { traceComponentTree, analyzeHooks } from "./tools/react-tools.js";
import { impactAnalysis } from "./tools/impact-tools.js";
import { traceRoute } from "./tools/route-tools.js";
import { detectCommunities } from "./tools/community-tools.js";
import { assembleContext, getKnowledgeMap } from "./tools/context-tools.js";
import { diffOutline, changedSymbols } from "./tools/diff-tools.js";
import { generateClaudeMd } from "./tools/generate-tools.js";
import { codebaseRetrieval } from "./retrieval/codebase-retrieval.js";
import { analyzeComplexity } from "./tools/complexity-tools.js";
import { findClones } from "./tools/clone-tools.js";
import { analyzeHotspots } from "./tools/hotspot-tools.js";
import { crossRepoSearchSymbols, crossRepoFindReferences } from "./tools/cross-repo-tools.js";
import { searchPatterns, listPatterns } from "./tools/pattern-tools.js";
import { generateReport } from "./tools/report-tools.js";
import { getUsageStats, formatUsageReport } from "./storage/usage-stats.js";
import { goToDefinition, getTypeInfo, renameSymbol, getCallHierarchy } from "./lsp/lsp-tools.js";
import { indexConversations, searchConversations, searchAllConversations, findConversationsForSymbol } from "./tools/conversation-tools.js";
import { scanSecrets } from "./tools/secret-tools.js";
import {
  resolvePhpNamespace,
  analyzeActiveRecord,
  tracePhpEvent,
  findPhpViews,
  resolvePhpService,
  phpSecurityScan,
  phpProjectAudit,
} from "./tools/php-tools.js";
import { consolidateMemories, readMemory } from "./tools/memory-tools.js";
import { createAnalysisPlan, writeScratchpad, readScratchpad, listScratchpad, updateStepStatus, getPlan, listPlans } from "./tools/coordinator-tools.js";
import { frequencyAnalysis } from "./tools/frequency-tools.js";
import { analyzeProject, getExtractorVersions } from "./tools/project-tools.js";
import { reviewDiff } from "./tools/review-diff-tools.js";
import { auditScan } from "./tools/audit-tools.js";
import type { AuditScanOptions } from "./tools/audit-tools.js";
import { indexStatus } from "./tools/status-tools.js";
import { findPerfHotspots } from "./tools/perf-tools.js";
import { fanInFanOut, coChangeAnalysis } from "./tools/coupling-tools.js";
import { architectureSummary } from "./tools/architecture-tools.js";
import { nestLifecycleMap, nestModuleGraph, nestDIGraph, nestGuardChain, nestRouteInventory, nestAudit } from "./tools/nest-tools.js";
import type { NestLifecycleMapResult, NestModuleGraphResult, NestDIGraphResult, NestGuardChainResult, NestRouteInventoryResult, NestAuditResult } from "./tools/nest-tools.js";
import { explainQuery } from "./tools/query-tools.js";
import { formatSnapshot, getContext, getSessionState } from "./storage/session-state.js";
import { formatComplexityCompact, formatComplexityCounts, formatClonesCompact, formatClonesCounts, formatHotspotsCompact, formatHotspotsCounts, formatTraceRouteCompact, formatTraceRouteCounts } from "./formatters-shortening.js";
import type { SecretSeverity } from "./tools/secret-tools.js";
import type { SymbolKind, Direction } from "./types.js";
import { formatSearchSymbols, formatFileTree, formatFileOutline, formatSearchPatterns, formatDeadCode, formatComplexity, formatClones, formatHotspots, formatRepoOutline, formatSuggestQueries, formatSecrets, formatConversations, formatRoles, formatAssembleContext, formatCommunities, formatCallTree, formatTraceRoute, formatKnowledgeMap, formatImpactAnalysis, formatDiffOutline, formatChangedSymbols, formatReviewDiff, formatPerfHotspots, formatFanInFanOut, formatCoChange, formatArchitectureSummary } from "./formatters.js";

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

// ---------------------------------------------------------------------------
// H11 — warn when symbol tools return empty for repos with text_stub languages
// ---------------------------------------------------------------------------

const SYMBOL_TOOLS = new Set([
  "search_symbols", "get_file_outline", "get_symbol", "get_symbols",
  "find_references", "trace_call_chain", "find_dead_code", "analyze_complexity",
]);

/**
 * Check if a repo has text_stub files as dominant language. Returns a hint
 * string to prepend to empty results, or null if no hint needed.
 */
async function checkTextStubHint(repo: string | undefined, toolName: string, resultEmpty: boolean): Promise<string | null> {
  if (!resultEmpty || !repo || !SYMBOL_TOOLS.has(toolName)) return null;

  const index = await getCodeIndex(repo);
  if (!index) return null;

  const stubCount = index.files.filter(f => f.language === "text_stub" || f.language === "kotlin").length;
  if (stubCount === 0) return null;

  const stubPct = Math.round((stubCount / index.files.length) * 100);
  if (stubPct < 30) return null; // only warn if text_stub is significant portion

  const stubExts = [...new Set(index.files
    .filter(f => f.language === "text_stub" || f.language === "kotlin")
    .map(f => "." + f.path.split(".").pop()))].slice(0, 3).join(", ");

  return `⚡H11 No parser for ${stubExts} files (${stubPct}% of repo). Symbol tools return empty.\n` +
    `  → search_text(query) works on ALL files (uses ripgrep, not parser)\n` +
    `  → get_file_tree shows file listing\n` +
    `  → Only symbol-based tools (this one) need a parser to return results.\n`;
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

// ---------------------------------------------------------------------------
// Tool definition type
// ---------------------------------------------------------------------------

interface ToolDefinition {
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
  | "meta";

/** Tools visible in ListTools — core (high usage) + direct-use (agents call without discovery) */
const CORE_TOOL_NAMES = new Set([
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
  "nest_audit",              // one-call NestJS analysis: modules+DI+guards+routes+lifecycle
  // --- Essential infrastructure ---
  "index_folder",            // repo onboarding
  "discover_tools",          // meta: discovers remaining hidden tools
  "describe_tools",          // meta: full schema for hidden tools
  "get_session_snapshot",    // session: compaction survival
  "analyze_project",         // project profile
  "get_extractor_versions",  // cache invalidation
  "index_status",            // meta: check if repo is indexed
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
    schema: {
      path: z.string().describe("Absolute path to the folder to index"),
      incremental: zBool().describe("Only re-index changed files"),
      include_paths: z.union([z.array(z.string()), z.string().transform((s) => JSON.parse(s) as string[])]).optional().describe("Glob patterns to include. Can be passed as JSON string."),
    },
    handler: (args) => indexFolder(args.path as string, {
      incremental: args.incremental as boolean | undefined,
      include_paths: args.include_paths as string[] | undefined,
    }),
  },
  {
    name: "index_repo",
    category: "indexing",
    searchHint: "clone remote git repository index",
    description: "Clone and index a remote git repository",
    schema: {
      url: z.string().describe("Git clone URL"),
      branch: z.string().optional().describe("Branch to checkout"),
      include_paths: z.union([z.array(z.string()), z.string().transform((s) => JSON.parse(s) as string[])]).optional().describe("Glob patterns to include. Can be passed as JSON string."),
    },
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
    schema: {
      compact: zBool().describe("true=names only (default), false=full metadata"),
      name_contains: z.string().optional().describe("Filter repos by name substring (case-insensitive). E.g. 'tgm' matches 'local/tgm-panel'"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    },
    handler: (args) => invalidateCache(args.repo as string),
  },

  {
    name: "index_file",
    category: "indexing",
    searchHint: "re-index single file update incremental",
    description: "Re-index a single file after editing. Auto-finds repo, skips if unchanged.",
    schema: {
      path: z.string().describe("Absolute path to the file to re-index"),
    },
    handler: (args) => indexFile(args.path as string),
  },

  // --- Search ---
  {
    name: "search_symbols",
    category: "search",
    searchHint: "search find symbols functions classes types methods by name signature",
    outputSchema: OutputSchemas.searchResults,
    description: "Search symbols by name/signature. detail_level: compact (~15 tok), standard (default), full.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      query: z.string().describe("Search query string"),
      kind: z.string().optional().describe("Filter by symbol kind (function, class, etc.)"),
      file_pattern: z.string().optional().describe("Glob pattern to filter files"),
      include_source: zBool().describe("Include full source code of each symbol"),
      top_k: zNum().describe("Maximum number of results to return (default 50)"),
      source_chars: zNum().describe("Truncate each symbol's source to N characters (reduces output size)"),
      detail_level: z.enum(["compact", "standard", "full"]).optional().describe("compact (~15 tok), standard (default), full (all source)"),
      token_budget: zNum().describe("Max tokens for results — greedily packs results until budget exhausted. Overrides top_k."),
      rerank: zBool().describe("Rerank results using cross-encoder model for improved relevance (requires @huggingface/transformers)"),
    },
    handler: async (args) => {
      const results = await searchSymbols(args.repo as string, args.query as string, {
        kind: args.kind as SymbolKind | undefined,
        file_pattern: args.file_pattern as string | undefined,
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
    searchHint: "AST tree-sitter query structural pattern matching code shape",
    description: "Search AST patterns via tree-sitter S-expressions. Finds code by structural shape.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      query: z.string().describe("Tree-sitter query in S-expression syntax"),
      language: z.string().describe("Tree-sitter grammar: typescript, javascript, python, go, rust, java, ruby, php"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      max_matches: zNum().describe("Maximum matches to return (default: 50)"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      query: z.string().describe("Natural language query describing what you're looking for"),
      top_k: zNum().describe("Number of results (default: 10)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      exclude_tests: zBool().describe("Exclude test files from results"),
      rerank: zBool().describe("Re-rank results with cross-encoder for better precision"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      query: z.string().describe("Search query or regex pattern"),
      regex: zBool().describe("Treat query as a regex pattern"),
      context_lines: zNum().describe("Number of context lines around each match"),
      file_pattern: z.string().optional().describe("Glob pattern to filter files"),
      max_results: zNum().describe("Maximum number of matching lines to return (default 200)"),
      group_by_file: zBool().describe("Group by file: {file, count, lines[], first_match}. ~80% less output."),
      auto_group: zBool().describe("Auto group_by_file when >50 matches."),
      ranked: z.boolean().optional().describe("Classify hits by containing symbol and rank by centrality"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      path_prefix: z.string().optional().describe("Filter to a subtree by path prefix"),
      name_pattern: z.string().optional().describe("Glob pattern to filter file names"),
      depth: zNum().describe("Maximum directory depth to traverse"),
      compact: zBool().describe("Return flat list of {path, symbols} instead of nested tree (much less output)"),
      min_symbols: zNum().describe("Only include files with at least this many symbols"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_path: z.string().describe("Relative file path within the repository"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_id: z.string().describe("Unique symbol identifier"),
      include_related: zBool().describe("Include children/related symbols (default: true)"),
    },
    handler: async (args) => {
      const opts: { include_related?: boolean } = {};
      if (args.include_related != null) opts.include_related = args.include_related as boolean;
      const result = await getSymbol(args.repo as string, args.symbol_id as string, opts);
      if (!result) return null;
      let text = formatSymbolCompact(result.symbol);
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_ids: z.union([
        z.array(z.string()),
        z.string().transform((s) => JSON.parse(s) as string[]),
      ]).describe("Array of symbol identifiers. Can be passed as JSON string."),
    },
    handler: async (args) => {
      const syms = await getSymbols(args.repo as string, args.symbol_ids as string[]);
      return formatSymbolsCompact(syms);
    },
  },
  {
    name: "find_and_show",
    category: "symbols",
    searchHint: "find symbol by name show source code references",
    description: "Find a symbol by name and show its source, optionally including references",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      query: z.string().describe("Symbol name or query to search for"),
      include_refs: zBool().describe("Include locations that reference this symbol"),
    },
    handler: async (args) => {
      const result = await findAndShow(args.repo as string, args.query as string, args.include_refs as boolean | undefined);
      if (!result) return null;
      let text = formatSymbolCompact(result.symbol);
      if (result.references) {
        text += `\n\n--- references ---\n${formatRefsCompact(result.references)}`;
      }
      return text;
    },
  },
  {
    name: "get_context_bundle",
    category: "symbols",
    searchHint: "context bundle symbol imports siblings callers one call",
    description: "Symbol + imports + siblings in one call. Saves 2-3 round-trips.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().describe("Symbol name to find"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().optional().describe("Name of the symbol to find references for"),
      symbol_names: z.union([z.array(z.string()), z.string().transform((s) => JSON.parse(s) as string[])]).optional()
        .describe("Array of symbol names for batch search (reads each file once). Can be JSON string."),
      file_pattern: z.string().optional().describe("Glob pattern to filter files"),
    },
    handler: async (args) => {
      const names = args.symbol_names as string[] | undefined;
      if (names && names.length > 0) {
        return findReferencesBatch(args.repo as string, names, args.file_pattern as string | undefined);
      }
      const refs = await findReferences(args.repo as string, args.symbol_name as string, args.file_pattern as string | undefined);
      // Compact format: drop col, use file:line: context (matches grep output)
      return formatRefsCompact(refs);
    },
  },
  {
    name: "trace_call_chain",
    category: "graph",
    searchHint: "trace call chain callers callees dependency graph mermaid react hooks",
    outputSchema: OutputSchemas.callTree,
    description: "Trace call chain: callers or callees. output_format='mermaid' for diagram. filter_react_hooks=true skips useState/useEffect etc. for cleaner React graphs.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().describe("Name of the symbol to trace"),
      direction: z.enum(["callers", "callees"]).describe("Trace direction"),
      depth: zNum().describe("Maximum depth to traverse the call graph (default: 1)"),
      include_source: zBool().describe("Include full source code of each symbol (default: false)"),
      include_tests: zBool().describe("Include test files in trace results (default: false)"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output format: 'json' (default) or 'mermaid' (flowchart diagram)"),
      filter_react_hooks: zBool().describe("Skip edges to React stdlib hooks (useState, useEffect, etc.) to reduce call graph noise in React codebases (default: false)"),
    },
    handler: async (args) => {
      const result = await traceCallChain(args.repo as string, args.symbol_name as string, args.direction as Direction, {
        depth: args.depth as number | undefined,
        include_source: args.include_source as boolean | undefined,
        include_tests: args.include_tests as boolean | undefined,
        output_format: args.output_format as "json" | "mermaid" | undefined,
        filter_react_hooks: args.filter_react_hooks as boolean | undefined,
      });
      return formatCallTree(result as never);
    },
  },
  {
    name: "impact_analysis",
    category: "graph",
    searchHint: "impact analysis blast radius git changes affected symbols",
    outputSchema: OutputSchemas.impactAnalysis,
    description: "Blast radius of git changes — affected symbols and files.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      since: z.string().describe("Git ref to compare from (e.g. HEAD~3, commit SHA, branch)"),
      depth: zNum().describe("Depth of dependency traversal"),
      until: z.string().optional().describe("Git ref to compare to (defaults to HEAD)"),
      include_source: zBool().describe("Include full source code of affected symbols (default: false)"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      component_name: z.string().describe("Root component name (must have kind 'component' in index)"),
      depth: zNum().describe("Maximum depth of composition tree (default: 3)"),
      include_source: zBool().describe("Include full source of each component (default: false)"),
      include_tests: zBool().describe("Include test files (default: false)"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output format: 'json' (default) or 'mermaid'"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      component_name: z.string().optional().describe("Filter to single component/hook (default: all)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      include_tests: zBool().describe("Include test files (default: false)"),
      max_entries: zNum().describe("Max entries to return (default: 100)"),
    },
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
    name: "trace_route",
    category: "graph",
    searchHint: "trace HTTP route handler API endpoint service database NestJS Express Next.js",
    description: "Trace HTTP route → handler → service → DB. NestJS, Next.js, Express.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      path: z.string().describe("URL path to trace (e.g. '/api/users', '/api/projects/:id')"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output format: 'json' (default) or 'mermaid' (sequence diagram)"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().describe("Symbol name to find definition of"),
      file_path: z.string().optional().describe("File containing the symbol reference (for LSP precision)"),
      line: zNum().describe("0-based line number of the reference"),
      character: zNum().describe("0-based column of the reference"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().describe("Symbol name to get type info for"),
      file_path: z.string().optional().describe("File containing the symbol"),
      line: zNum().describe("0-based line number"),
      character: zNum().describe("0-based column"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().describe("Current name of the symbol to rename"),
      new_name: z.string().describe("New name for the symbol"),
      file_path: z.string().optional().describe("File containing the symbol"),
      line: zNum().describe("0-based line number"),
      character: zNum().describe("0-based column"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().describe("Symbol name to get call hierarchy for"),
      file_path: z.string().optional().describe("File containing the symbol (for LSP precision)"),
      line: zNum().describe("0-based line number"),
      character: zNum().describe("0-based column"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      focus: z.string().optional().describe("Path substring to filter files (e.g. 'src/lib')"),
      resolution: zNum().describe("Louvain resolution: higher = more smaller communities, lower = fewer larger (default: 1.0)"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output format: 'json' (default) or 'mermaid' (graph diagram)"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      max_cycles: zNum().describe("Maximum cycles to report (default: 50)"),
    },
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
    schema: {
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
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      include_tests: zBool().describe("Include test files (default: false)"),
      top_n: zNum().describe("Maximum number of symbols to return (default: 100)"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      query: z.string().describe("Natural language query describing what context is needed"),
      token_budget: zNum().describe("Maximum tokens for the assembled context"),
      level: z.enum(["L0", "L1", "L2", "L3"]).optional().describe("L0=source (default), L1=signatures, L2=files, L3=dirs"),
      rerank: zBool().describe("Rerank results using cross-encoder model for improved relevance (requires @huggingface/transformers)"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      focus: z.string().optional().describe("Focus on a specific module or directory"),
      depth: zNum().describe("Maximum depth of the dependency graph"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output format: 'json' (default) or 'mermaid' (dependency diagram)"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      since: z.string().describe("Git ref to compare from"),
      until: z.string().optional().describe("Git ref to compare to (defaults to HEAD)"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      since: z.string().describe("Git ref to compare from"),
      until: z.string().optional().describe("Git ref to compare to (defaults to HEAD)"),
      include_diff: zBool().describe("Include unified diff per changed file (truncated to 500 chars)"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      output_path: z.string().optional().describe("Custom output file path"),
    },
    handler: (args) => generateClaudeMd(args.repo as string, args.output_path as string | undefined),
  },

  // --- Batch retrieval ---
  {
    name: "codebase_retrieval",
    category: "search",
    searchHint: "batch retrieval multi-query semantic hybrid token budget",
    outputSchema: OutputSchemas.batchResults,
    description: "Batch multi-query retrieval with shared token budget. Supports symbols/text/semantic/hybrid.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      queries: z
        .union([
          z.array(z.object({ type: z.string() }).passthrough()),
          z.string().transform((s) => JSON.parse(s) as Array<{ type: string } & Record<string, unknown>>),
        ])
        .describe("Sub-queries array (symbols/text/file_tree/outline/references/call_chain/impact/context/knowledge_map). JSON string OK."),
      token_budget: zNum().describe("Maximum total tokens across all sub-query results"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      include_tests: zBool().describe("Include test files in scan (default: false)"),
    },
    handler: async (args) => {
      const result = await findDeadCode(args.repo as string, {
        file_pattern: args.file_pattern as string | undefined,
        include_tests: args.include_tests as boolean | undefined,
      });
      return formatDeadCode(result as never);
    },
  },
  {
    name: "find_unused_imports",
    category: "analysis",
    searchHint: "unused imports dead cleanup lint",
    description: "Find imported names never referenced in the file body. Complements find_dead_code.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      include_tests: zBool().describe("Include test files in scan (default: false)"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      top_n: zNum().describe("Return top N most complex functions (default: 30)"),
      min_complexity: zNum().describe("Minimum cyclomatic complexity to include (default: 1)"),
      include_tests: zBool().describe("Include test files (default: false)"),
    },
    handler: async (args) => {
      const result = await analyzeComplexity(args.repo as string, {
        file_pattern: args.file_pattern as string | undefined,
        top_n: args.top_n as number | undefined,
        min_complexity: args.min_complexity as number | undefined,
        include_tests: args.include_tests as boolean | undefined,
      });
      return formatComplexity(result as never);
    },
  },
  {
    name: "find_clones",
    category: "analysis",
    searchHint: "code clones duplicates copy-paste detection similar functions",
    outputSchema: OutputSchemas.clones,
    description: "Find code clones: similar function pairs via hash bucketing + line-similarity.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      min_similarity: zNum().describe("Minimum similarity threshold 0-1 (default: 0.7)"),
      min_lines: zNum().describe("Minimum normalized lines to consider (default: 10)"),
      include_tests: zBool().describe("Include test files (default: false)"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      top_n: zNum().optional().describe("Number of clusters to return (default: 30)"),
      min_nodes: zNum().optional().describe("Minimum AST nodes in a subtree to include (default: 5)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      kind: z.string().optional().describe("Filter by symbol kind, comma-separated (default: function,method)"),
      include_tests: zBool().describe("Include test files (default: false)"),
      token_budget: zNum().optional().describe("Max tokens for response"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      since_days: zNum().describe("Look back N days (default: 90)"),
      top_n: zNum().describe("Return top N hotspots (default: 30)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
    },
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
    schema: {
      query: z.string().describe("Symbol search query"),
      repo_pattern: z.string().optional().describe("Filter repos by name pattern (e.g. 'local/tgm')"),
      kind: z.string().optional().describe("Filter by symbol kind"),
      top_k: zNum().describe("Max results per repo (default: 10)"),
      include_source: zBool().describe("Include source code"),
    },
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
    schema: {
      symbol_name: z.string().describe("Symbol name to find references for"),
      repo_pattern: z.string().optional().describe("Filter repos by name pattern"),
      file_pattern: z.string().optional().describe("Filter files by glob pattern"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      pattern: z.string().describe("Built-in pattern name or custom regex"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      include_tests: zBool().describe("Include test files (default: false)"),
      max_results: zNum().describe("Max results (default: 50)"),
    },
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
    schema: {},
    handler: async () => listPatterns(),
  },

  // --- Report ---
  {
    name: "generate_report",
    category: "reporting",
    searchHint: "generate HTML report complexity dead code hotspots architecture browser",
    description: "Generate a standalone HTML report with complexity, dead code, hotspots, and architecture. Opens in any browser.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    },
    handler: (args) => generateReport(args.repo as string),
  },

  // --- Conversations ---
  {
    name: "index_conversations",
    category: "conversations",
    searchHint: "index conversations Claude Code history JSONL",
    description: "Index Claude Code conversation history for search. Scans JSONL files in ~/.claude/projects/ for the given project path.",
    schema: {
      project_path: z.string().optional().describe("Path to the Claude project conversations directory. Auto-detects from cwd if omitted."),
      quiet: zBool().describe("Suppress output (used by session-end hook)"),
    },
    handler: async (args) => indexConversations(args.project_path as string | undefined),
  },
  {
    name: "search_conversations",
    category: "conversations",
    searchHint: "search conversations past sessions history BM25 semantic",
    description: "Search conversations in one project (BM25+semantic). For all projects: search_all_conversations.",
    schema: {
      query: z.string().describe("Search query — keywords or natural language"),
      project: z.string().optional().describe("Project path to search (default: current project)"),
      limit: zNum().optional().describe("Maximum results to return (default: 10, max: 50)"),
    },
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
    schema: {
      symbol_name: z.string().describe("Name of the code symbol to search for in conversations"),
      repo: z.string().describe("Code repository to resolve the symbol from (e.g., 'local/my-project')"),
      limit: zNum().optional().describe("Maximum conversation results (default: 5)"),
    },
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
    schema: {
      query: z.string().describe("Search query — keywords, natural language, or concept"),
      limit: zNum().optional().describe("Maximum results across all projects (default: 10)"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Glob pattern to filter scanned files"),
      min_confidence: z.enum(["high", "medium", "low"]).optional().describe("Minimum confidence level (default: medium)"),
      exclude_tests: zBool().describe("Exclude test file findings (default: true)"),
      severity: z.enum(["critical", "high", "medium", "low"]).optional().describe("Minimum severity level"),
    },
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

  // --- PHP / Yii2 tools (all discoverable via discover_tools(query="php")) ---
  {
    name: "resolve_php_namespace",
    category: "analysis",
    searchHint: "php namespace resolve PSR-4 autoload composer class file path yii2 laravel symfony",
    description: "Resolve a PHP FQCN to file path via composer.json PSR-4 autoload mapping.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      class_name: z.string().describe("Fully-qualified class name, e.g. 'App\\\\Models\\\\User'"),
    },
    handler: async (args) => {
      return await resolvePhpNamespace(args.repo as string, args.class_name as string);
    },
  },
  {
    name: "analyze_activerecord",
    category: "analysis",
    searchHint: "php activerecord eloquent model schema relations rules behaviors table yii2 laravel orm",
    description: "Extract PHP ActiveRecord/Eloquent model schema: table name, relations, validation rules, behaviors.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      model_name: z.string().optional().describe("Filter by specific model class name"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
    },
    handler: async (args) => {
      const opts: { model_name?: string; file_pattern?: string } = {};
      if (typeof args.model_name === "string") opts.model_name = args.model_name;
      if (typeof args.file_pattern === "string") opts.file_pattern = args.file_pattern;
      return await analyzeActiveRecord(args.repo as string, opts);
    },
  },
  {
    name: "trace_php_event",
    category: "analysis",
    searchHint: "php event listener trigger handler chain yii2 laravel observer dispatch",
    description: "Trace PHP event → listener chains: find trigger() calls and matching on() handlers.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      event_name: z.string().optional().describe("Filter by specific event name"),
    },
    handler: async (args) => {
      const opts: { event_name?: string } = {};
      if (typeof args.event_name === "string") opts.event_name = args.event_name;
      return await tracePhpEvent(args.repo as string, opts);
    },
  },
  {
    name: "find_php_views",
    category: "analysis",
    searchHint: "php view render template controller widget yii2 laravel blade",
    description: "Map PHP controller render() calls to view files. Yii2/Laravel convention-aware.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      controller: z.string().optional().describe("Filter by controller class name"),
    },
    handler: async (args) => {
      const opts: { controller?: string } = {};
      if (typeof args.controller === "string") opts.controller = args.controller;
      return await findPhpViews(args.repo as string, opts);
    },
  },
  {
    name: "resolve_php_service",
    category: "analysis",
    searchHint: "php service locator DI container component resolve yii2 laravel facade provider",
    description: "Resolve PHP service locator references (Yii::$app->X, Laravel facades) to concrete classes via config parsing.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      service_name: z.string().optional().describe("Filter by specific service name (e.g. 'db', 'user', 'cache')"),
    },
    handler: async (args) => {
      const opts: { service_name?: string } = {};
      if (typeof args.service_name === "string") opts.service_name = args.service_name;
      return await resolvePhpService(args.repo as string, opts);
    },
  },
  {
    name: "php_security_scan",
    category: "security",
    searchHint: "php security scan audit vulnerability injection XSS CSRF SQL eval exec unserialize",
    description: "Scan PHP code for security vulnerabilities: SQL injection, XSS, eval, exec, unserialize, file inclusion. Parallel pattern checks.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Glob pattern to filter scanned files (default: '*.php')"),
      checks: z.array(z.string()).optional().describe("Subset of checks to run: sql-injection-php, xss-php, eval-php, exec-php, unserialize-php, file-include-var, unescaped-yii-view, raw-query-yii"),
    },
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
    searchHint: "php project audit health quality technical debt code review comprehensive yii2 laravel",
    description: "Compound PHP project audit: security scan + ActiveRecord analysis + health score. Runs checks in parallel.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Glob pattern to filter analyzed files"),
    },
    handler: async (args) => {
      const opts: { file_pattern?: string } = {};
      if (typeof args.file_pattern === "string") opts.file_pattern = args.file_pattern;
      return await phpProjectAudit(args.repo as string, opts);
    },
  },

  // --- Memory consolidation ---
  {
    name: "consolidate_memories",
    category: "conversations",
    searchHint: "consolidate memories dream knowledge MEMORY.md decisions solutions patterns",
    description: "Consolidate conversations into MEMORY.md — decisions, solutions, patterns.",
    schema: {
      project_path: z.string().optional().describe("Project path (auto-detects from cwd if omitted)"),
      output_path: z.string().optional().describe("Custom output file path (default: MEMORY.md in project root)"),
      min_confidence: z.enum(["high", "medium", "low"]).optional().describe("Minimum confidence level for extracted memories (default: low)"),
    },
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
    schema: {
      project_path: z.string().optional().describe("Project path (default: current directory)"),
    },
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
    schema: {
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
    },
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
    schema: {
      plan_id: z.string().describe("Analysis plan identifier"),
      key: z.string().describe("Key name for the entry"),
      value: z.string().describe("Value to store"),
    },
    handler: async (args) => writeScratchpad(args.plan_id as string, args.key as string, args.value as string),
  },
  {
    name: "scratchpad_read",
    category: "meta",
    searchHint: "scratchpad read retrieve knowledge entry",
    description: "Read a key from a plan's scratchpad. Returns the stored value or null if not found.",
    schema: {
      plan_id: z.string().describe("Analysis plan identifier"),
      key: z.string().describe("Key name to read"),
    },
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
    schema: {
      plan_id: z.string().describe("Analysis plan identifier"),
    },
    handler: (args) => listScratchpad(args.plan_id as string),
  },
  {
    name: "update_step_status",
    category: "meta",
    searchHint: "update step status plan progress completed failed",
    description: "Update step status in plan. Auto-updates plan status on completion.",
    schema: {
      plan_id: z.string().describe("Analysis plan identifier"),
      step_id: z.string().describe("Step identifier (e.g. step_1)"),
      status: z.enum(["pending", "in_progress", "completed", "failed", "skipped"]).describe("New status for the step"),
      error: z.string().optional().describe("Error message if status is 'failed'"),
    },
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
    schema: {
      plan_id: z.string().describe("Analysis plan identifier"),
    },
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
    schema: {},
    handler: async () => listPlans(),
  },

  // --- Review diff ---
  {
    name: "review_diff",
    category: "diff",
    searchHint: "review diff static analysis git changes secrets breaking-changes complexity dead-code blast-radius",
    description: "Run 9 parallel static analysis checks on a git diff: secrets, breaking changes, coupling gaps, complexity, dead-code, blast-radius, bug-patterns, test-gaps, hotspots. Returns a scored verdict (pass/warn/fail) with tiered findings.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      since: z.string().optional().describe("Base git ref (default: HEAD~1)"),
      until: z.string().optional().describe("Target ref. Default: HEAD. Special: WORKING, STAGED"),
      checks: z.string().optional().describe("Comma-separated check names (default: all)"),
      exclude_patterns: z.string().optional().describe("Comma-separated globs to exclude"),
      token_budget: zNum().describe("Max tokens (default: 15000)"),
      max_files: zNum().describe("Warn above N files (default: 50)"),
      check_timeout_ms: zNum().describe("Per-check timeout ms (default: 8000)"),
    },
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
    schema: {},
    handler: async () => {
      const stats = await getUsageStats();
      return { report: formatUsageReport(stats) };
    },
  },

  // ── Session context tools ───────────────────────────────────────────────
  {
    name: "get_session_snapshot",
    category: "session",
    searchHint: "session context snapshot compaction summary explored symbols files queries",
    description: "Get a compact ~200 token snapshot of what was explored in this session. Designed to survive context compaction. Call proactively before long tasks.",
    schema: {
      repo: z.string().optional().describe("Filter to specific repo. Default: most recent repo."),
    },
    handler: async (args: { repo?: string }) => {
      return formatSnapshot(getSessionState(), args.repo);
    },
  },
  {
    name: "get_session_context",
    category: "session",
    searchHint: "session context full explored symbols files queries negative evidence",
    description: "Get full session context: explored symbols, files, queries, and negative evidence (searched but not found). Use get_session_snapshot for a compact version.",
    schema: {
      repo: z.string().optional().describe("Filter to specific repo"),
      include_stale: zBool().describe("Include stale negative evidence entries (default: false)"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      force: zBool().describe("Ignore cached results and re-analyze"),
    },
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
    schema: {},
    handler: async () => getExtractorVersions(),
  },
  // --- Composite tools ---
  {
    name: "audit_scan",
    category: "analysis",
    searchHint: "audit scan code quality CQ gates dead code clones complexity patterns",
    description: "Run 5 analysis tools in parallel, return findings keyed by CQ gate. One call replaces sequential find_dead_code + search_patterns + find_clones + analyze_complexity + analyze_hotspots. Returns: CQ8 (empty catch), CQ11 (complexity), CQ13 (dead code), CQ14 (clones), CQ17 (perf anti-patterns).",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      include_tests: zBool().describe("Include test files (default: false)"),
      checks: z.string().optional().describe("Comma-separated CQ gates to check (default: all). E.g. 'CQ8,CQ11,CQ14'"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    },
    handler: async (args) => {
      const result = await indexStatus(args.repo as string);
      if (!result.indexed) return "index_status: NOT INDEXED — run index_folder first";
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      patterns: z.string().optional().describe("Comma-separated pattern names to check (default: all). Options: unbounded-query, sync-in-handler, n-plus-one, unbounded-parallel, missing-pagination, expensive-recompute"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      include_tests: zBool().describe("Include test files (default: false)"),
      max_results: zNum().describe("Max findings to return (default: 50)"),
    },
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
    searchHint: "fan-in fan-out coupling dependencies imports hub afferent efferent instability",
    description: "Analyze import graph to find most-imported files (fan-in), most-dependent files (fan-out), and hub files (high both — instability risk). Returns coupling score 0-100.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      path: z.string().optional().describe("Focus on files in this directory"),
      top_n: zNum().describe("How many entries per list (default: 20)"),
    },
    handler: async (args) => {
      const opts: Parameters<typeof fanInFanOut>[1] = {};
      if (args.path != null) opts!.path = args.path as string;
      if (args.top_n != null) opts!.top_n = args.top_n as number;
      const result = await fanInFanOut(args.repo as string, opts);
      return formatFanInFanOut(result);
    },
  },
  {
    name: "co_change_analysis",
    category: "architecture",
    searchHint: "co-change temporal coupling git history Jaccard co-commit correlation cluster",
    description: "Analyze git history to find files that frequently change together (temporal coupling). Returns file pairs ranked by Jaccard similarity, plus clusters of always-co-changed files. Useful for detecting hidden dependencies.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      since_days: zNum().describe("Analyze last N days of history (default: 180)"),
      min_support: zNum().describe("Minimum co-commits to include a pair (default: 3)"),
      min_jaccard: zNum().describe("Minimum Jaccard similarity threshold (default: 0.3)"),
      path: z.string().optional().describe("Focus on files in this directory"),
      top_n: zNum().describe("Max pairs to return (default: 30)"),
    },
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
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      focus: z.string().optional().describe("Focus on this directory path"),
      output_format: z.enum(["text", "mermaid"]).optional().describe("Output format (default: text)"),
      token_budget: zNum().describe("Max tokens for output"),
    },
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
    schema: {
      code: z.string().describe("Prisma code snippet (e.g. prisma.user.findMany({...}))"),
      dialect: z.enum(["postgresql", "mysql", "sqlite"]).optional().describe("SQL dialect (default: postgresql)"),
    },
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
  // --- NestJS analysis tools ---
  {
    name: "nest_lifecycle_map",
    category: "nestjs",
    searchHint: "nestjs lifecycle hook onModuleInit onApplicationBootstrap shutdown",
    description: "Map NestJS lifecycle hooks across the codebase — onModuleInit, onModuleDestroy, etc.",
    schema: { repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)") },
    handler: async (args: { repo?: string }) => nestLifecycleMap(args.repo ?? ""),
    format: (r: NestLifecycleMapResult) => {
      if (r.hooks.length === 0) return "No lifecycle hooks found.";
      return r.hooks.map((h) => `${h.class_name}.${h.hook} (${h.file})${h.is_async ? " [async]" : ""}`).join("\n");
    },
  },
  {
    name: "nest_module_graph",
    category: "nestjs",
    searchHint: "nestjs module dependency graph circular import boundary",
    description: "Build NestJS module dependency graph with circular dependency detection and boundary analysis.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      max_modules: z.number().optional().describe("Max modules to process (default: 200)"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output format: json (default) or mermaid"),
    },
    handler: async (args: { repo?: string; max_modules?: number; output_format?: "json" | "mermaid" }) => nestModuleGraph(args.repo ?? "", args),
    format: (r: NestModuleGraphResult) => {
      const lines = [`Modules: ${r.modules.length}`, `Edges: ${r.edges.length}`, `Circular deps: ${r.circular_deps.length}`];
      if (r.truncated) lines.push("[truncated]");
      for (const m of r.modules) lines.push(`  ${m.name} (${m.file})${m.is_global ? " [global]" : ""} → imports: [${m.imports.join(", ")}]`);
      return lines.join("\n");
    },
  },
  {
    name: "nest_di_graph",
    category: "nestjs",
    searchHint: "nestjs dependency injection provider constructor inject graph cycle",
    description: "Build NestJS provider DI graph with constructor injection tracking and cycle detection.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      max_nodes: z.number().optional().describe("Max provider nodes (default: 200)"),
      focus: z.string().optional().describe("Path substring to filter files"),
    },
    handler: async (args: { repo?: string; max_nodes?: number; focus?: string }) => nestDIGraph(args.repo ?? "", args),
    format: (r: NestDIGraphResult) => {
      const lines = [`Providers: ${r.nodes.length}`, `Edges: ${r.edges.length}`, `Cycles: ${r.cycles.length}`];
      if (r.truncated) lines.push("[truncated]");
      for (const n of r.nodes) lines.push(`  ${n.name} (${n.file})${n.scope ? ` [${n.scope}]` : ""}`);
      for (const e of r.edges) lines.push(`  ${e.from} → ${e.to} (${e.via})`);
      return lines.join("\n");
    },
  },
  {
    name: "nest_guard_chain",
    category: "nestjs",
    searchHint: "nestjs guard interceptor pipe filter middleware chain route security",
    description: "Show guard/interceptor/pipe/filter execution chain per NestJS route (global → controller → method).",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      path: z.string().optional().describe("Filter to specific route path"),
      max_routes: z.number().optional().describe("Max routes (default: 300)"),
    },
    handler: async (args: { repo?: string; path?: string; max_routes?: number }) => nestGuardChain(args.repo ?? "", args),
    format: (r: NestGuardChainResult) => {
      if (r.routes.length === 0) return "No routes found.";
      const lines: string[] = [];
      for (const route of r.routes) {
        lines.push(`${route.method} ${route.route} (${route.controller})`);
        if (route.chain.length === 0) { lines.push("  (no guards/interceptors)"); continue; }
        for (const c of route.chain) lines.push(`  [${c.layer}] ${c.type}: ${c.name}`);
      }
      return lines.join("\n");
    },
  },
  {
    name: "nest_route_inventory",
    category: "nestjs",
    searchHint: "nestjs route endpoint api map inventory list all guards params",
    description: "Full NestJS route map with guards, params, and protected/unprotected stats.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      max_routes: z.number().optional().describe("Max routes (default: 500)"),
    },
    handler: async (args: { repo?: string; max_routes?: number }) => nestRouteInventory(args.repo ?? "", args),
    format: (r: NestRouteInventoryResult) => {
      const lines = [`Routes: ${r.stats.total_routes} (${r.stats.protected} protected, ${r.stats.unprotected} unprotected)`];
      for (const route of r.routes) {
        const guards = route.guards.length > 0 ? ` [${route.guards.join(", ")}]` : "";
        lines.push(`  ${route.method} ${route.path} → ${route.controller}.${route.handler}${guards}`);
      }
      return lines.join("\n");
    },
  },
  {
    name: "nest_audit",
    category: "nestjs",
    searchHint: "nestjs audit analysis comprehensive module di guard route lifecycle pattern",
    description: "One-call NestJS architecture audit: modules, DI, guards, routes, lifecycle, anti-patterns.",
    schema: {
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      checks: z.string().optional().describe("Comma-separated checks (default: all). Options: modules,routes,di,guards,lifecycle,patterns"),
    },
    handler: async (args: { repo?: string; checks?: string }) => {
      const checks = args.checks?.split(",").map((s) => s.trim()).filter(Boolean);
      return nestAudit(args.repo ?? "", checks ? { checks } : undefined);
    },
    format: (r: NestAuditResult) => {
      if (!r.framework_detected) return "Not a NestJS repository.";
      const lines = [
        `NestJS Audit Summary`,
        `  Routes: ${r.summary.total_routes}`,
        `  Cycles: ${r.summary.cycles}`,
        `  Anti-pattern hits: ${r.summary.anti_pattern_hits}`,
        `  Failed checks: ${r.summary.failed_checks}`,
      ];
      if (r.summary.truncated_checks.length > 0) lines.push(`  Truncated: ${r.summary.truncated_checks.join(", ")}`);
      if (r.errors && r.errors.length > 0) {
        lines.push("  Errors:");
        for (const e of r.errors) lines.push(`    ${e.check}: ${e.reason}`);
      }
      return lines.join("\n");
    },
  },
];

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
  return TOOL_DEFINITIONS.map((t) => ({
    name: t.name,
    category: t.category,
    description: t.description,
    searchHint: t.searchHint,
  }));
}

/**
 * Extract structured param info from a ToolDefinition's Zod schema.
 */
function extractToolParams(def: ToolDefinition): Array<{ name: string; required: boolean; description: string }> {
  return Object.entries(def.schema).map(([key, val]) => {
    const zodVal = val as z.ZodTypeAny;
    const isOptional = zodVal.isOptional?.() ?? false;
    return {
      name: key,
      required: !isOptional,
      description: zodVal.description ?? "",
    };
  });
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
    const def = TOOL_DEFINITIONS.find((t) => t.name === name);
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
  const categories = [...new Set(summaries.map((s) => s.category).filter(Boolean))] as string[];

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
      const fullDef = TOOL_DEFINITIONS.find((t) => t.name === s.tool.name);
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

export function registerTools(server: McpServer, options?: { deferNonCore?: boolean }): void {
  const deferNonCore = options?.deferNonCore ?? false;

  // Clear handles from any previous registration (e.g. tests calling registerTools multiple times)
  toolHandles.clear();

  // Register ALL tools with full schema; store returned handles
  for (const tool of TOOL_DEFINITIONS) {
    const handle = server.tool(
      tool.name,
      tool.description,
      tool.schema,
      async (args) => wrapTool(tool.name, args as Record<string, unknown>, () => tool.handler(args as Record<string, unknown>))(),
    );
    toolHandles.set(tool.name, handle);
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
          const h = toolHandles.get(t.name);
          if (h) h.enable();
        }
      }
      return result;
    })(),
  );
  toolHandles.set("describe_tools", describeHandle);

  // In deferred mode, disable non-core tools (they remain registered but hidden from ListTools).
  // LLM discovers them via discover_tools, then reveals with describe_tools(reveal: true).
  if (deferNonCore) {
    for (const [name, handle] of toolHandles) {
      if (!CORE_TOOL_NAMES.has(name) && name !== "discover_tools" && name !== "describe_tools") {
        handle.disable();
      }
    }
  }

  // Register progressive shorteners for analysis tools with large outputs
  registerShortener("analyze_complexity", { compact: formatComplexityCompact, counts: formatComplexityCounts });
  registerShortener("find_clones", { compact: formatClonesCompact, counts: formatClonesCounts });
  registerShortener("analyze_hotspots", { compact: formatHotspotsCompact, counts: formatHotspotsCounts });
  registerShortener("trace_route", { compact: formatTraceRouteCompact, counts: formatTraceRouteCounts });
  registerShortener("get_session_context", {
    compact: (text: string) => {
      try {
        const data = JSON.parse(text);
        return `session:${data.session_id?.slice(0, 8)} calls:${data.call_count} files:${data.explored_files?.count} symbols:${data.explored_symbols?.count} queries:${data.queries?.count} neg:${data.negative_evidence?.count}`;
      } catch { return text.slice(0, 500); }
    },
    counts: (text: string) => {
      try {
        const data = JSON.parse(text);
        return `files:${data.explored_files?.count} symbols:${data.explored_symbols?.count} queries:${data.queries?.count} neg:${data.negative_evidence?.count}`;
      } catch { return "parse error"; }
    },
  });
}
