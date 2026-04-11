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

Non-core tools are **hidden** from ListTools (via SDK `disable()`). Only 47 core tools are visible (out of 160 total).
To find hidden tools: `discover_tools(query="dead code")` → keyword search.
To get full schema: `describe_tools(names=["find_dead_code"])` → returns params with types.
To reveal in ListTools: `describe_tools(names=["find_dead_code"], reveal=true)`.

### Framework tool auto-loading (NEW)
Framework-specific tools are auto-enabled at startup when a signal file is detected at CWD:
- `composer.json` → enables 9 PHP/Yii2 tools (resolve_php_namespace, analyze_activerecord,
  trace_php_event, find_php_views, resolve_php_service, php_security_scan, php_project_audit,
  find_php_n_plus_one, find_php_god_model)
- `build.gradle.kts` / `settings.gradle.kts` / `build.gradle` → enables 5 Kotlin tools
  (find_extension_functions, analyze_sealed_hierarchy, trace_hilt_graph,
  trace_suspend_chain, analyze_kmp_declarations)
- `package.json` with `react`/`next`/`@remix-run/react` dep + `.tsx` files present →
  enables React tools (trace_component_tree, analyze_hooks, analyze_renders)
- `package.json` with `next` dep → enables 7 hidden Next.js tools
  (analyze_nextjs_components, nextjs_audit_server_actions, nextjs_api_contract,
  nextjs_boundary_analyzer, nextjs_link_integrity, nextjs_data_flow,
  nextjs_middleware_coverage). The 3 core Next.js tools (nextjs_route_map,
  nextjs_metadata_audit, framework_audit) are always visible.
- `package.json` with `hono` / `@hono/zod-openapi` / `@hono/node-server` / `hono-openapi` /
  `chanfana` dep → enables 11 hidden Hono tools (trace_context_flow, extract_api_contract,
  trace_rpc_types, audit_hono_security, visualize_hono_routes, trace_conditional_middleware,
  analyze_inline_handler, extract_response_types, detect_middleware_env_regression,
  detect_hono_modules, find_dead_hono_routes). The 2 core Hono tools
  (trace_middleware_chain, analyze_hono_app) are always visible.

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
   grep -rn "160 tools\|160 MCP" src/ ../codesift-website/src/
   ```

## Architecture

**160 MCP tools** (47 core + 113 discoverable) | tree-sitter AST + BM25F + semantic search + LSP bridge + conversation search + secret detection + session-aware context + **Python deep intelligence** (13 Python tools: `get_model_graph` Django/SQLAlchemy ORM, `get_test_fixtures` pytest fixture graph, `find_framework_wiring` Django signals/Celery tasks/middleware, `run_ruff` with symbol correlation, `parse_pyproject`, `find_python_callers` cross-module tracing, `analyze_django_settings` 15 security checks, `trace_celery_chain` canvas/orphan detection, `run_mypy`/`run_pyright` type checking, `analyze_python_deps` PyPI+OSV, `find_python_circular_imports` TYPE_CHECKING-aware; plus 17 anti-patterns in search_patterns + Flask/FastAPI/Django in trace_route) + **Astro deep intelligence** (island hydration audit with AH01-AH12 scoring, route map, config analysis, template parsing) + **Next.js Tier-1 intelligence** (server/client classifier, route map, metadata audit, server actions security, API contract, boundary analyzer, link integrity, data flow, middleware coverage, `framework_audit` meta-tool) + Hono framework intelligence + **PHP/Yii2 intelligence** (PSR-4 edges, PHPDoc synthesis, N+1 query detector, god-model detector) + **Kotlin Wave 2** (Kotest DSL, Gradle KTS, Hilt DI graph, coroutine chain, KMP expect/actual) + **Kotlin Wave 3** (Compose component tree `trace_compose_tree`, recomposition analysis `analyze_compose_recomposition`, Room schema graph `trace_room_schema`, kotlinx.serialization contract `extract_kotlin_serialization_contract`, Flow operator chain `trace_flow_chain`, 3 Compose anti-patterns)

**src/tools/** (38 files) — MCP tool handlers + search-ranker.ts (4-phase ranked pipeline). Includes: astro-islands.ts (island analysis + hydration audit), astro-routes.ts (route map + findAstroHandlers), astro-config.ts (config analysis + conventions), nextjs-tools.ts (10 Next.js tools: analyze_nextjs_components, nextjs_route_map, nextjs_metadata_audit, nextjs_audit_server_actions, nextjs_api_contract, nextjs_boundary_analyzer, nextjs_link_integrity, nextjs_data_flow, nextjs_middleware_coverage, framework_audit), coupling-tools.ts (fan_in_fan_out, co_change_analysis, shared computeCoChangePairs), perf-tools.ts (6 perf anti-pattern scanners with balanced-brace loop body extraction), architecture-tools.ts (composite: communities + coupling + circular deps + LOC + entry points), query-tools.ts (Prisma→SQL explain), status-tools.ts (index status check), audit-tools.ts (5-gate composite), review-diff-tools.ts (10-check composite), php-tools.ts (9 PHP/Yii2 tools including find_php_n_plus_one, find_php_god_model), react-tools.ts (React component/hook conventions).
**src/lsp/** (4 files) — LSP bridge (6 languages)
**src/parser/extractors/** (15 files) — Language extractors (TS, JS, **Python (full)**, Go, Rust, Prisma, MD, Astro, Conversation, **Kotlin** (with Kotest DSL + KMP expect/actual + @Annotation surfacing), **gradle-kts** (structured plugins/dependencies/config extraction for `*.gradle.kts`), **PHP**, **Hono**, _shared). Python extractor handles async def, @dataclass/@property/@classmethod/@staticmethod/@abstractmethod, dunder methods (tagged via meta), module constants, __all__ exports, superclasses (via extends field), dataclass fields, nested class walk, iterative walk with depth cap 200.
**src/storage/** (10 files) — Index persistence, embeddings, usage tracker, watcher, session-state (compaction survival), **per-language `extractor_version` cache invalidation** (mismatch vs current EXTRACTOR_VERSIONS forces reindex so schema bumps don't leave stale symbols behind)
**src/retrieval/** (5 files) — codebase_retrieval batch engine, semantic/hybrid search
**src/search/** (5 files) — BM25F index with centrality bonus, semantic embeddings, chunker
**src/utils/** (9 files) — Import graph (TS/JS/PHP/Kotlin/**Python**), glob, walk, git validation; python-imports.ts (tree-sitter AST extraction) + python-import-resolver.ts (package-aware resolution with `src/` layout detection) + language-detect.ts (startup file-tree scan for language-gated tool registration)
**src/cli/** (5 files) — CLI commands + hooks.ts (PreToolUse/PostToolUse/PreCompact)
**src/formatters-shortening.ts** — Compact/counts formatters for progressive cascade
**src/instructions.ts** — CODESIFT_INSTRUCTIONS (~800 tok) sent via MCP instructions field
**rules/** — Platform-specific rules (claude.md, cursor.mdc, codex.md, gemini.md)
**tests/** — 1337+ tests (Vitest)
