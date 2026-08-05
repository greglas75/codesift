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
| `H19` | Answer comes from a DIFFERENT git working tree than your CWD | Results describe other files — `index_folder(path=<your worktree>)` |

### Worktrees get their own registry name (2026-08-06)

The registry is keyed by repo NAME, and all three name sources collapse a repo's worktrees onto one:
the `.codesift.json` override is TRACKED so git checks it into every worktree, `remote.origin.url` is
shared by definition, and the basename fallback collides across parents. Measured here:
`tgm-survey-platform` has **36 worktrees**, so 35 registry entries were being silently overwritten and
resolving by name returned whichever tree indexed last — H19 as a permanent condition rather than a
transient one. `getRepoName` now suffixes a LINKED worktree with git's own worktree name
(`local/tgm-survey-platform@ci-docker-cache`), taking the base from the MAIN checkout because a
worktree has no `.git/config` of its own. Submodules also use a `.git` file but point at
`.git/modules/<name>` and are deliberately left alone — a submodule is a different repository.
Bare-name input (`tgm-survey-platform`) still resolves to the main checkout, since a suffixed name
does not end in `/<input>`.

## Tool Discovery (NEW — agents read this)

Non-core tools are **hidden** from ListTools (via SDK `disable()`). Only 51 core tools are visible (out of 150 total).
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

### index_folder sanity check is now visible + self-healing (NEW)
When a re-walk finds <50% of the previously indexed file count, index_folder keeps the old index — but now returns `status: "rejected_partial"` + `reason` + `hint` instead of silently echoing the old counts as success (pre-fix this skipped saveIndex AND registerRepo, so the repo could vanish from the registry while the tool reported OK). Before rejecting, it samples the old index's paths on disk: if ≥50% no longer exist (e.g. deleted `.worktrees/` swept by an older walker), the old index is treated as stale and the new one is accepted (auto-heal — breaks the poisoned-baseline deadlock where every honest reindex was rejected forever).

### Multi-host usage telemetry (NEW)
Every usage.jsonl entry now carries `host` (os.hostname(), override via `CODESIFT_HOST_TAG`). Logs pulled from other machines into `~/.codesift/usage-remote/<host>.jsonl` (see `scripts/sync-usage-remote.sh` + cron) are merged by `usage_stats` (new `host` filter param, `hosts` breakdown in stats/report) and by the dashboard (Usage by Host section on /analytics). Entries predating the field inherit the local hostname or the remote file's name stem.

### Progressive response shortening (NEW)
Large responses auto-cascade: >52.5K chars → compact format, >87.5K → counts only, >105K → hard truncate. Skipped when `detail_level` or `token_budget` is explicitly set. Annotation `[compact]` or `[counts]` prepended.

### CLI hooks (NEW)
`codesift setup claude --hooks` installs PreToolUse (redirect Read on large code files to CodeSift), PostToolUse (auto index-file after Edit/Write), SessionStart (inject CodeSift availability prompt + wiki project overview), and PreCompact (inject session snapshot before context compaction). Hooks go to `~/.claude/settings.json` (user-level `settings.local.json` is NOT read by Claude Code — versions ≤0.8.9 wrote there, leaving all hooks dead; setup now migrates legacy entries out).

The `precheck-bash` hook lexes the command instead of regex-matching the raw string
(`lexShellSegments` in `src/cli/hooks/pre-tool-use.ts`). Two false positives it used to hit: quoted
text was read as shell code, so any command that merely *mentioned* a search tool was redirected
(`echo "use rg instead"`, a python/node script passed via `-c` or a heredoc whose source contains
`'rg'`); and flags were matched line-wide, so `grep -ic x "$f" | sort -rn` read as a recursive grep
because of `sort`'s `-rn`. Quoted regions are now inert for splitting but keep their text (so
`"rg" "TODO"` is still ripgrep), heredoc bodies are skipped, `$(...)` still splits into its own
segment, and flags only count on unquoted tokens of the invocation that owns them.

