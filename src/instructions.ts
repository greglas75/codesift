/**
 * CODESIFT_INSTRUCTIONS — single source of truth for agent guidance.
 * Target: ~800 tokens (~3200 chars). Compact abbreviated format.
 */
export const CODESIFT_INSTRUCTIONS = `CodeSift — 146 MCP tools (51 core, 95 hidden via disable()).

START HERE: For any non-trivial code task call mcp__codesift__plan_turn(query="<your task>") FIRST. plan_turn is always visible — no schema-loading required. It returns ranked tools+symbols+files and auto-reveals hidden tools in one call. Do NOT iterate ToolSearch to discover CodeSift tools — plan_turn replaces that path.

PREFER core CodeSift tools over Grep/Glob/Read for code search. Always-visible core covers: search_text, search_symbols, get_file_outline, get_file_tree, get_symbol, get_symbols, codebase_retrieval, find_references, find_and_show, get_context_bundle, analyze_complexity, detect_communities, audit_scan, search_conversations, index_status, plus framework-core (framework_audit, nextjs_route_map, nextjs_metadata_audit for Next.js; analyze_hono_app, trace_middleware_chain for Hono; astro_audit + 6 astro_* for Astro; nest_audit for NestJS).

AUTO-LOAD: Framework-specific tools auto-enable when project type is detected at CWD or indexed path:
  composer.json → PHP/Yii2 (6 tools)        build.gradle.kts → Kotlin (10 tools incl. Compose/Room)
  pyproject.toml | requirements.txt → Python (14 tools incl. Django/FastAPI/pytest)
  package.json + react/@xyflow/react/next + .tsx files → React (6 tools)
  package.json + hono → Hono (9 tools)

DISCOVERY (when plan_turn doesn't surface what you need)
  describe_tools(names=["find_dead_code"], reveal=true) → enables hidden tool in ListTools
  discover_tools(query="dead code") → keyword search across all 146 tools
  ToolSearch(query="select:mcp__codesift__<name>") → Claude Code primitive (last resort)

HINT CODES (act on immediately when they appear in responses)
  H1(n)  → add group_by_file=true    H2(n,tool) → batch into one call
  H3(n)  → repo auto-resolves, skip  H4 → add file_pattern
  H5     → use cached tree result    H6(n) → add detail_level=compact
  H7     → use get_context_bundle    H8(n) → use assemble_context(level=L1)
  H9     → codebase_retrieval(type:semantic)  H10 → call get_session_snapshot
  H11    → use search_text instead
  H15 — journal fetch: use search_text(query=<term>, glob='.codesift/wiki/journal/**') rather than reading whole phase files; phase files can be 30KB+.

ALWAYS: repo auto-resolves, skip list_repos. file_pattern when scoped. get_symbols (batch)
  for 2+. Batch 3+ into codebase_retrieval. token_budget to cap. index_file after edits.
  trace_route for endpoints. codebase_retrieval(type:semantic) for conceptual queries.

NEVER: index_folder if already indexed. list_repos in single-repo. get_knowledge_map
  without detect_communities (129K+). Read file for return type → get_type_info.

KEY PARAMS
  search_symbols: detail_level=compact | token_budget=N | kind=function/class/component/hook
  search_text: group_by_file=true | auto_group | ranked=true (dedup by function)
  assemble_context: L0 full | L1 sigs (3-5x denser) | L2 summaries | L3 dirs
  codebase_retrieval: always token_budget | get_knowledge_map: ALWAYS focus=

CASCADE (auto): >52.5K→compact, >87.5K→counts, >105K→truncate. Skipped if detail_level/token_budget set.

TOOL MAPPING (quick ref)
  text pattern      → search_text(file_pattern=)
  function/class    → search_symbols(include_source=true)
  file structure    → get_file_outline | find files → get_file_tree(compact=true)
  1 symbol          → get_symbol | 2+ symbols → get_symbols (batch)
  symbol + refs     → find_and_show(include_refs=true) | usages → find_references
  call chain        → trace_call_chain | blast radius → impact_analysis(since="HEAD~3")
  concept question  → codebase_retrieval(type:semantic)
  multi-search 3+   → codebase_retrieval(queries=[...])
  dead code         → find_dead_code | complexity → analyze_complexity
  duplication       → find_clones(min_similarity=0.7) | anti-patterns → search_patterns
  architecture/deps → detect_communities(focus=) | git churn → analyze_hotspots(since_days=90)
  mermaid diagram   → trace_call_chain(output_format="mermaid")
  API endpoint      → trace_route (FIRST) | secrets → scan_secrets
  source → sink     → taint_trace(file_pattern=, framework="python-django")
  past sessions     → search_conversations | changed code → changed_symbols(since=)
  plan next task    → plan_turn(query=...)
  session snapshot  → get_session_snapshot | session → get_session_context
  React components  → search_symbols(kind=component) | hooks → search_symbols(kind=hook)
  component tree    → trace_component_tree | hook analysis → analyze_hooks
  re-render risk    → analyze_renders | context flow → analyze_context_graph
  React anti-pats   → search_patterns("hook-in-condition") | clean graph → trace_call_chain(filter_react_hooks=true)
  Astro islands     → astro_analyze_islands | hydration audit → astro_hydration_audit
  Astro routes      → astro_route_map | config → astro_config_analyze
  Next.js audit     → framework_audit | route map → nextjs_route_map
  SEO/metadata      → nextjs_metadata_audit | server actions → nextjs_audit_server_actions
  API contract      → nextjs_api_contract | client boundary → nextjs_boundary_analyzer
  broken links      → nextjs_link_integrity | data waterfalls → nextjs_data_flow
  middleware gaps   → nextjs_middleware_coverage | server/client → analyze_nextjs_components
  Hono overview     → analyze_hono_app (FIRST for any Hono project)
  Hono middleware   → trace_middleware_chain (modes: route/scope/app-wide, only_conditional=true for applied_when)
  Hono context flow → trace_context_flow | inline handler → analyze_inline_handler
  Hono API contract → extract_api_contract | response types → extract_response_types
  Hono RPC types    → trace_rpc_types | security+env → audit_hono_security (rate-limit, auth, env-regression #3587)
  Hono modules      → detect_hono_modules | dead routes → find_dead_hono_routes | visualize → visualize_hono_routes
`;
