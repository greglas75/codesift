import type { SearchResult } from "../../types.js";
import type { AssembleContextResult } from "./types.js";
import { estimateTokens } from "./shared.js";

export function assembleL0(results: SearchResult[], budget: number): AssembleContextResult {
  const symbols = [];
  let totalTokens = 0;
  let truncated = false;
  for (const result of results) {
    const tokens = estimateTokens(result.symbol.source ?? "");
    if (totalTokens + tokens > budget) { truncated = true; break; }
    symbols.push(result.symbol);
    totalTokens += tokens;
  }
  return { symbols, level: "L0", total_tokens: totalTokens, truncated, result_count: symbols.length };
}
