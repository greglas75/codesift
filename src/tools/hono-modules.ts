/**
 * detect_hono_modules — clusters routes into logical modules without any new
 * AST walking. Uses the 2-segment path prefix as the clustering key (e.g.,
 * /api/admin/users → /api/admin), then rolls up middleware, env bindings,
 * and source files per group. Single-segment routes cluster on the first
 * segment alone.
 *
 * Closes Hono GitHub Issue #4121 — there is no existing architecture
 * guidance for enterprise Hono apps with multiple logical modules. This
 * tool surfaces the implicit module structure already encoded in path
 * prefixes and shared middleware.
 *
 * Spec: docs/specs/2026-04-11-hono-phase-2-plan.md (T11)
 */

import { getCodeIndex } from "./index-tools.js";
import { honoCache } from "../cache/hono-cache.js";
import { HonoExtractor } from "../parser/extractors/hono.js";
import { detectFrameworks } from "../utils/framework-detect.js";
import { join } from "node:path";
import type { HonoModule } from "../parser/extractors/hono-model.js";

export interface HonoModulesResult {
  modules?: HonoModule[];
  total?: number;
  error?: string;
}

export async function detectHonoModules(
  repo: string,
): Promise<HonoModulesResult> {
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

  // Bucket routes by module prefix.
  const buckets = new Map<
    string,
    {
      routes: string[];
      files: Set<string>;
      bindings: Set<string>;
    }
  >();

  for (const route of model.routes) {
    const prefix = modulePrefix(route.path);
    let bucket = buckets.get(prefix);
    if (!bucket) {
      bucket = { routes: [], files: new Set(), bindings: new Set() };
      buckets.set(prefix, bucket);
    }
    bucket.routes.push(`${route.method} ${route.path}`);
    bucket.files.add(route.file);
    // Collect env bindings referenced from the route's inline handler
    if (route.inline_analysis) {
      for (const access of route.inline_analysis.context_access) {
        if (access.type === "env") bucket.bindings.add(access.key);
      }
    }
  }

  // Roll up middleware from chains whose scope pattern matches any route
  // in the module. Scope matching is a simple glob-to-regex conversion.
  const modules: HonoModule[] = [];
  for (const [prefix, bucket] of buckets) {
    const mwNames = new Set<string>();
    for (const chain of model.middleware_chains) {
      const pattern = scopeToRegex(chain.scope);
      const anyMatch = bucket.routes.some((r) => {
        const path = r.split(" ")[1] ?? "";
        return pattern.test(path);
      });
      if (anyMatch) {
        for (const entry of chain.entries) {
          if (entry.name !== "<inline>") mwNames.add(entry.name);
        }
      }
    }
    modules.push({
      name: moduleNameFromPrefix(prefix),
      routes: bucket.routes.sort(),
      middleware: [...mwNames].sort(),
      bindings: [...bucket.bindings].sort(),
      path_prefix: prefix,
      files: [...bucket.files].sort(),
    });
  }

  modules.sort((a, b) => a.name.localeCompare(b.name));
  return { modules, total: modules.length };
}

/**
 * Compute the module prefix from a route path. Takes the first two
 * non-empty segments so `/api/admin/users/:id` → `/api/admin`, and
 * `/health` → `/health`. Single-segment paths become their own module.
 */
function modulePrefix(routePath: string): string {
  const segments = routePath.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return "/";
  if (segments.length === 1) return `/${segments[0]}`;
  return `/${segments[0]}/${segments[1]}`;
}

function moduleNameFromPrefix(prefix: string): string {
  const cleaned = prefix.replace(/^\//, "").replace(/\//g, "-");
  return cleaned.length > 0 ? cleaned : "root";
}

/**
 * Convert a middleware scope like "/api/admin/*" into a regex. "*" inside a
 * path segment maps to "[^/]*"; a trailing "/*" means "anything under this
 * prefix", so it maps to ".*". Bare "*" means global.
 */
function scopeToRegex(scope: string): RegExp {
  if (scope === "*") return /^.*$/;
  const escaped = scope
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\/\*$/, "/.*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
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
