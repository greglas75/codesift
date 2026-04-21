# Project History

> Day-by-day chronicle of the CodeSift MCP project, compiled from `git log` (709 commits across 34 active days), the GitHub repo at `greglas75/codesift` (created 2026-03-17, TypeScript, BSL-1.1 license), and the competitive context in the code-intelligence MCP space. See also [[index]] · [[hubs]] · [[hotspots]] · [[surprises]].

## At a glance

| Metric | Value |
| --- | --- |
| First commit | 2026-03-13 |
| Latest commit | 2026-04-20 |
| Active days | 34 |
| Total commits | 709 |
| Peak day | 2026-04-11 — **322 commits** (multi-branch merge storm) |
| Public on GitHub | 2026-03-17 |
| Tool count trajectory | 22 → 31 → 33 → 35 → 36 → 39 → 44 → 48 → 63 → 64 → 66 → 172 → **146** (after consolidation) |
| Latest release | v0.5.24 (2026-04-20) |
| License | MIT → **BSL-1.1** (changed 2026-03-28) |
| Competitive neighbours | jCodeMunch, Serena, codedb (Zig), codesight-mcp, cbm-mcp, SocratiCode |

## Timeline

### Week 1 — Foundation (Mar 13 – Mar 17)

#### 2026-03-13 — Bootstrap (5 commits)
The project is born. Phases 0–2 land in a single commit (MCP server skeleton + tree-sitter extraction + BM25 index), followed the same day by Phase 3 (semantic search with hybrid RRF ranking) and Phase 4 (`index_repo`, README, npm publish prep). First review round (R-1 through R-6) lands before the day ends.

#### 2026-03-14 — CLI and benchmarks (6 commits)
CLI is split out of a 834-line monolith into `args` / `help` / `commands` modules. First benchmark document lands: **CodeSift vs Bash grep vs Auggie** across tasks R26–R37. Test-file exclusion from semantic search ships.

#### 2026-03-15 — Refactor + auto-group (10 commits)
`search_text` gains `group_by_file` mode (68–86% output reduction) and `auto_group`. Shared utilities extracted from `codebase-retrieval.ts` (517→392 lines). Zod validation and fetch timeouts hardened. 35 new tests for the TypeScript symbol extractor.

#### 2026-03-16 — Analysis suite v1 (13 commits)
**10 new analysis tools** land. `impact_analysis` and `knowledge_map` caps added. `graph-tools.ts` splits into `graph` + `impact`. `server.ts` moves to data-driven tool registration. First full T1–T18 benchmark run (baseline R42/R43). Tool count: **22 → 31**.

#### 2026-03-17 — Public repo, response caps (9 commits)
Repo goes public on GitHub. Heavy day of response-size guards: `get_file_tree` cap 500, `search_symbols` bloat reduction, grouped-output `first_match` cap, in-flight dedup for parallel identical calls. Glob brace expansion support added.

### Week 2 — Language support & discoverability (Mar 18 – Mar 23)

#### 2026-03-18 — Memory + crash fixes (4 commits)
Embeddings switch from giant in-memory strings to disk streaming. Watcher becomes lazy-start. `find_references` noise filter added.

#### 2026-03-19 — Astro, tokens, incremental index (14 commits)
**`.astro` language support** lands. `search_symbols` gains `token_budget` and `detail_level` (compact/standard/full). `index_file` tool (instant single-file reindex). **mtime-based incremental indexing**. Centrality bonus added to BM25. New tool: `suggest_queries`. Tool count → **33**.

#### 2026-03-20 — Communities, routes, compression (6 commits)
Two flagship tools land: **`detect_communities`** (Louvain) and **`trace_route`** (HTTP → handler → service → DB). Dirty propagation (mark callers stale on signature change). Multi-level context compression L0–L3 for `assemble_context`.

