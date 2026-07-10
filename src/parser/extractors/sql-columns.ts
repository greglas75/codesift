import type { CodeSymbol } from "../../types.js";
import { tokenizeIdentifier, makeSymbolId } from "../symbol-extractor.js";
import { sliceBalancedParens, splitTopLevelCommas } from "./sql-boundaries.js";
const CONSTRAINT_RE = /^\s*(?:PRIMARY\s+KEY|FOREIGN\s+KEY|CONSTRAINT|UNIQUE|CHECK|INDEX|KEY|FULLTEXT)\b/i;
// Column name: backtick, double-quote, bracket, or unquoted with #/$ allowed
const COLUMN_RE = /^\s*(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|([\w#$]+))\s+(.+)/i;

export function extractColumns(
  lines: string[],
  startIdx: number,
  endIdx: number,
  filePath: string,
  repo: string,
  parentId: string,
  matchOffset?: number,
  source?: string,
): CodeSymbol[] {
  const fields: CodeSymbol[] = [];

  // For multi-line: use lines (preserves correct line numbers).
  // For minified single-line: split the body content (between parens) on top-level commas.
  if (startIdx === endIdx && source !== undefined && matchOffset !== undefined) {
    // Minified path: extract body between matching parens, split on top-level commas
    const openIdx = source.indexOf("(", matchOffset);
    if (openIdx === -1) return fields;
    const body = sliceBalancedParens(source, openIdx);
    if (!body) return fields;

    const segments = splitTopLevelCommas(body);
    const fieldLine = startIdx + 1; // all on same line for minified
    for (const seg of segments) {
      const trimmed = seg.trim();
      if (!trimmed || CONSTRAINT_RE.test(trimmed)) continue;
      const m = COLUMN_RE.exec(trimmed);
      if (!m) continue;
      const colName = m[1] ?? m[2] ?? m[3] ?? m[4]!;
      const colType = m[5]!.trim();
      fields.push({
        id: makeSymbolId(repo, filePath, colName, fieldLine),
        repo,
        name: colName,
        kind: "field",
        file: filePath,
        start_line: fieldLine,
        end_line: fieldLine,
        signature: colType,
        parent: parentId,
        tokens: tokenizeIdentifier(colName),
      });
    }
    return fields;
  }

  // Multi-line path (original behavior)
  for (let j = startIdx + 1; j <= endIdx; j++) {
    const trimmed = lines[j]!.trim();
    if (trimmed === "" || trimmed === ")" || trimmed === ");") continue;
    if (CONSTRAINT_RE.test(trimmed)) continue;

    const m = COLUMN_RE.exec(trimmed);
    if (!m) continue;

    const colName = m[1] ?? m[2] ?? m[3] ?? m[4]!;
    const colType = m[5]!.replace(/,\s*$/, "").trim();
    const fieldLine = j + 1;

    fields.push({
      id: makeSymbolId(repo, filePath, colName, fieldLine),
      repo,
      name: colName,
      kind: "field",
      file: filePath,
      start_line: fieldLine,
      end_line: fieldLine,
      signature: colType,
      parent: parentId,
      tokens: tokenizeIdentifier(colName),
    });
  }
  return fields;
}

export function buildTableSignature(
  name: string,
  lines: string[],
  startIdx: number,
  endIdx: number,
): string {
  const cols: string[] = [];
  for (let j = startIdx + 1; j <= endIdx; j++) {
    const trimmed = lines[j]!.trim();
    if (/^\s*(?:PRIMARY\s+KEY|FOREIGN\s+KEY|CONSTRAINT|UNIQUE|CHECK|INDEX)\s*[\(]/i.test(trimmed)) continue;
    if (trimmed === "" || trimmed === ")" || trimmed === ");") continue;
    const colMatch = /^"?(\w+)"?\s+\S/i.exec(trimmed);
    if (colMatch) cols.push(colMatch[1]!);
  }
  return `TABLE ${name} (${cols.join(", ")})`;
}
