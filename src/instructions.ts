/**
 * CODESIFT_INSTRUCTIONS — single source of truth for agent guidance.
 * Target: ~800 tokens (~3200 chars). Compact abbreviated format.
 */
export const CODESIFT_INSTRUCTIONS = `CodeSift — 150 MCP tools. Usage-critical tools are always visible; niche tools are discoverable.

START HERE: For any non-trivial code task call mcp__codesift__plan_turn(query="<your task>") FIRST. plan_turn is always visible — no schema-loading required. It returns ranked tools+symbols+files and auto-reveals hidden tools in one call. Do NOT iterate ToolSearch to discover CodeSift tools — plan_turn replaces that path.

PREFER core CodeSift tools over Grep/Glob/Read for code search. Always-visible usage core: plan_turn, search_text, search_symbols, get_file_outline, get_file_tree, index_file, codebase_retrieval, search_all_conversations. Additional visible core covers get_symbol, get_symbols, find_references, find_and_show, get_context_bundle, analyze_complexity, detect_communities, audit_scan, search_conversations, index_status, plus framework-core (framework_audit, nextjs_route_map, nextjs_metadata_audit for Next.js; analyze_hono_app, trace_middleware_chain for Hono; astro_audit + 6 astro_* for Astro; nest_audit for NestJS).

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
  H19    → answer is from a DIFFERENT git working tree than your CWD — index it
  H11    → use search_text instead   H12 → batch search_text into codebase_retrieval
  H13    → route query → use trace_route  H14 → secret pattern → use scan_secrets
  H15    → journal fetch: search_text(glob='.codesift/wiki/journal/**')

ALWAYS: repo auto-resolves, skip list_repos. file_pattern when scoped. get_symbols (batch)
  for 2+. Batch 3+ into codebase_retrieval. token_budget to cap. index_file after edits.
  trace_route for endpoints. codebase_retrieval(type:semantic) for conceptual queries.

LANGUAGES: full symbols incl. KOTLIN (.kt/.kts/.gradle.kts) + TS/TSX/JS/Python/Go/Rust/PHP;
  generic for Java/Ruby/CSS. text_stub = NO symbols, but search_text/get_file_tree/scan_secrets
  still work: swift, dart, scala, clojure, elixir, lua, zig, nim, .gradle, sbt, html, config.
  Verify with index_status, never assume. analyze_complexity is regex in EVERY language.

STALE INDEX → index_folder(path=<root>) ONCE. commit.matches=false or files_changed=N is an
  instruction to reindex, NEVER a reason to skip CodeSift and fall back to grep/find.

NEVER: index_folder if already indexed — EXCEPT in a linked git worktree, where the
  repo reported as indexed is the PARENT checkout, not your tree: index_folder(path=<cwd>)
  once, and treat H19 or a file count that does not match your tree as the signal.
  list_repos in single-repo. get_knowledge_map without detect_communities (129K+).
  Read file for return type → get_type_info.

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

/**
 * A short instructions field, for measuring what the long one buys.
 *
 * The MCP `instructions` field is sent once per session but lives in the prompt for every turn of
 * it, so its cost is paid ~48 times in a typical task. CODESIFT_INSTRUCTIONS measured 1663 tokens
 * against the ~800 its own header sets as the target — it doubled without anyone re-measuring.
 *
 * What is kept here is what changes behaviour: use these tools instead of grep/find, the repo
 * resolves itself, and plan_turn is the way to reach everything unlisted. What is dropped is
 * reference material the model can fetch on demand — the full catalog, the framework auto-load
 * table, the monorepo section — none of which alters a decision until the moment it is needed,
 * and all of which is reachable through discover_tools/plan_turn at that moment.
 *
 * Opt in with CODESIFT_BRIEF_INSTRUCTIONS=1. Default is unchanged.
 */
export const CODESIFT_INSTRUCTIONS_BRIEF = `CodeSift — code intelligence over an indexed repo.

PREFER these over Grep/Glob/Bash(grep|find|rg) and over reading a whole file:
  search_text(query, file_pattern=) — text/regex search, returns file:line with context
  search_symbols(query, kind=) — find a function/class/type by name
  get_file_outline(path) — structure of one file without reading it
  get_file_tree(name_pattern=) — find files

