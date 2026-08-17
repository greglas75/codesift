import { join, relative } from "node:path";
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
  } catch (err: unknown) {
    // An extractor failure and "this repo has no Hono app" produced the same empty result, so a
    // broken parse read as a project with no routes. Same shape as the swallowed parse failures in
    // the indexer and the swallowed reads in file-sources.
    console.error(
      `[codesift] Hono model extraction failed for ${entryFile}: `
      + `${err instanceof Error ? err.message : String(err)} — reporting no routes for this app.`,
    );
    return null;
  }
}

function routeHandlerSymbol(repo: string, index: CodeIndex, route: HonoRoute): CodeSymbol {
  // `.replace(index.root + "/", "")` hardcoded the POSIX separator, so on win32 the prefix never
  // matched, `relativeFile` stayed absolute, and the symbol lookup below missed every time —
  // silently, as "no handler". Three of the installs reporting telemetry are win32.
  const relativeFile = relative(index.root, route.handler.file);
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
