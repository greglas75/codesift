## Tech Stack
TypeScript | Vitest | tree-sitter | BM25F + semantic search | LSP bridge

## Response Hint Codes

| Code | Meaning | Action |
|------|---------|--------|
| `H1(n)` | n matches returned | Add `group_by_file=true` |
| `H2(n,tool)` | n consecutive identical calls | Batch into one `tool` call |
| `H3(n)` | `list_repos` called n times | Reuse cached value |
| `H4` | `include_source` without `file_pattern` | Add `file_pattern` |
| `H5(path)` | Duplicate `get_file_tree` | Use cached result |
| `H6(n)` | n results without `detail_level` | Add `detail_level='compact'` |
| `H7` | `get_symbol` after `search_symbols` | Use `get_context_bundle` |
| `H8(n)` | n× `get_symbol` calls | Use `assemble_context(level='L1')` |
| `H9` | Question-word text query | Use semantic search |
| `H10` | 50+ tool calls this session | Call `get_session_snapshot` to preserve context |

## Tool Discovery (NEW — agents read this)

Non-core tools are **hidden** from ListTools (via SDK `disable()`). Only 51 core tools are visible (out of 146 total).
To find hidden tools: `discover_tools(query="dead code")` → keyword search.
To get full schema: `describe_tools(names=["find_dead_code"])` → returns params with types.
To reveal in ListTools: `describe_tools(names=["find_dead_code"], reveal=true)`.

### Framework tool auto-loading (NEW)
Framework-specific tools are auto-enabled at startup when a signal file is detected at CWD:
- `composer.json` → enables 6 PHP/Yii2 tools (resolve_php_namespace,
  trace_php_event, find_php_views, resolve_php_service, php_security_scan, php_project_audit)
- `build.gradle.kts` / `settings.gradle.kts` / `build.gradle` → enables 5 Kotlin tools
  (find_extension_functions, analyze_sealed_hierarchy, trace_hilt_graph,
  trace_suspend_chain, analyze_kmp_declarations)
- `package.json` with `react`/`next`/`@remix-run/react` dep + `.tsx` files present →
  enables React tools (trace_component_tree, analyze_hooks, analyze_renders)
- `package.json` with `next` dep → enables hidden Next.js tools. The 3 core Next.js
  tools (nextjs_route_map, nextjs_metadata_audit, framework_audit) are always visible.
  The 7 former sub-tools (analyze_nextjs_components, nextjs_audit_server_actions,
  nextjs_api_contract, nextjs_boundary_analyzer, nextjs_link_integrity, nextjs_data_flow,
  nextjs_middleware_coverage) are now accessed via `framework_audit(checks=...)`.
- `package.json` with `hono` / `@hono/zod-openapi` / `@hono/node-server` / `hono-openapi` /
  `chanfana` dep → enables 9 hidden Hono tools (trace_context_flow, extract_api_contract,
  trace_rpc_types, audit_hono_security, visualize_hono_routes, analyze_inline_handler,
  extract_response_types, detect_hono_modules, find_dead_hono_routes). The 2 core Hono
  tools (trace_middleware_chain, analyze_hono_app) are always visible — total 11 Hono
  tools. Phase 2 polish consolidation merged trace_conditional_middleware into
  trace_middleware_chain (only_conditional=true param) and detect_middleware_env_regression
  into audit_hono_security (env-regression rule).

Agents working in framework-specific projects see relevant tools in ListTools from the
first call — no need to run `discover_tools`/`describe_tools` first. Filename-based
config lives in `FRAMEWORK_TOOL_GROUPS`; content-based detection (React, Hono) lives
in `detectAutoLoadTools` at `src/register-tools.ts`.

### search_text ranked mode (NEW)
`search_text(repo, query, ranked=true)` classifies each hit by its containing function, deduplicates (max 2 per function), and ranks by symbol centrality. Returns `TextMatch` with `containing_symbol` field. Saves 1-3 follow-up get_symbol calls. Takes precedence over `auto_group`.

### Progressive response shortening (NEW)
Large responses auto-cascade: >52.5K chars → compact format, >87.5K → counts only, >105K → hard truncate. Skipped when `detail_level` or `token_budget` is explicitly set. Annotation `[compact]` or `[counts]` prepended.

### CLI hooks (NEW)
`codesift setup claude --hooks` installs PreToolUse (redirect Read on large code files to CodeSift), PostToolUse (auto index-file after Edit/Write), and PreCompact (inject session snapshot before context compaction). Hooks go to `.claude/settings.local.json`.

## After adding/changing features — update checklist

When you add a new tool, change tool count, update benchmarks, or modify behavior:

1. **This repo (codesift-mcp):**
   - `src/instructions.ts` — update if ALWAYS/NEVER rules or hint codes changed
   - `rules/codesift.md` + `rules/codesift.mdc` + `rules/codex.md` + `rules/gemini.md` — update tool mapping
   - `CLAUDE.md` — update architecture section, tool count
   - `README.md` — update tool count, benchmarks, feature table
   - Bump version: `npm version patch/minor` → `npm publish --ignore-scripts`

