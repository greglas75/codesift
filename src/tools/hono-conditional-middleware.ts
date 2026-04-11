/**
 * trace_conditional_middleware — lists middleware that is applied under a
 * runtime condition (e.g., basicAuth only for non-GET methods). Consumes
 * the applied_when data populated by HonoExtractor Phase 2 T4.
 *
 * Use case: audit_hono_security was producing false positives on conditional
 * auth wrappers in inline middleware arrows. This tool surfaces the gated
 * middleware so operators can verify the gating is correct.
 *
 * Spec: docs/specs/2026-04-11-hono-phase-2-plan.md (T7)
 */

import { getCodeIndex } from "./index-tools.js";
import { honoCache } from "../cache/hono-cache.js";
import { HonoExtractor } from "../parser/extractors/hono.js";
import { detectFrameworks } from "../utils/framework-detect.js";
import { join } from "node:path";
import type { ConditionalApplication } from "../parser/extractors/hono-model.js";

export interface ConditionalMiddlewareEntry {
  scope: string;
  middleware_name: string;
  condition_type: ConditionalApplication["condition_type"];
  condition_text: string;
  file: string;
  line: number;
}

export interface ConditionalMiddlewareResult {
  entries?: ConditionalMiddlewareEntry[];
  total?: number;
  error?: string;
}

export async function traceConditionalMiddleware(
  repo: string,
  scopeFilter?: string,
): Promise<ConditionalMiddlewareResult> {
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

  const entries: ConditionalMiddlewareEntry[] = [];
  for (const chain of model.middleware_chains) {
    if (scopeFilter && chain.scope !== scopeFilter) continue;
    for (const entry of chain.entries) {
      if (!entry.applied_when) continue;
      entries.push({
        scope: chain.scope,
        middleware_name: entry.name,
        condition_type: entry.applied_when.condition_type,
        condition_text: entry.applied_when.condition_text,
        file: entry.file,
        line: entry.line,
      });
    }
  }

  return { entries, total: entries.length };
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
