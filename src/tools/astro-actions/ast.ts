import type Parser from "web-tree-sitter";

const MAX_AST_DEPTH = 400;

export function stripActionQuotes(value: string): string {
  return (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]
    ? value.slice(1, -1)
    : value;
}

export function getActionProperty(
  objectNode: Parser.SyntaxNode,
  name: string,
): Parser.SyntaxNode | null {
  for (const pair of objectNode.namedChildren) {
    if (pair.type !== "pair") continue;
    const key = pair.childForFieldName("key");
    if (key && stripActionQuotes(key.text) === name) {
      return pair.childForFieldName("value") ?? null;
    }
  }
  return null;
}

/** Walk every descendant of a node, with a defensive depth cap. */
export function walkAll(
  node: Parser.SyntaxNode,
  visit: (node: Parser.SyntaxNode) => void,
  depth = 0,
): void {
  if (depth > MAX_AST_DEPTH) return;
  visit(node);
  for (const child of node.namedChildren) walkAll(child, visit, depth + 1);
}

/** Return the receiver of a member-call expression. */
export function receiverOfCall(call: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const callable = call.childForFieldName("function");
  if (!callable || callable.type !== "member_expression") return null;
  return callable.childForFieldName("object");
}

/** Return the method name of a member-call expression. */
export function methodName(call: Parser.SyntaxNode): string | null {
  const callable = call.childForFieldName("function");
  if (!callable || callable.type !== "member_expression") return null;
  return callable.childForFieldName("property")?.text ?? null;
}

/** Resolve a chained Zod expression to its underlying z.object call. */
export function unwrapZodChain(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let current: Parser.SyntaxNode | null = node;
  while (current?.type === "call_expression") {
    const name = methodName(current);
    if (name === "object") return current;
    if (name === null) return null;
    current = receiverOfCall(current);
  }
  return null;
}

function isFunctionBoundary(node: Parser.SyntaxNode): boolean {
  return node.type === "function_declaration"
    || node.type === "function_expression"
    || node.type === "arrow_function"
    || node.type === "method_definition";
}

function containsOwnedReturn(node: Parser.SyntaxNode, root: Parser.SyntaxNode): boolean {
  if (node.type === "return_statement") return true;
  if (node !== root && isFunctionBoundary(node)) return false;
  return node.namedChildren.some((child) => containsOwnedReturn(child, root));
}

/** Detect a return owned by the handler rather than a nested callback. */
export function handlerHasTopLevelReturn(handler: Parser.SyntaxNode): boolean {
  const body = handler.childForFieldName("body");
  if (!body) return false;
  if (body.type !== "statement_block") return true;
  return containsOwnedReturn(body, body);
}