### Wiki auto-update + agent access (NEW)
The wiki is kept fresh and surfaced to agents automatically — no manual `wiki-generate` needed once a wiki exists:
- **Auto-update**: `handlePostindexFile` (PostToolUse Write|Edit) spawns a detached, throttled `wiki-generate` after re-indexing — never blocks the agent. Gated to keep CPU cost negligible: (1) wiki manifest must already exist (never auto-creates), (2) **structural trigger** — only regenerates when the edited file is NOT in the manifest's `file_to_community` (a new file = structure changed); edits to known files skip regen since the overview won't change, so the common case costs nothing, (3) **size gate** — skips repos with > `CODESIFT_WIKI_AUTO_REGEN_MAX_FILES` files (default 5000; huge repos are manual-only), (4) throttle `WIKI_REGEN_DEBOUNCE_MS` = 30 min/repo via `wiki-regen-debounce.json`. Opt out: `CODESIFT_WIKI_AUTO_REGEN=0`. `git_commit` in the manifest is now captured from real HEAD (was hardcoded "unknown") to power the staleness hint.
- **SessionStart overview**: `handleSessionStart` appends a compact project overview (stack, entry points, modules + one-line descriptions, top gotchas, staleness hint) built from the v2 manifest `project`/`modules` blocks via `tryLoadProjectOverview`. v1/missing manifest → static prompt only. Budget `CODESIFT_WIKI_OVERVIEW_MAX_CHARS` (default 1800). Opt out: `CODESIFT_WIKI_OVERVIEW=0`.
- **Per-file summary**: `precheck-read` still injects the community `.summary.md` when an agent reads a small file (unchanged).
- **Telemetry**: both hooks log to `usage.jsonl` (same shape as MCP tool events) — `wiki_overview_injected` (SessionStart, with module count + char budget) and `wiki_auto_regen` (PostToolUse, with trigger file). Surfaces in `usage_stats` / `grep`, so wiki adoption is measurable. Opt out: `CODESIFT_WIKI_TELEMETRY=0`.
- `codesift wiki-generate` now auto-resolves the repo from CWD when no repo id is passed (the hook relies on this).

## Release & Install

### Building and publishing a new version
```bash
npm run build                    # compile TypeScript → dist/
npm version patch                # or: minor / major (bumps package.json + git tag)
npm publish --ignore-scripts     # publish to npm (requires OTP)
git push origin main --tags      # push commits + tag to GitHub
```

### Installing (for users)
```bash
npm install -g codesift-mcp      # install globally (always gets latest)
codesift setup all               # configure all platforms (Claude, Codex, Cursor, Gemini, Antigravity)
```

Or per-platform: `codesift setup claude`, `codesift setup codex`, `codesift setup cursor`, `codesift setup gemini`.

No version number needed — `npm install -g codesift-mcp` always installs latest. MCP configs use `npx -y codesift-mcp` which also auto-updates.

## After adding/changing features — update checklist

When you add a new tool, change tool count, update benchmarks, or modify behavior:

1. **This repo (codesift-mcp):**
   - `src/instructions.ts` — update if ALWAYS/NEVER rules or hint codes changed
   - `rules/codesift.md` + `rules/codesift.mdc` + `rules/codex.md` + `rules/gemini.md` — update tool mapping
   - `CLAUDE.md` — update architecture section, tool count
   - `README.md` — update tool count, benchmarks, feature table
   - Bump version + publish: see "Release & Install" above

2. **Website (../codesift-website):**
   - `public/llms.txt` — update features, install instructions, tool count
   - `public/llms-full.txt` — update header, add new articles
   - Components with tool count: Hero, FeatureGrid, Footer, Problem, Nav, Pricing, BaseLayout
   - Pages: index, tools/index, how-it-works, benchmarks, articles/index
   - Build + deploy: `npm run build && wrangler pages deploy dist --project-name codesift-website --commit-dirty=true`

3. **Quick grep to find all places with a number (e.g., tool count):**
   ```bash
   grep -rn "150 tools\|150 MCP" src/ ../codesift-website/src/
   ```

## Architecture

