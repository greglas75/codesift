/**
 * extract_api_contract — infer OpenAPI-like API contract from Hono app.
 *
 * Uses explicit createRoute() definitions where available, falls back to
 * inferring from regular routes (method + path + optional validators).
 *
 * Spec: docs/specs/2026-04-10-hono-framework-intelligence-spec.md (Task 19)
 */

import { getCodeIndex } from "./index-tools.js";
import { honoCache } from "../cache/hono-cache.js";
import { HonoExtractor } from "../parser/extractors/hono.js";
import { resolveHonoEntryFile } from "./hono-entry-resolver.js";
import { detectFrameworks } from "../utils/framework-detect.js";

export type ContractFormat = "openapi" | "summary";

export interface ApiContractResult {
  format?: ContractFormat;
  paths?: Record<string, Record<string, unknown>>;
  summary?: Array<{
    path: string;
    method: string;
    source: "explicit" | "inferred";
    file: string;
  }>;
  error?: string;
}

export async function extractApiContract(
  repo: string,
  entryFile?: string,
  format: ContractFormat = "openapi",
): Promise<ApiContractResult> {
  const index = await getCodeIndex(repo);
  if (!index) return { error: `Repository "${repo}" not found` };

  const frameworks = detectFrameworks(index);
  if (!frameworks.has("hono")) return { error: "No Hono app detected" };

  const resolved = entryFile ?? resolveHonoEntryFile(index);
  if (!resolved) return { error: "No Hono entry file found" };

  let model;
  try {
    model = await honoCache.get(repo, resolved, new HonoExtractor());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Failed to parse: ${msg}` };
  }

  if (format === "summary") {
    const summary: NonNullable<ApiContractResult["summary"]> = [];
    for (const route of model.routes) {
      summary.push({
        path: route.path,
        method: route.method,
        source: route.openapi_route_id ? "explicit" : "inferred",
        file: route.file,
      });
    }
    return { format, summary };
  }

  // OpenAPI 3.1 format
  const paths: Record<string, Record<string, unknown>> = {};

  // Explicit createRoute() definitions
  for (const oar of model.openapi_routes) {
    const pathKey = oar.path;
    if (!paths[pathKey]) paths[pathKey] = {};
    paths[pathKey][oar.method.toLowerCase()] = {
      parameters: [],
      responses: oar.response_schemas,
      "x-hono-source": "createRoute",
    };
  }

  // Inferred from regular routes. When Phase 2 inline_analysis is available,
  // build a real responses object from the extracted c.json/text/html/error
  // emissions instead of a generic "200 Success" stub.
  for (const route of model.routes) {
    if (route.openapi_route_id) continue; // already covered above
    const pathKey = route.path;
    if (!paths[pathKey]) paths[pathKey] = {};
    paths[pathKey][route.method.toLowerCase()] = {
      responses: buildInferredResponses(route),
      "x-hono-source": route.inline_analysis ? "inline_analysis" : "inferred",
      "x-hono-file": route.file,
    };
  }

  return { format, paths };
}

/**
 * Build an OpenAPI-style `responses` object from a route's inline_analysis.
 * When inline_analysis is absent (e.g. named-handler routes), falls back to
 * the generic "200 Success" stub to preserve Phase 1 behavior.
 */
function buildInferredResponses(route: {
  inline_analysis?: {
    responses: Array<{ status: number; kind: string; shape_hint?: string }>;
    errors: Array<{ status: number; exception_class: string; message_hint?: string }>;
  };
}): Record<string, Record<string, unknown>> {
  if (!route.inline_analysis) {
    return { "200": { description: "Success (inferred)" } };
  }
  const bucket = new Map<number, { description: string; source: string }>();
  for (const resp of route.inline_analysis.responses) {
    if (!bucket.has(resp.status)) {
      const desc = resp.shape_hint
        ? `${resp.kind} response — ${resp.shape_hint.slice(0, 80)}`
        : `${resp.kind} response`;
      bucket.set(resp.status, { description: desc, source: "c." + resp.kind });
    }
  }
  for (const err of route.inline_analysis.errors) {
    if (!bucket.has(err.status)) {
      bucket.set(err.status, {
        description: `${err.exception_class} thrown${err.message_hint ? ` — ${err.message_hint.slice(0, 80)}` : ""}`,
        source: "throw " + err.exception_class,
      });
    }
  }
  if (bucket.size === 0) {
    return { "200": { description: "Success (inferred)" } };
  }
  const result: Record<string, Record<string, unknown>> = {};
  for (const [status, info] of [...bucket.entries()].sort((a, b) => a[0] - b[0])) {
    result[String(status)] = {
      description: info.description,
      "x-hono-emission-source": info.source,
    };
  }
  return result;
}