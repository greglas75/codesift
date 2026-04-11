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

  // Inferred from regular routes
  for (const route of model.routes) {
    if (route.openapi_route_id) continue; // already covered above
    const pathKey = route.path;
    if (!paths[pathKey]) paths[pathKey] = {};
    paths[pathKey][route.method.toLowerCase()] = {
      responses: { "200": { description: "Success (inferred)" } },
      "x-hono-source": "inferred",
      "x-hono-file": route.file,
    };
  }

  return { format, paths };
}