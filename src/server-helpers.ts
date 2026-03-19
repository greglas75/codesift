import { trackToolCall } from "./storage/usage-tracker.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HIGH_CARDINALITY_THRESHOLD = 50;
export const CHARS_PER_TOKEN = 4;
export const MAX_RESPONSE_TOKENS = 30_000; // Hard cap — truncate any response above this

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

/** Cache completed responses */
const responseCache = new Map<string, { text: string; ts: number }>();

/** In-flight requests — coalesce parallel identical calls */
const inflight = new Map<string, Promise<ToolResponse>>();

function getCacheKey(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}\0${JSON.stringify(args, Object.keys(args).sort())}`;
}

const STATIC_TOOLS = new Set(["list_repos", "get_repo_outline"]);

function getCached(key: string): string | null {
  const entry = responseCache.get(key);
  if (!entry) return null;
  const toolName = key.split("\0")[0] ?? "";
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

function trackSequentialCalls(toolName: string): void {
  if (toolName === lastToolName && BATCHABLE_TOOLS.has(toolName)) {
    consecutiveCount++;
  } else {
    consecutiveCount = 1;
  }
  lastToolName = toolName;

  if (toolName === "list_repos") {
    listReposCallCount++;
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

/**
 * Build optimization hints based on response data + call patterns.
 */
export function buildResponseHint(toolName: string, args: Record<string, unknown>, data: unknown): string | null {
  const hints: string[] = [];

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

  return hints.length > 0 ? hints.join("\n") : null;
}

function formatResponse(text: string, toolName: string, args: Record<string, unknown>, data: unknown): ToolResponse {
  // Hard cap: truncate oversized responses
  const maxChars = MAX_RESPONSE_TOKENS * CHARS_PER_TOKEN;
  if (text.length > maxChars) {
    const estimatedTokens = Math.round(text.length / CHARS_PER_TOKEN);
    text = text.slice(0, maxChars) +
      `\n\n⚠️ Response truncated: ${estimatedTokens.toLocaleString()} tokens exceeded ${MAX_RESPONSE_TOKENS.toLocaleString()} token limit. Use file_pattern to narrow scope, or group_by_file=true for compact output.`;
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