#### 2026-03-21 – 2026-03-23 — Quiet hardening (7 commits over 3 days)
Bug fixes for partial-index overwrites, embedding fire-and-forget to prevent MCP timeouts, `search_text` using the indexed file list with a 30s hard timeout, batch `find_references`.

### Week 3 — LSP, dashboard, conversation search (Mar 25 – Mar 31)

#### 2026-03-25 — Visuals + 10 quality features (15 commits)
**HTML report export** (standalone browser report). **Mermaid diagrams** for `trace_route`, `get_knowledge_map`, `detect_communities`. Semantic chunking by symbol boundaries. Framework-aware dead code (React / NestJS / Next.js entry-point whitelist). `include_diff` on `changed_symbols`.

#### 2026-03-26 — LSP bridge (15 commits)
**LSP bridge ships**: JSON-RPC stdio client, server config registry (6 language servers), session manager with lazy-start and 5-min idle kill. New tools: `go_to_definition`, `find_references` (LSP upgraded), `get_type_info`, `rename_symbol`. First dashboard design spec lands (4 tabs + badge API). Tool count → **39**.

#### 2026-03-27 — Dashboard v1.1 + git freshness (4 commits)
6 new analysis CLI commands. **Git-based auto-refresh** — transparent index freshness check.

#### 2026-03-28 — Conversation search + secrets (20 commits)
Two major features: **conversation search** (index Claude Code chat histories with hybrid + cross-project semantic search) and **`scan_secrets`** (~1,100 AST-aware rules). `setup` command for automated MCP configuration. **License changes from MIT to BSL-1.1**. Tool count → **44**.

#### 2026-03-29 — Architecture tools (9 commits)
New tools: **`check_boundaries`** (architecture enforcement), **`ast_query`** (structural grep via tree-sitter query language), **`classify_roles`** (hub/leaf/bridge via call graph). Cross-encoder reranking added as optional 3rd search-pipeline stage.

#### 2026-03-30 — Performance day (13 commits)
**CodeSift vs jCodeMunch** head-to-head benchmark published. Ripgrep backend. Compact text output. Unified combo benchmark (13 real tool sequences from usage data). Final optimizations: `file_tree` cap 250, `changed_symbols` cap 5/file. Tool count → **48**.

#### 2026-03-31 — `review_diff` feature (19 commits)
Full `review_diff` tool lands — a composite PR-review runner: blast-radius, secrets, dead-code, bug-patterns, hotspots, complexity, co-change (Jaccard), breaking-change (export diff), test-gap detection. Integration smoke test with a real git repo.

### Week 4 — Token optimization + sessions (Apr 2 – Apr 10)

#### 2026-04-02 — Claude Code inspiration (2 commits)
Six MCP improvements inspired by analyzing the Claude Code source.

#### 2026-04-03 — Token optimization (8 commits)
New tools: `semantic_search`, `find_circular_deps`, `find_unused_imports`. **H1–H9 hint-code system** (compact symbol codes for response nudges). Parallel I/O, binary-search RRF, LSP timeouts. **~7–15k tokens/session saved**.

#### 2026-04-04 — Reliability fixes (4 commits)
Stream-error races, tmp collisions, circular deps in graph cache fixed. 7 more token-reduction techniques land.

#### 2026-04-05 — Ranked mode + progressive cascade (15 commits)
`search_text` ranked mode ships (classify hits by containing function → dedupe max 2/function → rank by centrality). **Progressive response shortening** (>52.5K compact / >87.5K counts / >105K truncate). `describe_tools` meta-tool for on-demand schema retrieval. Non-core tools hidden from ListTools. **Hooks system**: `precheck-read`, `postindex-file`.

#### 2026-04-06 — v0.2.0 release day (26 commits — the biggest day so far)
Back-to-back releases **v0.2.0, v0.2.1, v0.2.2, v0.2.3**. Features: MCP `instructions` field for all clients (CODESIFT_INSTRUCTIONS). Platform rules distribution: `rules/codesift.md` / `.mdc` / `codex.md` / `gemini.md`. Gemini CLI platform + `setup-all` command. Postinstall setup message. Version tracking.

