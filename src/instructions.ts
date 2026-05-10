/**
 * CODESIFT_INSTRUCTIONS — single source of truth for agent guidance.
 * Target: ~800 tokens (~3200 chars). Compact abbreviated format.
 */
export const CODESIFT_INSTRUCTIONS = `CodeSift — 150 MCP tools (51 core, 95 hidden via disable()).

START HERE: For any non-trivial code task call mcp__codesift__plan_turn(query="<your task>") FIRST. plan_turn is always visible — no schema-loading required. It returns ranked tools+symbols+files and auto-reveals hidden tools in one call. Do NOT iterate ToolSearch to discover CodeSift tools — plan_turn replaces that path.

PREFER core CodeSift tools over Grep/Glob/Read for code search. Always-visible core covers: search_text, search_symbols, get_file_outline, get_file_tree, get_symbol, get_symbols, codebase_retrieval, find_references, find_and_show, get_context_bundle, analyze_complexity, detect_communities, audit_scan, search_conversations, index_status, plus framework-core (framework_audit, nextjs_route_map, nextjs_metadata_audit for Next.js; analyze_hono_app, trace_middleware_chain for Hono; astro_audit + 6 astro_* for Astro; nest_audit for NestJS).

AUTO-LOAD: Framework-specific tools auto-enable when project type is detected at CWD or indexed path:
  composer.json → PHP/Yii2 (6 tools)        build.gradle.kts → Kotlin (10 tools incl. Compose/Room)
  pyproject.toml | requirements.txt → Python (14 tools incl. Django/FastAPI/pytest)
  package.json + react/@xyflow/react/next + .tsx files → React (6 tools)
  package.json + hono → Hono (9 tools)

DISCOVERY (when plan_turn doesn't surface what you need)
  describe_tools(names=["find_dead_code"], reveal=true) → enables hidden tool in ListTools
  discover_tools(query="dead code") → keyword search across all 150 tools
  ToolSearch(query="select:mcp__codesift__<name>") → Claude Code primitive (last resort)

HINT CODES (act on immediately when they appear in responses)
  H1(n)  → add group_by_file=true    H2(n,tool) → batch into one call
  H3(n)  → repo auto-resolves, skip  H4 → add file_pattern
  H5     → use cached tree result    H6(n) → add detail_level=compact
  H7     → use get_context_bundle    H8(n) → use assemble_context(level=L1)
  H9     → codebase_retrieval(type:semantic)  H10 → call get_session_snapshot
  H11    → use search_text instead   H12 → batch search_text into codebase_retrieval
  H13    → route query → use trace_route  H14 → secret pattern → use scan_secrets
  H15    → journal fetch: search_text(glob='.codesift/wiki/journal/**')

ALWAYS: repo auto-resolves, skip list_repos. file_pattern when scoped. get_symbols (batch)
  for 2+. Batch 3+ into codebase_retrieval. token_budget to cap. index_file after edits.
  trace_route for endpoints. codebase_retrieval(type:semantic) for conceptual queries.

NEVER: index_folder if already indexed. list_repos in single-repo. get_knowledge_map
  without detect_communities (129K+). Read file for return type → get_type_info.

KEY PARAMS
  search_symbols: detail_level=compact | token_budget=N | kind=function/class/component/hook
  search_text decision tree:
    - identifier-only query (e.g. "OrganizationService", "useAuth") → ranked=true
      auto-applied server-side when no grouping passed; symbol-grouped+centrality-ranked
    - error string / unknown phrase → omit grouping; server auto-groups above 30 matches
    - already passing top_k≥30 → group_by_file=true
    - ALWAYS pass file_pattern when scope is known
  assemble_context: L0 full | L1 sigs (3-5x denser) | L2 summaries | L3 dirs
  codebase_retrieval: always token_budget | get_knowledge_map: ALWAYS focus=

CASCADE (auto): >52.5K→compact, >87.5K→counts, >105K→truncate. Skipped if detail_level/token_budget set.

TOOL MAPPING (quick ref)
  text → search_text(file_pattern=) | symbols → search_symbols(include_source=true)
  file outline → get_file_outline | files → get_file_tree(compact=true)
  1 sym → get_symbol | 2+ → get_symbols (batch) | sym+refs → find_and_show(include_refs=true)
  usages → find_references | call chain → trace_call_chain | blast → impact_analysis(since=)
  concept → codebase_retrieval(type:semantic) | multi-search 3+ → codebase_retrieval(queries=[])
  dead code → find_dead_code | complexity → analyze_complexity | dup → find_clones(min_similarity=0.7)
  anti-pat → search_patterns | arch → detect_communities(focus=) | churn → analyze_hotspots(since_days=)
  diagram → trace_call_chain(output_format=mermaid) | endpoint → trace_route (FIRST)
  secrets → scan_secrets | taint → taint_trace(framework=) | past → search_conversations
  changed → changed_symbols(since=) | plan → plan_turn(query=) | session → get_session_snapshot
  React: kind=component/hook | trace_component_tree | analyze_hooks/renders/context_graph
  React anti-pat: search_patterns("hook-in-condition") | clean graph: filter_react_hooks=true
  Astro: astro_analyze_islands / astro_hydration_audit / astro_route_map / astro_config_analyze
  Next.js: framework_audit | nextjs_route_map | nextjs_metadata_audit
    sub-checks via framework_audit(checks=server-actions/api-contract/boundary/link-integrity/data-flow/middleware/components)
  Hono: analyze_hono_app (FIRST) | trace_middleware_chain (only_conditional=true for applied_when)
    trace_context_flow | analyze_inline_handler | extract_api_contract | extract_response_types
    trace_rpc_types | audit_hono_security (env-regression #3587) | detect_hono_modules
    find_dead_hono_routes | visualize_hono_routes
  Monorepo: list_workspaces (FIRST for Turbo/pnpm/Nx) | workspace_graph(format=mermaid)
    affected_workspaces(since="HEAD~1") | workspace_boundaries(rules=[{from_workspace, cannot_import_workspaces}])
  Workspace scoping: framework_audit / nextjs_route_map / analyze_hono_app / nest_audit / astro_audit accept workspace=<name|path>
`;
