import { trackToolCall, addSavings, extractResultChunks } from "./storage/usage-tracker.js";
import { recordToolCall as recordSessionCall, recordCacheHit, getCallCount, getSessionState, resetSession, scheduleSidecarFlush } from "./storage/session-state.js";
import { writeFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, sep } from "node:path";
import { tmpdir, homedir } from "node:os";

// ---------------------------------------------------------------------------
// Auto-resolve repo from CWD — eliminates mandatory list_repos on session start
// ---------------------------------------------------------------------------

/** Tools that accept a `repo` param and should auto-resolve from CWD */
const TOOLS_WITHOUT_REPO = new Set(["list_repos", "index_folder", "index_repo", "index_conversations", "discover_tools", "describe_tools", "search_conversations", "search_all_conversations", "get_session_snapshot", "get_session_context", "usage_stats", "usage_hotspots", "usage_trace_session", "retros_list", "retros_analyze", "memory_candidate_extract", "optimization_candidates", "pope_insights_push_candidates", "test_tool"]);

const REGISTRY_PATH = join(homedir(), ".codesift", "registry.json");
const CONVERSATIONS_PREFIX = join(homedir(), ".claude", "projects") + sep;

interface RegistryRepoMeta {
  name: string;
  root: string;
  symbol_count: number;
  file_count: number;
}

let registryCache: { mtimeMs: number; entries: RegistryRepoMeta[] } | null = null;

/** Read registry synchronously, cached by mtime to avoid disk hits in the hot path. */
export function loadRegistrySync(registryPath: string = REGISTRY_PATH): RegistryRepoMeta[] {
  try {
    const st = statSync(registryPath);
    if (registryCache && registryCache.mtimeMs === st.mtimeMs) {
      return registryCache.entries;
    }
    const parsed = JSON.parse(readFileSync(registryPath, "utf-8")) as { repos?: Record<string, RegistryRepoMeta> };
    const entries = Object.values(parsed.repos ?? {});
    registryCache = { mtimeMs: st.mtimeMs, entries };
    return entries;
  } catch {
    return [];
  }
}

/** True iff `descendant` is `ancestor` or sits underneath it on a path-segment boundary. */
export function isAncestorOrEqual(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const a = ancestor.endsWith(sep) ? ancestor : ancestor + sep;
  return descendant.startsWith(a);
}

/**
 * Resolve the repo name for a CWD by consulting the registry.
 *
 * Strategy:
 *  1. Drop chat-history indexes (`~/.claude/projects/...`) — they shadow real
 *     repos when the AI session's CWD matches them as a sibling/ancestor.
 *  2. Drop empty entries (symbol_count=0) — they're stub registrations from
 *     `index_folder` calls that found nothing or got auto-created on cd.
 *  3. From remaining repos whose `root` is an ancestor of `cwd`, pick the
 *     longest match. This handles monorepo subdirs and worktrees correctly:
 *     cwd=/repo/apps/api with root=/repo registered → resolves to /repo's name.
 *  4. If nothing matches, fall back to `local/<basename(cwd)>` so the tool
 *     surfaces a clear NOT INDEXED error instead of silently using a stale value.
 */
export function resolveRepoFromCwd(cwd: string, registryPath: string = REGISTRY_PATH): string {
  const candidates = loadRegistrySync(registryPath).filter(
    (r) =>
      typeof r.root === "string" &&
      !r.root.startsWith(CONVERSATIONS_PREFIX) &&
      r.symbol_count > 0 &&
      isAncestorOrEqual(r.root, cwd),
  );
  if (candidates.length === 0) {
    return `local/${basename(cwd)}`;
  }
  candidates.sort((a, b) => b.root.length - a.root.length);
  return candidates[0]!.name;
}

function resolveRepo(toolName: string, args: Record<string, unknown>): void {
  if (TOOLS_WITHOUT_REPO.has(toolName) || args["repo"]) return;
  args["repo"] = resolveRepoFromCwd(process.cwd());
}

