import { readFile } from "node:fs/promises";
import type Parser from "web-tree-sitter";
import { classifyZodField, stripQuotes } from "../astro-helpers.js";
import type { ParsedField } from "./types.js";

export function extractSchemaFields(schemaNode: Parser.SyntaxNode): ParsedField[] {
  let target: Parser.SyntaxNode | null = null;
  const stack: Parser.SyntaxNode[] = [schemaNode];
  while (stack.length > 0) {
    const node = stack.shift()!;
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn?.type === "member_expression") {
        const prop = fn.childForFieldName("property");
        if (prop?.text === "object") {
          target = node;
          break;
        }
      }
    }
    for (const child of node.namedChildren) stack.push(child);
  }
  if (!target) return [];

  const args = target.childForFieldName("arguments");
  const obj = args?.namedChildren.find((node) => node.type === "object");
  if (!obj) return [];

  const fields: ParsedField[] = [];
  for (const pair of obj.namedChildren) {
    if (pair.type !== "pair") continue;
    const keyNode = pair.childForFieldName("key");
    const valueNode = pair.childForFieldName("value");
    if (!keyNode || !valueNode) continue;
    const name = keyNode.type === "string" ? stripQuotes(keyNode.text) : keyNode.text;
    const classified = classifyZodField(valueNode);
    const field: ParsedField = {
      name,
      type: classified.type,
      required: classified.required,
    };
    if (classified.references) field.references = classified.references;
    fields.push(field);
  }
  return fields;
}

function parseInlineArray(value: string): string[] {
  return value
    .slice(1, -1)
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter((item) => item.length > 0);
}

function parseFrontmatterValue(value: string): unknown {
  if (value === "") return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) return parseInlineArray(value);
  return value.replace(/^["']|["']$/g, "");
}

export function parseFrontmatter(source: string): Record<string, unknown> | null {
  const match = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return null;
  const body = match[1]!;
  const out: Record<string, unknown> = {};
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, "  ");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (/^\s/.test(line)) continue;
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]!;
    out[key] = parseFrontmatterValue(kv[2]!.trim());
  }
  return out;
}

export async function parseJsonEntry(absPath: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(absPath, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
