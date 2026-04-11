/**
 * trace_middleware_chain — returns the ordered middleware chain for a given Hono route.
 *
 * For a path like /api/admin/users/:id, walks all middleware chains whose scope
 * pattern matches the route's fully-resolved path and concatenates them in
 * registration order. Output is a MiddlewareEntry[] (see hono-model.ts).
 *
 * Spec: docs/specs/2026-04-10-hono-framework-intelligence-spec.md (Task 16)
 */

import { getCodeIndex } from "./index-tools.js";
import { honoCache } from "../cache/hono-cache.js";
import { HonoExtractor } from "../parser/extractors/hono.js";
import { matchPath } from "./route-tools.js";
import { detectFrameworks } from "../utils/framework-detect.js";
import { join } from "node:path";
import type { MiddlewareEntry, HonoRoute } from "../parser/extractors/hono-model.js";

export interface MiddlewareChainResult {
  route?: {
    method: string;
    path: string;
    file: string;
    line: number;
  };
  chain: MiddlewareEntry[];
  error?: string;
}

export async function traceMiddlewareChain(
  repo: string,
  path: string,
  method?: string,
): Promise<MiddlewareChainResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    return { chain: [], error: `Repository "${repo}" not found` };
  }

  const frameworks = detectFrameworks(index);
  if (!frameworks.has("hono")) {
    return { chain: [], error: "No Hono app detected in this repo" };
  }

  const entryFile = resolveHonoEntryFile(index);
  if (!entryFile) {
    return { chain: [], error: "No Hono app entry file found" };
  }

  let model;
  try {
    model = await honoCache.get(repo, entryFile, new HonoExtractor());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { chain: [], error: `Failed to parse Hono app: ${msg}` };
  }

  // Find the matching route
  const upperMethod = method?.toUpperCase();
  const matchingRoute = model.routes.find(
    (r: HonoRoute) =>
      matchPath(r.path, path) && (!upperMethod || r.method === upperMethod),
  );

  if (!matchingRoute) {
    return {
      chain: [],
      error: `No route matching ${method ?? "ANY"} ${path}`,
    };
  }

  // Find all middleware chains whose scope_pattern matches the route path
  const chain: MiddlewareEntry[] = [];
  for (const mc of model.middleware_chains) {
    const pattern = compileScopePattern(mc.scope_pattern);
    if (pattern.test(matchingRoute.path)) {
      chain.push(...mc.entries);
    }
  }

  // Sort by order (registration order within each chain is already numeric)
  chain.sort((a, b) => a.order - b.order);

  return {
    route: {
      method: matchingRoute.method,
      path: matchingRoute.path,
      file: matchingRoute.file,
      line: matchingRoute.line,
    },
    chain,
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

function compileScopePattern(pattern: string): RegExp {
  // Simple glob→regex: * matches anything (non-greedy-ish for path segments)
  // Handle bare "*" as "match anything"
  if (pattern === "*") return /^.*$/;
  // Escape regex metachars EXCEPT *, then replace * with .*
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regexStr = escaped.replace(/\*/g, ".*");
  return new RegExp(`^${regexStr}$`);
}
