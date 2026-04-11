/**
 * Next.js API contract extractor (T3).
 *
 * Walks `app/api/**\/route.{ts,tsx}` and `pages/api/**\/*.{ts,js}` files,
 * extracts HTTP methods, query parameters, request body schemas (Zod-aware),
 * response shapes and status codes, and aggregates a per-handler contract
 * (`HandlerShape`) with a completeness signal.
 *
 * This file is the public-facing entry point and types module. AST readers
 * live in `nextjs-api-contract-readers.ts` per the 2-file split (D10).
 */

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { deriveUrlPath, discoverWorkspaces } from "../utils/nextjs.js";
import { parseFile } from "../parser/parser-manager.js";
import { walkDirectory } from "../utils/walk.js";
import { getCodeIndex } from "./index-tools.js";
import {
  extractHttpMethods,
  extractQueryParams,
  extractRequestBodySchema,
  extractResponseShapes,
} from "./nextjs-api-contract-readers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "DELETE"
  | "PATCH"
  | "HEAD"
  | "OPTIONS";

export interface QueryParam {
  name: string;
  type: string;
}

export interface RequestBodySchema {
  fields?: Record<string, unknown>;
  ref?: string;
  resolved?: boolean;
  type?: "json" | "form" | "unknown";
}

export interface ResponseShape {
  status: number;
  type: "json" | "empty" | "stream" | "redirect" | "unknown";
  body_shape?: unknown;
}

export interface HandlerShape {
  method: HttpMethod;
  path: string;
  router: "app" | "pages";
  query_params: QueryParam[] | "*";
  request_schema: RequestBodySchema | null;
  response_shapes: ResponseShape[];
  inferred_status_codes: number[];
  completeness: number; // 0..1
  file: string;
}

export interface HttpMethodInfo {
  methods: HttpMethod[];
  wrapped: boolean;
}

export interface ApiContractResult {
  handlers: HandlerShape[];
  total: number;
  completeness_score: number; // 0..100 — fraction of handlers with resolved schemas
  parse_failures: string[];
  scan_errors: string[];
  workspaces_scanned: string[];
  limitations: string[];
}

export interface NextjsApiContractOptions {
  workspace?: string | undefined;
  output?: "handler_shape" | "openapi31" | undefined;
  max_files?: number | undefined;
}

// ---------------------------------------------------------------------------
// Orchestrator (Task 24)
// ---------------------------------------------------------------------------

const ROUTE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const PARSE_CONCURRENCY = 10;
const MAX_FILE_SIZE_BYTES = 2_097_152;
const DEFAULT_MAX_FILES = 1000;

function isAppRouteFile(path: string): boolean {
  return /(^|\/)app\/api\/.*\/route\.[jt]sx?$/.test(path);
}

function isPagesApiFile(path: string): boolean {
  return /(^|\/)pages\/api\/.*\.[jt]sx?$/.test(path);
}

export async function nextjsApiContract(
  repo: string,
  options?: NextjsApiContractOptions,
): Promise<ApiContractResult> {
  if (process.env.CODESIFT_DISABLE_TOOLS?.includes("nextjs_api_contract")) {
    throw new Error("nextjs_api_contract is disabled via CODESIFT_DISABLE_TOOLS");
  }

  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository not found: ${repo}. Run index_folder first.`);
  }
  const projectRoot = index.root;

  let workspaces: string[];
  if (options?.workspace) {
    workspaces = [join(projectRoot, options.workspace)];
  } else {
    const discovered = await discoverWorkspaces(projectRoot);
    workspaces = discovered.length > 0 ? discovered.map((w) => w.root) : [projectRoot];
  }

  const maxFiles = options?.max_files ?? DEFAULT_MAX_FILES;
  const handlers: HandlerShape[] = [];
  const parse_failures: string[] = [];
  const scan_errors: string[] = [];
  const workspaces_scanned: string[] = [];

  for (const workspace of workspaces) {
    workspaces_scanned.push(workspace);

    const candidates: string[] = [];
    for (const dir of ["app", "src/app", "pages", "src/pages"]) {
      const fullDir = join(workspace, dir);
      try {
        const walked = await walkDirectory(fullDir, {
          followSymlinks: true,
          fileFilter: (ext) => ROUTE_EXTS.has(ext),
          maxFileSize: MAX_FILE_SIZE_BYTES,
        });
        for (const f of walked) {
          if (isAppRouteFile(f) || isPagesApiFile(f)) candidates.push(f);
        }
      } catch (err) {
        scan_errors.push(`${fullDir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const remaining = maxFiles - handlers.length;
    const toProcess = candidates.slice(0, Math.max(0, remaining));

    for (let i = 0; i < toProcess.length; i += PARSE_CONCURRENCY) {
      const chunk = toProcess.slice(i, i + PARSE_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (filePath) => {
          const rel = relative(projectRoot, filePath);
          try {
            const source = await readFile(filePath, "utf8");
            const tree = await parseFile(filePath, source);
            if (!tree) {
              parse_failures.push(rel);
              return null;
            }
            const router: "app" | "pages" = isAppRouteFile(rel) ? "app" : "pages";
            const path = deriveUrlPath(rel, router);
            const methodInfo = extractHttpMethods(tree);
            const query_params = extractQueryParams(tree, source);
            const request_schema = extractRequestBodySchema(tree, source);
            const response_shapes = extractResponseShapes(tree, source);

            const built: HandlerShape[] = [];
            const methodList = methodInfo.methods.length > 0
              ? methodInfo.methods
              : router === "pages"
                ? (["GET"] as HttpMethod[])
                : [];
            for (const method of methodList) {
              const completeness =
                (request_schema?.resolved ? 0.5 : 0) +
                (response_shapes.length > 0 ? 0.5 : 0);
              const inferred_status_codes = response_shapes.map((r) => r.status);
              built.push({
                method,
                path,
                router,
                query_params,
                request_schema,
                response_shapes,
                inferred_status_codes,
                completeness,
                file: rel,
              });
            }
            return built;
          } catch (err) {
            parse_failures.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          }
        }),
      );
      for (const r of results) {
        if (!r) continue;
        handlers.push(...r);
      }
    }
  }

  const totalCompleteness = handlers.reduce((sum, h) => sum + h.completeness, 0);
  const completeness_score =
    handlers.length > 0 ? Math.round((totalCompleteness / handlers.length) * 100) : 0;

  return {
    handlers,
    total: handlers.length,
    completeness_score,
    parse_failures,
    scan_errors,
    workspaces_scanned,
    limitations: [
      "Zod-only schema detection (Yup/Joi/TypeBox not supported)",
      "best-effort response shape inference",
    ],
  };
}
