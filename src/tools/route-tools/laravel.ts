import { stripSource } from "../graph-tools.js";
import { matchPath } from "../route-shared.js";
import type { CodeIndex } from "../../types.js";
import { readIndexedFiles } from "./file-sources.js";
import type { RouteHandler } from "./types.js";

/**
 * Find Laravel route handlers by scanning route files for Route::method() patterns.
 */
export async function findLaravelHandlers(index: CodeIndex, searchPath: string): Promise<RouteHandler[]> {
  const handlers: RouteHandler[] = [];
  const routeFiles = await readIndexedFiles(index, (path) => /routes\/(web|api)\.php$/.test(path));

  if (routeFiles.length === 0) return handlers;

  const methods = ["get", "post", "put", "delete", "patch"];

  for (const file of routeFiles) {
    const { path: filePath, source } = file;

    for (const method of methods) {
      // Match: Route::get('/path', [Controller::class, 'method']) or Route::get('/path', 'Controller@method')
      const re = new RegExp(
        `Route::${method}\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*,\\s*(?:\\[([\\w\\\\]+)::class\\s*,\\s*['"\`](\\w+)['"\`]\\]|['"\`](\\w+)@(\\w+)['"\`])`,
        "gi",
      );
      let match: RegExpExecArray | null;
      while ((match = re.exec(source)) !== null) {
        const routePath = match[1] ?? "";
        const controllerClass = match[2] ?? match[4] ?? "";
        const methodName = match[3] ?? match[5] ?? "";

        if (!matchPath(routePath, searchPath)) continue;

        // Find the controller method in the index
        const controllerName = controllerClass.split("\\").pop() ?? controllerClass;
        const sym = index.symbols.find(
          (s) => s.name === methodName && s.kind === "method" &&
            index.symbols.some((c) => c.id === s.parent && c.name === controllerName),
        );

        handlers.push({
          symbol: sym
            ? stripSource(sym)
            : { id: `${controllerName}::${methodName}`, name: methodName, kind: "method", file: filePath, start_line: 0, end_line: 0 } as ReturnType<typeof stripSource>,
          file: sym?.file ?? filePath,
          method: method.toUpperCase(),
          framework: "laravel",
        });
      }
    }
  }

  return handlers;
}
