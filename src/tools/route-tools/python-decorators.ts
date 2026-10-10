import { stripSource } from "../graph-tools.js";
import { matchPath } from "../route-shared.js";
import type { CodeSymbol } from "../../types.js";
import { asRouteIndex, type RouteIndexInput } from "./route-index.js";
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

/**
 * Flask and FastAPI run side by side over the same index and both need every Python file's symbols;
 * one read per RouteIndex serves both.
 */
const pythonSymbolsByIndex = new WeakMap<object, Promise<CodeSymbol[]>>();

async function findDecoratedPythonHandlers(
  input: RouteIndexInput,
  searchPath: string,
  parseDecorator: DecoratorParser,
): Promise<RouteHandler[]> {
  const index = asRouteIndex(input);
  const handlers: RouteHandler[] = [];
  const pythonFiles = index.files.filter(
    (file) => file.path.endsWith(".py") && !isPythonTestFile(file.path),
  );
  if (pythonFiles.length === 0) return handlers;

  // One read for every Python file's symbols (no source — decorators are not source), grouped back
  // by file so the walk keeps its order: files in index order, symbols in index order within each.
  const byFile = new Map<string, CodeSymbol[]>();
  let read = pythonSymbolsByIndex.get(index);
  if (!read) {
    read = index.inFiles(pythonFiles.map((file) => file.path), false);
    pythonSymbolsByIndex.set(index, read);
    // A failed read must not answer the next caller sharing this RouteIndex.
    read.catch(() => pythonSymbolsByIndex.delete(index));
  }
  for (const symbol of await read) {
    const list = byFile.get(symbol.file);
    if (list) list.push(symbol);
    else byFile.set(symbol.file, [symbol]);
  }

  for (const file of pythonFiles) {
    for (const symbol of byFile.get(file.path) ?? []) {
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
export function findFlaskHandlers(index: RouteIndexInput, searchPath: string): Promise<RouteHandler[]> {
  return findDecoratedPythonHandlers(index, searchPath, (decorator) => {
    const match = /@\w+\.route\s*\(\s*['"]([^'"]*)['"]/.exec(decorator);
    return match ? { routePath: match[1] ?? "", handler: { framework: "flask" } } : null;
  });
}

/** Find FastAPI verb decorators on app and router instances. */
export function findFastAPIHandlers(index: RouteIndexInput, searchPath: string): Promise<RouteHandler[]> {
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
