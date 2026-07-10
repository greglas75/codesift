/**
 * SQL extractor — regex-based parser (no tree-sitter grammar).
 *
 * Extracts DDL constructs:
 * - CREATE TABLE  → kind: "table"
 * - CREATE VIEW   → kind: "view"
 * - CREATE INDEX  → kind: "index"
 * - CREATE FUNCTION  → kind: "function"
 * - CREATE PROCEDURE → kind: "procedure"
 * - CREATE TRIGGER   → kind: "trigger"
 * - CREATE SCHEMA    → kind: "namespace"
 * - CREATE TYPE      → kind: "type"
 * - CREATE SEQUENCE  → kind: "variable"
 * - Column defs      → kind: "field" (children of table)
 *
 * DML statements are intentionally skipped.
 */
import type { CodeSymbol } from "../../types.js";
import { tokenizeIdentifier, makeSymbolId } from "../symbol-extractor.js";
import { DDL_MATCHERS, pickName } from "./sql-matchers.js";
import type { DdlMatcher } from "./sql-matchers.js";
import { findEndByte } from "./sql-boundaries.js";
import { buildTableSignature, extractColumns } from "./sql-columns.js";
import { extractSqlDocstring } from "./sql-docstrings.js";
export { stripJinjaTokens } from "./sql-jinja.js";
const MAX_SOURCE_LENGTH = 5000;
export function extractSqlSymbols(
  source: string,
  filePath: string,
  repo: string,
  originalSource?: string,
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const lines = source.split("\n");
  const origLines = originalSource ? originalSource.split("\n") : lines;

  // Build line-offset map: lineOffsets[i] = byte offset where line i starts
  const lineOffsets: number[] = [0];
  for (let k = 0; k < source.length; k++) {
    if (source.charCodeAt(k) === 10) lineOffsets.push(k + 1);
  }

  function offsetToLine(offset: number): number {
    // Binary search for the line containing this byte offset
    let lo = 0, hi = lineOffsets.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (lineOffsets[mid]! <= offset) {
        if (mid === lineOffsets.length - 1 || lineOffsets[mid + 1]! > offset) return mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return 0;
  }

  // Track byte positions already consumed by a higher-priority match (e.g., TABLE inside TABLE).
  const consumed: Array<[number, number]> = [];
  function isConsumed(offset: number): boolean {
    for (const [lo, hi] of consumed) {
      if (offset >= lo && offset < hi) return true;
    }
    return false;
  }

  // Collect all matches across all DDL patterns
  interface Hit {
    matcher: DdlMatcher;
    name: string;
    matchOffset: number;  // start of the match in source
    nameOffset: number;   // approx start of name (used for line)
  }
  const hits: Hit[] = [];

  for (const matcher of DDL_MATCHERS) {
    matcher.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = matcher.pattern.exec(source)) !== null) {
      // Identifier name is in the LAST 4 capture groups (the IDENT pattern)
      const groupCount = m.length - 1;
      const name = pickName(m, Math.max(1, groupCount - 3));
      if (!name) continue;

      // Find the actual CREATE keyword within the match string (skip leading whitespace/separator)
      const matchStr = m[0]!;
      const localCreateIdx = matchStr.toUpperCase().indexOf("CREATE");
      if (localCreateIdx === -1) continue;
      const createOffset = m.index + localCreateIdx;

      hits.push({
        matcher,
        name,
        matchOffset: createOffset,
        nameOffset: m.index + m[0].length - name.length,
      });
    }
  }

  // Sort by source position
  hits.sort((a, b) => a.matchOffset - b.matchOffset);

  for (const hit of hits) {
    if (isConsumed(hit.matchOffset)) continue;

    const startLineIdx = offsetToLine(hit.matchOffset);
    const startLine = startLineIdx + 1; // 1-based

    // Compute byte-precise end of construct from source, then map to line
    const endByteOffset = findEndByte(source, hit.matchOffset, hit.matcher.endStrategy);
    const endLineIdx = offsetToLine(endByteOffset);
    const endLine = endLineIdx + 1;

    // Mark only the actual byte range as consumed (not the whole rest of the file)
    consumed.push([hit.matchOffset, endByteOffset + 1]);

    const blockSource = origLines.slice(startLineIdx, endLineIdx + 1).join("\n");
    const docstring = extractSqlDocstring(lines, startLineIdx);

    const signature = hit.matcher.kind === "table"
      ? buildTableSignature(hit.name, lines, startLineIdx, endLineIdx)
      : `${hit.matcher.kind.toUpperCase()} ${hit.name}`;

    const sym: CodeSymbol = {
      id: makeSymbolId(repo, filePath, hit.name, startLine),
      repo,
      name: hit.name,
      kind: hit.matcher.kind,
      file: filePath,
      start_line: startLine,
      end_line: endLine,
      signature,
      source: blockSource.length > MAX_SOURCE_LENGTH
        ? blockSource.slice(0, MAX_SOURCE_LENGTH) + "..."
        : blockSource,
      tokens: tokenizeIdentifier(hit.name),
    };
    if (docstring) sym.docstring = docstring;
    symbols.push(sym);

    if (hit.matcher.kind === "table") {
      const fields = extractColumns(lines, startLineIdx, endLineIdx, filePath, repo, sym.id, hit.matchOffset, source);
      symbols.push(...fields);
    }
  }

  return symbols;
}
