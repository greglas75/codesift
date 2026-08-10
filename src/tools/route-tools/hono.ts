import { join } from "node:path";
import type { HonoAppModel, HonoRoute } from "../../parser/extractors/hono-model.js";
import type { CodeIndex, CodeSymbol } from "../../types.js";
import { stripSource } from "../graph-tools.js";
import { matchPath } from "../route-shared.js";
import type { RouteHandler } from "./types.js";

function resolveHonoEntryFile(index: CodeIndex): string | null {
  const entrySymbol = index.symbols.find(
    (symbol) => symbol.source &&
      /new\s+(?:Hono|OpenAPIHono)\s*(?:<[^>]*>)?\s*\(/.test(symbol.source),
  );
  return entrySymbol ? join(index.root, entrySymbol.file) : null;
}

async function loadHonoModel(repo: string, entryFile: string): Promise<HonoAppModel | null> {
  try {
    const { honoCache } = await import("../../cache/hono-cache.js");
    const { HonoExtractor } = await import("../../parser/extractors/hono.js");
    return await honoCache.get(repo, entryFile, new HonoExtractor());
  } catch {
    return null;
  }
}

function routeHandlerSymbol(repo: string, index: CodeIndex, route: HonoRoute): CodeSymbol {
  const relativeFile = route.handler.file.replace(index.root + "/", "");
  return index.symbols.find(
    (symbol) =>
      symbol.file === relativeFile &&
      symbol.name === route.handler.name &&
      Math.abs(symbol.start_line - route.handler.line) <= 2,
  ) ?? {
    id: `hono:${route.file}:${route.line}`,
    repo,
    name: route.handler.name,
    kind: "function",
    file: relativeFile,
    start_line: route.handler.line,
    end_line: route.handler.line,
    start_byte: 0,
    end_byte: 0,
    source: "",
    tokens: [route.handler.name],
  };
}

function toRouteHandler(repo: string, index: CodeIndex, route: HonoRoute): RouteHandler {
  const symbol = routeHandlerSymbol(repo, index, route);
  return {
    symbol: stripSource(symbol),
    file: symbol.file,
    method: route.method,
    framework: "hono",
  };
}

/** Find Hono handlers from the extractor's resolved application model. */
export async function findHonoHandlers(
  repo: string,
  index: CodeIndex,
  searchPath: string,
): Promise<RouteHandler[]> {
  const { detectFrameworks } = await import("../../utils/framework-detect.js");
  if (!detectFrameworks(index).has("hono")) return [];

  const entryFile = resolveHonoEntryFile(index);
  if (!entryFile) return [];

  const model = await loadHonoModel(repo, entryFile);
  if (!model) return [];

  return model.routes
    .filter((route) => matchPath(route.path, searchPath))
    .map((route) => toRouteHandler(repo, index, route));
}
