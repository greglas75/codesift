import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Session ID — unique per process lifetime
// ---------------------------------------------------------------------------

const SESSION_ID = randomUUID();

/** Machine identity stamped on every entry so logs merged across machines
 *  (laptop + VPS, see usage-remote/) stay attributable. Overridable for
 *  ephemeral hosts whose hostnames are random (CI, containers). */
const HOST = process.env["CODESIFT_HOST_TAG"] ?? hostname();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageEntry {
  ts: number;
  tool: string;
  repo: string;
  args_summary: Record<string, unknown>;
  elapsed_ms: number;
  /** Estimated tokens of the RAW handler result (pre-shortening). */
  result_tokens: number;
  result_chunks: number;
  session_id: string;
  /** Machine that produced the entry (os.hostname() or CODESIFT_HOST_TAG).
   * Lets stats split local vs remote once logs are merged. Absent in
   * pre-multi-host entries — readers treat those as the local host. */
  host?: string;
  /** Estimated tokens actually sent after the progressive-shortening
   * cascade + response hints. Present only when it differs from
   * result_tokens — so cascade effectiveness is measurable. */
  result_tokens_sent?: number;
  /** True when the handler threw — the logged result is the error message. */
  error?: boolean;
  /** True when served from the response cache — excluded from latency/error/empty
   *  aggregation, counted only toward cache_hit_rate. */
  cache_hit?: boolean;
  /** Response-hint codes emitted on this call (e.g. ["H1","H12"]) — powers the
   *  hint-efficacy funnel. Codes only, never the hint text. */
  hints_emitted?: string[];
  /** Tool names plan_turn recommended on this call — powers the discovery funnel
   *  (was a recommended tool actually used next?). Names only. */
  recommended_tools?: string[];
}

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

export function getUsagePath(): string {
  const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
  return join(dataDir, "usage.jsonl");
}

/**
 * Directory holding usage logs synced from other machines (one .jsonl per
 * host, e.g. usage-remote/vps.jsonl pulled via rsync/cron). Stats readers
 * merge these with the local log; the filename stem doubles as the host tag
 * for pre-multi-host entries that lack a `host` field.
 */
export function getRemoteUsageDir(): string {
  const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
  return join(dataDir, "usage-remote");
}

/** Host tag stamped on entries written by this process. */
export function getLocalHostTag(): string {
  return HOST;
}

// ---------------------------------------------------------------------------
// Args summary builders — lightweight, never includes large content
// ---------------------------------------------------------------------------

/** Per-tool field extraction schema: [key, expectedType] pairs.
 * Exported for testing — assert a tool is absent to confirm telemetry blacklisting. */
export const TOOL_ARG_FIELDS: Record<string, Array<[string, "string" | "number" | "boolean"]>> = {
  search_symbols: [["kind", "string"], ["top_k", "number"], ["file_pattern", "string"], ["decorator", "string"], ["include_source", "boolean"]],
  search_text: [["regex", "boolean"], ["context_lines", "number"], ["file_pattern", "string"], ["max_results", "number"], ["group_by_file", "boolean"], ["auto_group", "boolean"], ["ranked", "boolean"], ["compact", "boolean"]],
  get_file_tree: [["path_prefix", "string"], ["name_pattern", "string"], ["depth", "number"]],
  get_file_outline: [["file_path", "string"]],
  get_symbol: [["symbol_id", "string"]],
  find_and_show: [["include_refs", "boolean"]],
  find_references: [["symbol_name", "string"], ["file_pattern", "string"]],
  trace_call_chain: [["symbol_name", "string"], ["direction", "string"], ["depth", "number"]],
  impact_analysis: [["since", "string"], ["until", "string"], ["depth", "number"]],
  assemble_context: [["token_budget", "number"]],
  get_knowledge_map: [["focus", "string"], ["depth", "number"]],
  diff_outline: [["since", "string"], ["until", "string"]],
  changed_symbols: [["since", "string"], ["until", "string"]],
  resolve_constant_value: [["symbol_name", "string"], ["file_pattern", "string"], ["max_depth", "number"]],
  effective_django_view_security: [["path", "string"], ["symbol_name", "string"], ["file_pattern", "string"], ["settings_file", "string"]],
  taint_trace: [["framework", "string"], ["file_pattern", "string"], ["max_depth", "number"], ["max_traces", "number"]],
  index_folder: [["path", "string"], ["incremental", "boolean"]],
  index_repo: [["url", "string"], ["branch", "string"]],
  generate_claude_md: [["output_path", "string"]],
  scan_secrets: [["file_pattern", "string"], ["min_confidence", "string"], ["severity", "string"], ["exclude_tests", "boolean"]],
};

