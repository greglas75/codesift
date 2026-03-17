import { trackToolCall } from "./storage/usage-tracker.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HIGH_CARDINALITY_THRESHOLD = 50;
export const CHARS_PER_TOKEN = 4;
export const MAX_RESPONSE_TOKENS = 30_000; // Hard cap — truncate any response above this

const BATCHABLE_TOOLS = new Set(["search_text", "search_symbols", "find_references", "get_symbol"]);
const SEQUENTIAL_HINT_THRESHOLD = 3; // Suggest batching after N consecutive calls

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolResponse {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Session-level call tracking (in-memory, resets on server restart)
// ---------------------------------------------------------------------------

let lastToolName = "";
let consecutiveCount = 0;
let listReposCallCount = 0;

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
 * Returns null if no hint is needed.
 */
export function buildResponseHint(toolName: string, args: Record<string, unknown>, data: unknown): string | null {
  const hints: string[] = [];

  // High-cardinality ungrouped results
  if (toolName === "search_text" && Array.isArray(data) && data.length > HIGH_CARDINALITY_THRESHOLD) {
    if (!args["group_by_file"] && !args["auto_group"]) {
      hints.push(`⚡ ${data.length} matches — use group_by_file=true or auto_group=true to reduce output by ~70%.`);
    }
  }

  // Sequential same-tool calls → suggest codebase_retrieval
  if (consecutiveCount >= SEQUENTIAL_HINT_THRESHOLD && BATCHABLE_TOOLS.has(toolName)) {
    const batchTool = toolName === "get_symbol" ? "get_symbols" : "codebase_retrieval";
    hints.push(`⚡ ${consecutiveCount} consecutive ${toolName} calls detected. Batch these into a single ${batchTool} call to save round-trips and tokens.`);
  }

  // Repeated list_repos
  if (toolName === "list_repos" && listReposCallCount > 1) {
    hints.push(`⚡ list_repos called ${listReposCallCount}x this session. The result doesn't change — cache it from the first call.`);
  }

  return hints.length > 0 ? hints.join("\n") : null;
}

export function wrapTool<T>(toolName: string, args: Record<string, unknown>, fn: () => Promise<T>): () => Promise<ToolResponse> {
  return async () => {
    const start = performance.now();
    try {
      const data = await fn();
      let text = JSON.stringify(data, null, 2);
      const elapsed = performance.now() - start;
      trackToolCall(toolName, args, text, data, elapsed);
      trackSequentialCalls(toolName);

      // Hard cap: truncate oversized responses to prevent 100K+ token blowouts
      const maxChars = MAX_RESPONSE_TOKENS * CHARS_PER_TOKEN;
      if (text.length > maxChars) {
        const estimatedTokens = Math.round(text.length / CHARS_PER_TOKEN);
        text = text.slice(0, maxChars) +
          `\n\n⚠️ Response truncated: ${estimatedTokens.toLocaleString()} tokens exceeded ${MAX_RESPONSE_TOKENS.toLocaleString()} token limit. Use file_pattern to narrow scope, or group_by_file=true for compact output.`;
      }

      // Append optimization hints
      const hint = buildResponseHint(toolName, args, data);
      if (hint) {
        return { content: [{ type: "text" as const, text: text + "\n\n" + hint }] };
      }

      return { content: [{ type: "text" as const, text }] };
    } catch (err: unknown) {
      const elapsed = performance.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      trackToolCall(toolName, args, message, { error: message }, elapsed);
      trackSequentialCalls(toolName);
      return errorResult(message);
    }
  };
}
