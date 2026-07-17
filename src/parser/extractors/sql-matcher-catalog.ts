import type { SymbolKind } from "../../types.js";
import type { SqlEndStrategy } from "./sql-boundaries.js";

export interface DdlMatcher {
  pattern: RegExp;
  kind: SymbolKind;
  endStrategy: SqlEndStrategy;
}

const IDENT = String.raw`(?:"([^"]+)"|\x60([^\x60]+)\x60|\[([^\]]+)\]|([\w#$]+))`;
const QUALIFIED = String.raw`(?:(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[\w#$]+)\s*\.\s*)?` + IDENT;
const create = (prefix: string, suffix = "") => new RegExp(
  String.raw`(?:^|[;\s])\s*CREATE\s+` + prefix + suffix,
  "gi",
);

export const DDL_MATCHERS: DdlMatcher[] = [
  { pattern: create(String.raw`(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`, QUALIFIED + String.raw`\s*\(`), kind: "table", endStrategy: "paren" },
  { pattern: create(String.raw`(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?`, QUALIFIED), kind: "view", endStrategy: "semicolon" },
  { pattern: create(String.raw`(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?`, QUALIFIED), kind: "index", endStrategy: "semicolon" },
  { pattern: create(String.raw`(?:OR\s+REPLACE\s+)?FUNCTION\s+`, QUALIFIED), kind: "function", endStrategy: "begin-end" },
  { pattern: create(String.raw`(?:OR\s+REPLACE\s+)?PROCEDURE\s+`, QUALIFIED), kind: "procedure", endStrategy: "begin-end" },
  { pattern: create(String.raw`(?:OR\s+REPLACE\s+)?TRIGGER\s+`, QUALIFIED), kind: "trigger", endStrategy: "begin-end" },
  { pattern: create(String.raw`SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?`, IDENT), kind: "namespace", endStrategy: "semicolon" },
  { pattern: create(String.raw`TYPE\s+`, QUALIFIED), kind: "type", endStrategy: "semicolon" },
  { pattern: create(String.raw`SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?`, QUALIFIED), kind: "variable", endStrategy: "semicolon" },
];
