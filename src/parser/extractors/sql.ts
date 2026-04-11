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
  test: (line: string) => { name: string } | null;
  kind: SymbolKind;
  /** How to find the end of this construct */
  endStrategy: "paren" | "semicolon" | "begin-end" | "single-line";
}

function extractName(m: RegExpExecArray, offset: number): string | null {
  return m[offset + 2] ?? m[offset + 3] ?? m[offset] ?? m[offset + 1] ?? null;
}

const DDL_MATCHERS: DdlMatcher[] = [
  // CREATE TABLE name (
  {
    test: (line) => {
      const m = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"([^"]+)"|(\w+))\s*\.\s*)?(?:"([^"]+)"|(\w+))\s*\(/i.exec(line);
      return m ? { name: extractName(m, 1)! } : null;
    },
    kind: "table",
    endStrategy: "paren",
  },
  // CREATE [OR REPLACE] [MATERIALIZED] VIEW name
  {
    test: (line) => {
      const m = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"([^"]+)"|(\w+))\s*\.\s*)?(?:"([^"]+)"|(\w+))/i.exec(line);
      return m ? { name: extractName(m, 1)! } : null;
    },
    kind: "view",
    endStrategy: "semicolon",
  },
  // CREATE [UNIQUE] INDEX name
  {
    test: (line) => {
      const m = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"([^"]+)"|(\w+))\s*\.\s*)?(?:"([^"]+)"|(\w+))/i.exec(line);
      return m ? { name: extractName(m, 1)! } : null;
    },
    kind: "index",
    endStrategy: "semicolon",
  },
  // CREATE [OR REPLACE] FUNCTION name
  {
    test: (line) => {
      const m = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:(?:"([^"]+)"|(\w+))\s*\.\s*)?(?:"([^"]+)"|(\w+))/i.exec(line);
      return m ? { name: extractName(m, 1)! } : null;
    },
    kind: "function",
    endStrategy: "begin-end",
  },
  // CREATE [OR REPLACE] PROCEDURE name
  {
    test: (line) => {
      const m = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s+(?:(?:"([^"]+)"|(\w+))\s*\.\s*)?(?:"([^"]+)"|(\w+))/i.exec(line);
      return m ? { name: extractName(m, 1)! } : null;
    },
    kind: "procedure",
    endStrategy: "begin-end",
  },
  // CREATE [OR REPLACE] TRIGGER name
  {
    test: (line) => {
      const m = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(?:(?:"([^"]+)"|(\w+))\s*\.\s*)?(?:"([^"]+)"|(\w+))/i.exec(line);
      return m ? { name: extractName(m, 1)! } : null;
    },
    kind: "trigger",
    endStrategy: "begin-end",
  },
  // CREATE SCHEMA name
  {
    test: (line) => {
      const m = /^\s*CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|(\w+))/i.exec(line);
      return m ? { name: m[1] ?? m[2] ?? null } : null;
    },
    kind: "namespace",
    endStrategy: "semicolon",
  },
  // CREATE TYPE name
  {
    test: (line) => {
      const m = /^\s*CREATE\s+TYPE\s+(?:(?:"([^"]+)"|(\w+))\s*\.\s*)?(?:"([^"]+)"|(\w+))/i.exec(line);
      return m ? { name: extractName(m, 1)! } : null;
    },
    kind: "type",
    endStrategy: "semicolon",
  },
  // CREATE SEQUENCE name
  {
    test: (line) => {
      const m = /^\s*CREATE\s+SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"([^"]+)"|(\w+))\s*\.\s*)?(?:"([^"]+)"|(\w+))/i.exec(line);
      return m ? { name: extractName(m, 1)! } : null;
    },
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

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    let matched = false;
    for (const matcher of DDL_MATCHERS) {
      const result = matcher.test(line);
      if (!result || !result.name) continue;

      const { name } = result;
      const startLine = i + 1; // 1-based

      // Find end of construct
      const endLineIdx = findEnd(lines, i, matcher.endStrategy);
      const endLine = endLineIdx + 1;

      // Source from original (preserves Jinja tokens)
      const blockSource = origLines.slice(i, endLineIdx + 1).join("\n");

      const docstring = extractSqlDocstring(lines, i);

      const signature = matcher.kind === "table"
        ? buildTableSignature(name, lines, i, endLineIdx)
        : `${matcher.kind.toUpperCase()} ${name}`;

      const sym: CodeSymbol = {
        id: makeSymbolId(repo, filePath, name, startLine),
        repo,
        name,
        kind: matcher.kind,
        file: filePath,
        start_line: startLine,
        end_line: endLine,
        signature,
        source: blockSource.length > MAX_SOURCE_LENGTH
          ? blockSource.slice(0, MAX_SOURCE_LENGTH) + "..."
          : blockSource,
        tokens: tokenizeIdentifier(name),
      };
      if (docstring) sym.docstring = docstring;
      symbols.push(sym);

      // Extract column definitions as field children for tables
      if (matcher.kind === "table") {
        const fields = extractColumns(lines, i, endLineIdx, filePath, repo, sym.id);
        symbols.push(...fields);
      }

      i = endLineIdx + 1;
      matched = true;
      break;
    }

    if (!matched) i++;
  }

  return symbols;
}

// ── Column extraction ─────────────────────────────────────

const CONSTRAINT_RE = /^\s*(?:PRIMARY\s+KEY|FOREIGN\s+KEY|CONSTRAINT|UNIQUE|CHECK|INDEX)\b/i;
const COLUMN_RE = /^\s*"?(\w+)"?\s+(.+)/i;

function extractColumns(
  lines: string[],
  startIdx: number,
  endIdx: number,
  filePath: string,
  repo: string,
  parentId: string,
): CodeSymbol[] {
  const fields: CodeSymbol[] = [];
  for (let j = startIdx + 1; j <= endIdx; j++) {
    const trimmed = lines[j]!.trim();
    // Skip empty, closing paren, constraint lines
    if (trimmed === "" || trimmed === ")" || trimmed === ");") continue;
    if (CONSTRAINT_RE.test(trimmed)) continue;

    const m = COLUMN_RE.exec(trimmed);
    if (!m) continue;

    const colName = m[1]!;
    // Strip trailing comma from type declaration
    const colType = m[2]!.replace(/,\s*$/, "").trim();
    const fieldLine = j + 1; // 1-based

    fields.push({
      id: makeSymbolId(repo, filePath, `${colName}`, fieldLine),
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

// ── End-finding strategies ────────────────────────────────

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
