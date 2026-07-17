import type { CodeSymbol, SearchResult } from "../../types.js";
import type { AssembleContextResult, SymbolCompact } from "./types.js";
import { estimateTokens } from "./shared.js";

function toCompact(sym: CodeSymbol): SymbolCompact {
  const compact: SymbolCompact = { id: sym.id, name: sym.name, kind: sym.kind, file: sym.file, start_line: sym.start_line };
  if (sym.signature) compact.signature = sym.signature;
  if (sym.docstring) compact.docstring = sym.docstring;
  return compact;
}

export function assembleL1(results: SearchResult[], budget: number): AssembleContextResult {
  const compactSymbols: SymbolCompact[] = [];
  let totalTokens = 0;
  let truncated = false;
  for (const result of results) {
    const compact = toCompact(result.symbol);
    const tokens = estimateTokens(JSON.stringify(compact));
    if (totalTokens + tokens > budget) { truncated = true; break; }
    compactSymbols.push(compact);
    totalTokens += tokens;
  }
  return { compact_symbols: compactSymbols, level: "L1", total_tokens: totalTokens, truncated, result_count: compactSymbols.length };
}
