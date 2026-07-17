import type { CodeSymbol } from "../../types.js";
import { tokenizeIdentifier, makeSymbolId } from "../symbol-utils.js";
import { buildTableSignature } from "./sql-columns.js";
import { extractSqlDocstring } from "./sql-docstrings.js";
import type { DdlHit } from "./sql-matchers.js";

const MAX_SOURCE_LENGTH = 5000;

export function buildDdlSymbol(
  hit: DdlHit,
  context: {
    repo: string; filePath: string; lines: string[]; originalLines: string[];
    startLineIndex: number; endLineIndex: number;
  },
): CodeSymbol {
  const line = context.startLineIndex + 1;
  const block = context.originalLines.slice(context.startLineIndex, context.endLineIndex + 1).join("\n");
  const symbol: CodeSymbol = {
    id: makeSymbolId(context.repo, context.filePath, hit.name, line),
    repo: context.repo, name: hit.name, kind: hit.matcher.kind, file: context.filePath,
    start_line: line, end_line: context.endLineIndex + 1,
    signature: hit.matcher.kind === "table"
      ? buildTableSignature(hit.name, context.lines, context.startLineIndex, context.endLineIndex)
      : `${hit.matcher.kind.toUpperCase()} ${hit.name}`,
    source: block.length > MAX_SOURCE_LENGTH ? `${block.slice(0, MAX_SOURCE_LENGTH)}...` : block,
    tokens: tokenizeIdentifier(hit.name),
  };
  const docstring = extractSqlDocstring(context.lines, context.startLineIndex);
  if (docstring) symbol.docstring = docstring;
  return symbol;
}
