import type { CodeIndex } from "../../types.js";
import { stripSource } from "../graph-tools.js";
import { matchPath } from "../route-shared.js";
import { readIndexedFiles } from "./file-sources.js";
import type { RouteHandler } from "./types.js";

const LARAVEL_METHODS = ["get", "post", "put", "delete", "patch"];

function findControllerMethod(
  index: CodeIndex,
  controllerName: string,
  methodName: string,
) {
  return index.symbols.find(
    (candidate) => candidate.name === methodName &&
      candidate.kind === "method" &&
      index.symbols.some((parent) =>
        parent.id === candidate.parent && parent.name === controllerName
      ),
  );
}

function laravelHandler(
  index: CodeIndex,
  file: string,
  method: string,
  match: RegExpMatchArray,
): RouteHandler {
  const controllerClass = match[2] ?? match[4] ?? "";
  const methodName = match[3] ?? match[5] ?? "";
  const controllerName = controllerClass.split("\\").pop() ?? controllerClass;
  const symbol = findControllerMethod(index, controllerName, methodName);
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

function scanLaravelMethod(
  index: CodeIndex,
  file: string,
  source: string,
  searchPath: string,
  method: string,
): RouteHandler[] {
  const pattern = new RegExp(
    `Route::${method}\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*,\\s*(?:\\[([\\w\\\\]+)::class\\s*,\\s*['"\`](\\w+)['"\`]\\]|['"\`]([\\w\\\\]+)@(\\w+)['"\`])`,
    "gi",
  );
  return [...source.matchAll(pattern)]
    .filter((match) => matchPath(match[1] ?? "", searchPath))
    .map((match) => laravelHandler(index, file, method, match));
}

function scanLaravelFile(
  index: CodeIndex,
  file: string,
  source: string,
  searchPath: string,
): RouteHandler[] {
  return LARAVEL_METHODS.flatMap(
    (method) => scanLaravelMethod(index, file, source, searchPath, method),
  );
}

/** Find Laravel handlers by scanning framework route files. */
export async function findLaravelHandlers(
  index: CodeIndex,
  searchPath: string,
): Promise<RouteHandler[]> {
  const files = await readIndexedFiles(index, (path) => /routes\/(web|api)\.php$/.test(path));
  return files.flatMap(({ path, source }) => scanLaravelFile(index, path, source, searchPath));
}
