import { stripSource } from "../graph-tools.js";
import { matchPath } from "../route-shared.js";
import type { CodeIndex } from "../../types.js";
import type { RouteHandler } from "./types.js";

// --- Python frameworks ---

/**
 * Detect Python test files by pytest naming conventions.
 * Matches: test_*.py, *_test.py, conftest.py, and tests/ subdirectories.
 */
function isPythonTestFile(path: string): boolean {
  const basename = path.split("/").pop() ?? path;
  if (basename === "conftest.py") return true;
  if (/^test_.*\.py$/.test(basename)) return true;
  if (/_test\.py$/.test(basename)) return true;
  if (/\/tests?\//.test(path)) return true;
  return false;
}

/**
 * Find Flask route handlers via @app.route() and @bp.route() decorators.
 * Also handles @app.get/post/put/delete() (Flask 2.0+ shorthand).
 */
export function findFlaskHandlers(index: CodeIndex, searchPath: string): RouteHandler[] {
  const handlers: RouteHandler[] = [];
  // Exclude test files and conftest — users tracing a production route rarely
  // want test fixture routes like `@app.route('/')` inside test_*.py
  const pyFiles = index.files.filter(
    (f) => f.path.endsWith(".py")
      && !isPythonTestFile(f.path),
  );

  for (const file of pyFiles) {
    const fileSymbols = index.symbols.filter((s) => s.file === file.path);
    for (const sym of fileSymbols) {
      if (!sym.decorators || sym.decorators.length === 0) continue;

      for (const dec of sym.decorators) {
        // Match @app.route('/path') or @bp.route('/path') — Flask-specific.
        // For HTTP verb shortcuts (@app.get, @app.post), prefer FastAPI handler
        // since the syntax is ambiguous between Flask 2.0+ and FastAPI.
        const routeMatch = dec.match(
          /@\w+\.route\s*\(\s*['"]([^'"]*)['"]/,
        );
        if (!routeMatch) continue;

        const routePath = routeMatch[1] ?? "";
        if (!matchPath(routePath, searchPath)) continue;

        // @app.route can handle any method — omit method field
        handlers.push({
          symbol: stripSource(sym),
          file: file.path,
          framework: "flask",
        });
      }
    }
  }

  return handlers;
}

/**
 * Find FastAPI route handlers via @app.get/post/put/delete() and @router.get() decorators.
 * Handles APIRouter prefix extraction.
 */
export function findFastAPIHandlers(index: CodeIndex, searchPath: string): RouteHandler[] {
  const handlers: RouteHandler[] = [];
  const pyFiles = index.files.filter(
    (f) => f.path.endsWith(".py")
      && !isPythonTestFile(f.path),
  );

  for (const file of pyFiles) {
    const fileSymbols = index.symbols.filter((s) => s.file === file.path);
    for (const sym of fileSymbols) {
      if (!sym.decorators || sym.decorators.length === 0) continue;

      for (const dec of sym.decorators) {
        // Match @app.get('/path') or @router.get('/path') etc.
        const routeMatch = dec.match(
          /@\w+\.(get|post|put|delete|patch|options|head)\s*\(\s*['"]([^'"]*)['"]/,
        );
        if (!routeMatch) continue;

        const method = routeMatch[1]!.toUpperCase();
        const routePath = routeMatch[2] ?? "";

        if (!matchPath(routePath, searchPath)) continue;

        handlers.push({
          symbol: stripSource(sym),
          file: file.path,
          method,
          framework: "fastapi",
        });
      }
    }
  }

  return handlers;
}

