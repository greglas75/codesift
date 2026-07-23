import { z } from "zod";
import { TOOL_DEFINITIONS } from "../register-tool-groups/index.js";
import type { ToolCategory, ToolDefinition } from "../register-tool-groups/shared.js";

/** Usage-critical tools that must never require discover_tools/describe_tools. */
export const ALWAYS_VISIBLE_TOOL_NAMES = [
  "search_text",
  "get_file_outline",
  "plan_turn",
  "index_file",
  "search_symbols",
  "get_file_tree",
  "search_all_conversations",
  "codebase_retrieval",
] as const;

/** Tools visible in ListTools — core (high usage) + direct-use (agents call without discovery) */
export const CORE_TOOL_NAMES = new Set([
  ...ALWAYS_VISIBLE_TOOL_NAMES,
  // --- Additional high-usage/direct-use tools ---
  "list_repos",
  "get_symbol",
  "search_patterns",
  "index_conversations",
  // Semantic search was excluded because telemetry showed 0 calls — but that
  // number was an artifact of THIS list, not of the tool's value: it was hidden,
  // so no agent could call it, so it stayed at 0 and stayed hidden. A
  // self-fulfilling prophecy. Worse, search_text's own description tells agents
  // "For conceptual queries use semantic_search" — pointing at a tool they could
  // not see. Made visible so intent-based queries have a reachable answer
  // instead of degrading to keyword search.
  "semantic_search",
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
  "usage_hotspots",          // PopeInsights: find expensive CodeSift patterns
  "usage_trace_session",     // PopeInsights: inspect one CodeSift session
  "retros_list",             // PopeInsights: inspect Zuvo retros
  "retros_analyze",          // PopeInsights: aggregate Zuvo friction
  "memory_candidate_extract",// PopeInsights: extract memory candidates
  "optimization_candidates", // PopeInsights: rank tool/skill improvements
  "pope_insights_push_candidates",
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

export const TOOL_DEFINITION_MAP = new Map<string, ToolDefinition>(
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

// Cache for describeTools results. Schemas are deterministic per name set and
// never change within a process — telemetry showed 263/559 calls were duplicates
// within a session. Key = sorted-joined names, value = computed result. No TTL.
const describeToolsCache = new Map<string, DescribeToolsResult>();

/** Reset the describeTools cache. Test-only — not exported via index. */
export function resetDescribeToolsCacheForTesting(): void {
  describeToolsCache.clear();
}

/**
 * Return full param details for a specific list of tool names.
 * Unknown names are collected in not_found.
 */
export function describeTools(names: string[]): DescribeToolsResult {
  const capped = names.slice(0, 100); // CQ6 cap
  const cacheKey = [...capped].sort().join("\u0000");
  const cached = describeToolsCache.get(cacheKey);
  if (cached) return cached;

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

  const result = { tools, not_found };
  describeToolsCache.set(cacheKey, result);
  return result;
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
