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

export type StructuredEntryParseResult =
  | { kind: "data"; entries: Record<string, unknown>[] }
  | { kind: "read-error" }
  | { kind: "parse-error" };

type YamlParser = (source: string) => unknown;

let cachedYamlParser: YamlParser | null = null;

async function loadYamlParser(): Promise<YamlParser | null> {
  if (cachedYamlParser) return cachedYamlParser;
  try {
    cachedYamlParser = (await import("yaml")).parse;
    return cachedYamlParser;
  } catch {
    return null;
  }
}

function normalizeStructuredEntries(value: unknown): StructuredEntryParseResult {
  let values: unknown[];
  if (Array.isArray(value)) {
    values = value;
  } else if (value && typeof value === "object") {
    const mappedValues = Object.values(value);
    const isObjectMap = mappedValues.length > 0
      && mappedValues.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
    values = isObjectMap ? mappedValues : [value];
  } else {
    values = [value];
  }
  if (values.length === 0) return { kind: "data", entries: [] };
  if (values.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    return { kind: "parse-error" };
  }
  return { kind: "data", entries: values as Record<string, unknown>[] };
}

async function parseYamlSource(source: string): Promise<StructuredEntryParseResult> {
  const parser = await loadYamlParser();
  if (!parser) return { kind: "parse-error" };
  try {
    return normalizeStructuredEntries(parser(source));
  } catch {
    return { kind: "parse-error" };
  }
}

export async function parseFrontmatter(
  source: string,
): Promise<StructuredEntryParseResult | null> {
  const match = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  return match ? parseYamlSource(match[1]!) : null;
}

async function readStructuredEntry(
  absPath: string,
  parser: (source: string) => Promise<StructuredEntryParseResult>,
): Promise<StructuredEntryParseResult> {
  let raw: string;
  try {
    raw = await readFile(absPath, "utf-8");
  } catch {
    return { kind: "read-error" };
  }
  return parser(raw);
}

export async function parseJsonEntry(absPath: string): Promise<StructuredEntryParseResult> {
  return readStructuredEntry(absPath, async (raw) => {
    try {
      return normalizeStructuredEntries(JSON.parse(raw) as unknown);
    } catch {
      return { kind: "parse-error" };
    }
  });
}

export async function parseYamlEntry(absPath: string): Promise<StructuredEntryParseResult> {
  return readStructuredEntry(absPath, parseYamlSource);
}
