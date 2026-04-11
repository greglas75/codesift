# Changelog

## [0.3.0] — 2026-04-11

Major release: 66 → 72 tools, 5 new language parsers, composite audit tool, agent UX improvements.

### New Language Support

- **Kotlin** — Full tree-sitter parser + symbol extractor. Classes, functions, properties, objects, interfaces, companion objects, data classes, sealed classes. Kotlin import graph for `find_references` and `trace_call_chain`. 6 Kotlin-specific anti-patterns (`search_patterns`): `runblocking-main`, `global-scope-launch`, `mutable-state-flow-expose`, `uncancellable-coroutine`, `blocking-in-suspend`, `lateinit-primitive`. Ktor + Spring Boot route tracing via `trace_route`.
- **PHP/Yii2** — Full PHP extractor with Yii2 framework conventions. 7 PHP-specific tools for active record patterns, RBAC, migrations, events, and module analysis.
- **React** — JSX-aware call graph, component/hook symbol kinds. 14 React anti-patterns. `trace_component_tree` and `analyze_hooks` tools. Context bundle, suggest_queries, and entry point detection for React projects.
- **Hono** — HonoExtractor with tree-sitter scaffold, route detection, subapp route flattening, multi-file import resolution. Middleware chain extraction, rate limit detection.
- **Python** — Full Python extractor with async def, @dataclass, @property, @classmethod, @staticmethod, @abstractmethod, dunder methods, module constants, `__all__` exports, superclasses, nested class walk.
- **Text stub indexing** — 14 extensions (.kt, .kts, .swift, .dart, .scala, .clj, .cljs, .ex, .exs, .lua, .zig, .nim, .gradle, .sbt) now indexed as FileEntry without symbol extraction. `get_file_tree` and `search_text` work on these files. Previously the walker skipped them entirely.

### New Tools (6 → 72 total)

- **`audit_scan`** — Composite tool running `find_dead_code` + `search_patterns` + `find_clones` + `analyze_complexity` in parallel. Returns findings keyed by CQ gate (CQ8, CQ11, CQ13, CQ14, CQ17). One call replaces 5+ sequential tool calls, saving ~30K tokens per audit.
- **`trace_component_tree`** — Trace React component hierarchy from a root component.
- **`analyze_hooks`** — Analyze React hook usage patterns, dependencies, and anti-patterns.
- **`index_status`** — Confirm CWD is indexed without full `list_repos` overhead.
- **`find_perf_hotspots`** — Composite performance pattern scanner (findMany without take, Promise.all without pLimit, *Sync in handlers, .find() in loops).
- **`fan_in_fan_out`** — Import graph in-degree/out-degree analysis with top-N ranking.

### Agent UX Improvements

- **H11 hint code** — When symbol tools return empty results on repos where >30% of files lack a parser (Kotlin/Swift/Dart/etc.), agents now get an explicit hint: "No parser for .kt files → use search_text instead." Eliminates 3-5 wasted tool calls per session.
- **`list_repos(name_contains=)`** — Filter 278 repos down to matching subset. Saves ~8K tokens per session for users with many indexed repos.
- **`get_extractor_versions` structured output** — Returns `parser_languages`, `text_stub_languages`, `profile_frameworks` with explicit note that text tools work on ALL files. Prevents agents from incorrectly concluding CodeSift is useless for unsupported languages.
- **Core tools 14 → 36** — Usage analysis of 5,136 calls across 354 sessions showed 21 hidden tools called directly without discovery in 86% of sessions. Promoted based on actual agent usage data.

### Codex CLI

- **PreToolUse hook** — `codesift setup codex --hooks` now installs PreToolUse hook for Bash tool, redirecting `find`/`grep`/`rg` commands to CodeSift MCP tools. Previously only Stop (conversation indexing) was installed. Codex confirmed to support PreToolUse/PostToolUse for Bash (via stdin, like Gemini).

### Project Profile (`analyze_project`)

- **Phase 1B** — Added identity, dependency_graph, test_conventions, known_gotchas sections.
- **dependency_health + git_health** — Detect outdated deps, missing lockfiles, git velocity.
- **Framework extractors** — NestJS, Next.js, Express, React, Python, PHP, Hono, Yii2 convention extraction.
- **Monorepo support** — Stack detector scans workspace `package.json` in monorepos.
- **Promoted to core** — `analyze_project` and `get_extractor_versions` always visible in ListTools.

### Refactoring

- **hooks.ts** — Consolidated 3 `extractFilePath`/`extractSessionId`/`extractCommand` functions into single `parseHookInput()`. JSON parsed once instead of 3× per hook call. `Object.freeze` on shared empty result. Null-check guards for behavioral equivalence.

### Bug Fixes

- `get_extractor_versions` no longer returns a flat list that agents misinterpret as "supported languages" — now structured with clear separation of parser vs profile extractors.
- Next.js extractor detects API routes, services, Inngest functions, webhooks.
- Compact output tier uses top 30 + aggregates instead of full list.
- Dedup per-path middleware + resolve `imported_from` via import map.
- TS strict mode errors resolved in project-tools.

### Breaking Changes

- `get_extractor_versions` return type changed from `Record<string, string>` to structured `ExtractorVersionsResponse`. Legacy `versions` field preserved for backward compat.
- Core tool count changed from 14 to 36 — affects `instructions.ts` and all rules files.

<!-- Evidence Map
| Section | Source file(s) |
|---------|---------------|
| Kotlin parser | src/parser/extractors/kotlin.ts, src/parser/parser-manager.ts:39 |
| PHP/Yii2 | src/parser/extractors/php.ts, src/tools/project-tools.ts |
| React | src/parser/extractors/react.ts, src/tools/react-tools.ts |
| Hono | src/parser/extractors/hono.ts |
| Python | src/parser/extractors/python.ts |
| Text stub | src/parser/parser-manager.ts:34-50, src/tools/index-tools.ts:63 |
| audit_scan | src/tools/audit-tools.ts |
| H11 hint | src/register-tools.ts:56-87 |
| list_repos filter | src/tools/index-tools.ts:651-662 |
| get_extractor_versions | src/tools/project-tools.ts:1897-1954 |
| Core tools 14→36 | src/register-tools.ts:178-220 |
| Codex hooks | src/cli/setup.ts:386-411 |
| hooks.ts refactor | src/cli/hooks.ts:39-110 |
| Project profile | src/tools/project-tools.ts |
-->
