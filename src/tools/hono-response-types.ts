/**
 * extract_response_types — aggregates all statically-knowable response types
 * (status code + body shape hint + error classes) per route. Closes Hono
 * GitHub Issue #4270: error response types are not inferrable by RPC clients
 * so client-side type narrowing silently drops them. This tool surfaces them
 * from the inline_analysis data so callers can generate RPC client types
 * that include error paths.
 *
 * Spec: docs/specs/2026-04-11-hono-phase-2-plan.md (T9)
 */

import { detectRepoFrameworks, resolveRepoHonoEntryFile } from "./framework-detect-repo.js";
import { honoCache } from "../cache/hono-cache.js";
import { HonoExtractor } from "../parser/extractors/hono.js";

export interface ResponseTypeEntry {
  status: number;
  kind: "json" | "text" | "html" | "body" | "redirect" | "newResponse";
  shape_hint?: string;
}

export interface ErrorTypeEntry {
  status: number;
  exception_class: string;
  message_hint?: string;
}

export interface RouteResponseTypes {
  route: string;
  file: string;
  line: number;
  responses: ResponseTypeEntry[];
  errors: ErrorTypeEntry[];
  /** Distinct status codes reachable (union of responses + errors). */
  status_codes: number[];
}

export interface ResponseTypesResult {
  routes?: RouteResponseTypes[];
  total_routes?: number;
  total_statuses?: number;
  error?: string;
}

export async function extractResponseTypes(
  repo: string,
): Promise<ResponseTypesResult> {
  const scan = await detectRepoFrameworks(repo);
  if (!scan) return { error: `Repository "${repo}" not found` };

  const frameworks = scan.frameworks;
  if (!frameworks.has("hono")) return { error: "No Hono app detected" };

  const entryFile = await resolveRepoHonoEntryFile(repo, scan.root);
  if (!entryFile) return { error: "No Hono app entry file found" };

  let model;
  try {
    model = await honoCache.get(repo, entryFile, new HonoExtractor());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Failed to parse: ${msg}` };
  }

  const routes: RouteResponseTypes[] = [];
  const allStatuses = new Set<number>();

  for (const route of model.routes) {
    if (!route.inline_analysis) continue;
    const responses: ResponseTypeEntry[] = route.inline_analysis.responses.map((r) => {
      const entry: ResponseTypeEntry = { status: r.status, kind: r.kind };
      if (r.shape_hint !== undefined) entry.shape_hint = r.shape_hint;
      return entry;
    });
    const errors: ErrorTypeEntry[] = route.inline_analysis.errors.map((e) => {
      const entry: ErrorTypeEntry = {
        status: e.status,
        exception_class: e.exception_class,
      };
      if (e.message_hint !== undefined) entry.message_hint = e.message_hint;
      return entry;
    });
    const statusSet = new Set<number>();
    for (const r of responses) statusSet.add(r.status);
    for (const e of errors) statusSet.add(e.status);
    for (const s of statusSet) allStatuses.add(s);

    routes.push({
      route: `${route.method} ${route.path}`,
      file: route.file,
      line: route.line,
      responses,
      errors,
      status_codes: [...statusSet].sort((a, b) => a - b),
    });
  }

  return {
    routes,
    total_routes: routes.length,
    total_statuses: allStatuses.size,
  };
}