#### 2026-04-07 — Isolation fixes (3 commits)
`boundary-tools` tests get own `CODESIFT_DATA_DIR`, JSON string coercion for `check_boundaries` rules, test-usage isolation.

#### 2026-04-08 — Session-aware context (17 commits) — **v0.2.4, v0.2.5**
Huge session infrastructure lands: session-state module, `recordToolCall` extraction, negative evidence with TTL + watcher invalidation, LRU + stale-first eviction, sidecar file atomic writes, `formatSnapshot` with priority-tiered 700-char budget, `getContext` JSON endpoint. New MCP tools: session snapshot + context. **`PreCompact` hook** for context-compaction survival. `wrapTool` integrated. H10 hint code (50+ tool calls → snapshot). Auto-index current repo on startup.

#### 2026-04-09 — Project profiling + NestJS (17 commits) — **v0.2.6–v0.2.9**
**`analyze_project`** and **`get_extractor_versions`** ship. Stack detector scans workspace `package.json` in monorepos. **CWD auto-resolve for `repo` param** — eliminates mandatory `list_repos`. NestJS extractor. Next.js / Express / React / Python / PHP convention extractors. `precheck-bash` hook redirects `find`/`grep` to CodeSift in sub-agents. Tool count → **66**.

#### 2026-04-10 — Yii2 + core promotion (8 commits)
21 direct-use tools promoted to core (14 → 35 visible). Yii2 framework detection. Phase 1B for `analyze_project`: identity + dependency graph + test conventions + known gotchas. Next.js extractor detects API routes, services, Inngest, webhooks.

### Week 5 — The framework wave (Apr 11 – Apr 12)

#### 2026-04-11 — THE MEGA DAY (322 commits)
The single largest day in the project's history, driven by merging **multiple parallel feature branches** (`feat/nestjs-wave3`, `feat/hono-phase-2`, `feat/hono-polish`, `feat/php-polish`, `feat/sql-consolidation`, `worktree-python-phase-2-4`) into main, each carrying its own wave of commits.

Headline landings:
- **Hono Phase 2** (6 new tools, later consolidated 13 → 11): `trace_conditional_middleware`, `analyze_inline_handler`, `extract_response_types`, `detect_middleware_env_regression`, `detect_hono_modules`, `find_dead_hono_routes` — real-project validation on `honojs/examples/blog`.
- **Kotlin Wave 3**: `trace_compose_tree`, `analyze_compose_recomposition`, `trace_room_schema`, `extract_kotlin_serialization_contract`, `trace_flow_chain` + 3 Compose anti-patterns.
- **NestJS Wave 3**: 4 tools (pipeline/queue/scope/openapi) + 15 nestjs-doctor parity anti-patterns.
- **SQL consolidation**: `search_columns`, `analyze_schema_drift`, `lint_schema`, `scan_dml_safety`, `diff_migrations`, `find_orphan_tables`, `analyze_schema_complexity`.
- **Astro Wave 2**: content collections, actions audit, migration check, `astro_audit` meta-tool, 6 new anti-patterns, bundle-size heuristics.
- **Python**: `python_audit` composite, `analyze_async_correctness`, `trace_fastapi_depends`, `get_pydantic_models`, Python security tracing primitives. 13 Python tools registered + language gating.
- **PHP/Yii2 polish**: god-model detector, N+1 detection through getter chains, `@property`/`@method` synthesis for interfaces and traits.
- **React**: `react_quickstart` composite, `useEffect-missing-deps` pattern, 2 oxlint-inspired patterns (REACT_ONLY_PATTERNS → 22).
- **Next.js**: `framework_audit` priority mode, signal_locations with `file:line`, auto-enable 7 hidden Next.js tools when `next` dep detected.
- **Dep-audit suite**: `dependency_audit` + `migration_lint` + `analyze_prisma_schema`.
- **0.4.0 released**.

