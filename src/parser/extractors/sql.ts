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
 * DML (INSERT, UPDATE, DELETE, SELECT) is intentionally skipped.
 */

import type { CodeSymbol, SymbolKind } from "../../types.js";
import { tokenizeIdentifier, makeSymbolId } from "../symbol-extractor.js";

const MAX_SOURCE_LENGTH = 5000;

// ── Line-level DDL matchers ──────────────────────────────
// Each returns { name } if the line starts a DDL of that type, else null.
// Schema-qualified names: prefer the part after the dot.

interface DdlMatcher {
  /** Global regex used with String.matchAll over the full source */
  pattern: RegExp;
  kind: SymbolKind;
  /** How to find the end of this construct */
  endStrategy: "paren" | "semicolon" | "begin-end" | "single-line";
}

// Identifier pattern: accepts double-quotes, backticks (MySQL), brackets (SQL Server),
// or unquoted with optional schema prefix and Joomla-style #__name chars.
// Captures the unqualified name (last part after optional schema dot).
// Single ident: "x" | `x` | [x] | x (where x can include _, digits, #, $)
const IDENT = String.raw`(?:"([^"]+)"|\x60([^\x60]+)\x60|\[([^\]]+)\]|([\w#$]+))`;

// Schema-qualified: optional "schema". prefix
const QUALIFIED = String.raw`(?:(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[\w#$]+)\s*\.\s*)?` + IDENT;

/** Extract identifier name from match groups (4 capture groups per IDENT) */
function pickName(m: RegExpExecArray, offset: number): string | null {
  return m[offset] ?? m[offset + 1] ?? m[offset + 2] ?? m[offset + 3] ?? null;
}

const DDL_MATCHERS: DdlMatcher[] = [
  {
    pattern: new RegExp(
      String.raw`(?:^|[;\s])\s*CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?` + QUALIFIED + String.raw`\s*\(`,
      "gi",
    ),
    kind: "table",
    endStrategy: "paren",
  },
  {
    pattern: new RegExp(
      String.raw`(?:^|[;\s])\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?` + QUALIFIED,
      "gi",
    ),
    kind: "view",
    endStrategy: "semicolon",
  },
  {
    pattern: new RegExp(
      String.raw`(?:^|[;\s])\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?` + QUALIFIED,
      "gi",
    ),
    kind: "index",
    endStrategy: "semicolon",
  },
  {
    pattern: new RegExp(
      String.raw`(?:^|[;\s])\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+` + QUALIFIED,
      "gi",
    ),
    kind: "function",
    endStrategy: "begin-end",
  },
  {
    pattern: new RegExp(
      String.raw`(?:^|[;\s])\s*CREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s+` + QUALIFIED,
      "gi",
    ),
    kind: "procedure",
    endStrategy: "begin-end",
  },
  {
    pattern: new RegExp(
      String.raw`(?:^|[;\s])\s*CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+` + QUALIFIED,
      "gi",
    ),
    kind: "trigger",
    endStrategy: "begin-end",
  },
  {
    pattern: new RegExp(
      String.raw`(?:^|[;\s])\s*CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?` + IDENT,
      "gi",
    ),
    kind: "namespace",
    endStrategy: "semicolon",
  },
  {
    pattern: new RegExp(
      String.raw`(?:^|[;\s])\s*CREATE\s+TYPE\s+` + QUALIFIED,
      "gi",
    ),
    kind: "type",
    endStrategy: "semicolon",
  },
  {
    pattern: new RegExp(
      String.raw`(?:^|[;\s])\s*CREATE\s+SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?` + QUALIFIED,
      "gi",
    ),
    kind: "variable",
    endStrategy: "semicolon",
  },
];

/**
 * Extract symbols from a SQL file without tree-sitter.
 * @param source      SQL source text (or Jinja-stripped text for sql-jinja files)
 * @param filePath    Relative file path within repo
 * @param repo        Repository identifier
 * @param originalSource  If source was Jinja-stripped, pass the original for the `source` field
 */
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
    if (source.charCodeAt(k) === 10 /* \n */) lineOffsets.push(k + 1);
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

// ── Column extraction ─────────────────────────────────────