**146 MCP tools** (51 core + 95 discoverable; see "Host compatibility" below for the 12 front-loaded on frozen-list hosts) | **`analyze_complexity` language gating (2026-07-30)**: branch/nesting patterns are selected per file language — Kotlin's Elvis `?:` and PHP's `foreach`/`match(` used to be matched in every language, so a 126-field NestJS DTO scored `cyclomatic_complexity=82` with `max_nesting_depth=0` (one branch per `field?: T`) and was queued for a refactor it did not need. The ternary regex now also excludes `??`, `?.` and `?->`. | **43 React patterns + Tier 8 (May 2026)**: `preprocess: "strip-comments-strings"` declarative field on `BUILTIN_PATTERNS` entries — opted in for `dangerously-set-html`, `direct-dom-access`, `react19-useoptimistic-no-transition`, `empty-catch`, `any-type`, `console-log`. Single-pass 7-state-machine source stripper in `src/utils/source-stripper.ts` strips comments, string/template/regex literals before regex match (preserves character positions, keyword-aware regex context for `return /x/`/`throw /x/`/`case /x/`). Closes Tier 7 R-2.1 known limit (comment-embedded transition tokens). | Tier 7 May 2026: 3 regex bugfixes (useOptimistic, setstate-loop, server-action) + cross-file Suspense ancestor walker (`findSuspenseAncestor`, `findLazyComponentsWithoutSuspense`). | Tier 6 May 2026 added 9 patterns (derived-state-reducer, derived-state-custom-setter, stale-closure-toggle, stale-closure-broken-functional, context-provider-value-via-variable, context-provider-value-inline-destructured, react-lazy-no-suspense-same-file, rsc-non-serializable-prop-deep, error-boundary-incomplete) + full severity migration on existing 29 patterns. | Tier 5 May 2026 added derived-state, stale-closure-setstate, context-provider-value-inline, jsx-no-target-blank, button-no-type + `prop_chain_depth` render-tree-depth metric on `analyze_renders` + severity-aware `react_quickstart` bucketing + declarative `postFilter` field | tree-sitter AST + BM25F + semantic search + LSP bridge + conversation search + secret detection + session-aware context + **hybrid tool routing** (`plan_turn` — 5-signal WRR ranker: BM25 + identity + semantic + usage-freq + framework boost; first MCP tool to combine data-first routing with tool recommendations) + **Python deep intelligence** (11 Python tools: `get_model_graph` Django/SQLAlchemy ORM, `get_test_fixtures` pytest fixture graph, `find_framework_wiring` Django signals/Celery tasks/middleware, `run_ruff` with symbol correlation, `parse_pyproject`, `find_python_callers` cross-module tracing, `analyze_django_settings` 15 security checks, `run_mypy`/`run_pyright` type checking, `analyze_python_deps` PyPI+OSV; `trace_celery_chain` and `find_python_circular_imports` absorbed into `python_audit`; plus 17 anti-patterns in search_patterns + Flask/FastAPI/Django in trace_route) + **NestJS intelligence** (`nest_audit` composite — 14 sub-tools consolidated into single meta-tool with `checks=` parameter) + **Astro deep intelligence** (7 core tools: island hydration audit with AH01-AH12 scoring, route map, config analysis, actions audit, migration check, content collections, template parsing) + **Next.js Tier-1 intelligence** (route map, metadata audit, `framework_audit` meta-tool — 7 sub-tools consolidated into `framework_audit(checks=...)`) + **Hono Phase 2 intelligence** (11 tools after polish consolidation: `analyze_hono_app` meta-tool, `trace_middleware_chain` with `only_conditional` filter, `trace_context_flow`, `extract_api_contract`, `trace_rpc_types`, `audit_hono_security` with env-regression rule, `visualize_hono_routes`, `analyze_inline_handler`, `extract_response_types`, `detect_hono_modules`, `find_dead_hono_routes`) + **PHP/Yii2 intelligence** (6 tools: PSR-4 edges, PHPDoc synthesis, security scan, project audit with N+1/god-model/ActiveRecord checks via `php_project_audit(checks=...)`) + **SQL intelligence** (schema analysis, schema complexity, migration linting, DML safety scanner, orphan tables, query tracing, drift detection) + **Kotlin Wave 2** (Kotest DSL, Gradle KTS, Hilt DI graph, coroutine chain, KMP expect/actual) + **Kotlin Wave 3** (Compose component tree `trace_compose_tree`, recomposition analysis `analyze_compose_recomposition`, Room schema graph `trace_room_schema`, kotlinx.serialization contract `extract_kotlin_serialization_contract`, Flow operator chain `trace_flow_chain`, 3 Compose anti-patterns) + **Dependency audit** (`dependency_audit` composite: vulns + licenses + freshness + lockfile) + **Prisma schema analysis** (`analyze_prisma_schema` via @mrleebo/prisma-ast — FK index coverage, soft-delete detection, status-as-String warnings)

## Tool breakdown by category (150 total)

