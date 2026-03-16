import { trackToolCall } from "./storage/usage-tracker.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HIGH_CARDINALITY_THRESHOLD = 50;
export const CHARS_PER_TOKEN = 4;

/**
 * Benchmark-derived multipliers: estimated grep/Read tokens for equivalent task.
 * Source: benchmarks/tool-comparison-A through E (2026-03-14).
 *
 * multiplier > 1 means grep produces MORE output for the same query (CodeSift saves).
 * multiplier < 1 means grep produces LESS (CodeSift costs more but gives richer data).
 */
export const GREP_EQUIVALENT_MULTIPLIER: Record<string, number> = {
  search_text: 1.02,        // A: 93K grep vs 91K CodeSift — nearly equal
  search_symbols: 0.18,     // B: 9K grep vs 52K CodeSift — grep smaller but incomplete
  get_file_tree: 0.63,      // C: 65K grep vs 104K CodeSift (compact mode)
  get_file_outline: 1.5,    // Estimated: outline vs full Read
  find_references: 1.06,    // E: 26K grep vs 24K CodeSift
  trace_call_chain: 1.06,   // E: same category
  get_symbol: 0.5,          // D: grep+Read wins on single retrieval
  get_symbols: 1.2,         // D: batch wins over sequential Read
  codebase_retrieval: 1.88, // Batch: 27K sequential vs 14K batched
  list_repos: 0.19,         // ls is much smaller than repo metadata
  impact_analysis: 1.5,     // Estimated: manual git diff + grep
};

// Model pricing per 1M input tokens (tool output becomes model input)
export const MODEL_PRICING_PER_M: Record<string, number> = {
  "opus": 15.0,
  "sonnet": 3.0,
  "haiku": 0.80,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResponseMeta {
  tokens_used: number;
  tokens_saved: number;
  cost_avoided_usd: Record<string, string>;
  ms: number;
}

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

export function buildResponseMeta(toolName: string, textLength: number, elapsedMs: number): ResponseMeta {
  const tokensUsed = Math.ceil(textLength / CHARS_PER_TOKEN);
  const multiplier = GREP_EQUIVALENT_MULTIPLIER[toolName] ?? 1.0;
  const grepEquivalent = Math.ceil(tokensUsed * multiplier);

  // For tools where grep output is smaller (multiplier < 1), savings still exist
  // because CodeSift eliminates follow-up Read calls (est. 2-3 calls × 500 tok each)
  const followUpSavings = multiplier < 1 ? 1500 : 0;
  const tokensSaved = Math.max(0, (grepEquivalent - tokensUsed) + followUpSavings);

  const costAvoided: Record<string, string> = {};
  for (const [model, pricePerM] of Object.entries(MODEL_PRICING_PER_M)) {
    costAvoided[model] = "$" + ((tokensSaved * pricePerM) / 1_000_000).toFixed(4);
  }

  return {
    tokens_used: tokensUsed,
    tokens_saved: tokensSaved,
    cost_avoided_usd: costAvoided,
    ms: Math.round(elapsedMs),
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
