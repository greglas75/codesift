/**
 * trace_context_flow — tracks c.set/c.get/c.var/c.env flow through Hono app.
 *
 * Identifies MISSING_CONTEXT_VARIABLE when a route accesses a var that no
 * middleware in its scope sets.
 *
 * Spec: docs/specs/2026-04-10-hono-framework-intelligence-spec.md (Task 18)
 */

import { getCodeIndex } from "./index-tools.js";
import { honoCache } from "../cache/hono-cache.js";
import { HonoExtractor } from "../parser/extractors/hono.js";
import { detectFrameworks } from "../utils/framework-detect.js";
import { join } from "node:path";
import type { ContextVariable } from "../parser/extractors/hono-model.js";

export interface ContextFlowResult {
  context_vars?: ContextVariable[];
  findings?: Array<{
    type: "MISSING_CONTEXT_VARIABLE";
    variable: string;
    route: string;
    get_point: { file: string; line: number };
  }>;
  error?: string;
}

export async function traceContextFlow(
  repo: string,
  variable?: string,
): Promise<ContextFlowResult> {
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

  const vars = variable
    ? model.context_vars.filter((cv) => cv.name === variable)
    : model.context_vars;

  const findings: ContextFlowResult["findings"] = [];

  // MISSING_CONTEXT_VARIABLE detection: variable accessed in route whose
  // middleware scope doesn't include a setter
  for (const cv of vars) {
    if (cv.is_env_binding) continue; // c.env.* always available
    if (cv.set_points.length === 0) continue;
    for (const getPoint of cv.get_points) {
      // Find route containing this get point
      const route = model.routes.find(
        (r) =>
          r.file === getPoint.file &&
          Math.abs(r.line - getPoint.line) <= 50,
      );
      if (!route) continue;

      // Check if any middleware chain matching the route has a file that
      // contains a set_point for this variable
      const activeScopes = model.middleware_chains.filter((mc) => {
        if (mc.scope === "*") return true;
        const pattern = mc.scope.replace(/\*/g, ".*");
        return new RegExp(`^${pattern}$`).test(route.path);
      });
      const setInScope = cv.set_points.some((sp) =>
        activeScopes.some((s) => s.entries.some((e) => e.file === sp.file)),
      );
      if (!setInScope) {
        findings.push({
          type: "MISSING_CONTEXT_VARIABLE",
          variable: cv.name,
          route: route.path,
          get_point: { file: getPoint.file, line: getPoint.line },
        });
      }
    }
  }

  return { context_vars: vars, findings };
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
