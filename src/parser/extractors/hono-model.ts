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
