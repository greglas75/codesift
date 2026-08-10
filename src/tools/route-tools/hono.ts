import { join } from "node:path";
import { stripSource } from "../graph-tools.js";
import { matchPath } from "../route-shared.js";
import type { CodeIndex } from "../../types.js";
import type { RouteHandler } from "./types.js";

/**
 * Find Hono route handlers by consulting the HonoExtractor-produced model.
 * Uses HonoCache when available, falls back to on-demand parse.
 *
 * The model has pre-resolved paths (basePath + mount prefix + route path),
 * so path matching is a direct matchPath() call against each route.
 */
export async function findHonoHandlers(
  repo: string,
  index: CodeIndex,
  searchPath: string,
): Promise<RouteHandler[]> {
  // Only run if Hono is detected
  const { detectFrameworks } = await import("../../utils/framework-detect.js");
  const frameworks = detectFrameworks(index);
  if (!frameworks.has("hono")) return [];

  // Resolve entry file: prefer orchestrator, else first file containing `new Hono()`
  const entryFile = resolveHonoEntryFile(index);
  if (!entryFile) return [];

  // Get model (via cache)
  let model;
  try {
    const { honoCache } = await import("../../cache/hono-cache.js");
    const { HonoExtractor } = await import("../../parser/extractors/hono.js");
    const extractor = new HonoExtractor();
    model = await honoCache.get(repo, entryFile, extractor);
  } catch {
    return [];
  }

  const handlers: RouteHandler[] = [];
  for (const route of model.routes) {
    if (!matchPath(route.path, searchPath)) continue;

    // Find the handler symbol in the index by file + name + line
    let handlerSym = index.symbols.find(
      (s) =>
        s.file === route.handler.file.replace(index.root + "/", "") &&
        s.name === route.handler.name &&
        Math.abs(s.start_line - route.handler.line) <= 2,
    );

    // Fallback: synthetic stub for inline handlers
    if (!handlerSym) {
      handlerSym = {
        id: `hono:${route.file}:${route.line}`,
        repo,
        name: route.handler.name,
        kind: "function",
        file: route.handler.file.replace(index.root + "/", ""),
        start_line: route.handler.line,
        end_line: route.handler.line,
        start_byte: 0,
        end_byte: 0,
        source: "",
        tokens: [route.handler.name],
      };
    }

    handlers.push({
      symbol: stripSource(handlerSym),
      file: handlerSym.file,
      method: route.method,
      framework: "hono",
    });
  }

  return handlers;
}

/** Find the Hono entry file for a repo — ORCHESTRATOR or first new Hono() file. */
function resolveHonoEntryFile(index: CodeIndex): string | null {
  for (const sym of index.symbols) {
    if (sym.source && /new\s+(?:Hono|OpenAPIHono)\s*(?:<[^>]*>)?\s*\(/.test(sym.source)) {
      // Return absolute path
      return join(index.root, sym.file);
    }
  }
  return null;
}
