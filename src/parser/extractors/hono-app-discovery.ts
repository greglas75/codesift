import type Parser from "web-tree-sitter";
import type { HonoApp } from "./hono-model.js";
import { stringLiteralValue, walk } from "./hono-ast-utils.js";
import { joinPaths } from "./hono-route-utils.js";

export function walkHonoAppVariables(
  root: Parser.SyntaxNode,
  file: string,
  localVars: Record<string, HonoApp>,
): void {
  const factoryVars = collectFactoryVars(root);

  const cursor = root.walk();
  walk(cursor, (node) => {
    if (node.type !== "variable_declarator") return;
    const nameNode = node.childForFieldName("name");
    const valueNode = node.childForFieldName("value");
    if (!nameNode || !valueNode) return;
    if (nameNode.type !== "identifier") return;
    const name = nameNode.text;

    const basePath = extractBasePathCall(valueNode, localVars, factoryVars);
    if (basePath) {
      localVars[name] = {
        variable_name: name,
        file,
        line: nameNode.startPosition.row + 1,
        created_via: "basePath",
        base_path: basePath.prefix,
        ...(basePath.parentVar ? { parent: basePath.parentVar } : {}),
      };
      return;
    }

    const createdVia = classifyAppCreation(valueNode);
    if (createdVia) {
      localVars[name] = {
        variable_name: name,
        file,
        line: nameNode.startPosition.row + 1,
        created_via: createdVia,
        base_path: "",
      };
      return;
    }

    if (isFactoryCreateApp(valueNode, factoryVars)) {
      localVars[name] = {
        variable_name: name,
        file,
        line: nameNode.startPosition.row + 1,
        created_via: "factory.createApp",
        base_path: "",
      };
    }
  });
}

function collectFactoryVars(root: Parser.SyntaxNode): Set<string> {
  const factoryVars = new Set<string>();
  const cursor = root.walk();
  walk(cursor, (node) => {
    if (node.type !== "variable_declarator") return;
    const nameNode = node.childForFieldName("name");
    const valueNode = node.childForFieldName("value");
    if (!nameNode || !valueNode || nameNode.type !== "identifier") return;
    if (isCreateFactoryCall(valueNode)) {
      factoryVars.add(nameNode.text);
    }
  });
  return factoryVars;
}

function extractBasePathCall(
  valueNode: Parser.SyntaxNode,
  knownVars: Record<string, HonoApp>,
  factoryVars: Set<string>,
): { parentVar?: string; prefix: string } | null {
  if (valueNode.type !== "call_expression") return null;
  const fnNode = valueNode.childForFieldName("function");
  if (!fnNode || fnNode.type !== "member_expression") return null;
  const obj = fnNode.childForFieldName("object");
  const prop = fnNode.childForFieldName("property");
  if (!obj || !prop) return null;
  if (prop.text !== "basePath") return null;

  const argsNode = valueNode.childForFieldName("arguments");
  const firstArg = argsNode?.namedChildren[0];
  if (!firstArg) return null;
  const prefix = stringLiteralValue(firstArg) ??
    (firstArg.type === "identifier" ? `<dynamic:${firstArg.text}>` : "<dynamic>");

  if (obj.type === "identifier") {
    if (!knownVars[obj.text]) return null;
    const parentBase = knownVars[obj.text]?.base_path || "";
    return { parentVar: obj.text, prefix: joinPaths(parentBase, prefix) };
  }

  if (obj.type === "call_expression") {
    const parentBasePath = extractBasePathCall(obj, knownVars, factoryVars);
    if (parentBasePath) {
      return {
        ...(parentBasePath.parentVar
          ? { parentVar: parentBasePath.parentVar }
          : {}),
        prefix: joinPaths(parentBasePath.prefix, prefix),
      };
    }
  }

  if (classifyAppCreation(obj)) {
    return { prefix };
  }

  if (isFactoryCreateApp(obj, factoryVars)) {
    return { prefix };
  }

  return null;
}

function isCreateFactoryCall(valueNode: Parser.SyntaxNode): boolean {
  if (valueNode.type !== "call_expression") return false;
  const fn = valueNode.childForFieldName("function");
  if (!fn) return false;
  if (fn.type === "identifier" && fn.text === "createFactory") return true;
  if (fn.type === "member_expression") {
    const prop = fn.childForFieldName("property");
    if (prop?.text === "createFactory") return true;
  }
  return false;
}

function isFactoryCreateApp(
  valueNode: Parser.SyntaxNode,
  factoryVars: Set<string>,
): boolean {
  if (valueNode.type !== "call_expression") return false;
  const fn = valueNode.childForFieldName("function");
  if (!fn || fn.type !== "member_expression") return false;
  const obj = fn.childForFieldName("object");
  const prop = fn.childForFieldName("property");
  if (!obj || !prop || obj.type !== "identifier") return false;
  return factoryVars.has(obj.text) && prop.text === "createApp";
}

function classifyAppCreation(
  valueNode: Parser.SyntaxNode,
): HonoApp["created_via"] | null {
  if (valueNode.type === "call_expression") {
    const fn = valueNode.childForFieldName("function");
    if (fn) return classifyAppCreation(fn);
    return null;
  }
  if (valueNode.type === "member_expression") {
    const obj = valueNode.childForFieldName("object");
    if (obj) return classifyAppCreation(obj);
    return null;
  }
  if (valueNode.type !== "new_expression") return null;
  const ctor = valueNode.childForFieldName("constructor");
  if (!ctor) return null;
  if (ctor.type === "identifier") {
    if (ctor.text === "Hono") return "new Hono";
    if (ctor.text === "OpenAPIHono") return "OpenAPIHono";
  }
  if (ctor.type === "member_expression") {
    const prop = ctor.childForFieldName("property");
    if (prop?.text === "Hono") return "new Hono";
    if (prop?.text === "OpenAPIHono") return "OpenAPIHono";
  }
  return null;
}
