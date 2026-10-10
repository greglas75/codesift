import type { CodeSymbol } from "../../types.js";
import { asRouteIndex, type RouteIndexInput } from "./route-index.js";
import { stripSource } from "../graph-tools.js";
import { matchPath } from "../route-shared.js";
import type { RouteHandler } from "./types.js";

const EXPRESS_METHODS = ["get", "post", "put", "delete", "patch"];

function isProductionJavaScript(symbol: CodeSymbol): boolean {
  return Boolean(symbol.source) &&
    /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(symbol.file) &&
    !/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(symbol.file);
}

function handlersForSymbol(symbol: CodeSymbol, searchPath: string): RouteHandler[] {
  const handlers: RouteHandler[] = [];
  for (const method of EXPRESS_METHODS) {
    const pattern = new RegExp(`\\.(${method})\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`, "g");
    for (const match of (symbol.source ?? "").matchAll(pattern)) {
      const routePath = match[2] ?? "";
      if (!matchPath(routePath, searchPath)) continue;
      handlers.push({
        symbol: stripSource(symbol),
        file: symbol.file,
        method: method.toUpperCase(),
        framework: "express",
      });
    }
  }
  return handlers;
}

/** Find Express-style route handlers in production JS/TS symbols. */
export async function findExpressHandlers(input: RouteIndexInput, searchPath: string): Promise<RouteHandler[]> {
  // The store keeps only JS/TS symbols whose source has `.get`, `.post`, … — a literal every pattern
  // below requires — so the scan no longer pulls every source in the repo; the regexes still decide.
  const candidates = await asRouteIndex(input).find({
    fileSuffixAny: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    sourceContainsAny: EXPRESS_METHODS.map((method) => `.${method}`),
    withSource: true,
  });
  return candidates
    .filter(isProductionJavaScript)
    .flatMap((symbol) => handlersForSymbol(symbol, searchPath));
}
