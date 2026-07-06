import type Parser from "web-tree-sitter";
import type {
  HonoApp,
  HonoAppModel,
  HonoMethod,
  OpenAPIRoute,
} from "./hono-model.js";
import { stringLiteralValue, walk } from "./hono-ast-utils.js";
import { buildHandler, joinPaths } from "./hono-route-utils.js";

export class HonoOpenAPIExtractor {
  /**
   * Walk for createRoute() definitions and app.openapi() registrations.
   * createRoute({method, path}) definitions are tracked locally by variable
   * name, then app.openapi(routeVar, handler) emits both OpenAPI and Hono routes.
   */
  walkOpenAPI(
    root: Parser.SyntaxNode,
    file: string,
    appVars: Record<string, HonoApp>,
    prefix: string,
    model: HonoAppModel,
  ): void {
    const routeDefs = collectCreateRouteDefinitions(root);
    const cursor = root.walk();
    walk(cursor, (node) => {
      const registration = readOpenAPIRegistration(node, appVars, routeDefs);
      if (!registration) return;

      const { appVar, routeRef, routeDef, handlerArg } = registration;
      const honoPath = routeDef.path.replace(/\{([^}]+)\}/g, ":$1");
      const openapiRoute: OpenAPIRoute = {
        id: `openapi_${routeRef}`,
        method: routeDef.method,
        path: routeDef.path,
        hono_path: honoPath,
        request_schemas: {},
        response_schemas: {},
        middleware: [],
        hidden: false,
        file,
        line: routeDef.line,
      };
      model.openapi_routes.push(openapiRoute);

      model.routes.push({
        method: routeDef.method.toUpperCase() as HonoMethod,
        path: joinPaths(prefix, honoPath),
        raw_path: honoPath,
        file,
        line: node.startPosition.row + 1,
        owner_var: appVar,
        handler: buildHandler(handlerArg, file),
        inline_middleware: [],
        validators: [],
        openapi_route_id: openapiRoute.id,
      });
    });
  }
}

interface RouteDefinition {
  method: string;
  path: string;
  line: number;
}

interface OpenAPIRegistration {
  appVar: string;
  routeRef: string;
  routeDef: RouteDefinition;
  handlerArg: Parser.SyntaxNode;
}

function collectCreateRouteDefinitions(
  root: Parser.SyntaxNode,
): Map<string, RouteDefinition> {
  const routeDefs = new Map<string, RouteDefinition>();
  const cursor = root.walk();
  walk(cursor, (node) => {
    if (node.type !== "variable_declarator") return;
    const nameNode = node.childForFieldName("name");
    const valueNode = node.childForFieldName("value");
    if (!nameNode || !valueNode || nameNode.type !== "identifier") return;
    if (valueNode.type !== "call_expression") return;
    const fn = valueNode.childForFieldName("function");
    if (!fn || fn.text !== "createRoute") return;

    const objArg = valueNode.childForFieldName("arguments")?.namedChildren[0];
    if (!objArg || objArg.type !== "object") return;

    const routeDef = readRouteDefinitionObject(objArg, node.startPosition.row + 1);
    if (routeDef) routeDefs.set(nameNode.text, routeDef);
  });
  return routeDefs;
}

function readRouteDefinitionObject(
  objArg: Parser.SyntaxNode,
  line: number,
): RouteDefinition | null {
  let method = "";
  let routePath = "";
  for (const prop of objArg.namedChildren) {
    if (prop.type !== "pair") continue;
    const key = prop.childForFieldName("key");
    const val = prop.childForFieldName("value");
    if (!key || !val) continue;
    if (key.text === "method") method = stringLiteralValue(val) ?? "";
    if (key.text === "path") routePath = stringLiteralValue(val) ?? "";
  }
  return method && routePath ? { method, path: routePath, line } : null;
}

function readOpenAPIRegistration(
  node: Parser.SyntaxNode,
  appVars: Record<string, HonoApp>,
  routeDefs: Map<string, RouteDefinition>,
): OpenAPIRegistration | null {
  if (node.type !== "call_expression") return null;
  const fnNode = node.childForFieldName("function");
  const argsNode = node.childForFieldName("arguments");
  if (!fnNode || !argsNode || fnNode.type !== "member_expression") return null;

  const obj = fnNode.childForFieldName("object");
  const prop = fnNode.childForFieldName("property");
  if (!obj || !prop || obj.type !== "identifier") return null;
  if (!appVars[obj.text]) return null;
  if (prop.text !== "openapi") return null;

  const argList = argsNode.namedChildren;
  if (argList.length < 2) return null;
  const routeRef = argList[0];
  const handlerArg = argList[1];
  if (!routeRef || !handlerArg || routeRef.type !== "identifier") return null;

  const routeDef = routeDefs.get(routeRef.text);
  if (!routeDef) return null;
  return {
    appVar: obj.text,
    routeRef: routeRef.text,
    routeDef,
    handlerArg,
  };
}
