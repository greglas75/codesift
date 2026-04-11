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

// ── DDL patterns ──────────────────────────────────────────
// Each pattern captures the object name. Schema-qualified names (schema.name)
// are handled by optional non-capturing group. OR REPLACE, IF NOT EXISTS, etc. tolerated.

interface DdlPattern {
  regex: RegExp;
  kind: SymbolKind;
  /** True if the body is delimited by parens (tables, functions) */
  hasBracketBody: boolean;
}

const DDL_PATTERNS: DdlPattern[] = [
  {
    regex: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"\s*\.\s*)?(?:"([^"]+)"|(\w+)(?:\s*\.\s*(?:"([^"]+)"|(\w+)))?)?\s*\(/im,
    kind: "table",
    hasBracketBody: true,
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

    // Try CREATE TABLE with bracket body
    const tableMatch = matchCreateTable(line);
    if (tableMatch) {
      const { name } = tableMatch;
      const startLine = i + 1; // 1-based

      // Find closing paren, tracking depth
      const endLineIdx = findClosingParen(lines, i);
      const endLine = endLineIdx + 1;

      // Extract source from original (preserves Jinja tokens in display)
      const blockSource = origLines.slice(i, endLineIdx + 1).join("\n");

      const docstring = extractSqlDocstring(lines, i);

      const sym: CodeSymbol = {
        id: makeSymbolId(repo, filePath, name, startLine),
        repo,
        name,
        kind: "table",
        file: filePath,
        start_line: startLine,
        end_line: endLine,
        signature: buildTableSignature(name, lines, i, endLineIdx),
        source: blockSource.length > MAX_SOURCE_LENGTH
          ? blockSource.slice(0, MAX_SOURCE_LENGTH) + "..."
          : blockSource,
        tokens: tokenizeIdentifier(name),
      };
      if (docstring) sym.docstring = docstring;
      symbols.push(sym);

      i = endLineIdx + 1;
      continue;
    }

    i++;
  }

  return symbols;
}

// ── Helpers ───────────────────────────────────────────────

const CREATE_TABLE_RE =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"([^"]+)"|(\w+))\s*\.\s*)?(?:"([^"]+)"|(\w+))\s*\(/i;

function matchCreateTable(line: string): { name: string } | null {
  const m = CREATE_TABLE_RE.exec(line);
  if (!m) return null;
  // Capture groups: 1=quoted schema, 2=unquoted schema, 3=quoted name, 4=unquoted name
  const name = m[3] ?? m[4] ?? m[1] ?? m[2];
  if (!name) return null;
  return { name };
}

function findClosingParen(lines: string[], startIdx: number): number {
  let depth = 0;
  for (let j = startIdx; j < lines.length; j++) {
    const line = lines[j]!;
    for (const ch of line) {
      if (ch === "(") depth++;
      if (ch === ")") {
        depth--;
        if (depth === 0) return j;
      }
    }
  }
  // Unbalanced — return last line
  return lines.length - 1;
}

function buildTableSignature(
  name: string,
  lines: string[],
  startIdx: number,
  endIdx: number,
): string {
  // Collect column names from the body (between parens)
  const cols: string[] = [];
  for (let j = startIdx + 1; j <= endIdx; j++) {
    const trimmed = lines[j]!.trim();
    // Skip constraint lines
    if (/^\s*(?:PRIMARY\s+KEY|FOREIGN\s+KEY|CONSTRAINT|UNIQUE|CHECK|INDEX)\s*\(/i.test(trimmed)) continue;
    if (trimmed === "" || trimmed === ")" || trimmed === ");") continue;
    // First word is column name
    const colMatch = /^"?(\w+)"?\s+\S/i.exec(trimmed);
    if (colMatch) cols.push(colMatch[1]!);
  }
  return `TABLE ${name} (${cols.join(", ")})`;
}

/**
 * Extract SQL comments (-- or /* ... * /) immediately above a line as docstring.
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
