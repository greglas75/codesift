/** SQL DDL extractor public facade and orchestration. */
import type { CodeSymbol } from "../../types.js";
import { findEndByte } from "./sql-boundaries.js";
import { extractColumns } from "./sql-columns.js";
import { collectDdlHits } from "./sql-matchers.js";
import { createOffsetToLine } from "./sql-offsets.js";
import { buildDdlSymbol } from "./sql-symbols.js";
export { stripJinjaTokens } from "./sql-jinja.js";

export function extractSqlSymbols(
  source: string,
  filePath: string,
  repo: string,
  originalSource?: string,
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const lines = source.split("\n");
  const originalLines = originalSource ? originalSource.split("\n") : lines;
  const offsetToLine = createOffsetToLine(source);
  const consumed: Array<[number, number]> = [];

  for (const hit of collectDdlHits(source)) {
    if (consumed.some(([start, end]) => hit.matchOffset >= start && hit.matchOffset < end)) continue;
    const startLineIndex = offsetToLine(hit.matchOffset);
    const endOffset = findEndByte(source, hit.matchOffset, hit.matcher.endStrategy);
    const endLineIndex = offsetToLine(endOffset);
    consumed.push([hit.matchOffset, endOffset + 1]);
    const symbol = buildDdlSymbol(hit, {
      repo, filePath, lines, originalLines, startLineIndex, endLineIndex,
    });
    symbols.push(symbol);
    if (hit.matcher.kind === "table") {
      symbols.push(...extractColumns({
        lines, startIdx: startLineIndex, endIdx: endLineIndex,
        filePath, repo, parentId: symbol.id, matchOffset: hit.matchOffset, source,
      }));
    }
  }
  return symbols;
}