#### 2026-04-12 — Consolidation + `plan_turn` (40 commits)
**v0.5.0: Phase 1 tool consolidation — 172 → 146 tools** (absorb 26 hidden sub-tools into meta-tools with `checks=` params). **`plan_turn`** ships over Tasks 1–12: 5-signal WRR ranker (lexical / identity / semantic / structural / framework), query parser, formatter, 30-query benchmark. Hono further consolidated 13 → 11. Next.js split into reader + orchestrator. Rapid-fire patches v0.5.1 → v0.5.7 for GUI-app repo resolution (Antigravity, Claude Desktop), lazy-loaded tool handlers, deferred hidden-tool schemas, version exposed in MCP server info.

### Week 6 — Wiki + Lens (Apr 15 – Apr 17)

#### 2026-04-15 — Wiki pipeline + plan_turn tuning (16 commits) — **v0.5.8**
**Wiki generator built**: surprise scoring algorithm for cross-community connections, markdown/HTML escape utils, 6 page-generator templates, two-pass link resolution with backlink injection, manifest builder with file-to-community mapping, wiki lint for broken links and stale references. `plan_turn` tuned (W_STRUCTURAL 0.4 → 0.1 to cut popularity bias). New hints H12, H13 (route), H14 (secrets). H9 now auto-reveals `semantic_search`. `index_folder` auto-loads framework tools. `review_diff` + `scan_secrets` promoted to core.

#### 2026-04-16 — Wiki CLI + Lens dashboard (7 commits)
**`generate_wiki` registered as an MCP tool**. `wiki-generate` + `wiki-lint` CLI commands. **Lens HTML dashboard** with D3 chord diagram and tabs. Wiki safety guards: path validation, lockfile, atomic write. `handlePrecheckRead` extended with wiki context injection.

#### 2026-04-17 — Wiki review pass (10 commits) — **v0.5.9, v0.5.10, v0.5.11**
`precheck-glob` and `precheck-grep` hooks (redirect native tools). Explore sub-agent blocked for code search. 12 review findings + 6 follow-up findings across wiki/lens fixed. Wiki & Lens docs added to README. Wiki page descriptions and community naming improved.

### Week 7 — Ecosystem polish (Apr 19 – Apr 20)

#### 2026-04-19 — Adoption revert (3 commits) — **v0.5.12, v0.5.13**
Reverted rules rewording from PREFER to NEVER/CRITICAL after it **degraded tool adoption**. A feedback entry was saved about this regression — see `feedback-subagent-codesift.md` in memory.

#### 2026-04-20 — Wiki v2 + final adoption fix (42 commits)
The latest wave, happening as this history is written. Two threads:

1. **Wiki v2 design and build** (approved in spec 2026-04-20):
   - `is_exported` flag added to `CodeSymbol`, TypeScript extractor bumped to 2.0.0 with ancestor + modifier + default-export detection.
   - Wiki manifest v2 with JSON schema + lens_data import-graph edges.
   - `buildFilePageRank` utility + `graphology` + `graphology-metrics` deps.
   - `wiki-hub-ranker` uses PageRank + builtin-method blocklist (fixes builtin-name contamination in hub detection).
   - `wiki-page-generators` produce rich v2 pages + overview + architecture.
   - Wiki v2 orchestrator wired with `CODESIFT_WIKI_V1` env / `--v1` rollback.
   - End-to-end integration test on ts-monorepo fixture + fixture repos for python-fastapi and go-module.
2. **Adoption firefight** (v0.5.14 → v0.5.24, ten rapid releases):
   - `SessionStart` gate + `initial_instructions` Serena-style onboarding tool.
   - Agent gate + CLAUDE.md inject + JSON `permissionDecision` format.
   - **Reverted v0.5.18 long instructions block** after it broke agent adoption again (>90% drop).
   - Bulletproof-install iterations (postinstall auto-setup → `--prefer-online` → cache-clean).
   - Agent instructed to use `get_file_outline`/`get_symbol` instead of `Read` for code files, and to call `ToolSearch` first for deferred MCP tools.
   - **`npm audit fix`**: patched critical `protobufjs` + moderate `hono` vulnerabilities and resolved all 8 flagged issues.

