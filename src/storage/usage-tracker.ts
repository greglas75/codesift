import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Session ID — unique per process lifetime
// ---------------------------------------------------------------------------

const SESSION_ID = randomUUID();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageEntry {
  ts: number;
  tool: string;
  repo: string;
  args_summary: Record<string, unknown>;
  elapsed_ms: number;
  result_tokens: number;
  result_chunks: number;
  session_id: string;
}

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

function getUsagePath(): string {
  const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
  return join(dataDir, "usage.jsonl");
}

// ---------------------------------------------------------------------------
// Args summary builders — lightweight, never includes large content
// ---------------------------------------------------------------------------

/** Per-tool field extraction schema: [key, expectedType] pairs */
const TOOL_ARG_FIELDS: Record<string, Array<[string, "string" | "number" | "boolean"]>> = {
  search_symbols: [["kind", "string"], ["top_k", "number"], ["file_pattern", "string"], ["include_source", "boolean"]],
  search_text: [["regex", "boolean"], ["context_lines", "number"], ["file_pattern", "string"], ["max_results", "number"], ["group_by_file", "boolean"], ["auto_group", "boolean"]],
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
  index_folder: [["path", "string"], ["incremental", "boolean"]],
  index_repo: [["url", "string"], ["branch", "string"]],
  generate_claude_md: [["output_path", "string"]],
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
 * High-level helper: track a completed tool call.
 * Called at the end of each tool handler after the result is computed.
 */
export function trackToolCall(
  tool: string,
  args: Record<string, unknown>,
  resultText: string,
  resultData: unknown,
  elapsedMs: number,
): void {
  const entry: UsageEntry = {
    ts: Date.now(),
    tool,
    repo: typeof args["repo"] === "string" ? args["repo"] : "",
    args_summary: buildArgsSummary(tool, args),
    elapsed_ms: Math.round(elapsedMs),
    result_tokens: Math.ceil(resultText.length / 4),
    result_chunks: extractResultChunks(resultData),
    session_id: SESSION_ID,
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
