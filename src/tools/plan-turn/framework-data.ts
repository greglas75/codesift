export const KNOWN_FRAMEWORK_KEYWORDS: Record<string, string[]> = {
  react: ["react", "jsx", "tsx"],
  nextjs: ["next", "next.js", "nextjs"],
  astro: ["astro"],
  hono: ["hono"],
  php: ["php", "yii", "laravel", "symfony"],
  kotlin: ["kotlin", "compose", "android"],
  python: ["python", "django", "fastapi", "flask"],
};

export const MONOREPO_QUERY_TERMS = [
  "monorepo", "workspace", "package", "apps/", "packages/", "affected", "turbo",
];

export const MONOREPO_TOOL_NAMES = [
  "list_workspaces", "workspace_graph", "affected_workspaces", "workspace_boundaries",
];

export const FRAMEWORK_TOOL_OWNERS: Record<string, string> = {
  astro_actions_audit: "astro",
  astro_analyze_islands: "astro",
  astro_audit: "astro",
  astro_config_analyze: "astro",
  astro_content_collections: "astro",
  astro_db_audit: "astro",
  astro_env_validator: "astro",
  astro_image_audit: "astro",
  astro_middleware: "astro",
  astro_migration_check: "astro",
  astro_route_map: "astro",
  astro_sessions: "astro",
  astro_svg_components: "astro",
  analyze_context_graph: "react",
  analyze_hooks: "react",
  analyze_renders: "react",
  audit_compiler_readiness: "react",
  react_quickstart: "react",
  trace_component_tree: "react",
  analyze_hono_app: "hono",
  analyze_inline_handler: "hono",
  audit_hono_security: "hono",
  detect_hono_modules: "hono",
  extract_api_contract: "hono",
  extract_response_types: "hono",
  find_dead_hono_routes: "hono",
  trace_context_flow: "hono",
  trace_middleware_chain: "hono",
  trace_rpc_types: "hono",
  visualize_hono_routes: "hono",
};