/**
 * Build a lightweight args summary for a given tool call.
 * Extracts only the small, useful fields — never full source or query results.
 */
export function buildArgsSummary(
  tool: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};

  // Common fields — always include if present
  if (typeof args["query"] === "string") summary["query"] = (args["query"] as string).slice(0, 200);
  if (typeof args["repo"] === "string") summary["repo"] = args["repo"];

  // Special cases with non-trivial extraction
  if (tool === "codebase_retrieval") {
    const queries = args["queries"];
    if (Array.isArray(queries)) {
      summary["query_count"] = queries.length;
      summary["query_types"] = queries.map(
        (q: unknown) => (typeof q === "object" && q !== null ? (q as Record<string, unknown>)["type"] : "unknown"),
      );
    }
    if (typeof args["token_budget"] === "number") summary["token_budget"] = args["token_budget"];
  } else if (tool === "get_symbols") {
    const ids = args["symbol_ids"];
    if (Array.isArray(ids)) summary["symbol_count"] = ids.length;
  } else if (tool === "describe_tools") {
    // Capture which tool schemas were requested — previously logged as {} , which
    // hid repeat-fetch volume (920 calls / 1.8M tokens with no visibility into
    // whether the same schemas were re-requested and could be cached).
    const names = args["names"];
    if (Array.isArray(names)) {
      summary["names"] = names.filter((n) => typeof n === "string").slice(0, 30);
      summary["name_count"] = names.length;
    }
    if (typeof args["reveal"] === "boolean") summary["reveal"] = args["reveal"];
  }

  // Data-driven extraction for all standard tools
  const fields = TOOL_ARG_FIELDS[tool];
  if (fields) {
    for (const [key, type] of fields) {
      if (typeof args[key] === type) summary[key] = args[key];
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Result metrics extraction
// ---------------------------------------------------------------------------

/**
 * Estimate the number of discrete result items (chunks, symbols, files, etc.)
 * from the tool result object.
 */
/** Common "nothing found" markers in formatted string results. */
const NO_RESULT_STRING_RX = /^\(?no (results|matches|symbols|references|files)/i;

export function extractResultChunks(data: unknown): number {
  if (Array.isArray(data)) return data.length;

  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;

    // codebase_retrieval → results array
    if (Array.isArray(obj["results"])) return obj["results"].length;

    // various tools returning arrays under common keys
    if (Array.isArray(obj["symbols"])) return obj["symbols"].length;
    if (Array.isArray(obj["files"])) return obj["files"].length;
    if (Array.isArray(obj["matches"])) return obj["matches"].length;
    if (Array.isArray(obj["references"])) return obj["references"].length;
    if (Array.isArray(obj["repos"])) return obj["repos"].length;

    // single item results
    if (typeof obj["id"] === "string") return 1;
  }

  // Formatted-string results (most handlers return strings): non-empty line
  // count is a serviceable item proxy for tabular output, and lets telemetry
  // distinguish zero-result calls — previously every string-returning tool
  // logged result_chunks=0, making miss rates unmeasurable.
  if (typeof data === "string") {
    const trimmed = data.trim();
    if (trimmed === "" || NO_RESULT_STRING_RX.test(trimmed)) return 0;
    return trimmed.split("\n").filter((l) => l.trim() !== "").length;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Core tracking function
// ---------------------------------------------------------------------------

let cumulativeTokensSaved = 0;

export function getCumulativeSavings(): number {
  return cumulativeTokensSaved;
}

export function addSavings(tokens: number): void {
  cumulativeTokensSaved += tokens;
}

let dirEnsured = false;

/**
 * Log a usage entry to ~/.codesift/usage.jsonl.
 * Non-blocking: errors are silently caught and logged to stderr.
 */
export async function trackUsage(entry: UsageEntry): Promise<void> {
  try {
    const usagePath = getUsagePath();

    if (!dirEnsured) {
      const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
      await mkdir(dataDir, { recursive: true });
      dirEnsured = true;
    }

    const line = JSON.stringify(entry) + "\n";
    await appendFile(usagePath, line, "utf-8");
  } catch (err: unknown) {
    // Never throw — tracking is best-effort
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[usage-tracker] Failed to log usage: ${message}`);
  }
}

/**
 * Recommendations stashed by the plan_turn handler. Needed because that handler
 * returns a FORMATTED STRING (formatPlanTurnResult), so the structured
 * PlanTurnResult never reaches trackToolCall — which silently produced an empty
 * discovery funnel (telemetry 2026-07-20: 1821 plan_turn calls, 0 recommendations
 * recorded). Set immediately before the handler returns; consumed by the very
 * next trackToolCall in the same tool-call flow.
 */
let pendingPlanTurnRecommendations: string[] = [];

export function setPlanTurnRecommendations(names: string[]): void {
  pendingPlanTurnRecommendations = names.filter((n) => typeof n === "string" && n).slice(0, 10);
}

function takePlanTurnRecommendations(): string[] {
  const out = pendingPlanTurnRecommendations;
  pendingPlanTurnRecommendations = [];
  return out;
}

/** Extract recommended tool names from a plan_turn result (names only, capped). */
function extractRecommendedTools(resultData: unknown): string[] {
  if (!resultData || typeof resultData !== "object") return [];
  const tools = (resultData as Record<string, unknown>)["tools"];
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const t of tools) {
    if (t && typeof t === "object") {
      const n = (t as Record<string, unknown>)["tool"] ?? (t as Record<string, unknown>)["name"];
      if (typeof n === "string" && n) names.push(n);
    }
  }
  return names.slice(0, 10);
}

/**
 * High-level helper: track a completed tool call.
 * Called at the end of each tool handler after the result is computed.
 */
export function trackToolCall(
  tool: string,
  args: Record<string, unknown>,
  resultText: string,
  resultData: unknown,
  elapsedMs: number,
  extra?: {
    /** Char length of the response actually sent (post-cascade, with hints). */
    sentChars?: number;
    /** The handler threw — resultText is the error message. */
    error?: boolean;
    /** Served from the response cache (excluded from latency/error/empty stats). */
    cacheHit?: boolean;
    /** Response-hint codes emitted on this call, e.g. ["H1","H12"]. */
    hintsEmitted?: string[];
  },
): void {
  const resultTokens = Math.ceil(resultText.length / 4);
  const sentTokens = extra?.sentChars !== undefined ? Math.ceil(extra.sentChars / 4) : undefined;
  // Prefer the handler-supplied names (the plan_turn handler returns a formatted
  // string); fall back to structured extraction if a caller returns raw data.
  const recommended =
    tool === "plan_turn"
      ? (() => {
          const stashed = takePlanTurnRecommendations();
          return stashed.length ? stashed : extractRecommendedTools(resultData);
        })()
      : [];
  const entry: UsageEntry = {
    ts: Date.now(),
    tool,
    repo: typeof args["repo"] === "string" ? args["repo"] : "",
    args_summary: buildArgsSummary(tool, args),
    elapsed_ms: Math.round(elapsedMs),
    result_tokens: resultTokens,
    result_chunks: extractResultChunks(resultData),
    session_id: SESSION_ID,
    host: HOST,
    ...(sentTokens !== undefined && sentTokens !== resultTokens ? { result_tokens_sent: sentTokens } : {}),
    ...(extra?.error ? { error: true } : {}),
    ...(extra?.cacheHit ? { cache_hit: true } : {}),
    ...(extra?.hintsEmitted && extra.hintsEmitted.length ? { hints_emitted: extra.hintsEmitted } : {}),
    ...(recommended.length ? { recommended_tools: recommended } : {}),
  };

  // Fire and forget — never block the tool response
  trackUsage(entry).catch(() => {});
}

/**
 * Get the current session ID (for testing or display).
 */
export function getSessionId(): string {
  return SESSION_ID;
}
