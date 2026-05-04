/**
 * Astro DB schema parser. Extracts `defineTable({ columns: { ... } })` calls
 * into a structured TableDef[] with column metadata + FK references.
 * Pure function (no I/O) — accepts source content and returns parsed schema.
 */
import type Parser from "web-tree-sitter";
import { getParser, initParser } from "../parser/parser-manager.js";
import { getProperty, stripQuotes } from "./astro-helpers.js";

export interface ColumnDef {
  name: string;
  type: string;
  primaryKey?: boolean;
  unique?: boolean;
  optional?: boolean;
  references?: string;
}

export interface TableDef {
  name: string;
  columns: ColumnDef[];
}

export interface DbParserIssue {
  code: "DB00";
  severity: "error" | "warning";
  message: string;
  line: number;
}

export interface DbParserResult {
  tables: TableDef[];
  issues: DbParserIssue[];
}

function parseColumnCall(callNode: Parser.SyntaxNode): { type: string; props: Map<string, Parser.SyntaxNode> } | null {
  if (callNode.type !== "call_expression") return null;
  const fn = callNode.childForFieldName("function");
  if (!fn || fn.type !== "member_expression") return null;
  const obj = fn.childForFieldName("object");
  const prop = fn.childForFieldName("property");
  if (!obj || obj.text !== "column" || !prop) return null;
  const type = prop.text;
  const args = callNode.childForFieldName("arguments");
  const props = new Map<string, Parser.SyntaxNode>();
  if (args) {
    const objArg = args.namedChildren.find((n) => n.type === "object");
    if (objArg) {
      for (const pair of objArg.namedChildren) {
        if (pair.type !== "pair") continue;
        const k = pair.childForFieldName("key");
        const v = pair.childForFieldName("value");
        if (!k || !v) continue;
        const keyText = k.type === "string" ? stripQuotes(k.text) : k.text;
        props.set(keyText, v);
      }
    }
  }
  return { type, props };
}

function parseReferences(node: Parser.SyntaxNode): string | null {
  // Pattern: () => Author.columns.id  →  arrow_function with body member_expression
  if (node.type === "arrow_function") {
    const body = node.childForFieldName("body");
    if (body && body.type === "member_expression") return memberToFkPath(body);
  }
  if (node.type === "member_expression") return memberToFkPath(node);
  return null;
}

function memberToFkPath(node: Parser.SyntaxNode): string | null {
  // Author.columns.id → "Author.id". Skip the middle `columns` segment.
  const parts: string[] = [];
  let cur: Parser.SyntaxNode | null = node;
  while (cur && cur.type === "member_expression") {
    const p = cur.childForFieldName("property");
    if (p) parts.unshift(p.text);
    cur = cur.childForFieldName("object");
  }
  if (cur && cur.type === "identifier") parts.unshift(cur.text);
  if (parts.length < 2) return null;
  // Drop "columns" segment(s) — they're a syntactic detail of Astro DB FK syntax,
  // not part of the logical reference path. Preserve all other segments so that
  // namespaced refs like `db.User.columns.id` resolve to `db.User.id`, not `db.id`.
  const filtered = parts.filter((p) => p !== "columns");
  return filtered.length >= 2 ? filtered.join(".") : null;
}

function parseTableCall(callNode: Parser.SyntaxNode): ColumnDef[] | null {
  const fn = callNode.childForFieldName("function");
  if (!fn || fn.text !== "defineTable") return null;
  const args = callNode.childForFieldName("arguments");
  const objArg = args?.namedChildren.find((n) => n.type === "object");
  if (!objArg) return [];
  const columnsObj = getProperty(objArg, "columns");
  if (!columnsObj || columnsObj.type !== "object") return [];

  const columns: ColumnDef[] = [];
  for (const pair of columnsObj.namedChildren) {
    if (pair.type !== "pair") continue;
    const keyNode = pair.childForFieldName("key");
    const valueNode = pair.childForFieldName("value");
    if (!keyNode || !valueNode) continue;
    const colName = keyNode.type === "string" ? stripQuotes(keyNode.text) : keyNode.text;
    const parsed = parseColumnCall(valueNode);
    if (!parsed) continue;
    const col: ColumnDef = { name: colName, type: parsed.type };
    const pk = parsed.props.get("primaryKey");
    if (pk && pk.text === "true") col.primaryKey = true;
    const uniq = parsed.props.get("unique");
    if (uniq && uniq.text === "true") col.unique = true;
    const opt = parsed.props.get("optional");
    if (opt && opt.text === "true") col.optional = true;
    const refs = parsed.props.get("references");
    if (refs) {
      const fk = parseReferences(refs);
      if (fk) col.references = fk;
    }
    columns.push(col);
  }
  return columns;
}

export async function parseAstroDbSchema(content: string): Promise<DbParserResult> {
  if (!content || content.trim() === "") return { tables: [], issues: [] };
  await initParser();
  const lang = /:\s*\w+\s*=>/.test(content) || /<[A-Z]/.test(content) ? "typescript" : "typescript";
  const parser = await getParser(lang);
  if (!parser) return { tables: [], issues: [{ code: "DB00", severity: "error", message: "TypeScript parser unavailable", line: 1 }] };
  let tree;
  try { tree = parser.parse(content); } catch {
    return { tables: [], issues: [{ code: "DB00", severity: "error", message: "Parse error in schema source", line: 1 }] };
  }
  try {
    const root = tree.rootNode;
    // Tolerate hasError — tree-sitter recovers and exposes valid sub-trees.
    // Aborting here would silently zero out a schema during in-flight edits.
    const issues: DbParserIssue[] = root.hasError
      ? [{ code: "DB00", severity: "warning", message: "Source has syntax errors; partial schema extracted", line: 1 }]
      : [];
    const tables: TableDef[] = [];
    // Walk variable declarations: `const Author = defineTable(...)`
    for (const lex of root.descendantsOfType("lexical_declaration")) {
      for (const v of lex.namedChildren) {
        if (v.type !== "variable_declarator") continue;
        const name = v.childForFieldName("name");
        const value = v.childForFieldName("value");
        if (!name || !value || value.type !== "call_expression") continue;
        const cols = parseTableCall(value);
        if (cols !== null) tables.push({ name: name.text, columns: cols });
      }
    }
    return { tables, issues };
  } finally { tree.delete(); }
}