2. **Website (../codesift-website):**
   - `public/llms.txt` — update features, install instructions, tool count
   - `public/llms-full.txt` — update header, add new articles
   - Components with tool count: Hero, FeatureGrid, Footer, Problem, Nav, Pricing, BaseLayout
   - Pages: index, tools/index, how-it-works, benchmarks, articles/index
   - Build + deploy: `npm run build && wrangler pages deploy dist --project-name codesift-website --commit-dirty=true`

3. **Quick grep to find all places with a number (e.g., tool count):**
   ```bash
   grep -rn "146 tools\|146 MCP" src/ ../codesift-website/src/
   ```

## Architecture

**146 MCP tools** (51 core + 95 discoverable) | tree-sitter AST + BM25F + semantic search + LSP bridge + conversation search + secret detection + session-aware context + **hybrid tool routing** (`plan_turn` — 5-signal WRR ranker: BM25 + identity + semantic + usage-freq + framework boost; first MCP tool to combine data-first routing with tool recommendations) + **Python deep intelligence** (11 Python tools: `get_model_graph` Django/SQLAlchemy ORM, `get_test_fixtures` pytest fixture graph, `find_framework_wiring` Django signals/Celery tasks/middleware, `run_ruff` with symbol correlation, `parse_pyproject`, `find_python_callers` cross-module tracing, `analyze_django_settings` 15 security checks, `run_mypy`/`run_pyright` type checking, `analyze_python_deps` PyPI+OSV; `trace_celery_chain` and `find_python_circular_imports` absorbed into `python_audit`; plus 17 anti-patterns in search_patterns + Flask/FastAPI/Django in trace_route) + **NestJS intelligence** (`nest_audit` composite — 14 sub-tools consolidated into single meta-tool with `checks=` parameter) + **Astro deep intelligence** (7 core tools: island hydration audit with AH01-AH12 scoring, route map, config analysis, actions audit, migration check, content collections, template parsing) + **Next.js Tier-1 intelligence** (route map, metadata audit, `framework_audit` meta-tool — 7 sub-tools consolidated into `framework_audit(checks=...)`) + **Hono Phase 2 intelligence** (11 tools after polish consolidation: `analyze_hono_app` meta-tool, `trace_middleware_chain` with `only_conditional` filter, `trace_context_flow`, `extract_api_contract`, `trace_rpc_types`, `audit_hono_security` with env-regression rule, `visualize_hono_routes`, `analyze_inline_handler`, `extract_response_types`, `detect_hono_modules`, `find_dead_hono_routes`) + **PHP/Yii2 intelligence** (6 tools: PSR-4 edges, PHPDoc synthesis, security scan, project audit with N+1/god-model/ActiveRecord checks via `php_project_audit(checks=...)`) + **SQL intelligence** (schema analysis, schema complexity, migration linting, DML safety scanner, orphan tables, query tracing, drift detection) + **Kotlin Wave 2** (Kotest DSL, Gradle KTS, Hilt DI graph, coroutine chain, KMP expect/actual) + **Kotlin Wave 3** (Compose component tree `trace_compose_tree`, recomposition analysis `analyze_compose_recomposition`, Room schema graph `trace_room_schema`, kotlinx.serialization contract `extract_kotlin_serialization_contract`, Flow operator chain `trace_flow_chain`, 3 Compose anti-patterns) + **Dependency audit** (`dependency_audit` composite: vulns + licenses + freshness + lockfile) + **Prisma schema analysis** (`analyze_prisma_schema` via @mrleebo/prisma-ast — FK index coverage, soft-delete detection, status-as-String warnings)

## Tool breakdown by category (146 total)

| Category | Count | Examples |
|----------|------:|----------|
| analysis | 57 | find_dead_code, find_perf_hotspots, audit_scan, dependency_audit, analyze_prisma_schema, migration_lint, Python/SQL/React/Hono/Astro/Kotlin tools |
| nestjs | 1 | nest_audit (14 sub-tools consolidated into single meta-tool) |
| meta | 11 | index_status, analyze_project, get_extractor_versions, discover_tools, describe_tools, usage_stats, session tools |
| security | 8 | scan_secrets, taint_trace, php_security_scan, nextjs_audit_server_actions |
| architecture | 7 | detect_communities, check_boundaries, fan_in_fan_out, co_change_analysis, architecture_summary, classify_roles, ast_query |
| graph | 6 | trace_call_chain, impact_analysis, trace_route, find_references, find_circular_deps, get_call_hierarchy |
| search | 6 | search_text, search_symbols, codebase_retrieval, semantic_search, suggest_queries, find_and_show |
| conversations | 6 | index_conversations, search_conversations, search_all_conversations, find_conversations_for_symbol |
| indexing | 5 | index_folder, index_file, index_repo, list_repos, invalidate_cache |
| outline | 4 | get_file_outline, get_file_tree, get_repo_outline, get_symbols_overview |
| symbols | 4 | get_symbol, get_symbols, get_context_bundle, get_type_info |
| lsp | 4 | go_to_definition, get_type_info, rename_symbol, get_call_hierarchy |
| diff | 3 | diff_outline, changed_symbols, review_diff |
| reporting | 3 | generate_report, generate_claude_md, usage_stats |
| context | 2 | assemble_context, get_knowledge_map |
| cross-repo | 2 | cross_repo_search, cross_repo_refs |
| patterns | 2 | search_patterns, list_patterns |
| session | 2 | get_session_snapshot, get_session_context |
| navigation | 1 | go_to_definition |
| **discovery** | **1** | **`plan_turn` — hybrid data+tool routing concierge (NEW)** |

