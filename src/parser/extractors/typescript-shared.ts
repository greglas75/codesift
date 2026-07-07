import type Parser from "web-tree-sitter";
import type { CodeSymbol } from "../../types.js";
import { MAX_SOURCE_LENGTH } from "./_shared.js";

export { getNodeName, makeSymbol } from "./_shared.js";

/** Matches top-level SCREAMING_CASE identifiers like MAX_RETRIES, API_URL */
export const SCREAMING_CASE_RE = /^[A-Z][A-Z0-9_]+$/;

export interface TypeScriptExtractorContext {
  source: string;
  filePath: string;
  repo: string;
  symbols: CodeSymbol[];
  localReExported: Set<string>;
  cjsExported: Set<string>;
  ambientFnSigOverloadCount: Map<string, number>;
}

export type WalkNode = (
  node: Parser.SyntaxNode,
  parentId?: string,
  isExported?: boolean,
) => void;

export function getDocstring(
  node: Parser.SyntaxNode,
  source: string,
): string | undefined {
  const prev = node.previousNamedSibling;
  if (!prev) return undefined;

  if (prev.type === "comment") {
    const text = source.slice(prev.startIndex, prev.endIndex);
    if (text.startsWith("/**") || text.startsWith("//")) {
      return text;
    }
  }
  return undefined;
}

function getDecoratorText(node: Parser.SyntaxNode): string {
  return node.text.trim();
}

function collectOwnDecorators(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  return node.namedChildren.filter((child) => child.type === "decorator");
}

function collectLeadingSiblingDecorators(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const decorators: Parser.SyntaxNode[] = [];
  let sibling = node.previousNamedSibling;
  while (sibling && sibling.type === "decorator") {
    decorators.unshift(sibling);
    sibling = sibling.previousNamedSibling;
  }
  return decorators;
}

export function getDecorators(node: Parser.SyntaxNode): string[] {
  const decoratorNodes = [
    ...collectOwnDecorators(node),
    ...collectLeadingSiblingDecorators(node),
  ];
  if (decoratorNodes.length === 0) return [];

  const seen = new Set<string>();
  const decorators: string[] = [];
  for (const decorator of decoratorNodes) {
    const text = getDecoratorText(decorator);
    if (seen.has(text)) continue;
    seen.add(text);
    decorators.push(text);
  }
  return decorators;
}

export function getSignature(
  node: Parser.SyntaxNode,
  source: string,
): string | undefined {
  const params = node.childForFieldName("parameters");
  if (!params) return undefined;

  let sig = "";
  const typeParams = node.childForFieldName("type_parameters");
  if (typeParams) {
    sig += source.slice(typeParams.startIndex, typeParams.endIndex);
  }
  sig += source.slice(params.startIndex, params.endIndex);

  const returnType = node.childForFieldName("return_type");
  if (returnType) {
    sig += source.slice(returnType.startIndex, returnType.endIndex);
  }

  return sig;
}

/** True if the declaration has an `export` keyword child (modifier-based export). */
export function hasExportModifier(node: Parser.SyntaxNode): boolean {
  for (const child of node.children) {
    if (child.type === "export") return true;
  }
  return false;
}

/** True if the function/method/arrow has an `async` keyword child. */
export function hasAsyncModifier(node: Parser.SyntaxNode): boolean {
  for (const child of node.children) {
    if (child.type === "async") return true;
    if (child.type === "ERROR" && /^\s*async\b/.test(child.text)) return true;
  }
  return false;
}

/** Strip `export default ((...))` wrappers. */
export function unwrapParentheses(node: Parser.SyntaxNode): Parser.SyntaxNode {
  let cur = node;
  while (cur.type === "parenthesized_expression" && cur.namedChildren.length > 0) {
    const inner = cur.namedChildren[0];
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

export function truncateSourceShell(source: string): string {
  if (source.length > MAX_SOURCE_LENGTH) {
    return source.slice(0, MAX_SOURCE_LENGTH) + "...";
  }
  return source;
}
