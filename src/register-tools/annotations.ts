import type { ToolAnnotations } from "@modelcontextprotocol/server";

/**
 * MCP behaviour hints for every tool, reported in tools/list so a client can tell a
 * lookup from a tool that changes something. They are hints, never a security boundary.
 *
 * Classified from what the handler actually does, not from its name: analyze_project,
 * architecture_summary and react_quickstart read like lookups but all write
 * `.zuvo/project-profile.json` through analyzeProject. A read-only hint on a tool that
 * writes is the one wrong answer here, so an unclassified tool reports NOTHING and the
 * client falls back to the spec's defaults (may write, may be destructive) —
 * tests/tools/register/tool-annotations.test.ts fails until a new tool is listed.
 *
 * What does not count as writing: CodeSift's own bookkeeping under its data dir (usage
 * log, session state, index caches) and a linter's cache (.ruff_cache, .mypy_cache).
 * Changing which tools a client sees DOES count: describe_tools(reveal=true) and plan_turn
 * can put rename_symbol on the list, so neither may pass as a plain lookup.
 */
const CLOSED_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const REPEATABLE_WRITE: ToolAnnotations = { ...CLOSED_WRITE, idempotentHint: true };

/** Overwrites or removes something that may not be regenerable (or not cheaply). */
const OVERWRITES: ToolAnnotations = { ...REPEATABLE_WRITE, destructiveHint: true };

const LOCAL_READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const WRITING_TOOLS: Readonly<Record<string, ToolAnnotations>> = {
  analyze_project: REPEATABLE_WRITE,
  architecture_summary: REPEATABLE_WRITE,
  consolidate_memories: OVERWRITES, // MEMORY.md in the project root by default
  create_analysis_plan: CLOSED_WRITE,
  describe_tools: REPEATABLE_WRITE, // reveal=true enables tools in tools/list
  generate_claude_md: OVERWRITES, // any file in the repo via output_path
  generate_report: REPEATABLE_WRITE,
  generate_wiki: CLOSED_WRITE, // journal_mode can append
  index_conversations: REPEATABLE_WRITE,
  index_file: REPEATABLE_WRITE,
  index_folder: REPEATABLE_WRITE,
  index_repo: { ...REPEATABLE_WRITE, openWorldHint: true }, // clones a remote
  invalidate_cache: OVERWRITES,
  journal_append: CLOSED_WRITE,
  plan_turn: REPEATABLE_WRITE, // enables the hidden tools it recommends
  pope_insights_push_candidates: { ...CLOSED_WRITE, openWorldHint: true }, // POSTs with dry_run=false
  react_quickstart: REPEATABLE_WRITE,
  rename_symbol: { ...CLOSED_WRITE, destructiveHint: true }, // rewrites source files
  repo_group: { ...CLOSED_WRITE, destructiveHint: true }, // action='remove'
  scratchpad_write: REPEATABLE_WRITE,
  update_step_status: REPEATABLE_WRITE,
};

/** Read-only, but the answer comes from outside: a package registry, OSV, a live database. */
const EXTERNAL_READ_TOOLS: ReadonlySet<string> = new Set<string>([
  "analyze_python_deps",
  "dependency_audit",
  "introspect_pg",
]);