## Source layout

**src/tools/** (103 files) — MCP tool handlers. Key composites: `plan-turn-tools.ts` (query parser + planTurn handler + formatPlanTurnResult), `audit-tools.ts` (5-gate composite audit_scan), `review-diff-tools.ts` (10-check composite), `architecture-tools.ts` (communities + coupling + circular deps + LOC + entry points), `coupling-tools.ts` (fan_in_fan_out + co_change_analysis + shared computeCoChangePairs), `perf-tools.ts` (6 perf anti-pattern scanners with balanced-brace loop body extraction), `query-tools.ts` (Prisma→SQL explain), `status-tools.ts` (index status check), `dependency-audit-tools.ts` (4-check composite: vulns + licenses + freshness + lockfile), `migration-lint-tools.ts` (squawk wrapper), `prisma-schema-tools.ts` (AST-based schema analysis), `agent-config-tools.ts` (CLAUDE.md stale-ref auditor), `test-impact-tools.ts` (changed files → tests with confidence), `nextjs-*.ts` (13 Next.js files), `hono-*.ts` (13 Hono files), `php-tools.ts` (6 PHP/Yii2 tools), `python-*.ts` (13 Python deep-intelligence files), `astro-*.ts` (7 Astro files), `react-tools.ts`, `kotlin-tools.ts`, `compose-tools.ts`, `room-tools.ts`, `sql-tools.ts`.
**src/lsp/** (4 files) — LSP bridge (6 languages)
**src/parser/extractors/** (17 files) — Language extractors: `_shared.ts`, `typescript.ts`, `javascript.ts`, `python.ts` (full — async def, @dataclass/@property/@classmethod/@staticmethod/@abstractmethod, dunder methods tagged via meta, module constants, __all__ exports, superclasses, dataclass fields, nested class walk, iterative walk with depth cap 200), `go.ts`, `rust.ts`, `prisma.ts`, `markdown.ts`, `astro.ts`, `conversation.ts`, `kotlin.ts` (with Kotest DSL + KMP expect/actual + @Annotation surfacing), `gradle-kts.ts` (structured plugins/dependencies/config extraction for `*.gradle.kts`), `php.ts`, `hono.ts`, `hono-model.ts`, `hono-inline-analyzer.ts`, `sql.ts`. Text-stub languages indexed without symbol extraction: kotlin, swift, dart, scala, groovy, elixir, lua, zig, nim, gradle, sbt.
**src/storage/** (10 files) — Index persistence, embeddings, usage tracker, watcher, session-state (compaction survival), **per-language `extractor_version` cache invalidation** (mismatch vs current EXTRACTOR_VERSIONS forces reindex so schema bumps don't leave stale symbols behind)
**src/retrieval/** (5 files) — codebase_retrieval batch engine, semantic/hybrid search
**src/search/** (6 files) — BM25F index with centrality bonus, semantic embeddings, chunker, cross-encoder reranker; **`tool-ranker.ts`** — 5-signal WRR ranker (lexical W=1.0, identity W=2.0, semantic W=0.8, structural W=0.4, framework W=0.6) for `plan_turn`, with SHA-1 fingerprint cache + graceful BM25-only fallback when no embedding API key
**src/utils/** (9 files) — Import graph (TS/JS/PHP/Kotlin/**Python**), glob, walk, git validation; python-imports.ts (tree-sitter AST extraction) + python-import-resolver.ts (package-aware resolution with `src/` layout detection) + language-detect.ts (startup file-tree scan for language-gated tool registration)
**src/cli/** (5 files) — CLI commands + hooks.ts (PreToolUse/PostToolUse/PreCompact)
**src/formatters-shortening.ts** — Compact/counts formatters for progressive cascade
**src/instructions.ts** — CODESIFT_INSTRUCTIONS (~1.5K tok) sent via MCP instructions field
**rules/** — Platform-specific rules (codesift.md, codesift.mdc, codex.md, gemini.md)
**tests/** (193 files, 2971 tests, all passing) — Vitest with `exactOptionalPropertyTypes: true`
