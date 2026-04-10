/**
 * CODESIFT_INSTRUCTIONS — single source of truth for agent guidance.
 * Target: ~800 tokens (~3200 chars). Compact abbreviated format.
 */
export const CODESIFT_INSTRUCTIONS = `CodeSift — 66 MCP tools (35 core, 31 hidden via disable()).

DISCOVERY (for the 31 hidden/niche tools)
  discover_tools(query="dead code")    → keyword search → returns tool names
  describe_tools(names=["find_dead_code"])  → full schema with param types
  describe_tools(names=[...], reveal=true) → also adds tool to ListTools
  Then call the tool directly by name.

HINT CODES (appear in tool responses — take the suggested action immediately)
  H1(n)       n matches returned → add group_by_file=true
  H2(n,tool)  n consecutive identical calls → batch into one tool call
  H3(n)       list_repos called n times → repo auto-resolves from CWD, no need to call
  H4          include_source without file_pattern → add file_pattern
  H5(path)    duplicate get_file_tree → use cached result
  H6(n)       n results without detail_level → add detail_level=compact
  H7          get_symbol after search_symbols → use get_context_bundle instead
  H8(n)       n× get_symbol calls → use assemble_context(level=L1) instead
  H9          question-word text query → use semantic_search or codebase_retrieval(type:semantic)
  H10         50+ tool calls this session → call get_session_snapshot to preserve context

ALWAYS
  repo param auto-resolves from CWD — skip list_repos for single-repo sessions.
  Use semantic_search or codebase_retrieval(type:semantic) for conceptual/question queries.
  Pass file_pattern when scope is known (cuts noise and tokens).
  Use get_symbols (batch) for 2+ symbols — never sequential get_symbol calls.
  Batch 3+ searches into codebase_retrieval(queries=[...]).
  Pass token_budget to cap large responses.
  Call index_file(path) after editing a file (9ms vs 3-8s for index_folder).
  Use trace_route first for any API endpoint trace.

NEVER
  Call index_folder if repo is already indexed (file watcher auto-updates).
  Call list_repos in single-repo sessions — repo auto-resolves from CWD.
  Use get_knowledge_map without detect_communities first (129K+ tokens).
  Use sequential search_text + trace_call_chain for endpoint — use trace_route.
  Read entire file for a return type — use get_type_info.

KEY PARAMS
  search_symbols:  detail_level=compact (~15 tok/result) | token_budget=N | kind=function/class/type
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
`;
