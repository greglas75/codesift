import type { SearchResult } from "../../types.js";
import type { AssembleContextResult, DirectoryOverview } from "./types.js";
import { estimateTokens } from "./shared.js";

export function assembleL3(results: SearchResult[], budget: number): AssembleContextResult {
  const dirMap = new Map<string, { files: Set<string>; symbols: number }>();
  for (const result of results) {
    const file = result.symbol.file;
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
    let entry = dirMap.get(dir);
    if (!entry) { entry = { files: new Set(), symbols: 0 }; dirMap.set(dir, entry); }
    entry.files.add(file);
    entry.symbols++;
  }
  const overviews: DirectoryOverview[] = [];
  let totalTokens = 0;
  let truncated = false;
  for (const [path, entry] of [...dirMap.entries()].sort((a, b) => b[1].symbols - a[1].symbols)) {
    const overview: DirectoryOverview = { path, file_count: entry.files.size, symbol_count: entry.symbols, top_files: [...entry.files].slice(0, 3) };
    const tokens = estimateTokens(JSON.stringify(overview));
    if (totalTokens + tokens > budget) { truncated = true; break; }
    overviews.push(overview);
    totalTokens += tokens;
  }
  return { directory_overview: overviews, level: "L3", total_tokens: totalTokens, truncated, result_count: overviews.length };
}
