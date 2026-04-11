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
// Stub orchestrator (Task 24 wires this)
// ---------------------------------------------------------------------------

export async function nextjsApiContract(
  _repo: string,
  _options?: NextjsApiContractOptions,
): Promise<ApiContractResult> {
  throw new Error("not implemented");
}