| Category | Count | Examples |
|----------|------:|----------|
| analysis | 70 | find_dead_code, find_perf_hotspots, audit_scan, dependency_audit, analyze_prisma_schema, migration_lint, Python/SQL/React/Hono/Next.js/Astro/Kotlin tools |
| meta | 11 | index_status, analyze_project, get_extractor_versions, discover_tools, describe_tools, usage_stats, session tools |
| architecture | 7 | detect_communities, check_boundaries, fan_in_fan_out, co_change_analysis, architecture_summary, classify_roles, ast_query |
| search | 6 | search_text, search_symbols, codebase_retrieval, semantic_search, suggest_queries, find_and_show |
| graph | 6 | trace_call_chain, impact_analysis, trace_route, find_references, find_circular_deps, get_call_hierarchy |
| conversations | 6 | index_conversations, search_conversations, search_all_conversations, find_conversations_for_symbol |
| security | 6 | scan_secrets, taint_trace, php_security_scan, audit_hono_security |
| indexing | 5 | index_folder, index_file, index_repo, list_repos, invalidate_cache |
| outline | 4 | get_file_outline, get_file_tree, get_repo_outline, get_symbols_overview |
| symbols | 4 | get_symbol, get_symbols, get_context_bundle, get_type_info |
| lsp | 4 | go_to_definition, get_type_info, rename_symbol, get_call_hierarchy |
| diff | 3 | diff_outline, changed_symbols, review_diff |
| reporting | 3 | generate_report, generate_claude_md, usage_stats |
| context | 2 | assemble_context, get_knowledge_map |
| patterns | 2 | search_patterns, list_patterns |
| session | 2 | get_session_snapshot, get_session_context |
| nestjs | 1 | nest_audit (14 sub-tools consolidated into single meta-tool with `checks=` param) |
| navigation | 1 | go_to_definition |
| **discovery** | **1** | **`plan_turn` — hybrid data+tool routing concierge** |

## Source layout

