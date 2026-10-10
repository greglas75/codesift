import { join, relative } from "node:path";
import type { HonoAppModel, HonoRoute } from "../../parser/extractors/hono-model.js";
import type { CodeSymbol } from "../../types.js";
import { asRouteIndex, type RouteIndex, type RouteIndexInput } from "./route-index.js";
import { stripSource } from "../graph-tools.js";
import { matchPath } from "../route-shared.js";
import type { RouteHandler } from "./types.js";

async function resolveHonoEntryFile(index: RouteIndex): Promise<string | null> {
  // `.find()` took whichever app the index happened to list first, so a fixture or a sub-app in a
  // test file could shadow the real one. Still a heuristic — but a test file is never the routed
  // application, and that is the case this actually hit.
  // "Hono" is a literal the regex requires (OpenAPIHono contains it too); the store applies it.
  const candidates = (await index.find({ sourceContainsAny: ["Hono"], withSource: true })).filter(
    (symbol) => symbol.source &&
      /new\s+(?:Hono|OpenAPIHono)\s*(?:<[^>]*>)?\s*\(/.test(symbol.source),
  );
  const entrySymbol = candidates.find((s) => !/(^|\/)(tests?|__tests__)\//.test(s.file)
      && !/\.(test|spec)\.[jt]sx?$/.test(s.file))
    ?? candidates[0];
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

async function routeHandlerSymbol(repo: string, index: RouteIndex, route: HonoRoute): Promise<CodeSymbol> {
  // `.replace(index.root + "/", "")` hardcoded the POSIX separator, so on win32 the prefix never
  // matched, `relativeFile` stayed absolute, and the symbol lookup below missed every time —
  // silently, as "no handler". Three of the installs reporting telemetry are win32.
  const relativeFile = relative(index.root, route.handler.file);
  const named = await index.find({ file: relativeFile, name: route.handler.name, withSource: false });
  return named.find((symbol) => Math.abs(symbol.start_line - route.handler.line) <= 2) ?? {
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

async function toRouteHandler(repo: string, index: RouteIndex, route: HonoRoute): Promise<RouteHandler> {
  const symbol = await routeHandlerSymbol(repo, index, route);
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
  input: RouteIndexInput,
  searchPath: string,
): Promise<RouteHandler[]> {
  const index = asRouteIndex(input);
  const { detectFrameworks, FRAMEWORK_SOURCE_SAMPLE } = await import("../../utils/framework-detect.js");
  const sample = await index.find({ withSource: true, limit: FRAMEWORK_SOURCE_SAMPLE });
  if (!detectFrameworks({ files: index.files, symbols: sample }).has("hono")) return [];

  const entryFile = await resolveHonoEntryFile(index);
  if (!entryFile) return [];

  const model = await loadHonoModel(repo, entryFile);
  if (!model) return [];

  const handlers: RouteHandler[] = [];
  for (const route of model.routes) {
    if (matchPath(route.path, searchPath)) handlers.push(await toRouteHandler(repo, index, route));
  }
  return handlers;
}
