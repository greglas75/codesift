/**
 * AST readers for Next.js API contract extraction (T3).
 *
 * Each reader is a focused, pure function that extracts a specific contract
 * signal from a parsed tree-sitter tree. The orchestrator in
 * `nextjs-api-contract-tools.ts` composes them into a `HandlerShape`.
 */

import type Parser from "web-tree-sitter";
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
  _tree: Parser.Tree,
  _source: string,
): RequestBodySchema | null {
  throw new Error("not implemented");
}

export function extractResponseShapes(
  _tree: Parser.Tree,
  _source: string,
): ResponseShape[] {
  throw new Error("not implemented");
}
