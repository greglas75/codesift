<!-- codesift-rules-start -->
<!-- codesift-rules v0.1.0 hash:PLACEHOLDER -->

# CodeSift MCP — Agent Rules (Codex / AGENTS.md)

## Setup

The `repo` parameter auto-resolves from the current working directory — no need to call `list_repos`.
If the repo is not yet indexed, run `index_folder(path=<root>)` once.
For multi-repo sessions, call `list_repos()` to discover available repos.

## Tool Discovery

**146 MCP tools total** (51 core visible + 95 discoverable).

51 core tools appear in ListTools. The remaining 95 niche tools are discovered on demand:

- `plan_turn(query="...")` — natural-language router with auto-reveal (preferred start-of-task entry point)
- `discover_tools(query="dead code")` — keyword search across all 146 tools
- `describe_tools(names=["find_dead_code"])` — get full parameter schema
- `describe_tools(names=["find_dead_code"], reveal=true)` — also reveal in ListTools

Core tools (51) always visible — includes search, symbols, context, analysis, architecture, conversations, meta, and `plan_turn`. Use `discover_tools` for niche tools like `classify_roles`, `find_unused_imports`, `rename_symbol`, `ast_query`, etc.

## Tool Mapping

Use this table to pick the right tool for each task:

| Task | Tool |
|------|------|
| text pattern search | `search_text(file_pattern=)` |
| find function/class/type | `search_symbols(include_source=true)` |
| file structure/outline | `get_file_outline` |
| find files | `get_file_tree(compact=true)` |
| read 1 symbol | `get_symbol` |
| read 2+ symbols | `get_symbols` (batch) |
| find usages | `find_references` |
| symbol + refs in 1 call | `find_and_show(include_refs=true)` |
| call chain | `trace_call_chain` |
| callers/callees of function | `get_call_hierarchy(direction="incoming")` |
| blast radius | `impact_analysis(since="HEAD~3")` |
| concept question | `semantic_search` or `codebase_retrieval(queries=[{type:"semantic",...}])` |
| multi-search 3+ | `codebase_retrieval(queries=[...])` |
| symbol in context | `get_context_bundle` |
| dead code | `find_dead_code` |
| complexity | `analyze_complexity` |
| copy-paste | `find_clones` |
| anti-patterns | `search_patterns` |
| git churn | `analyze_hotspots` |
| cross-repo | `cross_repo_search` |
| circular deps | `find_circular_deps` or `get_knowledge_map(focus=)` |
| mermaid diagram | `trace_call_chain(output_format="mermaid")` |
| affected tests | `impact_analysis` → `.affected_tests` |
| explore new repo | `suggest_queries` |
| re-index 1 file | `index_file(path=)` |
| route trace | `trace_route` |
| code modules | `detect_communities(focus=)` |
| go to definition | `go_to_definition` |
| return type | `get_type_info` |
| cross-file rename | `rename_symbol` |
| scan secrets | `scan_secrets` |
| search past sessions | `search_conversations` |
| symbol ↔ conversation | `find_conversations_for_symbol` |
| index conversations | `index_conversations` |
| structural diff | `diff_outline(since=)` |
| what changed | `changed_symbols(since=)` |
| start of task / unclear where to begin | `plan_turn(query=...)` |
| React component tree | `trace_component_tree` |
| React hook analysis | `analyze_hooks` |
| React re-render analysis | `analyze_renders` |
| React context graph | `analyze_context_graph` |
| find components | `search_symbols(kind="component")` |
| find hooks | `search_symbols(kind="hook")` |
| Astro islands/hydration | `astro_analyze_islands` |
| Astro hydration audit | `astro_hydration_audit` |
| Astro route map | `astro_route_map` |
| Astro config analysis | `astro_config_analyze` |
| Next.js full audit | `framework_audit` |
| route map + rendering | `nextjs_route_map` |
| SEO / metadata gaps | `nextjs_metadata_audit` |
| server actions security | `framework_audit(checks=["server-actions"])` |
| API contract extraction | `framework_audit(checks=["api-contract"])` |
| client boundary / bundle | `framework_audit(checks=["boundary"])` |
| broken internal links | `framework_audit(checks=["link-integrity"])` |
| data fetch waterfalls | `framework_audit(checks=["data-flow"])` |
| middleware coverage gaps | `framework_audit(checks=["middleware"])` |
| server vs client classify | `framework_audit(checks=["components"])` |
| Python project health audit | `python_audit` (compound: 8 checks, health score) |
| Django/Flask/FastAPI routes | `trace_route(path="/api/users")` |
| Python anti-patterns | `search_patterns("mutable-default"\|"bare-except"\|"eval-exec"\|"shell-true"\|"pickle-load"\|"n-plus-one-django")` |
| async/await pitfalls | `analyze_async_correctness` (blocking requests/sleep, sync ORM in async) |
| FastAPI Depends() graph | `trace_fastapi_depends` (Security, scopes, yield deps) |
| Pydantic model schemas | `get_pydantic_models(output_format="mermaid")` |
| Django/SQLAlchemy ORM graph | `get_model_graph` |
| Django settings security audit | `analyze_django_settings` (15 checks) |
| pytest fixture graph | `get_test_fixtures` (conftest hierarchy, scope, autouse) |
| Celery task + canvas tracing | `python_audit(checks=["celery"])` |
| Django signals / Celery / middleware | `find_framework_wiring` |
| Python cross-module callers | `find_python_callers(target_name=)` |
| Python circular imports | `python_audit(checks=["circular-imports"])` |
| run Ruff on Python | `run_ruff(categories=["B","PERF","SIM","S"])` |
| run mypy / pyright | `run_mypy` or `run_pyright` |
| parse pyproject.toml | `parse_pyproject` |
| Python dep freshness + CVEs | `analyze_python_deps(check_pypi=true, check_vulns=true)` |
| Hono full overview | `analyze_hono_app` |
| Hono middleware chain (route/scope/app-wide modes) | `trace_middleware_chain` |
| Hono conditional middleware (applied_when) | `trace_middleware_chain(only_conditional=true)` |
| Hono inline handler analysis | `analyze_inline_handler` |
| Hono context variables | `trace_context_flow` |
| Hono API contract / OpenAPI | `extract_api_contract` |
| Hono response types (Issue #4270) | `extract_response_types` |
| Hono RPC types / Issue #3869 | `trace_rpc_types` |
| Hono security + env-regression audit / #3587 | `audit_hono_security` |
| Hono architecture modules / #4121 | `detect_hono_modules` |
| Hono dead routes | `find_dead_hono_routes` |
| Hono route visualization | `visualize_hono_routes` |

## When to Use (Situational Triggers)

| Situation | Tool |
|-----------|------|
| refactor/clean up | `analyze_complexity(top_n=10)` |
| dead code/unused | `find_dead_code` |
| unused imports | `find_unused_imports` |
| DRY/duplication | `find_clones(min_similarity=0.7)` |
| architecture/deps | `detect_communities(focus="src")` |
| module boundaries | `check_boundaries` |
| symbol roles (hub/leaf/bridge) | `classify_roles` |
| structural code patterns | `ast_query` |
| diagram/visualize | `trace_call_chain(output_format="mermaid")` |
| hotspots/tech debt | `analyze_hotspots(since_days=90)` |
| unfamiliar symbol | `get_context_bundle` |
| new repo | `suggest_queries` |
| trace endpoint | `trace_route` |
| dense context (5+ symbols) | `assemble_context(level="L1")` |
| overview only | `assemble_context(level="L3")` |
| review git diff | `review_diff` |
| code review / PR | `changed_symbols(since="HEAD~N")` + `diff_outline` |
| quick symbol + refs | `find_and_show(include_refs=true)` |
| error seen before | `search_conversations` |
| before refactoring complex fn | `find_conversations_for_symbol` |
| "we discussed this" | `search_conversations` |
| secrets/leaked keys | `scan_secrets` |
| security audit | `scan_secrets(min_confidence="high")` |
| code audit | `search_patterns("empty-catch")` |
| past decisions | `find_conversations_for_symbol` |
| starting a task, want tool recommendations | `plan_turn(query=...)` |
| React codebase | `trace_component_tree("App")` + `analyze_hooks` |
| React anti-patterns | `search_patterns("hook-in-condition")` |
| React call graph (clean) | `trace_call_chain(filter_react_hooks=true)` |
| new Next.js project (first look) | `framework_audit` |
| SEO audit / metadata review | `nextjs_metadata_audit` |
| security review (Next.js) | `framework_audit(checks=["server-actions"])` |
| rendering strategy check | `nextjs_route_map` |
| bundle size concerns | `framework_audit(checks=["boundary"])` |
| new Hono project (first look) | `analyze_hono_app` |
| Hono middleware order bug | `trace_middleware_chain` |
| Hono auth false positive (blog pattern) | `trace_middleware_chain(only_conditional=true)` |
| Hono handler introspection | `analyze_inline_handler` |
| Hono RPC compile time slow | `trace_rpc_types` (flags Issue #3869 slow pattern) |
| Hono enterprise architecture | `detect_hono_modules` (Issue #4121) |

## Key Parameters

### search_symbols
- `detail_level="compact"` — locations only (~15 tok/result vs ~150 default)
- `token_budget=N` — cap output instead of guessing `top_k`
- `file_pattern=` — always pass when scope is known (e.g. `"*.ts"`, `"src/tools/"`)
- `kind=` — filter by type: `function`, `class`, `type`, `interface`, `component`, `hook`
- `include_source=true` — include source code in results

### search_text
- `group_by_file=true` — ~80% output reduction on many matches
- `auto_group=true` — auto-switch to grouped above 50 matches
- `ranked=true` — classifies hits by containing function, deduplicates (max 2/function), ranks by centrality. Returns `containing_symbol` field. Takes precedence over `auto_group`.
- `file_pattern=` — always pass when scope is known

### assemble_context levels
- `L0` — full source (use when editing)
- `L1` — signatures only (3× more symbols fit, use when reading)
- `L2` — file summaries
- `L3` — directory overview (91% less tokens, use for orientation)

### codebase_retrieval
- Always pass `token_budget` to cap output
- Batch 3+ searches: `queries=[{type:"semantic",...},{type:"text",...}]`

### get_knowledge_map
- **ALWAYS pass `focus=`** — without it returns 129K+ tokens

## Hint Codes

The server appends hint codes to responses to guide tool usage. Act on them immediately.

| Code | Meaning | Action |
|------|---------|--------|
| `H1(n)` | n matches returned | Add `group_by_file=true` |
| `H2(n,tool)` | n consecutive identical calls | Batch into one `tool` call |
| `H3(n)` | `list_repos` called n times | Repo auto-resolves from CWD, no need to call |
| `H4` | `include_source` without `file_pattern` | Add `file_pattern` |
| `H5(path)` | Duplicate `get_file_tree` | Use cached result |
| `H6(n)` | n results without `detail_level` | Add `detail_level='compact'` |
| `H7` | `get_symbol` after `search_symbols` | Use `get_context_bundle` |
| `H8(n)` | n× `get_symbol` calls | Use `assemble_context(level='L1')` |
| `H9` | Question-word text query | Use semantic search |
| `H10` | 50+ tool calls this session | Call `get_session_snapshot` to preserve context before compaction |

## ALWAYS

- Use `semantic_search` or `codebase_retrieval(type:"semantic")` for conceptual questions
- Use `trace_route` FIRST for any API endpoint — NEVER multiple `search_text` + `trace_call_chain`
- Use `detect_communities` BEFORE `get_knowledge_map` — NEVER `knowledge_map` without communities first
- Use `index_file(path)` after editing — NEVER `index_folder` (9ms vs 3-8s)
- Pass `include_source=true` on `search_symbols`
- Use `get_symbols` (batch) for 2+ symbols — NEVER sequential `get_symbol`
- Batch 3+ searches into `codebase_retrieval`
- Use `search_conversations` when encountering error/bug that may have been solved before
- Use `Read` tool when file path is already known — CodeSift excels at discovery

## NEVER

- Call `index_folder` if repo is already indexed — file watcher auto-updates
- Call `list_repos` in single-repo sessions — repo auto-resolves from CWD
- Use manual Edit on multiple files for rename — use `rename_symbol`
- Read entire file just to get a return type — use `get_type_info`
- Index worktrees — use the main repo index
- Call `get_knowledge_map` without `focus=` parameter

## Response Cascade

Large responses auto-shorten to stay within token limits:

| Threshold | Format | Annotation |
|-----------|--------|------------|
| > 52,500 chars | compact format | `[compact]` prepended |
| > 87,500 chars | counts only | `[counts]` prepended |
| > 105,000 chars | hard truncate | `[truncated]` prepended |

Cascade is **skipped** when `detail_level` or `token_budget` is explicitly set.

## Hooks

Setup auto-indexing and read-redirect hooks for Claude Code:

```
codesift setup claude --hooks
```

Installs two hooks in `.claude/settings.local.json`:

- **PreToolUse** (`precheck-read`) — redirects `Read` on large code files to CodeSift tools
- **PostToolUse** (`postindex-file`) — auto-runs `index_file` after `Edit` or `Write`

This ensures the index stays current without manual `index_file` calls after every edit.
<!-- codesift-rules-end -->
