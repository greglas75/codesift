/**
 * HonoAppModel — unified data model produced by HonoExtractor and consumed
 * by trace_route, trace_middleware_chain, analyze_hono_app, trace_context_flow,
 * extract_api_contract, trace_rpc_types, audit_hono_security, visualize_hono_routes.
 *
 * Spec: docs/specs/2026-04-10-hono-framework-intelligence-spec.md
 * All Map<> fields use Record<> for JSON-serialization safety (spec HIGH-2).
 */

export interface HonoAppModel {
  entry_file: string;
  app_variables: Record<string, HonoApp>;
  routes: HonoRoute[];
  mounts: HonoMount[];
  middleware_chains: MiddlewareChain[];
  context_vars: ContextVariable[];
  openapi_routes: OpenAPIRoute[];
  rpc_exports: RPCExport[];
  runtime: HonoRuntime;
  env_bindings: string[];
  files_used: string[];
  extraction_status: "complete" | "partial";
  skip_reasons: Record<string, number>;
  /** Phase 2: logical modules clustered from routes + middleware + bindings. */
  modules?: HonoModule[];
}

export type HonoRuntime =
  | "cloudflare"
  | "node"
  | "bun"
  | "deno"
  | "lambda"
  | "unknown";

export interface HonoApp {
  variable_name: string;
  file: string;
  line: number;
  created_via: "new Hono" | "OpenAPIHono" | "factory.createApp" | "basePath";
  base_path: string;
  parent?: string;
  generic_env?: string;
}

export type HonoMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "DELETE"
  | "PATCH"
  | "OPTIONS"
  | "ALL"
  | "ON";

export interface HonoRoute {
  method: HonoMethod;
  methods?: string[];
  path: string;
  raw_path: string;
  file: string;
  line: number;
  owner_var: string;
  handler: HonoHandler;
  inline_middleware: string[];
  openapi_route_id?: string;
  validators: HonoValidator[];
  regex_constraint?: Record<string, string>;
  /** Phase 2: populated when handler.inline is true — result of InlineHandlerAnalyzer scan. */
  inline_analysis?: InlineHandlerAnalysis;
}

export interface HonoHandler {
  name: string;
  symbol_id?: string;
  inline: boolean;
  file: string;
  line: number;
}

export interface HonoMount {
  parent_var: string;
  mount_path: string;
  child_var: string;
  child_file: string;
  mount_type: "hono_route" | "hono_mount";
  base_path?: string;
  external_framework?: string;
}

export interface MiddlewareChain {
  scope: string;
  scope_pattern: string;
  owner_var: string;
  entries: MiddlewareEntry[];
}

export interface MiddlewareEntry {
  name: string;
  order: number;
  line: number;
  file: string;
  inline: boolean;
  is_third_party: boolean;
  imported_from?: string;
  expanded_from?: string;
  conditional: boolean;
  /** Phase 2: populated when middleware is applied under a runtime condition. */
  applied_when?: ConditionalApplication;
}

export interface ContextVariable {
  name: string;
  set_points: ContextAccessPoint[];
  get_points: ContextAccessPoint[];
  is_env_binding: boolean;
}

export interface ContextAccessPoint {
  file: string;
  line: number;
  containing_symbol?: string;
  scope: "middleware" | "handler" | "service";
  via_context_storage: boolean;
  condition: "always" | "conditional";
}

export interface HonoValidator {
  target: "json" | "form" | "query" | "param" | "header" | "cookie";
  schema_symbol_id?: string;
  schema_file: string;
  line: number;
  kind: "zValidator" | "valibot" | "typebox" | "arktype" | "custom";
}

export interface OpenAPIRoute {
  id: string;
  method: string;
  path: string;
  hono_path: string;
  request_schemas: Record<string, string>;
  response_schemas: Record<
    string,
    { schema_symbol_id?: string; description?: string }
  >;
  middleware: string[];
  hidden: boolean;
  file: string;
  line: number;
}

export interface RPCExport {
  export_name: string;
  file: string;
  line: number;
  shape: "full_app" | "route_group";
  source_var: string;
}

/* ============================================================
 * Phase 2 — inline handler analysis, conditional middleware,
 * module clustering. All optional; Phase 1 models remain valid.
 * ============================================================ */

/**
 * Result of analyzing an inline handler body — `(c) => { ... }` inside
 * `app.get/post/...` calls. Populated by InlineHandlerAnalyzer when
 * HonoRoute.handler.inline is true. Named handlers in other files get undefined.
 */
export interface InlineHandlerAnalysis {
  responses: ResponseEmission[];
  errors: ErrorEmission[];
  db_calls: ExternalCall[];
  fetch_calls: ExternalCall[];
  context_access: ContextAccess[];
  validators_inline: string[];
  has_try_catch: boolean;
  /** True when the analyzer hit MAX_WALK_DEPTH and the analysis is incomplete. */
  truncated: boolean;
}

export interface ResponseEmission {
  /** Which `c.*` helper emitted the response (disambiguated from HTTP method). */
  kind: "json" | "text" | "html" | "body" | "redirect" | "newResponse";
  /** Defaults to 200 when status argument omitted. */
  status: number;
  /** Best-effort shape extraction — literal text of first arg, truncated to 200 chars. */
  shape_hint?: string;
  line: number;
}

export interface ErrorEmission {
  status: number;
  exception_class: string;
  message_hint?: string;
  line: number;
}

export interface ExternalCall {
  callee: string;
  line: number;
  kind: "db" | "fetch" | "queue" | "email" | "other";
}

export interface ContextAccess {
  type: "set" | "get" | "var" | "env";
  key: string;
  line: number;
}

/**
 * Runtime condition under which a middleware is applied. Set by
 * walkConditionalMiddleware ONLY when conditional — presence of `applied_when`
 * is itself the signal, so no `always_applies` flag is needed. Unconditional
 * middleware leave this field undefined and have `MiddlewareEntry.conditional: false`.
 */
export interface ConditionalApplication {
  condition_type: "method" | "header" | "path" | "custom";
  /** Raw source text of the condition, truncated to 200 chars by producer. */
  condition_text: string;
}

/**
 * A logical module clustered by detect_hono_modules from shared middleware
 * chains, path prefixes, and env bindings. Purely informational; no AST cost.
 */
export interface HonoModule {
  name: string;
  /** Route ids in canonical "METHOD path" form, e.g. "GET /admin/users". */
  routes: string[];
  middleware: string[];
  bindings: string[];
  path_prefix: string;
  files: string[];
}
