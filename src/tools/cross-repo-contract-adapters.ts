import type { RepoEndpoint } from "../types.js";
import type { ApiContractResult as HonoContractResult } from "./hono-api-contract.js";
import type { NestRouteInventoryResult } from "./nest-tools.js";
import type { ApiContractResult as NextjsContractResult } from "./nextjs-api-contract-tools.js";

/**
 * Replace all path-parameter segments with the canonical `{param}` placeholder.
 *
 * Recognised styles:
 *   - Express / Hono   `:name`
 *   - OpenAPI / NestJS `{name}`
 *   - Next.js          `[name]`
 *   - Next.js catch-all `[...name]`
 *
 * Trailing slashes are stripped (except for a bare "/").
 * Method strings are UPPERCASED by callers; this function only handles paths.
 */
export function normalizePathParams(path: string): string {
  // Replace :name segments
  let result = path.replace(/:([^/]+)/g, "{param}");
  // Replace {name} segments (already-braced OpenAPI style)
  result = result.replace(/\{([^}]+)\}/g, "{param}");
  // Replace [...name] and [name] Next.js segments
  result = result.replace(/\[\.\.\.([^\]]+)\]/g, "{param}");
  result = result.replace(/\[([^\]]+)\]/g, "{param}");
  // Strip trailing slash (but keep bare "/")
  if (result.length > 1 && result.endsWith("/")) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * Adapt an `extractApiContract` result (Hono) into `RepoEndpoint[]`.
 *
 * Only the `summary` format carries the per-route list; `openapi` format and
 * missing/undefined summary both return [].
 */
export function adaptHonoContract(repo: string, r: HonoContractResult): RepoEndpoint[] {
  if (!r.summary) return [];
  return r.summary.map((entry) => {
    const method = entry.method.toUpperCase();
    const normalized_path = normalizePathParams(entry.path);
    return { repo, method, path: entry.path, normalized_path, file: entry.file };
  });
}

/**
 * Adapt a `nestRouteInventory` result into `RepoEndpoint[]`.
 *
 * `NestRouteEntry.file` is a required string field — the value is used as-is
 * (may be "" for entries where the controller file couldn't be resolved).
 */
export function adaptNestInventory(repo: string, r: NestRouteInventoryResult): RepoEndpoint[] {
  const routes = r.routes ?? [];
  return routes.map((entry) => {
    const method = entry.method.toUpperCase();
    const normalized_path = normalizePathParams(entry.path);
    return { repo, method, path: entry.path, normalized_path, file: entry.file };
  });
}

/**
 * Adapt a Next.js `ApiContractResult` into `RepoEndpoint[]`.
 *
 * `HandlerShape.method` is a single `HttpMethod` string per entry (Next.js
 * emits one handler per HTTP verb), so each handler maps to one RepoEndpoint.
 */
export function adaptNextjsContract(repo: string, r: NextjsContractResult): RepoEndpoint[] {
  const handlers = r.handlers ?? [];
  return handlers.map((handler) => {
    const method = handler.method.toUpperCase();
    const normalized_path = normalizePathParams(handler.path);
    return { repo, method, path: handler.path, normalized_path, file: handler.file };
  });
}
