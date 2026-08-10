import { stripSource } from "../graph-tools.js";
import { matchPath } from "../route-shared.js";
import type { CodeIndex } from "../../types.js";
import type { RouteHandler } from "./types.js";

/** Find Express-style route handlers in production JS/TS symbols. */
export function findExpressHandlers(index: CodeIndex, searchPath: string): RouteHandler[] {
  const handlers: RouteHandler[] = [];
  const methods = ["get", "post", "put", "delete", "patch"];

  for (const sym of index.symbols) {
    if (!sym.source) continue;
    // Only scan JS/TS files — .get()/.post() is ambiguous across languages
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(sym.file)) continue;
    // Skip test files to avoid matching test harness client calls
    if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(sym.file)) continue;

    for (const method of methods) {
      const re = new RegExp(`\\.(${method})\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`);
      const match = re.exec(sym.source);
      if (!match) continue;

      const routePath = match[2] ?? "";
      if (matchPath(routePath, searchPath)) {
        handlers.push({
          symbol: stripSource(sym),
          file: sym.file,
          method: method.toUpperCase(),
          framework: "express",
        });
      }
    }
  }

  return handlers;
}
