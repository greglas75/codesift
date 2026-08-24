import { z } from "zod";
import { TOOL_DEFINITIONS } from "../register-tool-groups/index.js";
import type { ToolCategory, ToolDefinition } from "../register-tool-groups/shared.js";
import { getSessionState } from "../storage/session-state.js";
import { hasRequestContext } from "../server-helpers/request-context.js";

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
/**
 * The visible tool surface, overridable for measurement.
 *
 * Every name here costs prompt tokens in EVERY turn of EVERY session, whether or not the model
 * calls the tool: on a deferring host the names and descriptions sit in the prompt while only the
 * parameter schemas load on demand. Measured on this build: 60 names + descriptions = 2802 tokens,
 * against 8527 tokens of parameter schemas that stay out until something asks for them.
 *
 * That is worth a knob because the surface is priced per session and used per task. In a 35-session
 * SWE-bench-style run, 20 sessions called exactly ONE codesift tool, 7 called two, and 1 called
 * four — `search_text` alone covered 27 of 35. Every one of those paid for all 60.
 *
 * Unset (the default) means CORE_TOOL_NAMES, byte-identical to before — commit 3e1ec6c showed that
 * changing the default surface moves adoption sharply, so the default is not something to tune from
 * a benchmark.
 */
export function resolveVisibleToolNames(): ReadonlySet<string> {
  const raw = process.env["CODESIFT_VISIBLE_TOOLS"];
  if (!raw) return CORE_TOOL_NAMES;
  const names = raw
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  // An env var that is set but parses to nothing is a typo, not a request for a zero-tool server.
  return names.length > 0 ? new Set(names) : CORE_TOOL_NAMES;
}

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

/**
 * Hidden tools that must be visible from the first ListTools on hosts whose
 * callable tool surface is frozen at session start.
 *
 * `describe_tools(reveal=true)` enables a tool server-side and emits
 * `notifications/tools/list_changed`. Claude Code honours that and the tool
 * becomes callable mid-session. The Codex MCP bridge does not: the tool shows up
 * in discovery, the reveal call succeeds, and the tool still cannot be called —
 * so every skill that depends on one of these degrades. Measured on 2026-07-30
 * across 13 Codex sessions: `describe_tools(reveal=true)` was called 35 times
 * and not one of the revealed tools was ever invoked; the runs fell back to
 * 318 `rg` + 75 `find` shell calls and reported BLOCKED_INFRA / INCOMPLETE.
 *
 * These names are NOT added to CORE_TOOL_NAMES. Commit 3e1ec6c ("revert
 * agent-visible changes that broke CodeSift adoption (>90% drop)") found that
 * growing the default ListTools depressed adoption on Claude Code, so the core
 * list stays byte-identical there; this set is applied only to frozen-list hosts.
 */
/**
 * True once this session is known to run against a host that will not re-read
 * `tools/list`. On such hosts the whole language-appropriate tool surface is
 * enabled up front, so nothing is "hidden pending reveal" any more.
 */
let frozenToolListHost = false;

export function setFrozenToolListHost(value: boolean): void {
  frozenToolListHost = value;
}

export function isFrozenToolListHost(): boolean {
  return frozenToolListHost;
}

/**
 * Whether a tool still needs a reveal before the agent can call it.
 *
 * On a frozen-list host the answer is always no: everything callable was
 * enabled during the handshake. Telling an agent to reveal there sends it into
 * the exact dead end this fallback exists to remove — the reveal succeeds and
 * the tool stays uncallable.
 */
export function isToolHiddenForHost(name: string): boolean {
  if (frozenToolListHost) return false;
  return !CORE_TOOL_NAMES.has(name);
}

/**
 * The language-agnostic analysis tools that skills call directly and that MUST
 * be reachable on a frozen-list host. Kept as an explicit list (rather than
 * relying on "everything is enabled") so a regression that narrows the
 * front-load has something concrete to fail against.
 */
