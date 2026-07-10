import type { CodeIndex, SearchResult } from "../../types.js";
import type { AssembleContextResult, FileSummary } from "./types.js";
import { estimateTokens } from "./shared.js";

export function assembleL2(results: SearchResult[], budget: number, index: CodeIndex | null): AssembleContextResult {
  const fileMap = new Map<string, { lang: string; exports: string[]; count: number }>();
  for (const result of results) {
    const sym = result.symbol;
    let entry = fileMap.get(sym.file);
    if (!entry) { entry = { lang: "unknown", exports: [], count: 0 }; fileMap.set(sym.file, entry); }
    entry.exports.push(`${sym.name}(${sym.kind})`);
    entry.count++;
  }
  if (index) {
    for (const file of index.files) {
      const entry = fileMap.get(file.path);
      if (entry) entry.lang = file.language;
    }
  }
  const summaries: FileSummary[] = [];
  let totalTokens = 0;
  let truncated = false;
  for (const [path, entry] of fileMap) {
    const summary: FileSummary = { path, language: entry.lang, exports: entry.exports, symbol_count: entry.count };
    const tokens = estimateTokens(JSON.stringify(summary));
    if (totalTokens + tokens > budget) { truncated = true; break; }
    summaries.push(summary);
    totalTokens += tokens;
  }
  return { file_summaries: summaries, level: "L2", total_tokens: totalTokens, truncated, result_count: summaries.length };
}