const LOCAL_READ_TOOLS: ReadonlySet<string> = new Set<string>([
  "affected_workspaces", "analyze_async_correctness", "analyze_complexity",
  "analyze_compose_recomposition", "analyze_context_graph", "analyze_django_settings",
  "analyze_hono_app", "analyze_hooks", "analyze_hotspots", "analyze_inline_handler",
  "analyze_kmp_declarations", "analyze_phpstan_baseline", "analyze_prisma_schema",
  "analyze_renders", "analyze_schema", "analyze_sealed_hierarchy",
  "analyze_yii_console_commands", "analyze_yii_migrations", "analyze_yii_modules",
  "analyze_yii_rbac", "assemble_context", "ast_query", "astro_actions_audit",
  "astro_analyze_islands", "astro_audit", "astro_config_analyze", "astro_content_collections",
  "astro_db_audit", "astro_env_validator", "astro_hydration_audit", "astro_image_audit",
  "astro_middleware", "astro_migration_check", "astro_route_map", "astro_sessions",
  "astro_svg_components", "audit_agent_config", "audit_compiler_readiness", "audit_hono_security",
  "audit_scan", "changed_symbols", "check_boundaries", "classify_roles", "co_change_analysis",
  "codebase_retrieval", "cross_repo_refs", "cross_repo_search",
  "detect_communities", "detect_hono_modules", "diff_migrations", "diff_outline",
  "discover_tools", "effective_django_view_security", "explain_query", "explore",
  "extract_api_contract", "extract_kotlin_serialization_contract", "extract_response_types",
  "fan_in_fan_out", "find_and_show", "find_circular_deps", "find_clones",
  "find_conversations_for_symbol", "find_dead_code", "find_dead_hono_routes",
  "find_endpoint_consumers", "find_extension_functions", "find_framework_wiring",
  "find_perf_hotspots", "find_php8_migration_candidates", "find_php_views", "find_python_callers",
  "find_references", "find_unused_imports", "find_yii3_attribute_candidates", "framework_audit",
  "frequency_analysis", "get_analysis_plan", "get_call_hierarchy", "get_context_bundle",
  "get_extractor_versions", "get_file_outline", "get_file_tree", "get_knowledge_map",
  "get_model_graph", "get_pydantic_models", "get_repo_outline", "get_session_context",
  "get_session_snapshot", "get_symbol", "get_symbols", "get_test_fixtures", "get_type_info",
  "go_to_definition", "impact_analysis", "index_status", "initial_instructions", "list_analysis_plans",
  "list_patterns", "list_repos", "list_workspaces", "match_group_contracts",
  "memory_candidate_extract", "migration_lint", "nest_audit", "nextjs_metadata_audit",
  "nextjs_route_map", "optimization_candidates", "parse_pyproject", "php8_compat_check",
  "php_project_audit", "php_security_scan", "python_audit", "read_memory",
  "resolve_constant_value", "resolve_php_namespace", "resolve_php_service", "retros_analyze",
  "retros_list", "review_diff", "run_mypy", "run_pyright", "run_ruff", "scan_secrets",
  "scratchpad_list", "scratchpad_read", "search_all_conversations", "search_columns",
  "search_conversations", "search_patterns", "search_symbols", "search_text", "semantic_search",
  "sql_audit", "suggest_queries", "taint_trace", "test_impact_analysis", "trace_call_chain",
  "trace_component_tree", "trace_compose_tree", "trace_context_flow", "trace_fastapi_depends",
  "trace_flow_chain", "trace_hilt_graph", "trace_middleware_chain", "trace_php_event",
  "trace_query", "trace_room_schema", "trace_route", "trace_rpc_types", "trace_suspend_chain",
  "usage_hotspots", "usage_stats", "usage_trace_session", "visualize_hono_routes",
  "workspace_boundaries", "workspace_graph", "yii3_migration_audit",
]);

/** Every classified name, in one list so a test can catch a typo or a name listed twice. */
export const ANNOTATED_TOOL_NAMES: readonly string[] = [
  ...Object.keys(WRITING_TOOLS),
  ...EXTERNAL_READ_TOOLS,
  ...LOCAL_READ_TOOLS,
];

/** A fresh object per call: the presets are shared, and a registered tool keeps what it is given. */
export function toolAnnotations(name: string): ToolAnnotations | undefined {
  if (Object.hasOwn(WRITING_TOOLS, name)) return { ...WRITING_TOOLS[name] };
  if (EXTERNAL_READ_TOOLS.has(name)) return { ...LOCAL_READ, openWorldHint: true };
  return LOCAL_READ_TOOLS.has(name) ? { ...LOCAL_READ } : undefined;
}

/** Spread into a registerTool config: exactOptionalPropertyTypes rejects `annotations: undefined`. */
export function annotationConfig(name: string): { annotations?: ToolAnnotations } {
  const annotations = toolAnnotations(name);
  return annotations ? { annotations } : {};
}
