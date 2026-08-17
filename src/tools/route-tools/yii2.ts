import type { CodeIndex } from "../../types.js";
import { stripSource } from "../graph-tools.js";
import { matchPath } from "../route-shared.js";
import { readIndexedFiles } from "./file-sources.js";
import type { RouteHandler } from "./types.js";

function toPascal(value: string): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function routeTarget(segments: string[]): { controllerId: string; actionId: string } | null {
  if (segments.length === 0) return null;
  if (segments.length === 1) {
    return { controllerId: segments[0]!, actionId: "index" };
  }
  return {
    controllerId: segments[segments.length - 2]!,
    actionId: segments[segments.length - 1]!,
  };
}

function conventionHandler(
  index: CodeIndex,
  controllerId: string,
  actionId: string,
): RouteHandler | null {
  const controllerName = toPascal(controllerId) + "Controller";
  const actionName = "action" + toPascal(actionId);
  const controller = index.symbols.find(
    (symbol) => symbol.name === controllerName && symbol.kind === "class",
  );
  if (!controller) return null;

  const action = index.symbols.find(
    (symbol) => symbol.name === actionName && symbol.parent === controller.id,
  );
  const symbol = action ?? controller;
  return {
    symbol: stripSource(symbol),
    file: symbol.file,
    ...(action ? { method: "GET" } : {}),
    framework: "yii2",
  };
}

function configRuleHandler(index: CodeIndex, route: string, method: string): RouteHandler | null {
  const target = routeTarget(route.split("/"));
  if (!target) return null;
  const handler = conventionHandler(index, target.controllerId, target.actionId);
  return handler ? { ...handler, method } : null;
}

async function findYii2HandlersFromConfig(
  index: CodeIndex,
  searchPath: string,
): Promise<RouteHandler[]> {
  // `const [config] = ...` took the FIRST config/web.php and ignored the rest. A Yii2 application
  // template has one per app (frontend, backend, console), so every route defined outside whichever
  // file the walker happened to return first was invisible.
  const configs = await readIndexedFiles(index, (path) => /config\/web\.php$/.test(path));
  if (configs.length === 0) return [];

  const normalizedSearch = searchPath.replace(/^\/|\/$/g, "").toLowerCase();
  const pattern = /['"](?:(GET|POST|PUT|DELETE|PATCH)\s+)?([^'"]+)['"]\s*=>\s*['"]([^'"]+)['"]/g;
  const handlers: RouteHandler[] = [];
  for (const config of configs) {
    for (const match of config.source.matchAll(pattern)) {
      const rulePath = match[2]!.replace(/<\w+(?::[^>]+)?>/g, "[param]").toLowerCase();
      if (!matchPath(rulePath, normalizedSearch)) continue;

      const handler = configRuleHandler(index, match[3]!, match[1]?.toUpperCase() ?? "GET");
      if (handler) handlers.push(handler);
    }
  }
  return handlers;
}

/** Find Yii2 handlers through controller/action conventions and URL rules. */
export async function findYii2Handlers(
  index: CodeIndex,
  searchPath: string,
): Promise<RouteHandler[]> {
  const segments = searchPath
    .replace(/^\/|\/$/g, "")
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  const target = routeTarget(segments);
  if (!target) return [];

  const handler = conventionHandler(index, target.controllerId, target.actionId);
  return handler ? [handler] : findYii2HandlersFromConfig(index, searchPath);
}
