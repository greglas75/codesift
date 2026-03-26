import { trackToolCall, addSavings } from "./storage/usage-tracker.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HIGH_CARDINALITY_THRESHOLD = 50;
export const CHARS_PER_TOKEN = 4;
export const MAX_RESPONSE_TOKENS = 30_000; // Hard cap — truncate any response above this

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
  trace_route: 4.0,
  get_context_bundle: 3.0,
};

const OPUS_COST_PER_TOKEN = 30 / 1_000_000; // $30/1M input tokens

const BATCHABLE_TOOLS = new Set(["search_text", "search_symbols", "find_references", "get_symbol"]);
const SEQUENTIAL_HINT_THRESHOLD = 3;
const CACHE_TTL_MS = 30_000; // 30s default for search results
const CACHE_TTL_STATIC_MS = 300_000; // 5min for static data (list_repos)
const CACHE_MAX_SIZE = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolResponse {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
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

/** Cache completed responses */
const responseCache = new Map<string, { text: string; ts: number }>();

/** In-flight requests — coalesce parallel identical calls */
const inflight = new Map<string, Promise<ToolResponse>>();

function getCacheKey(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}\0${JSON.stringify(args, Object.keys(args).sort())}`;
}

const STATIC_TOOLS = new Set(["list_repos", "get_repo_outline", "get_file_tree"]);

/** Tools whose cache NEVER expires within a session (repo list doesn't change mid-session) */
const SESSION_PERMANENT_TOOLS = new Set(["list_repos"]);

function getCached(key: string): string | null {
  const entry = responseCache.get(key);
  if (!entry) return null;
  const toolName = key.split("\0")[0] ?? "";

  // Session-permanent tools never expire (repo list doesn't change mid-session)
  if (SESSION_PERMANENT_TOOLS.has(toolName)) return entry.text;

  const ttl = STATIC_TOOLS.has(toolName) ? CACHE_TTL_STATIC_MS : CACHE_TTL_MS;
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

/**
 * Build optimization hints based on response data + call patterns.
 */
export function buildResponseHint(toolName: string, args: Record<string, unknown>, data: unknown): string | null {
  const hints: string[] = [];

  // --- Existing hints ---

  if (toolName === "search_text" && Array.isArray(data) && data.length > HIGH_CARDINALITY_THRESHOLD) {
    if (!args["group_by_file"] && !args["auto_group"]) {
      hints.push(`⚡ ${data.length} matches — use group_by_file=true or auto_group=true to reduce output by ~70%.`);
    }
  }

  if (consecutiveCount >= SEQUENTIAL_HINT_THRESHOLD && BATCHABLE_TOOLS.has(toolName)) {
    const batchTool = toolName === "get_symbol" ? "get_symbols" : "codebase_retrieval";
    hints.push(`⚡ ${consecutiveCount} consecutive ${toolName} calls. Batch into one ${batchTool} call.`);
  }

  if (toolName === "list_repos" && listReposCallCount > 1) {
    hints.push(`⚡ list_repos called ${listReposCallCount}x. Result is static — cache from first call.`);
  }

  if (toolName === "search_symbols" && args["include_source"] && !args["file_pattern"]) {
    hints.push(`⚡ search_symbols with include_source=true but no file_pattern scans entire repo. Add file_pattern to reduce tokens.`);
  }

  // --- Fix 1: get_file_tree duplicate path detection ---
  if (toolName === "get_file_tree") {
    const repo = typeof args["repo"] === "string" ? args["repo"] : "";
    const pathPrefix = typeof args["path_prefix"] === "string" ? args["path_prefix"] : "";
    const pathKey = `${repo}\0${pathPrefix}`;
    if (fileTreePaths.has(pathKey)) {
      hints.push(`⚡ get_file_tree("${pathPrefix || "(root)"}") was already fetched this session. Cache the result to avoid repeated calls.`);
    }
    fileTreePaths.add(pathKey);
  }

  // --- Fix 3: search_symbols detail_level hint ---
  if (toolName === "search_symbols" && !args["detail_level"]) {
    const resultCount = Array.isArray(data) ? data.length : 0;
    if (resultCount > 5) {
      hints.push(`⚡ ${resultCount} symbols returned. Use detail_level='compact' (~15 tok/result) for discovery, or 'full' for complete source.`);
    }
  }

  // --- Fix 5: search_symbols + get_symbol → suggest get_context_bundle ---
  if (toolName === "get_symbol" && sessionSearchSymbolsCalled) {
    hints.push(`⚡ Consider get_context_bundle(repo, symbol_name) — returns symbol + imports + siblings + callers in 1 call.`);
  }

  // --- Fix 6: 3+ get_symbol → suggest assemble_context ---
  if (toolName === "get_symbol" && sessionGetSymbolCount >= 3) {
    hints.push(`⚡ ${sessionGetSymbolCount}x get_symbol this session — try assemble_context(repo, query, level='L1') for batch retrieval (3x more symbols per budget).`);
  }

  // --- Fix 7: question-word text queries → suggest semantic search ---
  if (toolName === "search_text" && typeof args["query"] === "string" && QUESTION_PATTERN.test(args["query"])) {
    hints.push(`⚡ Text search with question words — consider codebase_retrieval with type:'semantic' for meaning-based search.`);
  }

  return hints.length > 0 ? hints.join("\n") : null;
}

function estimateSavings(toolName: string, resultTokens: number): { tokens: number; cost: number } | null {
  const mult = SAVINGS_MULTIPLIER[toolName];
  if (!mult || mult <= 1.0) return null;
  const saved = Math.round(resultTokens * (mult - 1));
  if (saved < 50) return null; // Don't show trivial savings
  return { tokens: saved, cost: saved * OPUS_COST_PER_TOKEN };
}

function formatResponse(text: string, toolName: string, args: Record<string, unknown>, data: unknown): ToolResponse {
  // Hard cap: truncate oversized responses
  const maxChars = MAX_RESPONSE_TOKENS * CHARS_PER_TOKEN;
  if (text.length > maxChars) {
    const estimatedTokens = Math.round(text.length / CHARS_PER_TOKEN);
    text = text.slice(0, maxChars) +
      `\n\n⚠️ Response truncated: ${estimatedTokens.toLocaleString()} tokens exceeded ${MAX_RESPONSE_TOKENS.toLocaleString()} token limit. Use file_pattern to narrow scope, or group_by_file=true for compact output.`;
  }

  // Token savings estimate
  const savings = estimateSavings(toolName, Math.round(text.length / CHARS_PER_TOKEN));
  if (savings) {
    const costStr = savings.cost >= 0.01 ? `$${savings.cost.toFixed(2)}` : `$${savings.cost.toFixed(4)}`;
    text = `⚡ Saved ~${savings.tokens.toLocaleString()} tokens vs manual approach (${costStr} at Opus rates)\n\n` + text;
    addSavings(savings.tokens);
  }

  const hint = buildResponseHint(toolName, args, data);
  if (hint) {
    // Prepend hint so agent sees it first (appended hints get ignored after long output)
    return { content: [{ type: "text" as const, text: hint + "\n\n" + text }] };
  }
  return { content: [{ type: "text" as const, text }] };
}

export function wrapTool<T>(toolName: string, args: Record<string, unknown>, fn: () => Promise<T>): () => Promise<ToolResponse> {
  return () => {
    const cacheKey = getCacheKey(toolName, args);

    // 1. Return completed cache hit
    const cached = getCached(cacheKey);
    if (cached) {
      trackSequentialCalls(toolName);
      return Promise.resolve({
        content: [{
          type: "text" as const,
          text: cached + "\n\n⚡ Deduplicated: identical call returned cached result (30s TTL).",
        }],
      });
    }

    // 2. Coalesce with in-flight request (parallel dedup)
    const pending = inflight.get(cacheKey);
    if (pending) {
      return pending.then((response) => ({
        content: [{
          type: "text" as const,
          text: (response.content[0]?.text ?? "") + "\n\n⚡ Deduplicated: coalesced with in-flight identical request.",
        }],
      }));
    }

    // 3. Execute and cache
    const promise = (async (): Promise<ToolResponse> => {
      const start = performance.now();
      try {
        const data = await fn();
        const text = JSON.stringify(data, null, 2);
        const elapsed = performance.now() - start;
        trackToolCall(toolName, args, text, data, elapsed);
        trackSequentialCalls(toolName);

        setCache(cacheKey, text);
        return formatResponse(text, toolName, args, data);
      } catch (err: unknown) {
        const elapsed = performance.now() - start;
        const message = err instanceof Error ? err.message : String(err);
        trackToolCall(toolName, args, message, { error: message }, elapsed);
        trackSequentialCalls(toolName);
        return errorResult(message);
      } finally {
        inflight.delete(cacheKey);
      }
    })();

    inflight.set(cacheKey, promise);
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
  responseCache.clear();
}
