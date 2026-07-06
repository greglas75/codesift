import type Parser from "web-tree-sitter";
import type {
  HonoApp,
  HonoHandler,
  HonoMethod,
  HonoRoute,
  InlineHandlerAnalysis,
} from "./hono-model.js";
import { HonoInlineAnalyzer } from "./hono-inline-analyzer.js";
import { stringLiteralValue, walk } from "./hono-ast-utils.js";
import {
  buildHandler,
  joinPaths,
  parseRegexConstraints,
} from "./hono-route-utils.js";

const HTTP_METHODS = new Set([
  "get", "post", "put", "delete", "patch", "options", "all", "on",
]);

export class HonoRouteExtractor {
  constructor(private readonly inlineAnalyzer = new HonoInlineAnalyzer()) {}

  walkHttpRoutes(
    root: Parser.SyntaxNode,
    file: string,
    appVars: Record<string, HonoApp>,
    routes: HonoRoute[],
  ): void {
    const cursor = root.walk();
    walk(cursor, (node) => {
      const routeCall = readRouteCall(node, appVars);
      if (!routeCall) return;

      const { method, argList, ownerVar, basePrefix } = routeCall;
      if (method === "on") {
        this.handleOnMethod(argList, file, node, ownerVar, basePrefix, routes);
        return;
      }

      const firstArg = argList[0];
      if (!firstArg) return;
      const rawPath = stringLiteralValue(firstArg);
      if (rawPath == null) return;

      const handlerNode = argList[argList.length - 1] ?? firstArg;
      const handler = buildHandler(handlerNode, file);
      const regexConstraint = parseRegexConstraints(rawPath);
      const inlineAnalysis = this.analyzeHandlerIfInline(handler, handlerNode);

      routes.push({
        method: method.toUpperCase() as HonoMethod,
        path: joinPaths(basePrefix, rawPath),
        raw_path: rawPath,
        file,
        line: node.startPosition.row + 1,
        owner_var: ownerVar,
        handler,
        inline_middleware: [],
        validators: [],
        ...(regexConstraint ? { regex_constraint: regexConstraint } : {}),
        ...(inlineAnalysis ? { inline_analysis: inlineAnalysis } : {}),
      });
    });
  }

  private analyzeHandlerIfInline(
    handler: HonoHandler,
    handlerNode: Parser.SyntaxNode,
  ): InlineHandlerAnalysis | undefined {
    if (!handler.inline) return undefined;
    return this.inlineAnalyzer.analyze(handlerNode);
  }

  private handleOnMethod(
    argList: Parser.SyntaxNode[],
    file: string,
    node: Parser.SyntaxNode,
    ownerVar: string,
    basePrefix: string,
    routes: HonoRoute[],
  ): void {
    if (argList.length < 2) return;
    const methodsArg = argList[0];
    const pathArg = argList[1];
    if (!methodsArg || !pathArg) return;

    const methods = extractOnMethods(methodsArg);
    if (methods.length === 0) return;

    const rawPath = stringLiteralValue(pathArg);
    if (rawPath == null) return;

    const handlerNode = argList[argList.length - 1] ?? pathArg;
    const handler = buildHandler(handlerNode, file);
    const regexConstraint = parseRegexConstraints(rawPath);
    const inlineAnalysis = this.analyzeHandlerIfInline(handler, handlerNode);

    for (const method of methods) {
      routes.push({
        method: method as HonoMethod,
        path: joinPaths(basePrefix, rawPath),
        raw_path: rawPath,
        file,
        line: node.startPosition.row + 1,
        owner_var: ownerVar,
        handler,
        inline_middleware: [],
        validators: [],
        ...(regexConstraint ? { regex_constraint: regexConstraint } : {}),
        ...(inlineAnalysis ? { inline_analysis: inlineAnalysis } : {}),
      });
    }
  }
}

interface RouteCall {
  method: string;
  argList: Parser.SyntaxNode[];
  ownerVar: string;
  basePrefix: string;
}

function readRouteCall(
  node: Parser.SyntaxNode,
  appVars: Record<string, HonoApp>,
): RouteCall | null {
  if (node.type !== "call_expression") return null;
  const fnNode = node.childForFieldName("function");
  const argsNode = node.childForFieldName("arguments");
  if (!fnNode || !argsNode || fnNode.type !== "member_expression") return null;

  const objectNode = fnNode.childForFieldName("object");
  const propertyNode = fnNode.childForFieldName("property");
  if (!objectNode || !propertyNode || objectNode.type !== "identifier")
    return null;

  const ownerVar = objectNode.text;
  const appDef = appVars[ownerVar];
  if (!appDef) return null;

  const method = propertyNode.text.toLowerCase();
  if (!HTTP_METHODS.has(method) || method === "use" || method === "route")
    return null;

  const argList = argsNode.namedChildren;
  if (argList.length === 0) return null;
  return {
    method,
    argList,
    ownerVar,
    basePrefix: appDef.base_path || "",
  };
}

function extractOnMethods(methodsArg: Parser.SyntaxNode): string[] {
  if (methodsArg.type === "array") {
    const methods: string[] = [];
    for (const element of methodsArg.namedChildren) {
      const value = stringLiteralValue(element);
      if (value) methods.push(value.toUpperCase());
    }
    return methods;
  }

  const value = stringLiteralValue(methodsArg);
  return value ? [value.toUpperCase()] : [];
}
