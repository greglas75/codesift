/**
 * CODESIFT_INSTRUCTIONS — single source of truth for agent guidance.
 * Target: ~800 tokens (~3200 chars). Compact abbreviated format.
 */
export const CODESIFT_INSTRUCTIONS = `CodeSift — 160 MCP tools (47 core, 113 hidden via disable()).

DISCOVERY (for the 113 hidden/niche tools)
  discover_tools(query="dead code")    → keyword search → returns tool names
  describe_tools(names=["find_dead_code"])  → full schema with param types
  describe_tools(names=[...], reveal=true) → also adds tool to ListTools
  Then call the tool directly by name.

HINT CODES (act on immediately when they appear in responses)
  H1(n)  → add group_by_file=true    H2(n,tool) → batch into one call
  H3(n)  → repo auto-resolves, skip  H4 → add file_pattern
  H5     → use cached tree result    H6(n) → add detail_level=compact
  H7     → use get_context_bundle    H8(n) → use assemble_context(level=L1)
  H9     → use semantic_search       H10 → call get_session_snapshot
  H11    → use search_text instead

ALWAYS
  repo auto-resolves from CWD — skip list_repos. Pass file_pattern when scope known.
  Use get_symbols (batch) for 2+. Batch 3+ into codebase_retrieval(queries=[...]).
  Pass token_budget. Call index_file(path) after edits. Use trace_route for endpoints.
  Use semantic_search for conceptual queries.

NEVER
  index_folder if already indexed. list_repos in single-repo sessions.
  get_knowledge_map without detect_communities (129K+). Read file for return type → get_type_info.

KEY PARAMS
  search_symbols:  detail_level=compact (~15 tok/result) | token_budget=N | kind=function/class/type/component/hook
  search_text:     group_by_file=true (-80% output) | auto_group=true (>50 matches)
                   ranked=true → classify by function, dedup (max 2/fn), rank by centrality
  assemble_context: level=L0 (full source) | L1 (signatures, 3-5x denser) | L2 (summaries) | L3 (dirs)
  codebase_retrieval: always pass token_budget; batch 3+ queries
  get_knowledge_map: ALWAYS pass focus= to avoid 129K+ token dumps

RESPONSE CASCADE (auto, no params needed)
  >52.5K chars → compact format    [compact] annotation prepended
  >87.5K chars → counts only       [counts] annotation prepended
  >105K chars  → hard truncate
  Cascade skipped when detail_level or token_budget is explicitly set.

TOOL MAPPING (quick ref)
  text pattern      → search_text(file_pattern=)
  function/class    → search_symbols(include_source=true)
  file structure    → get_file_outline | find files → get_file_tree(compact=true)
  1 symbol          → get_symbol | 2+ symbols → get_symbols (batch)
  symbol + refs     → find_and_show(include_refs=true) | usages → find_references
  call chain        → trace_call_chain | blast radius → impact_analysis(since="HEAD~3")
  concept question  → semantic_search or codebase_retrieval(type:semantic)
  multi-search 3+   → codebase_retrieval(queries=[...])
  dead code         → find_dead_code | complexity → analyze_complexity
  duplication       → find_clones(min_similarity=0.7) | anti-patterns → search_patterns
  architecture/deps → detect_communities(focus=) | git churn → analyze_hotspots(since_days=90)
  mermaid diagram   → trace_call_chain(output_format="mermaid")
  API endpoint      → trace_route (FIRST) | secrets → scan_secrets
  past sessions     → search_conversations | changed code → changed_symbols(since=)
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
`;
