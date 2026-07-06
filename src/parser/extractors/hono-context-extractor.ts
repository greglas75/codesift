import { readFile } from "node:fs/promises";
import type Parser from "web-tree-sitter";
import { getParser } from "../parser-manager.js";
import type { ContextVariable, HonoAppModel } from "./hono-model.js";
import { pickLanguage, stringLiteralValue, walk } from "./hono-ast-utils.js";

const CONTEXT_PARAM_NAMES = new Set(["c", "ctx", "context"]);

export class HonoContextExtractor {
  /**
   * Lightweight scan of an imported file (e.g., middleware) for context flow.
   * Does not extract routes or mounts, only c.set/c.get/c.var patterns.
   */
  async scanFileForContextFlow(
    file: string,
    model: HonoAppModel,
  ): Promise<void> {
    let source: string;
    try {
      source = await readFile(file, "utf-8");
    } catch {
      return;
    }
    const parser = await getParser(pickLanguage(file));
    if (!parser) return;
    const tree = parser.parse(source);
    if (!tree) return;
    try {
      this.walkContextFlow(tree.rootNode, file, model);
    } finally {
      tree.delete();
    }
  }

  /**
   * Walk for context variable flow: c.set("key", val), c.get("key"), c.var.key.
   * Detects conditional sets when the access appears inside if/switch/catch.
   */
  walkContextFlow(
    root: Parser.SyntaxNode,
    file: string,
    model: HonoAppModel,
  ): void {
    const varsMap = new Map<string, ContextVariable>();
    const getOrCreate = (name: string, isEnv: boolean): ContextVariable => {
      let contextVar = varsMap.get(name);
      if (!contextVar) {
        contextVar = { name, set_points: [], get_points: [], is_env_binding: isEnv };
        varsMap.set(name, contextVar);
      }
      return contextVar;
    };

    const cursor = root.walk();
    walk(cursor, (node) => {
      collectContextCall(node, file, getOrCreate);
      collectContextMember(node, file, getOrCreate);
      collectContextVarDestructuring(node, file, getOrCreate);
    });

    for (const contextVar of varsMap.values()) {
      const existing = model.context_vars.find((entry) => entry.name === contextVar.name);
      if (existing) {
        existing.set_points.push(...contextVar.set_points);
        existing.get_points.push(...contextVar.get_points);
      } else {
        model.context_vars.push(contextVar);
      }
    }
  }
}

type ContextVarFactory = (name: string, isEnv: boolean) => ContextVariable;

function isContextParam(node: Parser.SyntaxNode | null): boolean {
  return !!node && CONTEXT_PARAM_NAMES.has(node.text);
}

function collectContextCall(
  node: Parser.SyntaxNode,
  file: string,
  getOrCreate: ContextVarFactory,
): void {
  if (node.type !== "call_expression") return;
  const fn = node.childForFieldName("function");
  if (fn?.type !== "member_expression") return;

  const obj = fn.childForFieldName("object");
  const prop = fn.childForFieldName("property");
  if (!isContextParam(obj)) return;

  const keyArg = node.childForFieldName("arguments")?.namedChildren[0];
  if (!keyArg) return;
  const key = stringLiteralValue(keyArg) ??
    (keyArg.type === "identifier" ? keyArg.text : null);
  if (!key) return;

  if (prop?.text === "set") {
    const contextVar = getOrCreate(key, false);
    contextVar.set_points.push({
      file,
      line: node.startPosition.row + 1,
      scope: "middleware",
      via_context_storage: false,
      condition: isInsideBranch(node) ? "conditional" : "always",
    });
  }
  if (prop?.text === "get") {
    const contextVar = getOrCreate(key, false);
    contextVar.get_points.push({
      file,
      line: node.startPosition.row + 1,
      scope: "handler",
      via_context_storage: false,
      condition: "always",
    });
  }
}

function collectContextMember(
  node: Parser.SyntaxNode,
  file: string,
  getOrCreate: ContextVarFactory,
): void {
  if (node.type !== "member_expression") return;
  const obj = node.childForFieldName("object");
  const prop = node.childForFieldName("property");
  if (obj?.type !== "member_expression" || !prop) return;

  const innerObj = obj.childForFieldName("object");
  const innerProp = obj.childForFieldName("property");
  if (!isContextParam(innerObj) || innerProp?.text !== "var") return;

  const contextVar = getOrCreate(prop.text, false);
  contextVar.get_points.push({
    file,
    line: node.startPosition.row + 1,
    scope: "handler",
    via_context_storage: false,
    condition: "always",
  });
}

function collectContextVarDestructuring(
  node: Parser.SyntaxNode,
  file: string,
  getOrCreate: ContextVarFactory,
): void {
  if (node.type !== "variable_declarator") return;
  const nameNode = node.childForFieldName("name");
  const valueNode = node.childForFieldName("value");
  if (nameNode?.type !== "object_pattern" ||
      valueNode?.type !== "member_expression") {
    return;
  }

  const obj = valueNode.childForFieldName("object");
  const prop = valueNode.childForFieldName("property");
  if (!isContextParam(obj) || prop?.text !== "var") return;

  for (const child of nameNode.namedChildren) {
    let key: string | null = null;
    if (
      child.type === "shorthand_property_identifier_pattern" ||
      child.type === "shorthand_property_identifier"
    ) {
      key = child.text;
    }
    if (child.type === "pair_pattern") {
      const keyNode = child.childForFieldName("key");
      key = keyNode ? stringLiteralValue(keyNode) ?? keyNode.text : null;
    }
    if (!key) continue;
    const contextVar = getOrCreate(key, false);
    contextVar.get_points.push({
      file,
      line: node.startPosition.row + 1,
      scope: "handler",
      via_context_storage: false,
      condition: "always",
    });
  }
}

function isInsideBranch(node: Parser.SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (
      current.type === "if_statement" ||
      current.type === "switch_case" ||
      current.type === "catch_clause" ||
      current.type === "ternary_expression" ||
      current.type === "logical_expression" ||
      isShortCircuitBinaryExpression(current)
    ) {
      return true;
    }
    if (
      current.type === "arrow_function" ||
      current.type === "function_declaration" ||
      current.type === "function_expression" ||
      current.type === "method_definition"
    ) {
      break;
    }
    current = current.parent;
  }
  return false;
}

function isShortCircuitBinaryExpression(node: Parser.SyntaxNode): boolean {
  if (node.type !== "binary_expression") return false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.text === "&&" || child?.text === "||" || child?.text === "??") {
      return true;
    }
  }
  return false;
}