The repo argument resolves from the working directory — do not call list_repos.

ONE call beats a sequence. To understand a symbol — where it is defined AND everywhere it is used —
call find_and_show(query="<name>", include_refs=true) once, instead of grep-for-definition, then
grep-for-uses, then read the file. Measured on this pattern: 67% fewer tool calls and 43% fewer
bytes returned, for the same information.

plan_turn(query="<your task>") ranks tools, symbols and files for a task and reveals whatever else
is needed; it is the entry point for anything not listed above.`;

/**
 * The DEFAULT `instructions` field — must fit the host's cap.
 *
 * Claude Code 2.1.280 truncates MCP server instructions at 2,048 characters
 * (`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`). CODESIFT_INSTRUCTIONS is ~6.5K, so every session got
 * its first third — the catalog preamble — and lost ALWAYS/NEVER, the stale-index rule and the hint
 * legend: exactly the lines that stop an agent from abandoning the server for grep. Shipping a field
 * the host cuts is worse than shipping a short one, because nobody chose what survives the cut.
 *
 * This one keeps the rules that change a decision and points at `initial_instructions` for the full
 * manual, which is a tool result and therefore not subject to the cap.
 * CODESIFT_FULL_INSTRUCTIONS=1 restores the long field for a host known not to truncate it.
 */
export const CODESIFT_INSTRUCTIONS_SERVER = `CodeSift — code intelligence over an indexed repo (symbols, call graph, BM25+semantic search, framework analyzers).

PREFER these over Grep/Glob/Bash(grep|find|rg) and over reading whole files:
  search_text(query, file_pattern=) · search_symbols(query, kind=, include_source=true)
  get_file_outline(path) · get_file_tree(name_pattern=) · find_references · trace_call_chain
  impact_analysis(since=) for blast radius · codebase_retrieval(queries=[…], token_budget=) to batch 3+

ONE call beats a sequence: find_and_show(query="<name>", include_refs=true) returns definition + usages.
plan_turn(query="<task>") ranks tools/symbols/files and reveals hidden tools — the entry point for anything not listed.
initial_instructions() returns the full manual (tool mapping, hint codes H1–H19, framework tools).

ALWAYS: repo resolves from CWD — never call list_repos. Pass file_pattern when scope is known. index_file after edits.
STALE INDEX (commit.matches=false, files_changed=N) → index_folder(path=<root>) once. Never a reason to fall back to grep.
WORKTREE: in a linked git worktree the "indexed" repo is the PARENT checkout — index_folder(path=<cwd>) once. H19 in a response means the same.
Hint codes (H1…) in responses are instructions: act on them.`;

/** Hard cap the default field must stay under (Claude Code's default MCP instructions cap). */
export const HOST_INSTRUCTIONS_CHAR_CAP = 2048;

/**
 * Instructions for CODESIFT_TOOL_SURFACE=single. The default field names a dozen tools that this
 * surface does not register, so an agent on it would be told to call tools it cannot reach.
 */
export const CODESIFT_INSTRUCTIONS_SINGLE = `CodeSift — code intelligence over an indexed repo.

explore(query) is the one call for "where is X and how does it connect": it returns the best-matching
symbols with full source, their direct callers and callees, and the other matches as locations.
Prefer it over Grep/Glob/Read for finding and understanding code. A repeat of unchanged source comes
back as a one-line pointer; repeat the call with full_source=true only if you no longer have it.

search_text(query, file_pattern=) is for literal strings, error messages and config values.
index_file(path) after editing a file keeps answers current. The repo resolves from the working
directory. A stale index is a reason to reindex, never to fall back to grep.`;

export function resolveInstructions(): string {
  if (process.env["CODESIFT_BRIEF_INSTRUCTIONS"] === "1") return CODESIFT_INSTRUCTIONS_BRIEF;
  if (process.env["CODESIFT_TOOL_SURFACE"] === "single" && !process.env["CODESIFT_VISIBLE_TOOLS"]) {
    return CODESIFT_INSTRUCTIONS_SINGLE;
  }
  if (process.env["CODESIFT_FULL_INSTRUCTIONS"] === "1") return CODESIFT_INSTRUCTIONS;
  return CODESIFT_INSTRUCTIONS_SERVER;
}
