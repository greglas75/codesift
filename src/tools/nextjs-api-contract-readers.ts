/**
 * AST readers for Next.js API contract extraction (T3).
 *
 * Each reader is a focused, pure function that extracts a specific contract
 * signal from a parsed tree-sitter tree. The orchestrator in
 * `nextjs-api-contract-tools.ts` composes them into a `HandlerShape`.
 */

import type Parser from "web-tree-sitter";
import { extractZodSchema } from "../utils/nextjs.js";
import type {
  HttpMethod,
  HttpMethodInfo,
  QueryParam,
  RequestBodySchema,
  ResponseShape,
} from "./nextjs-api-contract-tools.js";

const HTTP_METHODS = new Set<HttpMethod>([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
]);

export function extractHttpMethods(tree: Parser.Tree): HttpMethodInfo {
  const methods = new Set<HttpMethod>();
  let wrapped = false;

  for (const exp of tree.rootNode.descendantsOfType("export_statement")) {
    // function declaration
    for (const fn of exp.descendantsOfType("function_declaration")) {
      const name = fn.childForFieldName("name")?.text;
      if (name && HTTP_METHODS.has(name as HttpMethod)) {
        methods.add(name as HttpMethod);
      }
    }
    // variable declarator: export const GET = ... or export const GET = withAuth(...)
    for (const decl of exp.descendantsOfType("variable_declarator")) {
      const name = decl.childForFieldName("name")?.text;
      if (!name || !HTTP_METHODS.has(name as HttpMethod)) continue;
      methods.add(name as HttpMethod);
      const value = decl.childForFieldName("value");
      if (value?.type === "call_expression") {
        wrapped = true;
      }
    }
  }

  return {
    methods: [...methods].sort() as HttpMethod[],
    wrapped,
  };
}

export function extractQueryParams(
  tree: Parser.Tree,
  source: string,
): QueryParam[] | "*" {
  // Heuristic: if the source contains `searchParams` or `URL(req.url)`, return wildcard.
  if (/\bnew\s+URL\s*\(/.test(source) && /searchParams/.test(source)) {
    return "*";
  }
  if (/\.searchParams\b/.test(source) || /\bsearchParams\.get\s*\(/.test(source)) {
    return "*";
  }

  // TODO: typed destructured searchParams param — left for follow-up.
  void tree;
  return [];
}

export function extractRequestBodySchema(
  tree: Parser.Tree,
  source: string,
): RequestBodySchema | null {
  const root = tree.rootNode;

  // 1) Form data
  if (/req\.formData\s*\(/.test(source)) {
    return { type: "form" };
  }

  // 2) Look for schema.parse(...) or schema.safeParse(...) calls
  for (const call of root.descendantsOfType("call_expression")) {
    const callee = call.childForFieldName("function") ?? call.namedChild(0);
    if (callee?.type !== "member_expression") continue;
    const obj = callee.childForFieldName("object") ?? callee.namedChild(0);
    const prop = callee.childForFieldName("property") ?? callee.namedChild(1);
    if (prop?.type !== "property_identifier") continue;
    if (prop.text !== "parse" && prop.text !== "safeParse") continue;
    if (obj?.type !== "identifier") continue;
    const schemaName = obj.text;

    // Try to resolve schemaName as a local variable_declarator
    let resolvedShape: Record<string, unknown> | null = null;
    for (const decl of root.descendantsOfType("variable_declarator")) {
      const name = decl.childForFieldName("name")?.text;
      if (name !== schemaName) continue;
      const value = decl.childForFieldName("value");
      if (!value) continue;
      // Use the global Zod schema extractor on the whole tree if any decl matches.
      const zod = extractZodSchema(tree, source);
      if (zod) {
        resolvedShape = zod.fields as unknown as Record<string, unknown>;
      }
      break;
    }

    if (resolvedShape) {
      return { fields: resolvedShape, resolved: true, type: "json" };
    }

    // Imported / unresolved
    return { ref: schemaName, resolved: false, type: "json" };
  }

  return null;
}

export function extractResponseShapes(
  _tree: Parser.Tree,
  _source: string,
): ResponseShape[] {
  throw new Error("not implemented");
}
