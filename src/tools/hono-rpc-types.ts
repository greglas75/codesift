/**
 * trace_rpc_types — analyzes Hono RPC type exports for slow-pattern detection.
 * Addresses Issue #3869: `export type X = typeof app` causes 8-min CI builds.
 *
 * Spec: docs/specs/2026-04-10-hono-framework-intelligence-spec.md (Task 20)
 */

import { getCodeIndex } from "./index-tools.js";
import { honoCache } from "../cache/hono-cache.js";
import { HonoExtractor } from "../parser/extractors/hono.js";
import { detectFrameworks } from "../utils/framework-detect.js";
import { join } from "node:path";

export interface RpcTypesResult {
  exports?: Array<{
    name: string;
    shape: "full_app" | "route_group";
    is_slow: boolean;
    source_var: string;
    file: string;
    line: number;
    recommendation?: string;
  }>;
  has_slow_pattern?: boolean;
  error?: string;
}

export async function traceRpcTypes(repo: string): Promise<RpcTypesResult> {
  const index = await getCodeIndex(repo);
  if (!index) return { error: `Repository "${repo}" not found` };

  const frameworks = detectFrameworks(index);
  if (!frameworks.has("hono")) return { error: "No Hono app detected" };

  const entryFile = resolveHonoEntryFile(index);
  if (!entryFile) return { error: "No Hono entry file found" };

  let model;
  try {
    model = await honoCache.get(repo, entryFile, new HonoExtractor());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Failed to parse: ${msg}` };
  }

  const exports = model.rpc_exports.map((r) => {
    const entry: NonNullable<RpcTypesResult["exports"]>[number] = {
      name: r.export_name,
      shape: r.shape,
      is_slow: r.shape === "full_app",
      source_var: r.source_var,
      file: r.file,
      line: r.line,
    };
    if (r.shape === "full_app") {
      entry.recommendation = "Split into per-route-group type exports (Hono docs + Issue #3869) to reduce tsc compile time.";
    }
    return entry;
  });

  return {
    exports,
    has_slow_pattern: exports.some((e) => e.is_slow),
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
