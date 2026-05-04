// Shared AST helpers for Astro tools (extracted from astro-content-collections).
import type Parser from "web-tree-sitter";

export function stripQuotes(s: string): string {
  if (s.length < 2) return s;
  const f = s[0], l = s[s.length - 1];
  if ((f === '"' || f === "'" || f === "`") && f === l) return s.slice(1, -1);
  return s;
}

export function getProperty(obj: Parser.SyntaxNode, name: string): Parser.SyntaxNode | null {
  for (const p of obj.namedChildren) {
    if (p.type !== "pair") continue;
    const k = p.childForFieldName("key");
    if (!k) continue;
    const keyText = k.type === "string" ? stripQuotes(k.text) : k.text;
    if (keyText === name) return p.childForFieldName("value") ?? null;
  }
  return null;
}

export function isLiteral(n: Parser.SyntaxNode): boolean {
  return n.type === "string" || n.type === "number" || n.type === "true"
    || n.type === "false" || n.type === "null" || n.type === "undefined";
}

export function innermostCall(node: Parser.SyntaxNode): Parser.SyntaxNode {
  let current = node;
  while (current.type === "call_expression") {
    const fn = current.childForFieldName("function");
    if (!fn || fn.type !== "member_expression") break;
    const obj = fn.childForFieldName("object");
    if (obj && obj.type === "call_expression") { current = obj; continue; }
    break;
  }
  return current;
}

export function methodChain(node: Parser.SyntaxNode): string[] {
  const chain: string[] = [];
  let current: Parser.SyntaxNode | null = node;
  while (current && current.type === "call_expression") {
    const fn = current.childForFieldName("function");
    if (!fn) break;
    if (fn.type === "member_expression") {
      const prop = fn.childForFieldName("property");
      const obj = fn.childForFieldName("object");
      if (prop) chain.unshift(prop.text);
      if (obj && obj.type === "call_expression") { current = obj; continue; }
      break;
    }
    if (fn.type === "identifier") { chain.unshift(fn.text); break; }
    break;
  }
  return chain;
}

export interface ZodFieldInfo { type: string; required: boolean; references?: string; }

export function classifyZodField(valueNode: Parser.SyntaxNode): ZodFieldInfo {
  let required = true;
  let cursor: Parser.SyntaxNode | null = valueNode;
  while (cursor && cursor.type === "call_expression") {
    const fn = cursor.childForFieldName("function");
    if (!fn) break;
    if (fn.type === "member_expression") {
      const prop = fn.childForFieldName("property");
      if (prop && (prop.text === "optional" || prop.text === "nullish"
          || prop.text === "nullable" || prop.text === "default")) required = false;
      const obj = fn.childForFieldName("object");
      if (obj && obj.type === "call_expression") { cursor = obj; continue; }
      cursor = obj;
      break;
    }
    if (fn.type === "identifier") break;
    break;
  }
  const base = innermostCall(valueNode);
  if (base.type !== "call_expression") return { type: "unknown", required };
  const baseFn = base.childForFieldName("function");
  if (!baseFn) return { type: "unknown", required };
  if (baseFn.type === "identifier" && baseFn.text === "reference") {
    const args = base.childForFieldName("arguments");
    const first = args?.namedChildren.find((n) => isLiteral(n));
    const ref = first ? stripQuotes(first.text) : undefined;
    const out: ZodFieldInfo = { type: "reference", required };
    if (ref) out.references = ref;
    return out;
  }
  if (baseFn.type === "member_expression") {
    const prop = baseFn.childForFieldName("property");
    if (prop) return { type: prop.text, required };
  }
  const chain = methodChain(valueNode);
  if (chain.length > 0) return { type: chain[0]!, required };
  return { type: "unknown", required };
}
