import { stripSource } from "../graph-tools.js";
import { matchPath } from "../route-shared.js";
import type { CodeIndex } from "../../types.js";
import type { RouteHandler } from "./types.js";

/** Find Yii2 handlers through controller/action conventions and URL rules. */
export async function findYii2Handlers(index: CodeIndex, searchPath: string): Promise<RouteHandler[]> {
  const handlers: RouteHandler[] = [];
  const normalized = searchPath.replace(/^\/|\/$/g, "").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);

  if (segments.length === 0) return handlers;

  // Determine controller ID and action ID
  // Patterns: "controller/action", "module/controller/action", "controller" (default action=index)
  let controllerId: string;
  let actionId: string;

  if (segments.length === 1) {
    controllerId = segments[0]!;
    actionId = "index";
  } else if (segments.length === 2) {
    controllerId = segments[0]!;
    actionId = segments[1]!;
  } else {
    // Module routing: take last two segments as controller/action
    controllerId = segments[segments.length - 2]!;
    actionId = segments[segments.length - 1]!;
  }

  // Convert kebab-case to PascalCase for class name: "site" → "Site", "user-comment" → "UserComment"
  const toPascal = (s: string): string =>
    s.split("-").map(p => p.charAt(0).toUpperCase() + p.slice(1)).join("");

  // Convert kebab-case to camelCase for action method: "hello-world" → "HelloWorld"
  const toCamelAction = (s: string): string =>
    s.split("-").map(p => p.charAt(0).toUpperCase() + p.slice(1)).join("");

  const controllerName = toPascal(controllerId) + "Controller";
  const actionMethod = "action" + toCamelAction(actionId);

  // Find controller class in index
  const controllerSymbol = index.symbols.find(
    (s) => s.name === controllerName && s.kind === "class",
  );

  if (!controllerSymbol) {
    // Fallback: try urlManager rules from config/web.php
    return findYii2HandlersFromConfig(index, searchPath);
  }

  // Find action method within the controller
  const actionSymbol = index.symbols.find(
    (s) => s.name === actionMethod && s.parent === controllerSymbol.id,
  );

  if (actionSymbol) {
    handlers.push({
      symbol: stripSource(actionSymbol),
      file: actionSymbol.file,
      method: "GET",
      framework: "yii2",
    });
  } else {
    // Fallback: controller found but action method not indexed — report controller
    handlers.push({
      symbol: stripSource(controllerSymbol),
      file: controllerSymbol.file,
      framework: "yii2",
    });
  }

  return handlers;
}
/**
 * Fallback: parse Yii2 urlManager rules from config/web.php.
 * Matches patterns like: 'GET api/users/<id>' => 'user/view'
 */
async function findYii2HandlersFromConfig(index: CodeIndex, searchPath: string): Promise<RouteHandler[]> {
  const handlers: RouteHandler[] = [];
  const configFile = index.files.find((f) => /config\/web\.php$/.test(f.path));
  if (!configFile) return handlers;

  const { readFile: rf } = await import("node:fs/promises");
  const { join: j } = await import("node:path");
  let source: string;
  try {
    source = await rf(j(index.root, configFile.path), "utf-8");
  } catch { return handlers; }

  const normalized = searchPath.replace(/^\/|\/$/g, "").toLowerCase();

  // Match: 'route/pattern' => 'controller/action' or ['GET method/pattern'] => 'controller/action'
  const ruleRe = /['"](?:(?:GET|POST|PUT|DELETE|PATCH)\s+)?([^'"]+)['"]\s*=>\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRe.exec(source)) !== null) {
    const rulePattern = match[1]!.replace(/<\w+(?::[^>]+)?>/g, "[param]").toLowerCase();
    if (!matchPath(rulePattern, normalized)) continue;

    const route = match[2]!; // e.g. "user/view"
    const parts = route.split("/");
    if (parts.length < 2) continue;

    const controllerId = parts[parts.length - 2]!;
    const actionId = parts[parts.length - 1]!;
    const toPascal = (s: string): string =>
      s.split("-").map(p => p.charAt(0).toUpperCase() + p.slice(1)).join("");

    const controllerName = toPascal(controllerId) + "Controller";
    const actionMethod = "action" + toPascal(actionId);

    const ctrlSym = index.symbols.find(s => s.name === controllerName && s.kind === "class");
    if (!ctrlSym) continue;

    const actionSym = index.symbols.find(s => s.name === actionMethod && s.parent === ctrlSym.id);
    handlers.push({
      symbol: stripSource(actionSym ?? ctrlSym),
      file: (actionSym ?? ctrlSym).file,
      method: "GET",
      framework: "yii2",
    });
  }

  return handlers;
}