**src/tools/** (103 files) — MCP tool handlers. Key composites: `plan-turn-tools.ts` (query parser + planTurn handler + formatPlanTurnResult), `audit-tools.ts` (5-gate composite audit_scan), `review-diff-tools.ts` (10-check composite), `architecture-tools.ts` (communities + coupling + circular deps + LOC + entry points), `coupling-tools.ts` (fan_in_fan_out + co_change_analysis + shared computeCoChangePairs), `perf-tools.ts` (6 perf anti-pattern scanners with balanced-brace loop body extraction), `query-tools.ts` (Prisma→SQL explain), `status-tools.ts` (index status check), `dependency-audit-tools.ts` (4-check composite: vulns + licenses + freshness + lockfile), `migration-lint-tools.ts` (squawk wrapper), `prisma-schema-tools.ts` (AST-based schema analysis), `agent-config-tools.ts` (CLAUDE.md stale-ref auditor), `test-impact-tools.ts` (changed files → tests with confidence), `nextjs-*.ts` (13 Next.js files), `hono-*.ts` (13 Hono files), `php-tools.ts` (6 PHP/Yii2 tools), `python-*.ts` (13 Python deep-intelligence files), `astro-*.ts` (7 Astro files), `react-tools.ts`, `kotlin-tools.ts`, `compose-tools.ts`, `room-tools.ts`, `sql-tools.ts`.
**src/lsp/** (4 files) — LSP bridge (6 languages)
**src/parser/extractors/** (17 files) — Language extractors: `_shared.ts`, `typescript.ts` (shared TS+JS walker — handles `field_definition` for JS class fields incl. `#private`/`static`, `class_static_block` as `<static>` method, `generator_function_declaration` with `meta.generator: true`, object-literal methods + arrow pairs, CommonJS exports: `module.exports = X / { foo, bar } / fn`, `module.exports.X = …`, `exports.X = …`), `javascript.ts` (delegates to TS walker — covers same JS-specific node types since v2.1.0), `python.ts` (full — async def, @dataclass/@property/@classmethod/@staticmethod/@abstractmethod, dunder methods tagged via meta, module constants, __all__ exports, superclasses, dataclass fields, nested class walk, iterative walk with depth cap 200), `go.ts`, `rust.ts`, `prisma.ts`, `markdown.ts`, `astro.ts`, `conversation.ts`, `kotlin.ts` (with Kotest DSL + KMP expect/actual + @Annotation surfacing), `gradle-kts.ts` (structured plugins/dependencies/config extraction for `*.gradle.kts`), `php.ts`, `hono.ts`, `hono-model.ts`, `hono-inline-analyzer.ts`, `sql.ts`. Text-stub languages indexed without symbol extraction: kotlin, swift, dart, scala, groovy, elixir, lua, zig, nim, gradle, sbt.
**src/storage/** (16 files + `sqlite/` 8) — Index persistence, embeddings, usage tracker, watcher, session-state (compaction survival), **per-language `extractor_version` cache invalidation** (mismatch vs current EXTRACTOR_VERSIONS forces reindex so schema bumps don't leave stale symbols behind). `sqlite-index-store.ts` is a **re-export facade only** (22 named exports, explicit list — never `export *`); the SQLite backend lives in `src/storage/sqlite/`: `runtime.ts` (is node:sqlite present + the memoised ctor), `errors.ts` (operational fault vs "nothing indexed"), `schema.ts` (DDL + v1→v2 migration as inert SQL), `rows.ts` (row↔domain mapping + byte accounting), `connection.ts` (open/close/cache, migration, meta k/v), `meta.ts` (optional meta fields + `IndexSummary`), `index-io.ts` (whole-index read/write), `accessors.ts` (narrow reads). **Two bindings must stay single-instance**: `sqliteCtor` only in `runtime.ts`, `connections` only in `connection.ts` — ESM gives one instance per module, so re-exporting is safe and re-declaring forks the state into a `closeIndexDb` that closes a handle someone else still hands out. `tests/storage/sqlite-module-state.test.ts` fails on exactly that fork (its cross-module cases; the same-module ones only bite if `connection.ts` is split further).
**src/retrieval/** (5 files) — codebase_retrieval batch engine, semantic/hybrid search
**src/search/** (6 files) — BM25F index with centrality bonus, semantic embeddings, chunker, cross-encoder reranker; **`tool-ranker.ts`** — 5-signal WRR ranker (lexical W=1.0, identity W=2.0, semantic W=0.8, structural W=0.4, framework W=0.6) for `plan_turn`, with SHA-1 fingerprint cache + graceful BM25-only fallback when no embedding API key. **Local embeddings default** (May 2026): `LocalProvider` in `src/search/semantic.ts` uses `nomic-ai/nomic-embed-text-v1.5` via `@huggingface/transformers` v3 ONNX pipeline (`dtype: "q8"`, 768d, mean pooled, normalized) — zero-config, no API key required. Provider precedence: explicit `CODESIFT_EMBEDDING_PROVIDER` → Voyage key → OpenAI key → Ollama URL → local. Opt-out via `CODESIFT_DISABLE_LOCAL_EMBEDDINGS=true`. **Task-aware prefixes**: `EmbeddingMode = "document" | "query"` propagates through `provider.embed()` callers; nomic + E5 families auto-prepend `search_document:`/`search_query:` (or `passage:`/`query:`) per HF model card so retrieval quality matches remote providers
**src/utils/** (9 files) — Import graph (TS/JS/PHP/Kotlin/**Python**), glob, walk, git validation; python-imports.ts (tree-sitter AST extraction) + python-import-resolver.ts (package-aware resolution with `src/` layout detection) + language-detect.ts (startup file-tree scan for language-gated tool registration)
**src/cli/** (5 files) — CLI commands + hooks.ts (PreToolUse/PostToolUse/PreCompact)
**src/formatters-shortening.ts** — Compact/counts formatters for progressive cascade
**src/instructions.ts** — CODESIFT_INSTRUCTIONS (~1.5K tok) sent via MCP instructions field
**rules/** — Platform-specific rules (codesift.md, codesift.mdc, codex.md, gemini.md)
**tests/** (355 files, 5112 tests, all passing) — Vitest with `exactOptionalPropertyTypes: true`

## Host compatibility — frozen tool lists (Codex)

`describe_tools(reveal=true)` enables a hidden tool and emits `notifications/tools/list_changed`.
Claude Code honours that; the **Codex MCP bridge does not** — the reveal succeeds, the tool appears
in discovery, and it is still not callable. Measured 2026-07-30 across 13 Codex sessions: 35 reveal
calls, zero revealed tools ever invoked, runs falling back to 318 `rg` + 75 `find` shell calls and
reporting `BLOCKED_INFRA` / `INCOMPLETE`.

Fix (`server.ts` `oninitialized` → `frontLoadHiddenToolsForFrozenHost`): on such hosts the **entire
language-appropriate surface** is enabled inside the `initialized` notification — the last window
before the client's first `tools/list`. Not just a shortlist: on a host that cannot reveal, any tool
left disabled is unreachable for the whole session. It is affordable precisely there because Codex
defers MCP tool schemas *and names*, surfacing them only through ToolSearch, so they never enter the
prompt (verified in the 2026-07-30 logs: codesift tool names appear only in `tool_search_output`).
`FROZEN_LIST_FALLBACK_TOOL_NAMES` remains as the must-be-reachable set a narrowing regression fails
against. `describe_tools(reveal=true)` returns `reveal_ineffective` + `reveal_note` there, and
`plan_turn` returns an empty `reveal_required` with no `[hidden]` marks (`isToolHiddenForHost`).

Handshake probe (spawn `dist/server.js`, initialize as a given client, read the first `tools/list`):
claude-code 60 · unknown-client 60 · codex-mcp-client 181 · TypeScript-only project on codex 148.

**These names are deliberately NOT in `CORE_TOOL_NAMES`.** Commit 3e1ec6c ("revert agent-visible
changes that broke CodeSift adoption (>90% drop)") found that growing the default ListTools
depressed adoption on Claude Code, so the core list stays byte-identical there. Host detection is an
explicit allowlist (`FROZEN_TOOL_LIST_PLATFORMS`); unknown hosts are assumed to honour the
notification. Override for undetectable hosts: `CODESIFT_STATIC_TOOL_LIST=1|0`.

Note: Codex's `ToolSearch(query="select:<names>")` answers with a semantic sample of the namespace
rather than the requested names (a 20-name query returned 20–25 tools, none of them requested,
including always-visible core tools the same session called successfully). That is client-side and
not fixable here — it is why front-loading, not a preload protocol, is the fix.

### ESM: never call bare `require()`

The package is `"type": "module"`, so a bare `require()` throws at runtime. Two places did, and both
failed silently because the call sites swallowed the error:

- `detectProjectLanguagesSync` — `registerTools` caught the throw and fell into its "on failure,
  enable everything" branch, so **`requiresLanguage` gating was dead**: every project looked like it
  contained every language. Invisible while non-core tools were hidden anyway; front-loading on
  Codex exposed it (a TypeScript-only repo was getting the full Python/PHP/Kotlin surface).
- `resolveMcpServerEntry` (`src/cli/setup/mcp.ts`) — both `which` lookups threw, so `codesift setup`
  **always** wrote the `npx -y codesift-mcp` fallback even with a global install present.

Unit tests did not catch either: vitest provides a CJS interop shim, so `require` resolves under
test and only breaks under plain Node. The guard is the source-level invariant in
`tests/utils/language-detect.test.ts` ("no src module calls require() without createRequire"),
which strips comments/strings first and exempts `createRequire`-derived calls (`server.ts`).

## Index write cost (measured 2026-07-30)

The index is **one JSON blob per repo**, and `saveIncremental` does a full
`loadIndex` + `saveIndex` per changed file. Measured on the live indexes:

| repo | index | read+parse+stringify | observed `index_file` median |
|---|---:|---:|---:|
| tgm-survey-platform | 262 MB | 1854 ms | 3711 ms |
| translation-qa | 130 MB | 849 ms | 1218 ms |
| codesift | 26 MB | 169 ms | 131 ms |

Telemetry over 10,613 `index_file` calls: 235 ms median overall, p90 6.2 s,
p99 29 s, **7.5 h of wall clock**. The documented "9ms" is the *unchanged-file*
short-circuit, not the write path.

Mitigation shipped: `enqueueIndexMutation` folds every queued mutation for one
index into a single load+save, so a burst of N concurrent edits costs one
rewrite instead of N (`getIndexWriteCountForTesting` exists because ESM forbids
spying on `node:fs/promises`). **This only helps concurrent bursts** — an agent
that awaits each `index_file` before the next still pays the full cycle per file,
and the CLI hook (`codesift postindex-file`) is a fresh process each time, so it
cannot batch at all.

**Both remaining costs are now fixed by the format change (ADR-003, 2026-08-02).**
The index is a per-repo SQLite database (`<hash>.index.db`) with normalized
`files` / `symbols` tables, via the built-in `node:sqlite` in WAL mode:
- `file-indexer` reads one file's `mtime_ms` through `getFileEntry` — one indexed
  row, not a whole-blob parse (was two full parses per first-touch edit).
- The in-memory index cache is now **safe**: `PRAGMA data_version` moves when
  another connection commits, which is the cross-process signal a plain JSON file
  never had. Our own writes invalidate explicitly (data_version does not move for
  the connection that wrote).

Measured on a 4k-file / 32k-symbol index: `saveIncremental` 10.8× faster, per-file
mtime read ~2500× faster, warm `loadIndex` ~17800× faster. Cold `loadIndex` (once
per process) and full `saveIndex` (once per reindex) are 2–3× *slower* — rebuilding
objects from rows costs more than one big `JSON.parse`. Deliberate trade: the
frequent paths win, the rare ones pay.

JSON remains the backend on Node < 22.5 (no `node:sqlite`; engines floor stays
`>=20`) and as the rollback target. `CODESIFT_INDEX_BACKEND=json|sqlite` pins the
choice; unset auto-detects. Existing JSON indexes migrate on first touch and the
`.json` file is **never deleted**, so rollback always has something to roll back to.

## Storage hygiene

`saveEmbeddings` / `saveChunkEmbeddings` write `<target>.tmp.<timestamp>` then
rename. A process killed mid-write (SIGKILL, the stdio-disconnect exit path, OOM,
machine sleep) never runs the writer's own cleanup, and the timestamped name is
never reused — so orphans accumulate forever: **100 files / 5.0 GB** in
`~/.codesift` by 2026-07-30, against 21.9 GB of live embeddings.
`cleanupOrphanTempFiles` (in `storage/_shared.ts`) sweeps siblings older than 1 h
at the start of each save; the age guard is what keeps it from touching a
concurrent writer's in-flight file.

## Host identity

`os.hostname()` is **not stable on macOS** — it follows DHCP/network state. One
Mac produced four identities in `usage.jsonl` (`greg-m5`, the `.local` name,
`Mac`, and a bare IP), splitting its own stats four ways. `resolveHostTag`
(`storage/usage-tracker.ts`) now freezes the identity in `<dataDir>/host-id` on
first use. `CODESIFT_HOST_TAG` still wins when set, but it is not sufficient on
its own: a GUI app launched before `launchctl setenv` never sees it, which is
why 1,109 of 1,370 calls on 2026-07-30 were still tagged `Mac` despite the
LaunchAgent being in place since 16 July.

## Memory controls (low-RAM / multi-session)
- **Auto-lite by total RAM (default, `config.ts`)**: on machines with **< 24 GB** total RAM, the local embedding model (nomic via onnxruntime, ~1–1.5 GB resident) is **not loaded by default** — this was previously the manual `CODESIFT_DISABLE_LOCAL_EMBEDDINGS=1` recommendation, now automatic so codesift stops OOM-ing small machines out of the box. BM25 + tree-sitter symbols still work; only semantic embeddings go dark. Logged once on startup. Override: `CODESIFT_DISABLE_LOCAL_EMBEDDINGS=0` forces the model on regardless of RAM (`=1`/`true` still forces lite on any machine); a remote provider (Voyage/OpenAI/Ollama) sidesteps the local model entirely.
- **Stdio server exits on client disconnect (`server.ts`)**: the MCP stdio server exits on transport-close / stdin-EOF / SIGTERM. Before this, a dead Claude/Codex left the server orphaned under launchd forever, holding 1–4 GB each — the root cause of "codesift is killing my machine" (one box had 51 procs / 30 GB / 202% CPU). The HTTP daemon (`codesift serve`) is unaffected (stdin handlers are stdio-only).
- `CODESIFT_MAX_EMBEDDING_MEM_MB` — resident embedding-**cache** budget; explicit value wins, otherwise **RAM-scaled default** (≤16 GB → 256 MB, ≤32 GB → 512 MB, else 1024 MB). LRU-evicts per-repo embeddings over budget; `getEmbeddingCache` pins the in-use repo. `loadEmbeddings` streams the ndjson (no whole-file slurp). Shared HTTP daemon (`codesift serve`, load-once) live — see docs/specs/2026-06-22-shared-server-memory-plan.md.
- `CODESIFT_MAX_INDEX_CACHE_MB` (**ADR-004**) — resident index-**cache** budget, same RAM-scaled tiers as the embedding budget. Replaces a bound on entry COUNT (`CODESIFT_MAX_CACHED_INDEXES`, kept as a secondary cap), which priced a 349 MB index and a 2 MB one identically — "at most three indexes" permitted ~1 GB of long-lived heap. Footprint is tallied by the SQLite loader as it walks the rows (one addition per row, no extra query); other backends fall back to constants calibrated from a `heapUsed` delta on the real 240k-symbol index. Both constants are rounded **up** — over-reporting costs a re-read, under-reporting silently breaks the budget (measured overshoot 9.4%). The most recently loaded index is never evicted, even if it alone exceeds the budget, or every call would re-read and re-evict it.
- **Load *time* is a separate, unfixed problem** (ADR-004 stage 2). Measured on the 240k-symbol index: 349 MB resident, of which `source` is 185 MB (45%) — but omitting `source` makes the load only 2% faster, because the cost is constructing 240k objects, not attaching strings. Fixing it means tools querying the DB for the rows they need instead of materialising the index: **348 call sites in 150 files**. Do NOT "fix" it by omitting `source` by default (hands `undefined` to ~60 files that read it, indistinguishable from a symbol with no source) or by a lazy getter (`JSON.stringify` skips prototype getters — source would vanish from serialised responses; own accessors on 240k objects force dictionary mode).

## Symbol ids are not unique — both lookup paths refuse a collision

A symbol id is `repo:file:name:line`, which does **not** identify one symbol: TypeScript's separate
type and value namespaces let `export type Collide` and `export const Collide` share a line, PHPDoc
`@method` synthesis emits a field and a method at one line, and a minified bundle puts hundreds of
declarations on line 1. Under the v1 SQLite schema this was a `PRIMARY KEY`, which silently dropped
73,165 rows across 16 indexes (fixed in `b7245f8`).

`getSymbol` and `getSymbols` now both throw `AmbiguousSymbolIdError` listing the candidates instead
of returning whichever match came first — `getSymbols` previously did last-write-wins into a `Map`,
so the two entry points disagreed about the same input. Use `isAmbiguousSymbolIdError` (structural,
not `instanceof` — a duplicated module instance across a worker/bundler boundary breaks
`instanceof`). `wrapTool` turns the throw into an `{isError: true}` result with the message intact.

**Searches fall back instead of failing — and say so.** `find_and_show` and `get_context_bundle`
read the id back off a BM25 hit they already hold, so `resolveSearchHit` returns that hit rather
than failing the whole query; refusing there would make the collision a worse answer than the
silent substitution it replaced, on the two tools the H7/H8 hints steer agents toward. Both then
carry `id_ambiguity: { status: "unique" | "ambiguous", shared_by?, candidates? }` — **always
present**, because an absent field is indistinguishable from "nobody checked". When ambiguous, the
tool output is **prefixed** with an `AMBIGUOUS ID —` banner naming the candidates: the handlers
return text, so a signal that lives only in the typed result informs nothing.

## Linting — Biome (`npm run lint`)

`npm run lint` is `biome lint . && tsc --noEmit`; `npm run lint:fix` applies the safe fixes. Config
in `biome.json`. Until 2026-08-04 `lint` was `tsc --noEmit` alone, so every CQ40 gate failed on every
file for want of a linter to run.

Deliberately narrow, and that is the point. **The formatter is off** — enabling it would rewrite the
whole repo in one commit and bury every real finding under whitespace. `recommended` is off too;
only rule groups that catch defects are on (correctness, suspicious, a little complexity/security).
Style and naming opinions stay out: a linter that fires on things nobody intends to change is a
linter that gets ignored.

`noAdjacentSpacesInRegex` is **off** rather than suppressed per-site: all 4 hits were regexes
matching indentation (`/^  - /gm` for markdown lists, `/^    - (.+)$/` for YAML). A rule that is
wrong every time it fires on this codebase is noise.

First run: 51 findings across 949 files. 44 were unused imports/variables/parameters (auto-fixed,
verified by `tsc` + the full suite), 3 were deliberate and are suppressed inline **with the reason
above the suppression** — `biome-ignore` only binds to the line immediately after it, so an
explanation placed between the directive and the code silently disables the suppression (Biome then
reports `suppressions/unused`). One was a real test defect: a "detects Yii2 from composer.json" test
that imported `detectStack`, never called it, and grepped the source for a string literal instead.

## Tests run on the i9 farm — use `rt`, not a local runner

This repo is wired to the shared test farm (burst-i9, 24 cores). The Mac runs
20-30 agent worktrees at once, so a local suite fights every other agent for the
same cores. `rt` wraps whatever you were going to run and executes it there,
streaming the log back.

```sh
rt                     # this repo's test command (from .tf.json), on i9
rt <any command>       # lint / build / typecheck / a single spec, on i9
rt -q                  # same, but only farm lines, failures and totals
rt --flaky             # per-test history: is this red a flake or a regression?
rt --repeat 20 <cmd>   # run it 20x in ONE job and report the failure RATE
```

**This applies to every test/lint/build command in this repo**, including ones
these docs name directly — `rt` composes with them, it does not replace them.
Off the tailnet `rt` transparently runs the same command locally, so it is
always safe to reach for.

Farm config for this repo lives in `.tf.json`. Tool source of truth:
`~/DEV/i9-farma` (edit there, then `./install.sh` — never edit `~/bin/rt`
or the deployed copies on i9).
