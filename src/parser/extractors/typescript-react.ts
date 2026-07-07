import type Parser from "web-tree-sitter";
import type { SymbolKind } from "../../types.js";

/** React wrapper functions that indicate a component */
const REACT_WRAPPER_NAMES = new Set(["memo", "forwardRef", "lazy"]);

/** Custom hook naming convention: starts with use + uppercase letter */
const CUSTOM_HOOK_RE = /^use[A-Z]/;

/** Component naming convention: starts with uppercase letter */
const COMPONENT_NAME_RE = /^[A-Z]/;

/** JSX node types that indicate a React component return */
const JSX_TYPES = new Set([
  "jsx_element", "jsx_self_closing_element", "jsx_fragment",
]);

/** React base class names that indicate a class component */
const REACT_COMPONENT_BASES = new Set([
  "Component", "PureComponent",
]);

export function isHookName(name: string): boolean {
  return CUSTOM_HOOK_RE.test(name);
}

export function isComponentName(name: string): boolean {
  return COMPONENT_NAME_RE.test(name);
}

export function returnsJSX(node: Parser.SyntaxNode): boolean {
  const body = node.childForFieldName("body");
  if (!body) return false;

  if (JSX_TYPES.has(body.type)) return true;

  if (body.type === "parenthesized_expression") {
    for (const child of body.namedChildren) {
      if (JSX_TYPES.has(child.type)) return true;
    }
  }

  const returns = body.descendantsOfType("return_statement");
  for (const ret of returns) {
    for (const child of ret.namedChildren) {
      if (JSX_TYPES.has(child.type)) return true;
      if (child.type === "parenthesized_expression") {
        for (const inner of child.namedChildren) {
          if (JSX_TYPES.has(inner.type)) return true;
        }
      }
    }
  }
  return false;
}

export function isReactWrapper(callExpr: Parser.SyntaxNode): boolean {
  const fn = callExpr.childForFieldName("function");
  if (!fn) return false;

  if (fn.type === "identifier" && REACT_WRAPPER_NAMES.has(fn.text)) return true;

  if (fn.type === "member_expression") {
    const prop = fn.childForFieldName("property");
    if (prop && REACT_WRAPPER_NAMES.has(prop.text)) return true;
  }

  return false;
}

export function getWrapperName(callExpr: Parser.SyntaxNode): string | null {
  const fn = callExpr.childForFieldName("function");
  if (!fn) return null;
  if (fn.type === "identifier") return fn.text;
  if (fn.type === "member_expression") {
    return fn.childForFieldName("property")?.text ?? null;
  }
  return null;
}

export function getWrappedFunction(callExpr: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const args = callExpr.childForFieldName("arguments");
  if (!args) return null;
  const firstArg = args.namedChildren[0];
  if (!firstArg) return null;
  if (firstArg.type === "arrow_function" || firstArg.type === "function_expression") {
    return firstArg;
  }
  return null;
}

export function extendsListIndicatesReactComponent(extendsList: string[]): boolean {
  for (const name of extendsList) {
    if (REACT_COMPONENT_BASES.has(name)) return true;
    const lastDot = name.lastIndexOf(".");
    if (lastDot >= 0 && REACT_COMPONENT_BASES.has(name.slice(lastDot + 1))) return true;
  }
  return false;
}

export function classifyReactKind(
  name: string,
  fnNode: Parser.SyntaxNode | null,
): SymbolKind {
  if (isHookName(name)) return "hook";
  if (isComponentName(name) && fnNode && returnsJSX(fnNode)) return "component";
  return "function";
}
