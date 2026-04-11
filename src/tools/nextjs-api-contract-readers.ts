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

export function extractHttpMethods(_tree: Parser.Tree): HttpMethodInfo {
  throw new Error("not implemented");
}

export function extractQueryParams(
  _tree: Parser.Tree,
  _source: string,
): QueryParam[] | "*" {
  throw new Error("not implemented");
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
