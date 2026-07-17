import { readFile } from "node:fs/promises";

import type { Conventions, MiddlewareChain, RouteMountEntry } from "./project-profile-types.js";

let _honoFallbackCount = 0;
export function getHonoFallbackCount(): number { return _honoFallbackCount; }

/**
 * Extract Hono conventions from an orchestrator file.
 *
 * Uses the tree-sitter AST extractor (HonoExtractor) and adapts the result
 * to the legacy Conventions shape. Falls back to the regex-based legacy
 * implementation on failure (with counter tracking for observability).
 *
 * Kill switch: set CODESIFT_LEGACY_HONO=1 to force legacy extractor.
 */
export async function extractHonoConventions(
  source: string,
  filePath: string,
): Promise<Conventions> {
  if (process.env.CODESIFT_LEGACY_HONO === "1") {
    const { legacyExtractHonoConventions } = await import("./legacy-hono-conventions.js");
    return legacyExtractHonoConventions(source, filePath);
  }

  // If called with a source string and a file path that doesn't exist on disk,
  // this is the legacy string-fixture API — use legacy extractor directly.
  // The AST extractor needs a real file to parse.
  const { existsSync } = await import("node:fs");
  const { isAbsolute, resolve: pathResolve } = await import("node:path");
  const resolved = isAbsolute(filePath) ? filePath : pathResolve(filePath);
  if (!existsSync(resolved)) {
    const { legacyExtractHonoConventions } = await import("./legacy-hono-conventions.js");
    return legacyExtractHonoConventions(source, filePath);
  }

  let diskSource: string;
  try {
    diskSource = await readFile(resolved, "utf-8");
  } catch (err) {
    throw new Error(`Unable to read Hono source file ${resolved}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (diskSource !== source) {
    const { legacyExtractHonoConventions } = await import("./legacy-hono-conventions.js");
    return legacyExtractHonoConventions(source, filePath);
  }

  try {
    return await honoConventionsAdapter(resolved);
  } catch (err: unknown) {
    _honoFallbackCount++;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[codesift] Hono AST extractor failed (fallback #${_honoFallbackCount}): ${msg}`);
    if (process.env.NODE_ENV !== "production" && process.env.CODESIFT_SILENT_FALLBACK !== "1") {
      throw err;
    }
    const { legacyExtractHonoConventions } = await import("./legacy-hono-conventions.js");
    return legacyExtractHonoConventions(source, filePath);
  }
}

/**
 * Adapter: run HonoExtractor.parse() and map HonoAppModel → Conventions.
 */
async function honoConventionsAdapter(filePath: string): Promise<Conventions> {
  const { HonoExtractor } = await import("../parser/extractors/hono.js");
  const extractor = new HonoExtractor();
  const model = await extractor.parse(filePath);

  // Map middleware_chains
  const middleware_chains: MiddlewareChain[] = model.middleware_chains.map((mc) => ({
    scope: mc.scope === "*" ? "global" : mc.scope.replace(/\/\*$/, "").split("/").filter(Boolean)[1] ?? mc.scope,
    file: mc.entries[0]?.file ?? filePath,
    chain: mc.entries.map((e) => ({
      name: e.name,
      line: e.line,
      order: e.order,
    })),
  }));

  // Map route_mounts
  const route_mounts: RouteMountEntry[] = model.mounts
    .filter((m) => m.mount_type === "hono_route")
    .map((m) => ({
      file: filePath,
      line: 0, // line not tracked in new model at mount level
      mount_path: m.mount_path,
      imported_from: m.child_file || null,
      exported_as: m.child_var,
    }));

  // Map auth_patterns from middleware names
  const authGroups: Record<string, { requires_auth: boolean; middleware: string[] }> = {};
  let auth_middleware: string | null = null;
  for (const mc of model.middleware_chains) {
    const scope = mc.scope === "*" ? "global" : mc.scope.replace(/\/\*$/, "").split("/").filter(Boolean)[1] ?? mc.scope;
    for (const entry of mc.entries) {
      if (/auth|clerk|jwt|session|passport/i.test(entry.name)) {
        auth_middleware = entry.name;
        if (!authGroups[scope]) authGroups[scope] = { requires_auth: false, middleware: [] };
        authGroups[scope].requires_auth = true;
        if (!authGroups[scope].middleware.includes(entry.name)) {
          authGroups[scope].middleware.push(entry.name);
        }
      }
    }
  }
  // Ensure all route groups represented
  for (const mount of model.mounts) {
    const group = mount.mount_path.split("/").filter(Boolean)[1] ?? "root";
    if (!authGroups[group]) authGroups[group] = { requires_auth: false, middleware: [] };
  }

  return {
    middleware_chains,
    rate_limits: [], // rate limits extracted from AST in future; empty for now
    route_mounts,
    auth_patterns: { auth_middleware, groups: authGroups },
  };
}
