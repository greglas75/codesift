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
  if (typeof args["query"] === "string") {
    summary["query"] = args["query"].slice(0, 200);
  }
  if (typeof args["repo"] === "string") {
    summary["repo"] = args["repo"];
  }

  switch (tool) {
    case "codebase_retrieval": {
      const queries = args["queries"];
      if (Array.isArray(queries)) {
        summary["query_count"] = queries.length;
        summary["query_types"] = queries.map(
          (q: unknown) => (typeof q === "object" && q !== null ? (q as Record<string, unknown>)["type"] : "unknown"),
        );
      }
      if (typeof args["token_budget"] === "number") {
        summary["token_budget"] = args["token_budget"];
      }
      break;
    }

    case "search_symbols": {
      if (typeof args["kind"] === "string") summary["kind"] = args["kind"];
      if (typeof args["top_k"] === "number") summary["top_k"] = args["top_k"];
      if (typeof args["file_pattern"] === "string") summary["file_pattern"] = args["file_pattern"];
      if (typeof args["include_source"] === "boolean") summary["include_source"] = args["include_source"];
      break;
    }

    case "search_text": {
      if (typeof args["regex"] === "boolean") summary["regex"] = args["regex"];
      if (typeof args["context_lines"] === "number") summary["context_lines"] = args["context_lines"];
      if (typeof args["file_pattern"] === "string") summary["file_pattern"] = args["file_pattern"];
      if (typeof args["max_results"] === "number") summary["max_results"] = args["max_results"];
      if (typeof args["group_by_file"] === "boolean") summary["group_by_file"] = args["group_by_file"];
      if (typeof args["auto_group"] === "boolean") summary["auto_group"] = args["auto_group"];
      break;
    }

    case "get_file_tree": {
      if (typeof args["path_prefix"] === "string") summary["path_prefix"] = args["path_prefix"];
      if (typeof args["name_pattern"] === "string") summary["name_pattern"] = args["name_pattern"];
      if (typeof args["depth"] === "number") summary["depth"] = args["depth"];
      break;
    }

    case "get_file_outline": {
      if (typeof args["file_path"] === "string") summary["file_path"] = args["file_path"];
      break;
    }

    case "get_symbol": {
      if (typeof args["symbol_id"] === "string") summary["symbol_id"] = args["symbol_id"];
      break;
    }

    case "get_symbols": {
      const ids = args["symbol_ids"];
      if (Array.isArray(ids)) summary["symbol_count"] = ids.length;
      break;
    }

    case "find_and_show": {
      if (typeof args["include_refs"] === "boolean") summary["include_refs"] = args["include_refs"];
      break;
    }

    case "find_references": {
      if (typeof args["symbol_name"] === "string") summary["symbol_name"] = args["symbol_name"];
      if (typeof args["file_pattern"] === "string") summary["file_pattern"] = args["file_pattern"];
      break;
    }

    case "trace_call_chain": {
      if (typeof args["symbol_name"] === "string") summary["symbol_name"] = args["symbol_name"];
      if (typeof args["direction"] === "string") summary["direction"] = args["direction"];
      if (typeof args["depth"] === "number") summary["depth"] = args["depth"];
      break;
    }

    case "impact_analysis": {
      if (typeof args["since"] === "string") summary["since"] = args["since"];
      if (typeof args["until"] === "string") summary["until"] = args["until"];
      if (typeof args["depth"] === "number") summary["depth"] = args["depth"];
      break;
    }

    case "assemble_context": {
      if (typeof args["token_budget"] === "number") summary["token_budget"] = args["token_budget"];
      break;
    }

    case "get_knowledge_map": {
      if (typeof args["focus"] === "string") summary["focus"] = args["focus"];
      if (typeof args["depth"] === "number") summary["depth"] = args["depth"];
      break;
    }

    case "diff_outline":
    case "changed_symbols": {
      if (typeof args["since"] === "string") summary["since"] = args["since"];
      if (typeof args["until"] === "string") summary["until"] = args["until"];
      break;
    }

    case "index_folder": {
      if (typeof args["path"] === "string") summary["path"] = args["path"];
      if (typeof args["incremental"] === "boolean") summary["incremental"] = args["incremental"];
      break;
    }

    case "index_repo": {
      if (typeof args["url"] === "string") summary["url"] = args["url"];
      if (typeof args["branch"] === "string") summary["branch"] = args["branch"];
      break;
    }

    case "generate_claude_md": {
      if (typeof args["output_path"] === "string") summary["output_path"] = args["output_path"];
      break;
    }

    // list_repos, invalidate_cache, get_repo_outline, usage_stats — no extra args needed
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