export const FROZEN_LIST_FALLBACK_TOOL_NAMES = [
  "find_dead_code",
  "find_clones",
  "find_circular_deps",
  "find_unused_imports",
  "rename_symbol",
  "review_diff",
  "changed_symbols",
  "diff_outline",
  "scan_secrets",
  "classify_roles",
  "check_boundaries",
  "resolve_constant_value",
] as const;

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
/**
 * Schemas already handed to a given session.
 *
 * `describeToolsCache` above caches the COMPUTATION, so a repeat costs no CPU and exactly as many
 * tokens as the first fetch. Measured over August: of 8,908 schema names requested, 2,254 (25%)
 * were re-fetched inside the SAME session — ~420K tokens re-delivering text the agent already had.
 * The repeat list is mostly core tools (scan_secrets 101x, search_patterns 97x, audit_scan 94x).
 *
 * Keyed by session, not process: the HTTP daemon serves many sessions from one process, and a
 * process-wide set would tell session B that session A's schema had already been delivered.
 */
const deliveredSchemas = new Map<string, Set<string>>();
const MAX_TRACKED_SESSIONS = 200;

function deliveredFor(sessionId: string): Set<string> {
  let set = deliveredSchemas.get(sessionId);
  if (!set) {
    // Bounded so a long-lived daemon cannot accumulate a set per session forever. Insertion order
    // is oldest-first, so the first key is the least recently created.
    if (deliveredSchemas.size >= MAX_TRACKED_SESSIONS) {
      const oldest = deliveredSchemas.keys().next().value;
      if (oldest !== undefined) deliveredSchemas.delete(oldest);
    }
    set = new Set();
    deliveredSchemas.set(sessionId, set);
  }
  return set;
}

/** Test seam — the dedupe is session state, and tests need it to start empty. */
export function resetDeliveredSchemasForTesting(): void {
  deliveredSchemas.clear();
}

export function describeTools(names: string[], opts?: { force?: boolean }): DescribeToolsResult {
  const capped = names.slice(0, 100); // CQ6 cap
  const force = opts?.force === true;

  // stdio only, deliberately. `SESSION_ID` is a per-PROCESS constant, so under the shared HTTP
  // daemon — one process serving every client on the machine — every session shares it, and the
  // dedupe would tell session B that session A's schema had already been delivered. That is a
  // pointer to text the agent never received. On stdio the client spawns one server per window,
  // so process and session coincide and the claim is true.
  //
  // Recovering the saving for the daemon needs a real per-session key on RequestContext; `cwd` is
  // not one, because two windows open on the same repo share it.
  const perSession = !hasRequestContext();
  const delivered = perSession ? deliveredFor(getSessionState().sessionId) : null;

  const tools: DescribeToolsResult["tools"] = [];
  const not_found: string[] = [];

  for (const name of capped) {
    const def = TOOL_DEFINITION_MAP.get(name);
    if (!def) {
      not_found.push(name);
      continue;
    }
    // A repeat returns a pointer, not the schema — but says so, and says how to override. Context
    // can be compacted away between the two calls, so silently withholding would leave the agent
    // with no schema and no way to ask for one.
    if (!force && delivered?.has(def.name)) {
      tools.push({
        name: def.name,
        category: def.category ?? "uncategorized",
        description: "[schema already returned earlier in this session — pass force=true to repeat it]",
        is_core: CORE_TOOL_NAMES.has(def.name),
        params: [],
      });
      continue;
    }
    delivered?.add(def.name);
    const cacheKey = `\u0001${def.name}`;
    let params = describeToolsCache.get(cacheKey)?.tools?.[0]?.params;
    if (!params) {
      params = extractToolParams(def);
      describeToolsCache.set(cacheKey, { tools: [{ name: def.name, category: def.category ?? "uncategorized", description: def.description, is_core: CORE_TOOL_NAMES.has(def.name), params }], not_found: [] });
    }
    tools.push({
      name: def.name,
      category: def.category ?? "uncategorized",
      description: def.description,
      is_core: CORE_TOOL_NAMES.has(def.name),
      params,
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
