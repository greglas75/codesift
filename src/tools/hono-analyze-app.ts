/**
 * analyze_hono_app — complete Hono application overview.
 *
 * Returns routes grouped by method/scope, middleware map, context variables,
 * OpenAPI status, RPC exports (with slow-pattern detection), runtime,
 * and env bindings in one call.
 *
 * Spec: docs/specs/2026-04-10-hono-framework-intelligence-spec.md (Task 17)
 */

import { getCodeIndex } from "./index-tools.js";
import { honoCache } from "../cache/hono-cache.js";
import { HonoExtractor } from "../parser/extractors/hono.js";
import { detectFrameworks } from "../utils/framework-detect.js";
import { join } from "node:path";
import type { HonoAppModel, HonoRoute, HonoMount } from "../parser/extractors/hono-model.js";

export interface AnalyzeHonoAppResult {
  framework?: "hono";
  runtime?: HonoAppModel["runtime"];
  entry_file?: string;
  routes?: {
    total: number;
    by_method: Record<string, number>;
    by_mount: Record<string, number>;
  };
  middleware?: {
    total_chains: number;
    by_scope: Record<string, number>;
    third_party: string[];
  };
  context_vars?: Array<{
    name: string;
    set_count: number;
    get_count: number;
    is_env_binding: boolean;
  }>;
  openapi?: {
    enabled: boolean;
    route_count: number;
  };
  rpc_exports?: Array<{
    name: string;
    shape: "full_app" | "route_group";
    is_slow_pattern: boolean;
    file: string;
  }>;
  env_bindings?: string[];
  extraction_status?: "complete" | "partial";
  skip_reasons?: Record<string, number>;
  files_used_count?: number;
  error?: string;
}

export async function analyzeHonoApp(
  repo: string,
  entryFile?: string,
  forceRefresh?: boolean,
): Promise<AnalyzeHonoAppResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    return { error: `Repository "${repo}" not found` };
  }

  const frameworks = detectFrameworks(index);
  if (!frameworks.has("hono")) {
    return { error: "No Hono app detected in this repo" };
  }

  const resolvedEntry = entryFile ?? resolveHonoEntryFile(index);
  if (!resolvedEntry) {
    return { error: "No Hono app entry file found" };
  }

  if (forceRefresh) {
    honoCache.clear(repo);
  }

  let model: HonoAppModel;
  try {
    model = await honoCache.get(repo, resolvedEntry, new HonoExtractor());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Failed to parse Hono app: ${msg}` };
  }

  // Routes grouped by method and mount prefix
  const byMethod: Record<string, number> = {};
  const byMount: Record<string, number> = {};
  for (const route of model.routes as HonoRoute[]) {
    byMethod[route.method] = (byMethod[route.method] ?? 0) + 1;
    const segments = route.path.split("/").filter(Boolean);
    const mountKey = segments.length >= 2 ? `/${segments[0]}/${segments[1]}` : `/${segments[0] ?? ""}`;
    byMount[mountKey] = (byMount[mountKey] ?? 0) + 1;
  }

  // Middleware grouped by scope, third-party list
  const byScope: Record<string, number> = {};
  const thirdParty = new Set<string>();
  for (const mc of model.middleware_chains) {
    byScope[mc.scope] = (byScope[mc.scope] ?? 0) + mc.entries.length;
    for (const entry of mc.entries) {
      if (entry.is_third_party) thirdParty.add(entry.name);
    }
  }

  return {
    framework: "hono",
    runtime: model.runtime,
    entry_file: model.entry_file,
    routes: {
      total: model.routes.length,
      by_method: byMethod,
      by_mount: byMount,
    },
    middleware: {
      total_chains: model.middleware_chains.length,
      by_scope: byScope,
      third_party: [...thirdParty].sort(),
    },
    context_vars: model.context_vars.map((cv) => ({
      name: cv.name,
      set_count: cv.set_points.length,
      get_count: cv.get_points.length,
      is_env_binding: cv.is_env_binding,
    })),
    openapi: {
      enabled: model.openapi_routes.length > 0,
      route_count: model.openapi_routes.length,
    },
    rpc_exports: model.rpc_exports.map((r) => ({
      name: r.export_name,
      shape: r.shape,
      is_slow_pattern: r.shape === "full_app",
      file: r.file,
    })),
    env_bindings: model.env_bindings,
    extraction_status: model.extraction_status,
    skip_reasons: model.skip_reasons,
    files_used_count: model.files_used.length,
  };
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
