import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type Parser from "web-tree-sitter";
import { getProperty, isLiteral, stripQuotes } from "../astro-helpers.js";
import { extractSchemaFields } from "./schema.js";
import type { DiscoveredConfig, LoaderInfo, RawCollection } from "./types.js";

const V5_CANDIDATES = ["src/content.config.ts", "src/content.config.mjs", "src/content.config.js"];
const LEGACY_CANDIDATES = ["src/content/config.ts", "src/content/config.mjs", "src/content/config.js"];

export async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function findFirstConfig(
  root: string,
  candidates: string[],
  version: DiscoveredConfig["version"],
): Promise<DiscoveredConfig | null> {
  for (const relPath of candidates) {
    const absPath = join(root, relPath);
    if ((await readTextFile(absPath)) !== null) {
      return { abs_path: absPath, rel_path: relPath, version };
    }
  }
  return null;
}

export async function findConfig(root: string): Promise<DiscoveredConfig | null> {
  return (await findFirstConfig(root, V5_CANDIDATES, "v5+"))
    ?? findFirstConfig(root, LEGACY_CANDIDATES, "legacy");
}

function extractLoader(
  loaderNode: Parser.SyntaxNode | null,
  configType: string | null,
): LoaderInfo {
  if (!loaderNode) return configType ? { kind: "glob" } : { kind: "unknown" };
  if (loaderNode.type !== "call_expression") return { kind: "custom" };

  const fnName = loaderNode.childForFieldName("function")?.text ?? "";
  if (fnName === "glob") return extractGlobLoader(loaderNode);
  if (fnName === "file") return extractFileLoader(loaderNode);
  return { kind: "custom" };
}

function extractGlobLoader(loaderNode: Parser.SyntaxNode): LoaderInfo {
  const args = loaderNode.childForFieldName("arguments");
  const obj = args?.namedChildren.find((node) => node.type === "object");
  if (!obj) return { kind: "glob" };
  const patternNode = getProperty(obj, "pattern");
  const baseNode = getProperty(obj, "base");
  const info: LoaderInfo = { kind: "glob" };
  if (patternNode && isLiteral(patternNode)) info.pattern = stripQuotes(patternNode.text);
  if (baseNode && isLiteral(baseNode)) info.base = stripQuotes(baseNode.text);
  return info;
}

function extractFileLoader(loaderNode: Parser.SyntaxNode): LoaderInfo {
  const args = loaderNode.childForFieldName("arguments");
  const first = args?.namedChildren.find((node) => isLiteral(node));
  const info: LoaderInfo = { kind: "file" };
  if (first) info.pattern = stripQuotes(first.text);
  return info;
}

function defineCollectionObject(call: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const fn = call.childForFieldName("function");
  if (fn?.text !== "defineCollection") return null;
  const args = call.childForFieldName("arguments");
  return args?.namedChildren.find((node) => node.type === "object") ?? null;
}

function extractRawCollection(name: string, defineObj: Parser.SyntaxNode): RawCollection {
  const loaderNode = getProperty(defineObj, "loader");
  const typeNode = getProperty(defineObj, "type");
  const schemaNode = getProperty(defineObj, "schema");
  const configType = typeNode && isLiteral(typeNode) ? stripQuotes(typeNode.text) : null;
  return {
    name,
    loader: extractLoader(loaderNode, configType),
    fields: schemaNode ? extractSchemaFields(schemaNode) : [],
  };
}

function collectLocalDefinitions(root: Parser.SyntaxNode): Map<string, Parser.SyntaxNode> {
  const definitions = new Map<string, Parser.SyntaxNode>();
  const walk = (node: Parser.SyntaxNode): void => {
    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      for (const declaration of node.namedChildren) {
        if (declaration.type !== "variable_declarator") continue;
        const nameNode = declaration.childForFieldName("name");
        const valueNode = declaration.childForFieldName("value");
        if (!nameNode || valueNode?.type !== "call_expression") continue;
        const object = defineCollectionObject(valueNode);
        if (object) definitions.set(nameNode.text, object);
      }
    }
    for (const child of node.namedChildren) walk(child);
  };
  walk(root);
  return definitions;
}

function resolveCollectionPair(
  pair: Parser.SyntaxNode,
  localDefinitions: Map<string, Parser.SyntaxNode>,
): RawCollection | null {
  if (pair.type === "shorthand_property_identifier") {
    const object = localDefinitions.get(pair.text);
    return object ? extractRawCollection(pair.text, object) : null;
  }
  if (pair.type !== "pair") return null;
  const keyNode = pair.childForFieldName("key");
  const valueNode = pair.childForFieldName("value");
  if (!keyNode || !valueNode) return null;
  const name = keyNode.type === "string" ? stripQuotes(keyNode.text) : keyNode.text;
  const object = valueNode.type === "identifier"
    ? localDefinitions.get(valueNode.text)
    : valueNode.type === "call_expression"
      ? defineCollectionObject(valueNode)
      : null;
  return object ? extractRawCollection(name, object) : null;
}

function collectExportedCollections(
  root: Parser.SyntaxNode,
  localDefinitions: Map<string, Parser.SyntaxNode>,
): RawCollection[] {
  const collections: RawCollection[] = [];
  for (const child of root.namedChildren) {
    if (child.type !== "export_statement") continue;
    const declaration = child.namedChildren.find(
      (node) => node.type === "lexical_declaration" || node.type === "variable_declaration",
    );
    if (!declaration) continue;
    for (const variable of declaration.namedChildren) {
      if (variable.type !== "variable_declarator") continue;
      const nameNode = variable.childForFieldName("name");
      const valueNode = variable.childForFieldName("value");
      if (nameNode?.text !== "collections" || valueNode?.type !== "object") continue;
      for (const pair of valueNode.namedChildren) {
        const collection = resolveCollectionPair(pair, localDefinitions);
        if (collection) collections.push(collection);
      }
    }
  }
  return collections;
}

export function discoverCollections(root: Parser.SyntaxNode): RawCollection[] {
  const localDefinitions = collectLocalDefinitions(root);
  const exported = collectExportedCollections(root, localDefinitions);
  if (exported.length > 0) return exported;
  return [...localDefinitions].map(([name, object]) => extractRawCollection(name, object));
}
