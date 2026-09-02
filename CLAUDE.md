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

### Anonymous retro rollups ride the codesift telemetry channel (0.14.0)

`/ingest/zuvo` is token-gated and its sender ships over SSH to a tailnet address, so it has exactly
ONE reporting install; `/ingest/codesift` is open and anonymous and has eleven. Retros therefore ride
the codesift L1 payload (`retros[]`, built in `telemetry/retro-aggregator.ts`, allowlisted in
`sanitizer.ts`). Five of the 17 retro columns — project, branch, commit sha, and the free-text note —
are **never read**, not read-then-scrubbed; anonymity by omission survives a format change, scrubbing
does not. Non-enum-shaped values collapse to `"other"` (retros.log is a plain text file anything can
append to). Medians, not sums, so total workload does not leak. The key is OMITTED when empty —
absent means "no zuvo installed", `[]` would mean "zuvo ran and produced nothing". The first-run
notice is the consent and `tests/storage/telemetry-retros.test.ts` fails if the payload can emit a
dimension the notice does not name.

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
**tests/** (431 files, 5859 tests — 5851 pass, 8 skipped; measured 2026-08-18) — Vitest with `exactOptionalPropertyTypes: true`

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

**Run that probe with `env -u CLAUDE_CODE_ENTRYPOINT` or it lies.** `oninitialized` computes
`envPlatform !== "unknown" ? envPlatform : clientPlatform` (`server.ts:476`), so the ENV wins over
`clientInfo`. A probe launched from inside a Claude Code session inherits `CLAUDE_CODE_ENTRYPOINT`,
`detectPlatform()` returns `claude`, and `codex-mcp-client` answers **60** — the exact signature of
"front-loading is broken", from a build where it works. Measured 2026-08-17: 60 with the variable
present, 181 with `env -u`, on the same binary minutes apart. The stderr line names the platform it
decided on (`[codesift] claude does not refresh…`), so read it before trusting a probe's count.
Two more artifacts of probing by hand: piping stdout into `head` closes the pipe and the server
reports `transport error … EPIPE` / `parent gone` — that is the harness, not a fault; and forced
front-loading emits one `notifications/tools/list_changed` per revealed tool (179 of them), which
trips `MaxListenersExceededWarning` on the socket.

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

## Auditing the registry — three traps, all hit on 2026-08-17

**`index_path` is an identifier, not a path that must exist.** It always carries the canonical
`.index.json` name and `sqlitePathFor()` derives the `.db` from it, so on a SQLite-backed install the
`.json` is normally absent. The "never deleted" note above covers indexes that were *migrated* from
JSON; one born SQLite never had a `.json` to keep. Auditing by `existsSync(entry.index_path)`
therefore reports **602 of 608 entries broken** on a completely healthy data dir. Verify with a live
`index_status` before believing any registry audit.

**`prune` is two-pass by design, and `--dry-run` cannot show the second pass.** Run 1 unregisters
stale repos; their artifacts get "one full run of retention" (the guard is
`live.has(hash) || staleHashes.has(hash)` in `commands-maintenance.ts`), so run 2 collects them.
Because the registry is only rewritten `if (!dryRun && stale.length > 0)`, a dry-run never advances
that state and reports only pre-existing orphans. Measured: dry-run `freed_gb: 2.1` / 9 files,
against **17.08 GB / 374 files** on the real second pass — 65 GB → 46 GB overall. Read `stale_repos`
in the dry-run output, not `freed_gb`, to predict the reclaim.

**The `.db` file is the source of truth for registry membership, not the registry.** `prune` opens
each database, reads `meta.repo` / `meta.root`, and if the root still exists it **re-registers** the
entry (`rescued_repos`). Deleting a row from `registry.json` to drop a repo is therefore futile — it
comes back on the next prune. Delete the artifacts (`<hash>.index.db`, `-wal`, `-shm`,
`.snapshot.json`, embeddings/chunks) and the row stops returning. Confirm the target first with
`sqlite3 <db> "select key,value from meta"`; a stray `local/tmp` rooted at `/private/tmp` had
indexed 16,514 scratch files (617 MB) and looked like a real repo in the registry.

## Which clients can actually use the shared daemon (2026-08-27)

The daemon learns the caller's directory from `?cwd=` in the URL and from nothing else — there is
no `roots/list` anywhere in the server, whatever `request-context.ts` used to claim. **One URL
carries one directory, so an HTTP entry is inherently PER-PROJECT.** A client whose MCP config is a
single global file therefore cannot use the daemon at all and falls back to a stdio server per
session. Measured while diagnosing timeouts at load 45: Claude Code (per-project config in
`~/.claude.json`) had 114 projects on the daemon; Codex (only `~/.codex/config.toml`) had **36 stdio
processes**, and closing Codex dropped the machine-wide count from 40+ to 4 — which is how the
attribution was settled.

**The Codex approval-guard LaunchAgent silently reverts every attempt to fix this.**
`com.codesift.codex-approval-guard` has `WatchPaths: ~/.codex/config.toml` and runs
`codesift setup codex --no-rules --no-hooks`. Without `--http` that rewrites the entry back to
stdio, so it watches the file it rewrites: any conversion is undone in ~7 seconds, with nothing in
any log. It exists to hold `default_tools_approval_mode`, not the transport — add `--http` to its
`ProgramArguments` rather than unloading it.

Three things about Codex, each verified by probe against **codex-cli 0.144.6**, not by reading:

- **It reads `<project>/.codex/config.toml`** and MERGES it into the global file, per key. A server
  defined only in the project file loads and completes its handshake.
- **A project `url` cannot override a global `command`.** The merge produces a hybrid and Codex
  refuses to start: `Error loading config.toml: url is not supported for stdio`. The global entry
  has to be HTTP first — a bare `http://127.0.0.1:7077/mcp` with no `?cwd=`, which each project's
  config then overrides. That is what `daemonHttpUrl(port, null)` is for.
- **`env` on an HTTP entry breaks the WHOLE file**: `env is not supported for streamable_http`.
  Every other MCP server in that config goes down with codesift, so a conversion that leaves
  `[mcp_servers.codesift.env]` behind is worse than no conversion. `setup --http` strips it.
- **Roots would not help.** Codex declares no `roots` capability and answers `roots/list` with
  `{"roots":[]}`. Implementing it server-side was the obvious fix and would have been hours in the
  void; the probe took minutes.

### Cursor and Antigravity are opposites — probe each client, never generalise (2026-08-27)

Both keep MCP config in ONE global file, so both looked like the Codex case. They are not the same,
and the difference decides the transport. Measured with an MCP probe that logs `initialize` and
issues `roots/list`:

| | Cursor 1.0 (`cursor-vscode`) | Antigravity (`antigravity-client v1.0.0`) |
|---|---|---|
| expands `${workspaceFolder}` | **yes** — but to a TILDE path (`~/DEV/x`) | **no**, and neither `${workspaceRoot}`, `${cwd}`, `${env:PWD}`, `$PWD`, `${PWD}`, `${projectRoot}` |
| declares `roots` | yes | yes, `listChanged: true` |
| answers `roots/list` | real workspace path | **`[]`**, with a project open |
| cwd of its stdio child | **`$HOME`** | the project directory |
| verdict | **daemon**, one global entry with the variable | **stdio** — converting it would be a regression |

Three things worth carrying to the next client:

- **A variable in the URL is what lets a global-config client use the daemon at all.** One entry,
  and each window fills in its own directory — no per-project files. `JsonPlatformConfig.workspaceVar`
  holds it, and it must be set only for a client measured to expand it.
- **The placeholder must reach the config UNENCODED.** `searchParams.set` writes
  `%24%7BworkspaceFolder%7D`, and the client substitutes by matching literal text — so an encoded
  placeholder is never expanded and every project silently resolves to the same non-directory.
  `daemonHttpUrl` special-cases it; `isClientPlaceholder` is the test.
- **Declaring `roots` is not evidence of answering it**, and the daemon cannot use roots regardless:
  it serves statelessly (`legacy: "stateless"`), so there is no session for a server→client round
  trip. The note in `request-context.ts` saying roots "is what would close that gap" predates that
  and is wrong on its own terms — `tests/server/http-session-cwd.test.ts` asserts the daemon never asks.

Cursor also exposed a fault that predates the daemon: it spawns stdio servers with cwd `$HOME`, so
repo auto-resolution under Cursor was resolving the home directory, not the project — wrong answers
rather than errors, for as long as Cursor has been configured.

**`cwd` values that are not absolute paths now say so.** `~/…` is expanded (Cursor sends it),
an unexpanded `${…}` and a relative path are refused, and each rejection is announced once on
stderr. Previously every one of these degraded silently to "no cwd", surfacing far away as
`Repository "local/" not found`.

**Antigravity has THREE config paths and `setup antigravity` writes only one.** `agy mcp list` reads
`~/.gemini/config/mcp_config.json`; setup writes `~/.gemini/antigravity/mcp_config.json`;
`~/.gemini/settings.json` is the gemini-cli file and holds a different server set entirely. Verify
with `agy mcp list` — not by reading the file setup wrote.

`codesift setup codex --http --project` writes the project file and excludes it via
`.git/info/exclude` — never `.gitignore`, because the file pins an absolute path and would break for
every other developer, and editing a tracked file for a local tool is a change nobody asked for.

**`npm i -g .` leaves the running daemon stale.** It replaces the files the daemon started from, and
`/health` then reports `status: "stale"` with `lazily imported modules will fail until it restarts`.
Restart it (`launchctl unload` + `load`) BEFORE any client reconnects, and use `--ignore-scripts`:
`postinstall` runs `setup all`, which writes the **stdio** entry and undoes the conversion.

## The daemon OOMs and launchd restarts it into the same wall (2026-08-28)

Symptom from the outside: "CodeSift is down and won't come back." It is not down — it is
**crash-looping**. The process answers, balloons, dies with `FatalProcessOutOfMemory` (SIGABRT,
`Abort trap: 6`), launchd's `KeepAlive` starts it again, and it repeats. Measured: RSS 508 MB → 4.69 GB
in one minute, `/health` failing 6 of 20 probes at 10 s each, **14 node crash reports in 24 h**.

**The cause was V8's DEFAULT heap limit — 4288 MB on a 128 GB machine.** Nothing set one. That is
far too little for what this process is: one long-lived server for every project on the box,
materialising whole indexes (a 240k-symbol index is ~349 MB resident, and construction is
synchronous — which is also why `/health` stops answering for 10 s at a time) plus two RAM-scaled
caches. `resolveDaemonHeapMb` now writes `--max-old-space-size` into both the LaunchAgent and the
systemd unit, scaled (RAM/8, floor 2048, cap 8192) and overridable with `CODESIFT_DAEMON_HEAP_MB`.
The flag must precede the script path or node treats it as a CLI argument and ignores it silently.

**The loop is what does the damage, not the single crash.** An OOM discards ALL in-flight work, so a
mass re-index — 29 repos rebuilding hash snapshots, seen in `daemon.err.log` — never reaches the end,
and the next process starts it over. Raising the ceiling is what lets that pass finish once.

A bigger number is not the long-term answer. If the daemon starts reaching 8 GB too, that is the
ADR-004 stage-2 work (query the DB instead of materialising indexes), not another bump.

**Diagnosing this class of fault — what actually told us something:**

- `ps -o state` → `U` (uninterruptible) or `R`, and RSS over time. A process that is *gone* between
  two checks has crashed and been respawned; `launchctl list` showing a live pid proves nothing
  about continuity. Compare the PID across checks.
- `~/Library/Logs/DiagnosticReports/node-*.ips` — the crash report names the reason outright
  (`node::OOMErrorHandler` in the triggered thread). This was the only artifact that gave a cause
  rather than a symptom; everything before it was inference.
- `/health` alone is not enough and is not stable under load: it answered instantly in one probe and
  timed out in the next. Sample it repeatedly and count, and follow with a real `tools/call`.
- The `embed batch … stalled … retrying as N+N` lines in `daemon.err.log` look like a retry storm but
  are **not** — `embedBatchWithStallRetry` splits sequentially and is depth-bounded. They are a
  symptom of load, not a cause of it. Checking the remote endpoint (tailnet ollama answered HTTP 200
  in 0.73 s) ruled that out early.

## Operating the shared daemon

The `codesift serve` daemon (launchd `com.codesift.daemon`, port 7077) can wedge: the port stays
`LISTEN` and the process burns CPU, but the event loop never reaches `/health`, so it answers
nothing. Every client then reports "still connecting" or `{"status":"timed_out","timeout_ms":90000}`
per tool call. **A `timed_out` on a large repo is almost never a slow operation** — after a clean
restart the same repos answered in 0–8 s against that same 90 s ceiling (translation-qa 0 s,
ResearchShieldNew 8 s, tgm-survey-platform 2 s).

Recovery: `launchctl unload` + `load` the plist. A plain `kill` is respawned by launchd but can come
back wedged, repeated kills trip the respawn throttle (~36 s to reappear), and `kickstart -k` was not
sufficient in the 2026-08-17 incident. `/health` answering is necessary but not sufficient — probe a
real `tools/call` too. `CODESIFT_TOOL_TIMEOUT_MS` (clamped to 600 s by `MAX_TOOL_TIMEOUT_MS`) buys
headroom but is not the fix.

Dead ends from that incident, so nobody re-runs them: `pragma quick_check` was `ok`; stored
`extractor_version` matched `EXTRACTOR_VERSIONS` exactly; `detectProjectLanguagesSync` on a
166k-file / 20 GB tree took **66 ms**; `resolveRepoFromCwd` on it took **0 ms** and returned the
right name; the tailnet ollama answered 200 in 0.65 s. The trigger was host memory pressure — 40
sessions on `stdio` instead of the daemon held 6.75 GB and drove the box to load 56 with 1.7 GB free.
Projects with no `codesift` entry in `~/.claude.json` inherit the **global** config, so a global
`stdio` entry silently gives every such project its own server; per-project `http` entries carry
`?cwd=`, which the daemon needs.

## Host identity

`os.hostname()` is **not stable on macOS** — it follows DHCP/network state. One
Mac produced four identities in `usage.jsonl` (`greg-m5`, the `.local` name,
`Mac`, and a bare IP), splitting its own stats four ways. `resolveHostTag`
(`storage/usage-tracker.ts`) now freezes the identity in `<dataDir>/host-id` on
first use. `CODESIFT_HOST_TAG` still wins when set, but it is not sufficient on
its own: a GUI app launched before `launchctl setenv` never sees it, which is
why 1,109 of 1,370 calls on 2026-07-30 were still tagged `Mac` despite the
LaunchAgent being in place since 16 July.

## Reading the error telemetry — slice by version AND day, or you chase closed bugs

Per-tool rows are keyed by `day`, and installs report historical days going back months. Summing
them without slicing makes a **fixed** defect read as a live error rate forever. Measured
2026-08-12 while investigating `find_and_show`:

| slice | find_and_show error rate |
|---|---|
| all days, all versions | 14.1% (292/2067) — and one narrower cut read 69.7% |
| by version | v0.9.10 20.8% · v0.10.1 11.1% · **v0.10.2+ 0/49** |
| by day-of-data | Apr 0/8 · May 0/8 · Jun 0/15 · **Jul 292/2033** · Aug 0/3 |

Every error in the corpus predates `974f92c` (2026-07-16), which made `getBM25Index` resolve repo
names case-insensitively. Local `usage.jsonl` agrees: 73/606 before, **0/100 after**;
`get_context_bundle` 14/149 → 0/36. The tell that it was a name-resolution fault and not a broken
tool: under the very same repo string (`local/Rewards-API`), `get_file_outline` was 431/431 green
while the three BM25-backed tools were 0/84 — code-index tools resolved the name, the BM25 getter
did not. **A defect is live only if it appears on the current version within the last ~14 days.**

Three things the log cannot tell you, all of which cost a full investigation:

- **`error: true` is a boolean.** `usage-tracker.ts:419` says "resultText is the error message", and
  it is — but only its *length* is used (`result_tokens`). The text never reaches the entry
  (line 450), so the error CLASS is unrecoverable after the fact.
- **`repo` on an errored call is not the repo that failed.** `resolveToolRepoArgs` injects a
  CWD-derived `repo` into every tool not in `TOOLS_WITHOUT_REPO` — including `index_file`, whose
  handler takes only `path` and ignores it. So "210 `index_file` errors in tgm-survey-platform"
  means *sessions whose cwd was that repo*, not *files of that repo*.
- **`args_summary` omits the argument that failed.** For `index_file` it carries `repo` and not
  `path`.

What is left to diagnose with: `elapsed_ms` (a ~2–3 ms failure is a fast pre-flight throw; a slow
one is a crash after the index loaded), the day/version slice, and reproducing the call.

**`empty_result_rate` before 2026-08-12 is wrong for `find_references`** — do not read historical
rows for it. It derives from `result_chunks === 0`, and `extractResultChunks` matched
`references` only as an ARRAY while the batch path returns `Record<name, Reference[]>`, so every
batch call logged 0. The tell that this was a shape miss and not a real miss: the "empty" calls
carried a median of 2,076 result tokens against 232 for the "non-empty" ones — the bucket labelled
*found nothing* was ten times the size of the other. Fixed in `extractResultChunks`; entries
already written keep the artifact.

### `index_file` fast-throw surface (the current top live error, 8.8% / 289 calls / 5 installs)

Three ways it fails in ~3 ms, indistinguishable in the log:
1. `No indexed repo contains "<abs>"` — the path is outside every registered root. The PostToolUse
   hook fires on **every** Write/Edit, including scratchpads and `~/.claude`, so this is expected
   traffic, not a fault.
2. **Unguarded `stat` (`file-indexer.ts:79`)** — a missing path escapes as a raw
   `ENOENT: no such file or directory, stat '<abs>'`. Verified by direct call 2026-08-12.
3. `Failed to parse "<rel>"` — `parseOneFile` wraps its whole body in `try` and returns `null` on
   any throw, so unrelated faults surface under one message. Unsupported file types are NOT this:
   `biome.json` indexes fine (`symbol_count: 0, skipped`).

Deletion is the gap worth noting: `handleFileDelete` lives in the **watcher** only. `index_file` —
the path agents are told to use, and the one the CLI hook (`codesift postindex-file`, a fresh
process with no watcher) takes — has no deletion branch, so a removed file throws ENOENT instead of
being pruned from the index.

### The git-diff family fails on an unregistered worktree path (live, ~11%)

`resolveExplicitRepoInput` (`storage/registry.ts`) resolves an absolute `repo` to **any registered
repo that is an ancestor of it**, longest root winning. An unregistered worktree therefore binds to
its parent checkout, and `diffOutline`/`changedSymbols`/`impactAnalysis`/`reviewDiff` all run
`runGitDiff(index.root, …)` — i.e. `git` executes in the parent, where a worktree-branch ref does
not resolve. Post-`974f92c` rates, local, split by whether `repo` was a path or a registry name:

| tool | path-as-repo | name-as-repo |
|---|---|---|
| `changed_symbols` | 10.1% (15/149) | 3.9% |
| `diff_outline` | 11.3% (17/150) | 2.4% |
| `impact_analysis` | 11.3% (25/221) | 5.8% |
| `review_diff` | 11.3% (22/195) | 3.1% |

All four landing within 1.2 points of each other is the signature of one shared resolver, not four
bugs. **Absolute paths are not the problem in general** — across all tools they error at 1.5%
(132/8805), *below* registry names at 2.0%; the fault is specific to ancestor-binding plus git.
For index-reading tools this is the familiar H19 (a confidently wrong answer about someone else's
tree); for the git tools it is a hard `Git diff failed: …` that never names the real cause.
`trace_call_chain` is the opposite shape — 15.8% on names vs 9.3% on paths, consistent with
"symbol not in index" rather than a resolution fault — so do not fold it into this cluster.

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

## Tests run on the test farm — use `rt`, not a local runner

This repo is wired to the shared test farm: primary host **waw-tf**
(`100.88.49.119`, EPYC 9455, 96 threads, 125 GB), overflow shield-tf /
staging-tf / translation-tf. **`burst-i9` and `burst-epyc` were switched off on
2026-09-02 — do not probe `100.69.215.9`, never set `TF_HOST=i9-tf` (`rt` refuses
it by name), and an "offline" i9 in `tailscale status` is not an outage.** The
Mac runs 20-30 agent worktrees at once, so a local suite fights every other
agent for the same cores. `rt` wraps whatever you were going to run and executes
it on the farm, streaming the log back; the broker picks the host.

```sh
rt                     # this repo's test command (from .tf.json), on the farm
rt <any command>       # lint / build / typecheck / a single spec, on the farm
rt -q                  # same, but only farm lines, failures and totals
rt --flaky             # per-test history: is this red a flake or a regression?
rt --repeat 20 <cmd>   # run it 20x in ONE job and report the failure RATE
```

**This applies to every test/lint/build command in this repo**, including ones
these docs name directly — `rt` composes with them, it does not replace them.
Off the tailnet `rt` **refuses (exit 21)** — nothing runs on the laptop;
`RT_LOCAL_OK=1` is an explicit human override, not something an agent sets.

Farm config for this repo lives in `.tf.json`. Tool source of truth:
`~/DEV/i9-farma` (edit there, then `./install.sh` — never edit `~/bin/rt`
or the deployed copies on the farm hosts).