const CONSTRAINT_RE = /^\s*(?:PRIMARY\s+KEY|FOREIGN\s+KEY|CONSTRAINT|UNIQUE|CHECK|INDEX|KEY|FULLTEXT)\b/i;
// Column name: backtick, double-quote, bracket, or unquoted with #/$ allowed
const COLUMN_RE = /^\s*(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|([\w#$]+))\s+(.+)/i;

function extractColumns(
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

/** Slice the contents between matching parens starting at openIdx (string-aware). */
function sliceBalancedParens(source: string, openIdx: number): string | null {
  if (source[openIdx] !== "(") return null;
  let depth = 0;
  let inString = false;
  let stringQuote = "";
  for (let k = openIdx; k < source.length; k++) {
    const ch = source[k]!;
    if (inString) {
      if (ch === stringQuote && source[k + 1] === stringQuote) { k++; continue; }
      if (ch === stringQuote) inString = false;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = true;
      stringQuote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return source.slice(openIdx + 1, k);
    }
  }
  return null;
}

/** Split a string on commas at parens-depth 0, ignoring commas inside strings/parens. */
function splitTopLevelCommas(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let stringQuote = "";
  let start = 0;
  for (let k = 0; k < body.length; k++) {
    const ch = body[k]!;
    if (inString) {
      if (ch === stringQuote && body[k + 1] === stringQuote) { k++; continue; }
      if (ch === stringQuote) inString = false;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = true;
      stringQuote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(body.slice(start, k));
      start = k + 1;
    }
  }
  if (start < body.length) out.push(body.slice(start));
  return out;
}

// ── Byte-precise end finding (for source-string scanning) ─

function findEndByte(source: string, startOffset: number, strategy: string): number {
  switch (strategy) {
    case "paren":
      return findClosingParenByte(source, startOffset);
    case "semicolon":
      return findSemicolonByte(source, startOffset);
    case "begin-end":
      return findBeginEndByte(source, startOffset);
    case "single-line":
      return source.indexOf("\n", startOffset) ?? source.length - 1;
    default:
      return findSemicolonByte(source, startOffset);
  }
}

/** Scan source for next `;` outside strings/comments */
function findSemicolonByte(source: string, startOffset: number): number {
  let inString = false;
  let stringQuote = "";
  let inLineComment = false;
  for (let k = startOffset; k < source.length; k++) {
    const ch = source[k]!;
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inString) {
      if (ch === stringQuote && source[k + 1] === stringQuote) { k++; continue; }
      if (ch === stringQuote) inString = false;
      continue;
    }
    if (ch === "-" && source[k + 1] === "-") { inLineComment = true; k++; continue; }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = true;
      stringQuote = ch;
      continue;
    }
    if (ch === ";") return k;
  }
  return source.length - 1;
}

/** Scan source for matching closing paren outside strings/comments */
function findClosingParenByte(source: string, startOffset: number): number {
  // First find the opening paren
  let openIdx = source.indexOf("(", startOffset);
  if (openIdx === -1) return findSemicolonByte(source, startOffset);

  let depth = 0;
  let inString = false;
  let stringQuote = "";
  let inLineComment = false;
  for (let k = openIdx; k < source.length; k++) {
    const ch = source[k]!;
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inString) {
      if (ch === stringQuote && source[k + 1] === stringQuote) { k++; continue; }
      if (ch === stringQuote) inString = false;
      continue;
    }
    if (ch === "-" && source[k + 1] === "-") { inLineComment = true; k++; continue; }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = true;
      stringQuote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        // Also include trailing semicolon if present nearby
        const semi = source.indexOf(";", k);
        if (semi !== -1 && semi - k < 200) return semi;
        return k;
      }
    }
  }
  return source.length - 1;
}

/** Scan source for BEGIN...END or fall back to semicolon */
function findBeginEndByte(source: string, startOffset: number): number {
  // Simplified: just use semicolon scan (BEGIN/END structures are rare in our test corpus)
  return findSemicolonByte(source, startOffset);
}

// ── Line-based end-finding (legacy, used for column extraction) ─

function findEnd(lines: string[], startIdx: number, strategy: string): number {
  switch (strategy) {
    case "paren":
      return findClosingParen(lines, startIdx);
    case "semicolon":
      return findSemicolon(lines, startIdx);
    case "begin-end":
      return findBeginEnd(lines, startIdx);
    case "single-line":
      return startIdx;
    default:
      return findSemicolon(lines, startIdx);
  }
}

