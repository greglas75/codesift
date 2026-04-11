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

const NAME_RE = String.raw`(?:(?:"([^"]+)"|(\w+))\s*\.\s*)?(?:"([^"]+)"|(\w+))`;
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

function findClosingParen(lines: string[], startIdx: number): number {
  let depth = 0;
  for (let j = startIdx; j < lines.length; j++) {
    for (const ch of lines[j]!) {
      if (ch === "(") depth++;
      if (ch === ")") {
        depth--;
        if (depth === 0) return j;
      }
    }
  }
  return lines.length - 1;
}

function findSemicolon(lines: string[], startIdx: number): number {
  for (let j = startIdx; j < lines.length; j++) {
    if (lines[j]!.includes(";")) return j;
  }
  return lines.length - 1;
}

function findBeginEnd(lines: string[], startIdx: number): number {
  // Look for BEGIN...END or fall back to semicolon after RETURN/AS
  let foundBegin = false;
  let depth = 0;
  for (let j = startIdx; j < lines.length; j++) {
    const upper = lines[j]!.toUpperCase().trim();
    if (/\bBEGIN\b/.test(upper)) {
      foundBegin = true;
      depth++;
    }
    if (foundBegin && /\bEND\b/.test(upper)) {
      depth--;
      if (depth === 0) return j;
    }
    // Fallback: if no BEGIN found and we hit a standalone semicolon
    if (!foundBegin && j > startIdx && upper === ";") return j;
  }
  // No BEGIN/END found — find semicolon
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
 * Extract SQL comments (-- single-line) immediately above a line as docstring.
 */
function extractSqlDocstring(lines: string[], blockLineIdx: number): string | undefined {
  const commentLines: string[] = [];
  for (let j = blockLineIdx - 1; j >= 0; j--) {
    const trimmed = lines[j]!.trim();
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
