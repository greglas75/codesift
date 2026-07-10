import type { SymbolKind } from "../../types.js";
export interface DdlMatcher {
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
export function pickName(m: RegExpExecArray, offset: number): string | null {
  return m[offset] ?? m[offset + 1] ?? m[offset + 2] ?? m[offset + 3] ?? null;
}

export const DDL_MATCHERS: DdlMatcher[] = [
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