/**
 * Scan a line character-by-character, skipping chars inside single-quoted
 * strings and after -- comments. Calls `onChar(ch)` for each non-skipped
 * character. Returns true if the callback returned true (early exit).
 */
function scanSqlLine(line: string, onChar: (ch: string) => boolean): boolean {
  let inString = false;
  for (let k = 0; k < line.length; k++) {
    const ch = line[k]!;
    if (inString) {
      if (ch === "'" && line[k + 1] === "'") { k++; continue; } // escaped ''
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") { inString = true; continue; }
    if (ch === "-" && line[k + 1] === "-") break; // rest is comment
    if (onChar(ch)) return true;
  }
  return false;
}

function findClosingParen(lines: string[], startIdx: number): number {
  let depth = 0;
  for (let j = startIdx; j < lines.length; j++) {
    const found = scanSqlLine(lines[j]!, (ch) => {
      if (ch === "(") depth++;
      if (ch === ")") { depth--; if (depth === 0) return true; }
      return false;
    });
    if (found) return j;
  }
  return lines.length - 1;
}

function findSemicolon(lines: string[], startIdx: number): number {
  for (let j = startIdx; j < lines.length; j++) {
    const found = scanSqlLine(lines[j]!, (ch) => ch === ";");
    if (found) return j;
  }
  return lines.length - 1;
}

function findBeginEnd(lines: string[], startIdx: number): number {
  let foundBegin = false;
  let depth = 0;
  for (let j = startIdx; j < lines.length; j++) {
    // Strip strings/comments before keyword matching
    let cleaned = "";
    scanSqlLine(lines[j]!, (ch) => { cleaned += ch; return false; });
    const upper = cleaned.toUpperCase().trim();

    if (/\bBEGIN\b/.test(upper)) {
      foundBegin = true;
      depth++;
    }
    if (foundBegin && /\bEND\b/.test(upper)) {
      depth--;
      if (depth === 0) return j;
    }
    if (!foundBegin && j > startIdx && upper === ";") return j;
  }
  return findSemicolon(lines, startIdx);
}

// ── Helpers ───────────────────────────────────────────────

function buildTableSignature(
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

/**
 * Extract SQL comments (-- single-line or /* block * /) immediately above a DDL line as docstring.
 */
function extractSqlDocstring(lines: string[], blockLineIdx: number): string | undefined {
  const commentLines: string[] = [];
  let inBlock = false;

  for (let j = blockLineIdx - 1; j >= 0; j--) {
    const trimmed = lines[j]!.trim();

    // Detect end of block comment (scanning upward, so */ comes first)
    if (!inBlock && trimmed.endsWith("*/")) {
      inBlock = true;
      // Handle single-line block comment: /* text */
      if (trimmed.startsWith("/*")) {
        commentLines.unshift(trimmed.slice(2, -2).trim());
        inBlock = false;
        continue;
      }
      const content = trimmed.replace(/\*\/\s*$/, "").replace(/^\s*\*\s?/, "").trim();
      if (content) commentLines.unshift(content);
      continue;
    }
    if (inBlock) {
      if (trimmed.startsWith("/*")) {
        const content = trimmed.replace(/^\/\*\s*/, "").trim();
        if (content) commentLines.unshift(content);
        inBlock = false;
        continue;
      }
      // Middle of block comment — strip leading *
      commentLines.unshift(trimmed.replace(/^\s*\*\s?/, ""));
      continue;
    }

    if (trimmed.startsWith("--")) {
      commentLines.unshift(trimmed.replace(/^--\s*/, ""));
    } else if (trimmed === "") {
      if (commentLines.length > 0) break;
    } else {
      break;
    }
  }
  return commentLines.length > 0 ? commentLines.join("\n") : undefined;
}

/**
 * Strip Jinja/dbt template tokens from SQL source while preserving line structure.
 * Every non-newline character inside Jinja markers is replaced with a space,
 * ensuring line numbers in the stripped source map 1:1 to the original file.
 */
export function stripJinjaTokens(source: string): string {
  const preserveLines = (match: string) => match.replace(/[^\n]/g, " ");
  return source
    .replace(/\{#[\s\S]*?#\}/g, preserveLines)    // Jinja comments
    .replace(/\{%[\s\S]*?%\}/g, preserveLines)    // Jinja blocks
    .replace(/\{\{[\s\S]*?\}\}/g, preserveLines); // Jinja expressions
}
