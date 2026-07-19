import { trackToolCall, addSavings, extractResultChunks } from "./storage/usage-tracker.js";
import { recordToolCall as recordSessionCall, recordCacheHit, getCallCount, getSessionState, resetSession, scheduleSidecarFlush } from "./storage/session-state.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveToolRepoArgs } from "./server-helpers/repo-resolution.js";
import { buildResponseHint, resetHintState, trackSequentialCalls } from "./server-helpers/response-hints.js";
export { loadRegistrySync, isAncestorOrEqual, resolveRepoFromCwd, canonicalizeRepoName, _resetRegistryCacheForTests } from "./server-helpers/repo-resolution.js";
export { buildResponseHint, trackSequentialCalls } from "./server-helpers/response-hints.js";
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
 *
 * Exported because the registration runtime derives its timeout-exempt allowlist
 * from it (indexing is legitimately long-running — index_repo clones + indexes a
 * remote repo — so it must never be cut off by the client-facing timeout).
 */
export const INDEX_MUTATING_TOOLS: ReadonlySet<string> = new Set<string>([
  "index_file",
  "index_folder",
  "index_repo",
  "invalidate_cache",
]);

/** Drop every cached response. Called after an indexing tool runs. */
function invalidateResponseCache(): void {
  responseCache.clear();
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
    resolveToolRepoArgs(toolName, args);
    const cacheKey = getCacheKey(toolName, args);

    if (!bypassCache) {
      // 1. Return completed cache hit
      const cached = getCached(cacheKey);
      if (cached) {
        trackSequentialCalls(toolName);
        recordCacheHit(toolName, args);
        // Log the cache hit so cache_hit_rate is measurable (excluded from
        // latency/error/empty aggregation by the telemetry aggregator).
        trackToolCall(toolName, args, cached, {}, 0, { cacheHit: true });
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
        const sentText = response.content[0]?.text ?? "";
        const sentChars = sentText.length;
        // Response-hint codes (H1..H18) are prepended to the sent text by
        // formatResponse; capture just the codes for the hint-efficacy funnel.
        const hintsEmitted = [...new Set(sentText.match(/\bH\d+/g) ?? [])];
        trackToolCall(toolName, args, text, data, elapsed, { sentChars, hintsEmitted });
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
  resetHintState();
  responseCache.clear();
  resetSession();
}
