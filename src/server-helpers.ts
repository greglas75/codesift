import { trackToolCall } from "./storage/usage-tracker.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HIGH_CARDINALITY_THRESHOLD = 50;
export const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolResponse {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
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
 * Build an optimization hint when tool results indicate suboptimal usage.
 * Returns null if no hint is needed.
 */
export function buildResponseHint(toolName: string, args: Record<string, unknown>, data: unknown): string | null {
  if (toolName === "search_text" && Array.isArray(data) && data.length > HIGH_CARDINALITY_THRESHOLD) {
    if (!args["group_by_file"] && !args["auto_group"]) {
      return `⚡ Tip: This search returned ${data.length} matches. Use group_by_file=true or auto_group=true to reduce output by ~70%. For 3+ searches, batch them with codebase_retrieval.`;
    }
  }
  return null;
}

export function wrapTool<T>(toolName: string, args: Record<string, unknown>, fn: () => Promise<T>): () => Promise<ToolResponse> {
  return async () => {
    const start = performance.now();
    try {
      const data = await fn();
      const text = JSON.stringify(data, null, 2);
      const elapsed = performance.now() - start;
      trackToolCall(toolName, args, text, data, elapsed);

      // Append optimization hint for high-cardinality search_text results
      const hint = buildResponseHint(toolName, args, data);
      if (hint) {
        return { content: [{ type: "text" as const, text: text + "\n\n" + hint }] };
      }

      return { content: [{ type: "text" as const, text }] };
    } catch (err: unknown) {
      const elapsed = performance.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      trackToolCall(toolName, args, message, { error: message }, elapsed);
      return errorResult(message);
    }
  };
}
