/**
 * analyze_inline_handler — returns structured body analysis for a specific
 * inline handler. Consumes HonoRoute.inline_analysis populated by T3.
 *
 * Closes blog API demo gap #1: all 7 blog routes are (c) => c.json(...) inline
 * arrows, and Phase 1 reported them as opaque "<inline>" handlers with zero
 * introspection. With this tool, callers can ask "what does GET /users/:id do?"
 * and get responses, errors, DB calls, fetch calls, context access, and
 * validators — all statically extracted.
 *
 * Spec: docs/specs/2026-04-11-hono-phase-2-plan.md (T8)
 */

import { getCodeIndex } from "./index-tools.js";
import { honoCache } from "../cache/hono-cache.js";
import { HonoExtractor } from "../parser/extractors/hono.js";
import { detectFrameworks } from "../utils/framework-detect.js";
import { join } from "node:path";
import type { InlineHandlerAnalysis } from "../parser/extractors/hono-model.js";

export interface InlineHandlerReport {
  route: string; // "GET /users/:id"
  file: string;
  line: number;
  analysis: InlineHandlerAnalysis;
}

export interface InlineHandlerResult {
  reports?: InlineHandlerReport[];
  total?: number;
  error?: string;
}

/**
 * @param repo repository identifier
 * @param method optional HTTP method filter (e.g. "GET"); case-insensitive
 * @param path optional path filter (e.g. "/users/:id"); exact match
 */
export async function analyzeInlineHandler(
  repo: string,
  method?: string,
  routePath?: string,
): Promise<InlineHandlerResult> {
  const index = await getCodeIndex(repo);
  if (!index) return { error: `Repository "${repo}" not found` };

  const frameworks = detectFrameworks(index);
  if (!frameworks.has("hono")) return { error: "No Hono app detected" };

  const entryFile = resolveHonoEntryFile(index);
  if (!entryFile) return { error: "No Hono app entry file found" };

  let model;
  try {
    model = await honoCache.get(repo, entryFile, new HonoExtractor());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Failed to parse: ${msg}` };
  }

  const methodFilter = method?.toUpperCase();
  const reports: InlineHandlerReport[] = [];
  for (const route of model.routes) {
    if (!route.inline_analysis) continue;
    if (methodFilter && route.method !== methodFilter) continue;
    if (routePath && route.path !== routePath) continue;
    reports.push({
      route: `${route.method} ${route.path}`,
      file: route.file,
      line: route.line,
      analysis: route.inline_analysis,
    });
  }

  return { reports, total: reports.length };
}

function resolveHonoEntryFile(index: {
  symbols: Array<{ source?: string | undefined; file: string }>;
  root: string;
}): string | null {
  for (const sym of index.symbols) {
    if (sym.source && /new\s+(?:Hono|OpenAPIHono)\s*(?:<[^>]*>)?\s*\(/.test(sym.source)) {
      return join(index.root, sym.file);
    }
  }
  return null;
}
