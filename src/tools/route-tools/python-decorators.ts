import { stripSource } from "../graph-tools.js";
import { matchPath } from "../route-shared.js";
import type { CodeIndex } from "../../types.js";
import type { RouteHandler } from "./types.js";

function isPythonTestFile(path: string): boolean {
  const basename = path.split("/").pop() ?? path;
  if (basename === "conftest.py") return true;
  if (/^test_.*\.py$/.test(basename)) return true;
  if (/_test\.py$/.test(basename)) return true;
  if (/\/tests?\//.test(path)) return true;
  return false;
}

interface DecoratorRoute {
  routePath: string;
  handler: Pick<RouteHandler, "framework" | "method">;
}

type DecoratorParser = (decorator: string) => DecoratorRoute | null;

function findDecoratedPythonHandlers(
  index: CodeIndex,
  searchPath: string,
  parseDecorator: DecoratorParser,
): RouteHandler[] {
  const handlers: RouteHandler[] = [];
  const pythonFiles = index.files.filter(
    (file) => file.path.endsWith(".py") && !isPythonTestFile(file.path),
  );

  for (const file of pythonFiles) {
    for (const symbol of index.symbols.filter((candidate) => candidate.file === file.path)) {
      for (const decorator of symbol.decorators ?? []) {
        const route = parseDecorator(decorator);
        if (!route || !matchPath(route.routePath, searchPath)) continue;
        handlers.push({
          symbol: stripSource(symbol),
          file: file.path,
          ...route.handler,
        });
      }
    }
  }

  return handlers;
}

/** Find Flask @app.route and @bp.route decorators. */
export function findFlaskHandlers(index: CodeIndex, searchPath: string): RouteHandler[] {
  return findDecoratedPythonHandlers(index, searchPath, (decorator) => {
    const match = /@\w+\.route\s*\(\s*['"]([^'"]*)['"]/.exec(decorator);
    return match ? { routePath: match[1] ?? "", handler: { framework: "flask" } } : null;
  });
}

/** Find FastAPI verb decorators on app and router instances. */
export function findFastAPIHandlers(index: CodeIndex, searchPath: string): RouteHandler[] {
  return findDecoratedPythonHandlers(index, searchPath, (decorator) => {
    const match = /@\w+\.(get|post|put|delete|patch|options|head)\s*\(\s*['"]([^'"]*)['"]/.exec(decorator);
    return match
      ? {
          routePath: match[2] ?? "",
          handler: { framework: "fastapi", method: match[1]!.toUpperCase() },
        }
      : null;
  });
}