/** Test-only: drop the registry cache. */
export function _resetRegistryCacheForTests(): void {
  registryCache = null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HIGH_CARDINALITY_THRESHOLD = 50;
/** ~3.5 chars/token for compact JSON + text formatters. Matches retrieval-constants.ts (3). */
const CHARS_PER_TOKEN = 3.5;
const MAX_RESPONSE_TOKENS = 30_000; // Hard cap — truncate any response above this
const PERSIST_THRESHOLD_CHARS = 200_000; // ~50k tokens — persist full output to disk
const COMPACT_THRESHOLD = 52_500;   // ~15K tokens at 3.5 chars/tok
const COUNTS_THRESHOLD = 87_500;    // ~25K tokens

/** Estimated token multiplier vs manual grep/Read approach (from benchmark data) */
const SAVINGS_MULTIPLIER: Record<string, number> = {
  search_text: 1.5,
  search_symbols: 1.0,
  get_file_outline: 3.0,
  get_file_tree: 1.25,
  find_references: 1.5,
  codebase_retrieval: 3.0,
  assemble_context: 5.0,
  trace_call_chain: 4.0,
  impact_analysis: 3.0,
  detect_communities: 2.0,
  trace_route: 2.0,
  get_context_bundle: 3.0,
  scan_secrets: 1.2,
  frequency_analysis: 2.0,
};

const OPUS_COST_PER_TOKEN = 30 / 1_000_000; // $30/1M input tokens

const BATCHABLE_TOOLS = new Set(["search_text", "search_symbols", "find_references", "get_symbol"]);
const SEQUENTIAL_HINT_THRESHOLD = 3;
// TTLs: response cache is invalidated automatically on index_file/index_folder
// (see INDEX_MUTATING_TOOLS), so it's safe to use longer windows than agents
// would otherwise tolerate. Telemetry showed 853 consecutive identical calls
// within 60s in same session — the previous 30s default missed half of them.
const CACHE_TTL_MS = 60_000; // 60s default for search results
const CACHE_TTL_STATIC_MS = 300_000; // 5min for static data (file tree, outline)
const CACHE_TTL_SYMBOL_MS = 120_000; // 2min for symbol reads (stable unless re-indexed)
const CACHE_MAX_SIZE = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolResponse {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Progressive response shortening — registry + cascade
// ---------------------------------------------------------------------------

interface ShorteningEntry {
  compact?: (data: unknown) => string;
  counts?: (data: unknown) => string;
}

const SHORTENING_REGISTRY = new Map<string, ShorteningEntry>();

export function registerShortener(toolName: string, entry: ShorteningEntry): void {
  SHORTENING_REGISTRY.set(toolName, entry);
}

export function resetShorteningRegistry(): void {
  SHORTENING_REGISTRY.clear();
}

// ---------------------------------------------------------------------------
// In-memory call tracking + response cache + in-flight dedup
// ---------------------------------------------------------------------------

let lastToolName = "";
let consecutiveCount = 0;
let listReposCallCount = 0;

/** Session-level tracking for cross-tool hints */
const fileTreePaths = new Set<string>();
let sessionSearchSymbolsCalled = false;
let sessionGetSymbolCount = 0;
const sessionSearchTextPatterns = new Set<string>(); // H12: track distinct file_patterns in search_text

/** Cache completed responses */
const responseCache = new Map<string, { text: string; ts: number }>();

/** In-flight requests — coalesce parallel identical calls */
const inflight = new Map<string, Promise<ToolResponse>>();

function getCacheKey(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}\0${JSON.stringify(args, Object.keys(args).sort())}`;
}

const STATIC_TOOLS = new Set(["list_repos", "get_repo_outline", "get_file_tree", "get_file_outline", "get_knowledge_map", "detect_communities"]);

/** Tools whose data changes only when symbols change — use medium TTL */
const SYMBOL_TOOLS = new Set(["get_symbol", "get_symbols", "get_context_bundle", "find_references", "find_dead_code", "find_circular_deps", "find_unused_imports", "analyze_complexity"]);

/** Tools whose cache NEVER expires within a session (repo list doesn't change mid-session) */
const SESSION_PERMANENT_TOOLS = new Set(["list_repos"]);

function getCached(key: string): string | null {
  const entry = responseCache.get(key);
  if (!entry) return null;
  const toolName = key.split("\0")[0] ?? "";

  // Session-permanent tools never expire (repo list doesn't change mid-session)
  if (SESSION_PERMANENT_TOOLS.has(toolName)) return entry.text;

  const ttl = STATIC_TOOLS.has(toolName) ? CACHE_TTL_STATIC_MS
    : SYMBOL_TOOLS.has(toolName) ? CACHE_TTL_SYMBOL_MS
    : CACHE_TTL_MS;
  if (Date.now() - entry.ts > ttl) {
    responseCache.delete(key);
    return null;
  }
  return entry.text;
}

function setCache(key: string, text: string): void {
  if (responseCache.size >= CACHE_MAX_SIZE) {
    const oldest = responseCache.keys().next().value;
    if (oldest !== undefined) responseCache.delete(oldest);
  }
  responseCache.set(key, { text, ts: Date.now() });
}

/**
 * Tool calls that mutate the index — must invalidate the response cache so
 * the next search/symbol read sees fresh data (otherwise the 30s-5min TTL
 * serves stale results for up to several minutes after an edit).
 */
const INDEX_MUTATING_TOOLS = new Set([
  "index_file",
  "index_folder",
  "index_repo",
  "invalidate_cache",
]);

/** Drop every cached response. Called after an indexing tool runs. */
function invalidateResponseCache(): void {
  responseCache.clear();
}

/** Track sequential calls + session-level state. Exported for testing. */
export function trackSequentialCalls(toolName: string): void {
  if (toolName === lastToolName && BATCHABLE_TOOLS.has(toolName)) {
    consecutiveCount++;
  } else {
    consecutiveCount = 1;
  }
  lastToolName = toolName;

  if (toolName === "list_repos") {
    listReposCallCount++;
  }
  if (toolName === "search_symbols") {
    sessionSearchSymbolsCalled = true;
  }
  if (toolName === "get_symbol") {
    sessionGetSymbolCount++;
  }
  // H12 tracking is in buildResponseHint (needs args, which trackSequentialCalls doesn't receive)
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

export function errorResult(message: string): ToolResponse {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ error: message }) },
    ],
    isError: true,
  };
}

const QUESTION_PATTERN = /^(how|where|why|what|when|which)\b/i;
const ROUTE_PATTERN = /\/api\/|endpoint|handler|router\.|middleware|app\.(get|post|put|delete)/i;
const SECRET_PATTERN = /api[._-]?key|AWS_|OPENAI_|SECRET_KEY|password|credential/i;
/**
 * H18: literal substrings that show up in the regex string of Jest/Vitest/RTL
 * test-quality audit patterns. Matches against the raw `query` text the agent
 * passed (treated as a string, not as a parsed regex) — so escapes like `\b`
 * appear as `\\b` here. Detection triggers a "batch via codebase_retrieval"
 * hint to collapse 100+ per-pattern calls into one composite call.
 */
const TEST_ANTIPATTERN_SUBSTRINGS = [
  // Distinctive Jest/Vitest/RTL matcher names — unlikely to appear outside test
  // audit context, so plain substring match is safe.
  "toBeTruthy", "toBeFalsy", "toBeDefined", "toBeGreaterThan", "toBeLessThan",
  "toBeNull", "toBeUndefined",
  "toHaveBeenCalled", "toHaveLength", "toHaveProperty",
  "toMatchSnapshot", "toMatchInlineSnapshot",
  // Common Jest/Vitest regex shapes — note backslash-escaped parens are LITERAL
  // chars in the query string the agent passes (regex=true mode).
  "toBe\\(true", "toBe\\(false", "expect\\(true", "expect\\(false",
  "\\.skip\\(", "\\.only\\(",
  // Use only the regex-escaped form for short tokens like "as any" — the bare
  // 6-char string was false-positive prone (e.g. "has any value", "cargo has anyone").
  "\\bas\\s+any",
  "TODO|FIXME", "FIXME|TODO",
];
function isTestAntipatternQuery(query: string): boolean {
  for (const sig of TEST_ANTIPATTERN_SUBSTRINGS) {
    if (query.includes(sig)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Hint codes — compact symbols decoded via CLAUDE.md legend.
// Each hint costs ~3-5 tokens instead of 20-50 tokens in verbose form.
// Legend lives in CLAUDE.md so LLM sees it once per session.
// ---------------------------------------------------------------------------
//
// H1(n)  = >50 matches, add group_by_file=true
// H2(n,t)= consecutive identical tool calls, batch them
// H3(n)  = list_repos called multiple times, result is static
// H4     = include_source without file_pattern, add file_pattern
// H5(p)  = duplicate get_file_tree path, cache result
// H6(n)  = many search_symbols results without detail_level, use compact
// H7     = get_symbol after search_symbols, use get_context_bundle instead
// H8(n)  = 3+ get_symbol calls, use assemble_context(level='L1')
// H9     = question-word text query, use semantic search
// ---------------------------------------------------------------------------

/**
 * Build optimization hints based on response data + call patterns.
 * Returns compact hint codes (decoded in CLAUDE.md).
 */
export function buildResponseHint(toolName: string, args: Record<string, unknown>, data: unknown): string | null {
  const hints: string[] = [];

  if (toolName === "search_text" && Array.isArray(data) && data.length > HIGH_CARDINALITY_THRESHOLD) {
    if (!args["group_by_file"] && !args["auto_group"]) {
      hints.push(`⚡H1(${data.length})`);
    }
  }

  if (consecutiveCount >= SEQUENTIAL_HINT_THRESHOLD && BATCHABLE_TOOLS.has(toolName)) {
    const batchTool = toolName === "get_symbol" ? "get_symbols" : "codebase_retrieval";
    hints.push(`⚡H2(${consecutiveCount},${batchTool})`);
  }

  if (toolName === "list_repos" && listReposCallCount > 1) {
    hints.push(`⚡H3(${listReposCallCount})`);
  }

  if (toolName === "search_symbols" && args["include_source"] && !args["file_pattern"]) {
    hints.push(`⚡H4`);
  }

  if (toolName === "get_file_tree") {
    const repo = typeof args["repo"] === "string" ? args["repo"] : "";
    const pathPrefix = typeof args["path_prefix"] === "string" ? args["path_prefix"] : "";
    const pathKey = `${repo}\0${pathPrefix}`;
    if (fileTreePaths.has(pathKey)) {
      hints.push(`⚡H5(${pathPrefix || "/"})`);
    }
    fileTreePaths.add(pathKey);
  }

  if (toolName === "search_symbols" && !args["detail_level"]) {
    const resultCount = Array.isArray(data) ? data.length : 0;
    if (resultCount > 5) {
      hints.push(`⚡H6(${resultCount})`);
    }
  }

  // H15: search_symbols("<bare keyword>") returned 0 results → query is likely a
  // substring/concept, not a symbol name. Telemetry showed 98× zero-result calls
  // for queries like "auth", "user", "render" — agents kept retrying instead of
  // switching tool. Detect lowercase ≤8-char queries with no uppercase/underscore
  // (true identifiers conventionally include caps or underscores).
  if (toolName === "search_symbols" && Array.isArray(data) && data.length === 0) {
    const q = typeof args["query"] === "string" ? args["query"] : "";
    if (/^[a-z]{2,8}$/.test(q)) {
      hints.push(`⚡H15 "${q}" returned 0 symbols — looks like a keyword, not a symbol name. Try search_text("${q}") for substring matches.`);
    }
  }

  // H11: search_text returned 0 matches → guide next step. Most common causes:
  // file_pattern too narrow, identifier not present as text (only as binding),
  // or concept question that needs semantic search.
  if (toolName === "search_text" && Array.isArray(data) && data.length === 0) {
    const q = typeof args["query"] === "string" ? args["query"] : "";
    const hasFilePattern = Boolean(args["file_pattern"]);
    const isRegex = Boolean(args["regex"]);
    if (q.length > 0) {
      const tips: string[] = [];
      if (hasFilePattern) tips.push(`drop file_pattern`);
      if (!isRegex && /^[A-Za-z_][A-Za-z0-9_]{2,}$/.test(q)) {
        tips.push(`use search_symbols("${q}") for the declaration`);
      }
      if (QUESTION_PATTERN.test(q)) {
        tips.push(`use semantic_search for concept questions`);
      } else if (tips.length === 0) {
        tips.push(`try a broader query or codebase_retrieval(type="semantic")`);
      }
      hints.push(`⚡H11 0 matches for "${q.slice(0, 60)}" — ${tips.join(", or ")}.`);
    }
  }

  // H16: get_file_tree returned an empty list while name_pattern was set →
  // pattern matched nothing. Most common in telemetry: agents trying patterns
  // for extensions the repo doesn't have (e.g. "*.kt" in a JS-only repo).
  if (toolName === "get_file_tree" && typeof args["name_pattern"] === "string" && (args["name_pattern"] as string).length > 0) {
    const isEmpty = Array.isArray(data)
      ? data.length === 0
      : (typeof data === "object" && data !== null && Array.isArray((data as Record<string, unknown>)["entries"])
          ? ((data as Record<string, unknown>)["entries"] as unknown[]).length === 0
          : false);
    if (isEmpty) {
      hints.push(`⚡H16 0 files match name_pattern="${args["name_pattern"]}". Try omitting name_pattern, or use get_repo_outline to see file structure.`);
    }
  }

  // H17: find_references returned 0 → symbol_name probably misspelled or not a
  // registered symbol. Telemetry showed 94% empty rate for find_references.
  // Agents should verify the symbol exists via search_symbols first.
  if (toolName === "find_references" && Array.isArray(data) && data.length === 0) {
    const name = typeof args["symbol_name"] === "string" ? args["symbol_name"] : "";
    if (name.length > 0) {
      hints.push(`⚡H17 0 references to "${name}" — verify with search_symbols(query="${name}") first; symbol may be misspelled, external, or only referenced in strings/comments (try search_text).`);
    }
  }

  // H18 (Wariant B): search_text with regex matching a known test-antipattern
  // signature → agents are running per-pattern audits one regex at a time.
  // Suggest batching via codebase_retrieval. Catches the bursts of 100+ calls
  // observed in zuvo:test-audit / zuvo:fix-tests sessions.
  if (toolName === "search_text" && args["regex"] && typeof args["query"] === "string") {
    if (isTestAntipatternQuery(args["query"] as string)) {
      hints.push(`⚡H18 query looks like a test-quality pattern — batch multiple via codebase_retrieval(queries=[{type:"text",regex:true,query:"..."}, ...]) to scan once instead of N times.`);
    }
  }

  if (toolName === "get_symbol" && sessionSearchSymbolsCalled) {
    hints.push(`⚡H7`);
  }

  if (toolName === "get_symbol" && sessionGetSymbolCount >= 3) {
    hints.push(`⚡H8(${sessionGetSymbolCount})`);
  }

  if (toolName === "search_text" && typeof args["query"] === "string" && QUESTION_PATTERN.test(args["query"])) {
    hints.push(`⚡H9`);
    // Auto-reveal semantic_search so agents can use it immediately
    import("./register-tools.js").then(m => m.enableToolByName("semantic_search")).catch(() => {});
  }

  // H10: Session snapshot reminder after 50 calls (read-only check; flag set by wrapTool)
  if (getCallCount() >= 50 && !getSessionState().h10Emitted) {
    hints.push(`⚡H10 50+ tool calls this session → call get_session_snapshot to preserve context`);
  }

  // H13: Route-shaped query → suggest trace_route
  if (toolName === "search_text" && typeof args["query"] === "string" && ROUTE_PATTERN.test(args["query"])) {
    hints.push(`⚡H13 route query → try trace_route(path=) for full endpoint tracing`);
  }

  // H14: Secret/credential pattern → suggest scan_secrets
  if (toolName === "search_text" && typeof args["query"] === "string" && SECRET_PATTERN.test(args["query"])) {
    hints.push(`⚡H14 secret pattern → try scan_secrets(min_confidence="high")`);
  }

  // H12: Repeated search_text with different file_patterns → suggest codebase_retrieval batch
  if (toolName === "search_text") {
    const fp = (args["file_pattern"] as string | undefined) ?? "__none__";
    sessionSearchTextPatterns.add(fp);
    if (sessionSearchTextPatterns.size >= SEQUENTIAL_HINT_THRESHOLD) {
      hints.push(`⚡H12(${sessionSearchTextPatterns.size}) ${sessionSearchTextPatterns.size}× search_text with different file_patterns → batch into codebase_retrieval(queries=[...])`);
    }
  }

  return hints.length > 0 ? hints.join(" ") : null;
}

function estimateSavings(toolName: string, resultTokens: number): { tokens: number; cost: number } | null {
  const mult = SAVINGS_MULTIPLIER[toolName];
  if (!mult || mult <= 1.0) return null;
  const saved = Math.round(resultTokens * (mult - 1));
  if (saved < 50) return null; // Don't show trivial savings
  return { tokens: saved, cost: saved * OPUS_COST_PER_TOKEN };
}

/** Persist oversized output to a temp file, return the file path. */
function persistLargeOutput(text: string, toolName: string): string {
  const dir = join(tmpdir(), "codesift-output");
  mkdirSync(dir, { recursive: true });
  const ts = Date.now();
  const filePath = join(dir, `${toolName}-${ts}.json`);
  writeFileSync(filePath, text, "utf-8");
  return filePath;
}

function formatResponse(text: string, toolName: string, args: Record<string, unknown>, data: unknown): ToolResponse {
  // Large output management: persist to disk when output is very large
  let persistedPath: string | undefined;
  if (text.length > PERSIST_THRESHOLD_CHARS) {
    persistedPath = persistLargeOutput(text, toolName);
  }

  // Progressive cascade: try registered shorteners before hard truncation
  const skipCascade =
    toolName === "codebase_retrieval" ||
    typeof args?.detail_level === "string" ||
    typeof args?.token_budget === "number";

  if (!skipCascade) {
    const entry = SHORTENING_REGISTRY.get(toolName);
    if (entry) {
      if (text.length > COMPACT_THRESHOLD && entry.compact) {
        text = "[compact] " + entry.compact(data);
      }
      if (text.length > COUNTS_THRESHOLD && entry.counts) {
        text = "[counts] " + entry.counts(data);
      }
    }
  }

  // Hard cap: truncate oversized responses
  const maxChars = MAX_RESPONSE_TOKENS * CHARS_PER_TOKEN;
  if (text.length > maxChars) {
    const estimatedTokens = Math.round(text.length / CHARS_PER_TOKEN);
    const fullSizeInfo = persistedPath
      ? `\n📄 Full output (${estimatedTokens.toLocaleString()} tokens) saved to: ${persistedPath}`
      : "";
    text = text.slice(0, maxChars) +
      `\n\n⚠️ Response truncated: ${estimatedTokens.toLocaleString()} tokens exceeded ${MAX_RESPONSE_TOKENS.toLocaleString()} token limit. Use file_pattern to narrow scope, or group_by_file=true for compact output.${fullSizeInfo}`;
  }

  // Token savings estimate
  const savings = estimateSavings(toolName, Math.round(text.length / CHARS_PER_TOKEN));
  if (savings) {
    text = `⚡ ~${savings.tokens.toLocaleString()} tok saved\n\n` + text;
    addSavings(savings.tokens);
  }

  const hint = buildResponseHint(toolName, args, data);
  if (hint) {
    // Prepend hint so agent sees it first (appended hints get ignored after long output)
    return { content: [{ type: "text" as const, text: hint + "\n\n" + text }] };
  }
  return { content: [{ type: "text" as const, text }] };
}

export function wrapTool<T>(
  toolName: string,
  args: Record<string, unknown>,
  fn: () => Promise<T>,
  opts?: { bypassCache?: boolean },
): () => Promise<ToolResponse> {
  // When bypassing, wrapTool does NOT read/write its inner (args-only) response
  // cache and does NOT join the in-flight dedup map — it only executes the
  // handler and shapes the ToolResponse (error handling, usage tracking, timing
  // are all preserved). Used by the runtime wiring for `cacheable` tools, whose
  // sole cache is the outer index-version-aware withCache; letting the inner
  // args-only cache also serve them would leak stale data after an
  // out-of-process re-index (the inner cache is invalidated only by an
  // in-session index_file).
  const bypassCache = opts?.bypassCache === true;
  return () => {
    resolveRepo(toolName, args);
    const cacheKey = getCacheKey(toolName, args);

    if (!bypassCache) {
      // 1. Return completed cache hit
      const cached = getCached(cacheKey);
      if (cached) {
        trackSequentialCalls(toolName);
        recordCacheHit(toolName, args);
        scheduleSidecarFlush();
        return Promise.resolve({
          content: [{
            type: "text" as const,
            text: cached + "\n⚡ cached",
          }],
        });
      }

      // 2. Coalesce with in-flight request (parallel dedup)
      const pending = inflight.get(cacheKey);
      if (pending) {
        return pending.then((response) => ({
          content: [{
            type: "text" as const,
            text: (response.content[0]?.text ?? "") + "\n⚡ deduped",
          }],
        }));
      }
    }

    // 3. Execute and cache
    const promise = (async (): Promise<ToolResponse> => {
      const start = performance.now();
      try {
        const data = await fn();
        const text = typeof data === "string" ? data : JSON.stringify(data);
        const elapsed = performance.now() - start;
        trackSequentialCalls(toolName);
        recordSessionCall(toolName, args, extractResultChunks(data), data);
        scheduleSidecarFlush();
        // Mark H10 emitted after recording (side-effect belongs in wrapTool, not buildResponseHint)
        const ss = getSessionState();
        if (getCallCount() >= 50 && !ss.h10Emitted) ss.h10Emitted = true;

        // Invalidate response cache after index mutations so subsequent
        // search/symbol reads see fresh data. Without this, the 30s-5min
        // TTL would serve stale results after an edit.
        if (INDEX_MUTATING_TOOLS.has(toolName)) {
          invalidateResponseCache();
        } else if (!bypassCache) {
          setCache(cacheKey, text);
        }
        const response = formatResponse(text, toolName, args, data);
        // Track AFTER formatting so telemetry can record both the raw size
        // and what was actually sent post-cascade (result_tokens_sent).
        const sentChars = response.content[0]?.text?.length ?? 0;
        trackToolCall(toolName, args, text, data, elapsed, { sentChars });
        return response;
      } catch (err: unknown) {
        const elapsed = performance.now() - start;
        const message = err instanceof Error ? err.message : String(err);
        trackToolCall(toolName, args, message, { error: message }, elapsed, { error: true });
        trackSequentialCalls(toolName);
        recordSessionCall(toolName, args, 0, { error: message });
        scheduleSidecarFlush();
        return errorResult(message);
      } finally {
        if (!bypassCache) inflight.delete(cacheKey);
      }
    })();

    if (!bypassCache) inflight.set(cacheKey, promise);
    return promise;
  };
}

/**
 * Reset all session-level tracking state. Exported for testing only.
 */
export function resetSessionState(): void {
  lastToolName = "";
  consecutiveCount = 0;
  listReposCallCount = 0;
  fileTreePaths.clear();
  sessionSearchSymbolsCalled = false;
  sessionGetSymbolCount = 0;
  sessionSearchTextPatterns.clear();
  responseCache.clear();
  resetSession();
}