## Themes across the project

Reading the 709 commits as a whole, the project moves through five recurring currents:

1. **Tool breadth → tool depth → tool consolidation.** The count climbed from 22 to 172, then deliberately contracted to 146 via meta-tool `checks=` params. Growth was never the goal; useful surface area was.
2. **Token-cost obsession.** Compact formats, progressive cascade, hint codes H1–H14, ranked dedup, deferred schemas, `detail_level`, `token_budget`, L0–L3 context levels. Every week has at least one commit explicitly shaving tokens.
3. **Adoption engineering.** Six commits are literally reverts of previous "improvements" that hurt agent adoption. The project treats agent-visible rules wording, subagent gates, and hook format with production-incident seriousness.
4. **Framework-specific intelligence as a moat.** Hono (11), Python (13), Kotlin (waves 2–3), NestJS (14 via `nest_audit`), Next.js, Astro, PHP/Yii2, SQL, React. Each framework wave lands with real-project validation against a public reference repo.
5. **Research-driven.** Benchmarks vs Bash grep, Auggie, jCodeMunch. Claude Code source analysis. Serena comparison. Conversation memory notes competitive updates across four dates (2026-04-05, 04-07, 04-08, 04-15).

## Competitive context (internet research)

The code-intelligence MCP space as of April 2026 is crowded but differentiated:

| Project | Scope | Notes |
| --- | --- | --- |
| **Serena** | General MCP code intel | ~22.5K★, the de-facto leader for general agents. |
| **jCodeMunch** | GitHub source-exploration MCP | ~1.5K★ (doubled in April). Voice features. Direct benchmark target for CodeSift. |
| **cbm-mcp** | Zero-config semantic | ~1.5K★ (doubled in April). |
| **SocratiCode** | Enterprise, branch-aware | ~888★. Enterprise segment. |
| **codedb** (justrach) | Zig-based, 16 tools | 606★. No semantic search. Different segment. |
| **codesight-mcp** | Tree-sitter, 34 tools, 66 languages | Closest name collision. |
| **tree-sitter-mcp** / **mcp-server-tree-sitter** | Generic tree-sitter wrappers | Lower-level. |
| **Axon / Codegraph / Augment / Chisel / YoYo / mcp-compressor** | Various graph/compression angles | Graph-heavy segment is dominant. |

CodeSift's bets: **per-language deep intelligence + hybrid BM25F + semantic + LSP + conversation memory + `plan_turn` tool routing**. Semantic search is still ~0% adoption in the competitive set — an open lane.

## Sources

- `git log --all` (709 commits, 2026-03-13 → 2026-04-20)
- GitHub: `https://github.com/greglas75/codesift` (created 2026-03-17, TypeScript, 4★, BSL-1.1)
- npm package `codesift-mcp` (published via `npm publish --ignore-scripts`)
- Memory files: `jcodemunch-competitive.md`, `competitive-update-2026-04-{07,08,15}.md`, `codedb-analysis.md`, `competitor-tools-deep-dive.md`, `wiki-v2-spec.md`, `session-aware-context.md`, `review-diff-feature.md`, `conversation-search.md`, `benchmark-v2-results.md`, `feedback-auto-execute.md`
- Web search: [codesight-mcp](https://github.com/cmillstead/codesight-mcp), [tree-sitter-mcp](https://github.com/nendotools/tree-sitter-mcp), [jcodemunch-mcp](https://github.com/jgravelle/jcodemunch-mcp), [codedb](https://github.com/justrach/codedb), [mcp-server-tree-sitter](https://github.com/wrale/mcp-server-tree-sitter)
