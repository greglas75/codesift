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

Non-core tools are **hidden** from ListTools (via SDK `disable()`). Only 47 core tools are visible.
To find hidden tools: `discover_tools(query="dead code")` → keyword search.
To get full schema: `describe_tools(names=["find_dead_code"])` → returns params with types.
To reveal in ListTools: `describe_tools(names=["find_dead_code"], reveal=true)`.

### Framework tool auto-loading (NEW)
Framework-specific tools are auto-enabled at startup when a signal file is detected at CWD:
- `composer.json` → enables 7 PHP/Yii2 tools (resolve_php_namespace, analyze_activerecord,
  trace_php_event, find_php_views, resolve_php_service, php_security_scan, php_project_audit)
- `build.gradle.kts` / `settings.gradle.kts` / `build.gradle` → enables 5 Kotlin tools
  (find_extension_functions, analyze_sealed_hierarchy, trace_hilt_graph,
  trace_suspend_chain, analyze_kmp_declarations)
- `package.json` with `react`/`next`/`@remix-run/react` dep + `.tsx` files present →
  enables React tools (trace_component_tree, analyze_hooks, analyze_renders)
- `package.json` with `hono` / `@hono/zod-openapi` / `@hono/node-server` / `hono-openapi` /
  `chanfana` dep → enables 5 hidden Hono tools (trace_context_flow, extract_api_contract,
  trace_rpc_types, audit_hono_security, visualize_hono_routes). The 2 core Hono tools
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
   grep -rn "127 tools\|127 MCP" src/ ../codesift-website/src/
   ```

## Architecture

**127 MCP tools** (47 core + 80 discoverable) | tree-sitter AST + BM25F + semantic search + LSP bridge + conversation search + secret detection + session-aware context + **Next.js Tier-1 intelligence** (server/client classifier with `suggested_fix`, route map with `rendering_reason`, metadata audit, server actions security audit, API contract extraction, client boundary analyzer, link integrity, data flow / waterfall detection, middleware coverage, plus `framework_audit` meta-tool) + **NestJS intelligence** (Wave 1: lifecycle/module/DI/guard/route tools + `nest_audit` meta; Wave 2: GraphQL resolvers, WebSocket gateways, schedule/@OnEvent, TypeORM entities, microservice patterns; middleware-aware auth chain, generic-unwrapped DI graph) + Hono framework intelligence + **PHP/Yii2 intelligence** (PSR-4 cross-file edges, PHPDoc @property/@method synthesis, N+1 query detector, god-model detector, parser error recovery, backup file exclusion) + **Kotlin Wave 2** (Kotest DSL detection, Gradle KTS structured config, Hilt DI graph `trace_hilt_graph`, coroutine chain `trace_suspend_chain`, KMP expect/actual `analyze_kmp_declarations`, per-language cache version invalidation)

**src/tools/** (36 files) — MCP tool handlers + search-ranker.ts (4-phase ranked pipeline). Includes: coupling-tools.ts (fan_in_fan_out, co_change_analysis, shared computeCoChangePairs), perf-tools.ts (6 perf anti-pattern scanners with balanced-brace loop body extraction), architecture-tools.ts (composite: communities + coupling + circular deps + LOC + entry points), query-tools.ts (Prisma→SQL explain), status-tools.ts (index status check), audit-tools.ts (5-gate composite), review-diff-tools.ts (10-check composite), php-tools.ts (9 PHP/Yii2 tools including find_php_n_plus_one, find_php_god_model), react-tools.ts (React component/hook conventions), nest-tools.ts (6 Wave 1 NestJS tools + nest_audit core meta), nest-ext-tools.ts (5 Wave 2 NestJS tools).
**src/lsp/** (4 files) — LSP bridge (6 languages)
**src/parser/extractors/** (15 files) — Language extractors (TS, JS, **Python (full)**, Go, Rust, Prisma, MD, Astro, Conversation, **Kotlin** (with Kotest DSL + KMP expect/actual + @Annotation surfacing), **gradle-kts** (structured plugins/dependencies/config extraction for `*.gradle.kts`), **PHP**, **Hono**, _shared). Python extractor handles async def, @dataclass/@property/@classmethod/@staticmethod/@abstractmethod, dunder methods (tagged via meta), module constants, __all__ exports, superclasses (via extends field), dataclass fields, nested class walk, iterative walk with depth cap 200.
**src/storage/** (10 files) — Index persistence, embeddings, usage tracker, watcher, session-state (compaction survival), **per-language `extractor_version` cache invalidation** (mismatch vs current EXTRACTOR_VERSIONS forces reindex so schema bumps don't leave stale symbols behind)
**src/retrieval/** (5 files) — codebase_retrieval batch engine, semantic/hybrid search
**src/search/** (5 files) — BM25F index with centrality bonus, semantic embeddings, chunker
**src/utils/** (8 files) — Import graph (TS/JS/PHP/Kotlin/**Python**), glob, walk, git validation; python-imports.ts (tree-sitter AST extraction) + python-import-resolver.ts (package-aware resolution with `src/` layout detection)
**src/cli/** (5 files) — CLI commands + hooks.ts (PreToolUse/PostToolUse/PreCompact)
**src/formatters-shortening.ts** — Compact/counts formatters for progressive cascade
**src/instructions.ts** — CODESIFT_INSTRUCTIONS (~800 tok) sent via MCP instructions field
**rules/** — Platform-specific rules (claude.md, cursor.mdc, codex.md, gemini.md)
**tests/** — 1337+ tests (Vitest)
