import { asRouteIndex, type RouteIndex, type RouteIndexInput } from "./route-index.js";
import { stripSource } from "../graph-tools.js";
import { matchPath } from "../route-shared.js";
import { readIndexedFiles } from "./file-sources.js";
import type { RouteHandler } from "./types.js";

const LARAVEL_METHODS = ["get", "post", "put", "delete", "patch"];

async function findControllerMethod(
  index: RouteIndex,
  controllerName: string,
  methodName: string,
) {
  // The first method of that name whose parent is a symbol named like the controller.
  const candidates = await index.find({ name: methodName, kind: "method", withSource: false });
  if (candidates.length === 0) return undefined;
  const parents = new Set(
    (await index.find({ name: controllerName, withSource: false })).map((parent) => parent.id),
  );
  return candidates.find((candidate) => candidate.parent !== undefined && parents.has(candidate.parent));
}

async function laravelHandler(
  index: RouteIndex,
  file: string,
  method: string,
  match: RegExpMatchArray,
): Promise<RouteHandler> {
  const controllerClass = match[2] ?? match[4] ?? "";
  const methodName = match[3] ?? match[5] ?? "";
  const controllerName = controllerClass.split("\\").pop() ?? controllerClass;
  const symbol = await findControllerMethod(index, controllerName, methodName);
  return {
    symbol: symbol
      ? stripSource(symbol)
      : {
          id: `${controllerName}::${methodName}`,
          name: methodName,
          kind: "method",
          file,
          start_line: 0,
          end_line: 0,
        } as ReturnType<typeof stripSource>,
    file: symbol?.file ?? file,
    method: method.toUpperCase(),
    framework: "laravel",
  };
}

async function scanLaravelMethod(
  index: RouteIndex,
  file: string,
  source: string,
  searchPath: string,
  method: string,
): Promise<RouteHandler[]> {
  const pattern = new RegExp(
    `Route::${method}\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*,\\s*(?:\\[([\\w\\\\]+)::class\\s*,\\s*['"\`](\\w+)['"\`]\\]|['"\`]([\\w\\\\]+)@(\\w+)['"\`])`,
    "gi",
  );
  const handlers: RouteHandler[] = [];
  for (const match of source.matchAll(pattern)) {
    if (matchPath(match[1] ?? "", searchPath)) handlers.push(await laravelHandler(index, file, method, match));
  }
  return handlers;
}

async function scanLaravelFile(
  index: RouteIndex,
  file: string,
  source: string,
  searchPath: string,
): Promise<RouteHandler[]> {
  const handlers: RouteHandler[] = [];
  for (const method of LARAVEL_METHODS) {
    handlers.push(...await scanLaravelMethod(index, file, source, searchPath, method));
  }
  return handlers;
}

/** Find Laravel handlers by scanning framework route files. */
export async function findLaravelHandlers(
  input: RouteIndexInput,
  searchPath: string,
): Promise<RouteHandler[]> {
  const index = asRouteIndex(input);
  const files = await readIndexedFiles(index, (path) => /routes\/(web|api)\.php$/.test(path));
  const handlers: RouteHandler[] = [];
  for (const { path, source } of files) handlers.push(...await scanLaravelFile(index, path, source, searchPath));
  return handlers;
}
