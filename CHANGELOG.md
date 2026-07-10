# Changelog

## Unreleased

### Changed

- Split Kotlin analysis tools into capability modules for extensions, sealed
  hierarchies, suspend chains, multiplatform declarations, and Flow chains,
  behind the existing `kotlin-tools.ts` compatibility facade.
- Split `plan_turn` parsing, ranking, framework context, stale-index checks,
  and formatting into focused modules behind the existing compatibility facade.
- Split `analyze_project` profile generation out of `src/tools/project-tools.ts`
  into focused project-profile modules, keeping `project-tools.ts` as the thin
  orchestration layer and removing its static `index-tools` import cycle.
- Split the built-in pattern registry out of `src/tools/pattern-tools.ts`,
  keeping `pattern-tools.ts` as the search engine/facade with compatible
  `BUILTIN_PATTERNS`, `searchPatterns`, and `listPatterns` exports.
- Split the PHP/Yii implementation file into per-tool modules while keeping
  `src/tools/php-tools.ts` as the compatibility facade for existing callers.

### Fixed

- Hardened Kotlin analysis for regex metacharacters and braces in sealed
  hierarchies, concurrent file scanning, suspend overload and uppercase-callee
  traversal, nested cancellation checks, depth validation, and spaced
  `stateIn` calls.
- Hardened `plan_turn` query/result limits, punctuation and case-sensitive
  parsing, repository-scoped framework detection, query-bounded index lookup
  allocations, usage cache expiry, and monorepo tool deduplication.
- Bounded search result/context limits, removed identifier-search shortlist
  false negatives, made ripgrep execution cancellable with JSON-safe path
  parsing, and preserved ranked/timeout result shapes across output modes.
- Hardened project profile extraction around root entrypoints, Python
  `pyproject.toml` detection, Hono source precedence, importer counting, git
  remote sanitization, and atomic profile writes.

## [0.7.0] — 2026-05-08

### PHP/Yii2 deep intelligence — 10 new tools + extractor v2.0.0

> Note: v0.6.0 (React Tier 6+7+8) shipped earlier the same day from a
> separate branch; this PHP/Yii2 release bumps minor to 0.7.0 alongside.

Closes the PHP/Yii2 gap analysis (`docs/specs/2026-05-05-php-yii2-gap-analysis.md`).
Validated end-to-end on real production tgm-panel codebase (1979 files, 13104
symbols) — full 12-tool audit completes in 4.48 seconds. See
`docs/specs/2026-05-07-tgm-panel-smoke.md` for the headline numbers.

#### Added

**10 new MCP tools** auto-loaded under `composer.json` detection:

- `yii3_migration_audit` — decision-support tool inventorying Yii2-API usage
  across 21 categories (service-locator, ActiveRecord, Module, RBAC, …) with
  effort estimate + decision_signal (stay-on-yii2 / consider-yii3 /
  high-effort-yii3 / blocked).
- `php8_compat_check` — pre-merge gating tool for PHP 7→8 upgrade. 13 rules
  across breaking_8_0 / deprecated_8_1 / deprecated_8_2 buckets. Detects Yii2
  < 2.0.49 + PHP 8 incompatibility automatically.
- `find_php8_migration_candidates` — post-merge modernization helper. 6 rule
  classes: promotable-ctor, docblock-to-typed-property, nullable-flag-to-syntax,
  readonly-candidate, enum-from-class-consts, match-from-switch.
- `find_yii3_attribute_candidates` — Yii2→Yii3 array-config → attribute
  conversion. behaviors-to-attributes, rules-to-attributes (with validator
  → attribute name mapping), urlmanager-rule-to-route.
- `analyze_yii_modules` — module inventory with controllerNamespace,
  controllers, views, migrations, sub-modules, URL prefixes resolved from
  urlManager rules.
- `analyze_yii_migrations` — Yii2 PHP-DSL migration parser (createTable,
  alterColumn, addForeignKey, …). 4 audit rules: missing-safe-down,
  alter-without-online-ddl (the tgm-panel db-audit DB6-001 finding),
  fk-without-index, raw-sql-without-comment.
- `analyze_yii_rbac` — permission graph audit. Cross-references definitions
  (createPermission/createRole in seed migrations) against runtime checks
  (Yii::$app->user->can + AccessControl behaviors). Surfaces orphan_checks,
  unused_definitions, controllers_without_access_control, dynamic_creates.
- `analyze_yii_console_commands` — console controller inventory with typed
  argument list, variadic flag, and 4 risk flags (exits-without-return-status,
  has-unbounded-all, has-no-error-handling, uses-output-via-echo).
- `analyze_phpstan_baseline` — universal PHPStan baseline triage. Parses
  `phpstan-baseline.neon`, ranks by_path, by_category, surfaces quick_wins
  (≤3 errors per file).

**12 new security patterns** added to `php_security_scan` (8 → 20 total):

- `yii-csrf-disabled`, `yii-debug-mode-prod`, `yii-cookie-no-validation`,
  `yii-mass-assignment-unsafe`, `yii-raw-sql-where`, `yii-no-row-level-locking`,
  `yii-config-hardcoded-secret`, `yii-unbounded-all`, `yii-rbac-cached-permission`,
  `php-md5-password`, `php-rand-token`, `php-loose-comparison-secret`.
- File-level scanning path added (`runFileLevelChecks`) for patterns that
  match at module level — entry-point files (`web/index.php` with
  `define('YII_DEBUG', true)`) and config arrays (`return [...]`) are now
  visible to the scanner.

**5 new performance patterns** in `yii_performance` gate of `php_project_audit`:

- `yii-translate-in-loop`, `yii-dbtarget-info-level`,
  `yii-find-with-large-then-filter`, `yii-cache-no-ttl`,
  `yii-no-batch-on-large`. Sourced from tgm-panel performance-audit findings.

#### Changed

**Extractor v2.0.0 (`src/parser/extractors/php.ts`)** — bumped from 1.0.0 to
2.0.0, forces full reindex of all PHP files. Adds:

- `extends`, `implements`, `meta.uses_traits` on classes/interfaces/traits.
- `meta.modifiers`: visibility, is_static, is_abstract, is_final, is_readonly.
- `meta.attributes`: PHP 8.0+ `#[Attribute]` list with raw arg strings.
- `meta.type` + `meta.type_source: "inline" | "phpdoc"` on properties — PHP
  7.4+ typed properties OR `@var T` from leading docblock as fallback.
- Promoted constructor params (PHP 8.0+) emitted as synthetic `field` symbols
  with `meta.from_constructor: true`.
- Backed enum types (PHP 8.1+) captured in `meta.backed_type`.
- Codeception base classes (Unit, Cest, Cept) classify as `test_suite` along
  with PHPUnit's TestCase.

**`analyzeActiveRecord`** — uses structural `extends` graph with cycle
protection + depth cap, falls back to source regex for stale indexes. Detects
transitive AR (e.g. `User extends BaseUser` with aliased import of dektrium AR).

**`findPhpNPlusOne`** — adds Pattern 4 (explicit `Model::findOne($id)` /
`Model::findAll(...)` inside foreach body, with whitelist for
Yii::createObject / ArrayHelper / self / static) and Pattern 5 (file-level
scan over `views/**/*.php` + `widgets/` + `layouts/`).

**`tracePhpEvent`** — class-const event-name resolution. `Event::on(User::class,
User::EVENT_AFTER_LOGIN, …)` now resolves to the const's literal value via
a pre-pass that walks all `constant` symbols under PHP classes.

**`resolvePhpService`** — module-scoped components, DI container singletons
+ definitions, closure factories, `Yii::$container->set()`. Bracket-balanced
forward-walking parser identifies the exact nesting (`module:<id>` /
`container.singletons` / `container.definitions` / `factory` / `components`).
Per-env `*-local.php` config files merged into the result.

**`find_php_views`** — render-kind tagging (full / partial / ajax / json /
file), `path_alias` field for `@app/...`-style references, `$this->layout`
assignments (controller-wide property + per-action override) captured as
`layouts[]`, widget references via `Widget::begin/widget` calls collected in
`widgets[]`, `AssetBundle::register($this)` call sites in `asset_bundles[]`.

#### Fixed

- Extractor's `extends` was missing on PHP class symbols, forcing every
  downstream tool to fall back to brittle source-text regex.
  Confirmed against tgm-panel: `User extends BaseUser` (aliased import of
  `dektrium\\user\\models\\User`) was previously not classified as AR.
- `analyzeActiveRecord`'s behaviors detection used unbounded
  `[A-Z]\w+Behavior` regex picking up references in comments. Now scopes
  to the `behaviors()` method body.

#### Tests

- 21 new test files (~280 new tests) covering every new tool.
- 502 PHP+pattern tests pass sequentially.
- All test fixtures shaped after real Yii2 idioms found in tgm-panel
  (Mobi 2 patterns: 11 modules, 379 migrations, dektrium/yii2-rbac, etc.).

#### Known recommendations (from cross-provider review — non-blocking)

- `phpstan-baseline-tools.ts:81` accepts a user-controlled `baseline_path`
  argument and passes it to `readFile()` without a path-traversal guard.
  Low impact for local-dev MCP, medium for hosted multi-tenant. Two-line
  fix: resolve path, ensure `result.startsWith(index.root + sep)`.
- `php8-compat-tools.ts:189` `VENDOR_RE` omits `tests/_data` (other 5 tools
  include it) — minor inconsistency.
- Smoke report (`docs/specs/2026-05-07-tgm-panel-smoke.md`) declares
  "successfully" while same artifact contains stale stderr OpenAI errors
  — cosmetic, harden the smoke driver to redirect stderr separately.

## [0.6.0] — 2026-05-09 — React Tier 6+7+8

Three-tier React static-analysis upgrade. Pattern count goes from 34 → 43 with
engine-level comment/string preprocessing and proper cross-file Suspense walking.

### Added
- **Tier 8 — engine preprocessing.** New `src/utils/source-stripper.ts` (single-pass
  7-state machine) strips comments, string/template/regex literals before regex
  match while preserving character positions. New `preprocess: "strip-comments-strings"`
  declarative field on `BUILTIN_PATTERNS` entries — opted in for `dangerously-set-html`,
  `direct-dom-access`, `react19-useoptimistic-no-transition`, `empty-catch`, `any-type`,
  `console-log`. Closes the Tier 7 R-2.1 known limit (comment-embedded transition tokens
  spoofing useOptimistic).
- **Tier 7 — cross-file Suspense detection.** New `findSuspenseAncestor` and
  `findLazyComponentsWithoutSuspense` helpers walk reverse JSX adjacency to verify
  `React.lazy()` usage has a real `<Suspense>` ancestor (handles aliased imports,
  module-scope `lazy()` declarations, cycle safety).
- **Tier 6 — 9 new patterns:** `derived-state-reducer`, `derived-state-custom-setter`,
  `stale-closure-toggle`, `stale-closure-broken-functional`,
  `context-provider-value-via-variable`, `context-provider-value-inline-destructured`,
  `react-lazy-no-suspense-same-file`, `rsc-non-serializable-prop-deep`,
  `error-boundary-incomplete`.
- Severity field assigned to all 29 prior React patterns (Tier 6 migration).
- 360 new tests covering all three tiers (pattern + helper + integration + state
  machine + adversarial-regression).

### Fixed
- **Tier 7 — 3 pre-existing CRITICAL bugs** in shipped patterns surfaced by
  Tier 6 adversarial review:
  - `react19-useoptimistic-no-transition`: trivial lookahead bypass — every call
    was being flagged because `[\s\S]{0,300}?` matched zero chars before the
    forward negation.
  - `useEffect-setstate-loop`: array literal in `setItems([...items])` was wrongly
    matching as the dependency array; cross-effect bridging via unbounded
    `[\s\S]{0,800}?`; missing implicit-return arrow form; property-chain false
    positive on `props.count`.
  - `react19-server-action-not-async`: missed arrow function and default-export
    forms; 500-char window too small for header-comment files.
- Adversarial-driven post-release fixes folded inline across 5 review rounds:
  word-boundary on `useOptimistic` lookahead, concise-arm balanced-paren tracker
  in setstate-loop, regex-after-keyword detection (`return /x/`, `throw /x/`,
  `case /x/`), regex-flag consumption (`gimsuy`), template `${expr}` interpolation
  processed as code (was opaque), wrong-owner attribution in lazy detection.

### Changed
- `BUILTIN_PATTERNS` entry shape extended with optional `severity`,
  `postFilter`, `preprocess` fields (all backward-compatible).
- README updated to reflect 8 waves of React support (was 6).

## [Unreleased] — Editor-agnostic git post-commit hook

`codesift setup` now installs a global git post-commit hook (default ON when
`--hooks` is on; opt out with `--no-git-hooks`). The hook auto-updates
`docs/review-queue.md` and Claude memory `review-backlog.md` on every commit,
**regardless of which tool created it** — Claude Code, Cursor, Codex,
Antigravity, terminal, GUI clients, etc. all benefit equally.

**Mechanism:**
- Bundled scripts in `<package>/hooks/` get copied to `~/.claude/hooks/` and
  `~/.claude/scripts/` on `codesift setup --hooks`.
- `git config --global core.hooksPath ~/.claude/hooks` is set once globally.
- Existing repos with `git config --local core.hooksPath` (e.g., Husky, Lefthook
  setups) are not affected — local config wins.
- Idempotent — re-running `codesift setup` skips already-installed scripts and
  preserves user modifications unless `--force` is passed.

**New CLI flags:**
- `--git-hooks` — install editor-agnostic git hook (default ON with `--hooks`)
- `--no-git-hooks` — opt out (Husky/Lefthook users, monorepo CI scenarios)

Test: `tests/cli/git-hooks-installer.test.ts` (7 cases including idempotency,
preservation of user mods, force overwrite, missing-git fallback, no-op when
hooksPath already pointing at target).

## [Unreleased] — TS extractor v3.0.0 (P0+P1)

Major TypeScript/TSX extractor expansion. Closes 11 gap items (L1, L2, L3, L4, L5, L7, L8, L9, L11, L12, L13) identified in the audit vs. competitors (Serena, lsmcp via tsserver; tree-sitter peers GitNexus, jCodeMunch, codebase-memory).

### Breaking — `EXTRACTOR_VERSIONS.typescript: 2.0.0 → 3.0.0`

All existing TypeScript indexes are invalidated on upgrade. The new `loadIndexOrStale` helper detects this and emits a structured warning ("Run index_folder to refresh"). Previously empty results would be returned silently. Re-index is a one-shot — no rolling migration needed.

### Extractor — new symbol fields and kinds

- **L4 — class heritage** (`extends[]` / `implements[]`): `class Foo extends Bar implements Baz<T>` now produces `sym.extends === ["Bar"]` and `sym.implements === ["Baz"]`. Generic type-args stripped, intersection types expanded (`extends A & B` → `["A", "B"]`), qualified names preserved (`extends ns.Base`). New `extractHeritageNames` helper handles `identifier` AND `type_identifier` AST nodes — fixing the silent-drop bug where standard ES6 `extends Foo` was missing.
- **L7 — generics in signature**: `function id<T extends Foo>(x: T): T` now produces `signature: "<T extends Foo>(x: T): T"`. Drops the buggy `: : ` double-colon prefix that affected all return-typed signatures.
- **L3 — enum members**: `enum Direction { North = 1, South }` emits the enum container plus 2 members with `kind: "constant"` parented to the enum. Search `kind=constant` now finds enum members.
- **L5 — `is_async` flag**: async functions, methods, arrows now carry `sym.is_async === true`. Unblocks future TS-aware async-correctness tooling.
- **L8/L9 — modifiers + accessor kind**: `meta.modifiers` (e.g., `["static", "readonly"]`, `["public"]`, `["override"]`) and `meta.accessor_kind` (`"get" | "set" | "accessor"`) populated on methods and fields. Handles both bare-keyword and named-wrapper grammar shapes (`accessibility_modifier`, `override_modifier`).
- **L11 — anonymous default exports**: `export default function() { return <div/> }` now emits `name: "default"`, `kind: "default_export"`, `is_exported: true`. JSX-returning anonymous defaults additionally get `meta.is_react_component: true` for React tool discoverability.
- **L2 + L12 — namespaces and ambient module declarations**: `namespace M { export class C {} }` emits M as `kind: "namespace"` with C parented. `declare module "x" { export function bar(): void }` emits string-named module x with `is_exported: true` (intrinsically module-public). Adds `function_signature` case for ambient function declarations. `declare const X` (no value) now emitted as a symbol.
- **Hardening**: top-level `walk()` wrapped in `try/catch RangeError` — partial-symbol extraction on stack overflow (e.g., 50k-node bundled `.d.ts`). `tree.rootNode.hasError` triggers a one-line warning so silent grammar-version mismatches are observable.

### Import graph — AST-based TS branch

- **L1 — `import type` flag**: TS/TSX files now go through `extractTypeScriptImports` (new `src/utils/ts-imports.ts`) instead of regex. `import type { X } from "./y"` produces `ImportEdge.type_only: true`; mixed `import { type X, Y }` is treated as runtime (any runtime specifier present). `export type { X } from "./y"` re-exports also flagged. AST failure falls back to legacy regex `extractImports` for the file (`type_only: undefined`).
- **L13 — `tsconfig.paths` resolution**: New `src/utils/tsconfig-paths.ts` wraps `get-tsconfig` (production dependency, MIT). Resolves `@alias/*` imports against the nearest `tsconfig.json` walking up from the importer file, follows `extends` chains, applies paths matcher, probes file extensions. Empty-string probe gates with `statSync().isFile()` to reject directory matches that would silently drop edges (regression guard for `@components/Button` → `Button/index.ts`). Two-level cache (`configCache`, `dirToConfigCache`) cleared via `clearTsconfigCache()` at every `index_folder` start.
- **`find_circular_deps` type-only filter**: cycles now exclude `edge.type_only === true` (Python and TS). `undefined` and `false` continue to participate so JS/JSX/PHP cycle detection is preserved and AST-fallback edges still work. Type-only cycles disappear from output — fewer false positives.
- **`addEdge` semantics unchanged**: runtime imports still upgrade prior `type_only` edges; reverse direction (AST type_only after regex runtime) preserves runtime via dedup.
- Reuses existing `getCachedParse` / `setCachedParse` LRU singleton from `src/parser/parse-cache.ts` (no new cache layer).

### Tool layer — stale-index surfacing

- New `loadIndexOrStale(indexPath, currentVersions)` in `src/storage/index-store.ts` returns discriminated union `{ status: "ok", index } | { status: "stale", reason, expected_version, actual_version }`. `getCodeIndex` migrated; on stale logs a structured warning before returning null (instead of silent null). Existing `loadIndex` retained for `saveIncremental` read-mutate-write paths.
- New `staleToMcpError(stale)` in `src/tools/_helpers.ts` converts the union to standard MCP `{ isError: true, content }` envelope. First occupant of `_helpers.ts` (designated home for tool-layer utilities).

### Schema — additive

- `CodeSymbol.implements?: string[]` added (symmetric with existing `extends?`). Optional, additive — non-breaking for MCP clients.
- `meta.modifiers?: string[]`, `meta.accessor_kind?: "get" | "set" | "accessor"`, `meta.is_react_component?: boolean` documented as conventional keys; no schema changes (uses existing `meta?: Record<string, unknown>`).

### Dependencies

- `+ get-tsconfig@^4.13.0` (privatenumber, ~46M weekly, MIT, zero transitive deps). Production dependency.

### Tests

- `tests/parser/typescript-extractor-gaps.test.ts` (NEW, 41 cases): one `describe` per gap (L4, L7, L3, L5, L8/9, L11, L2/L12) plus edge-cases (RangeError guard, grammar errors). Each new case has a `.tsx` parity test.
- `tests/parser/tsconfig-paths.test.ts` (NEW, 8 cases): monorepo extends chain, BOM, cyclic, malformed, missing target, alias-to-directory regression guard, exact-file alias.
- `tests/utils/ts-imports.test.ts` (NEW, 12 cases): all 7 import shapes + 4 re-export shapes + edge cases.
- `tests/integration/type-only-cycle.test.ts` (NEW): `tests/fixtures/type-only-cycle/` fixture pins post-change cycle count = 1 (runtime cycle only).
- `tests/storage/code-symbol-schema.test.ts` (NEW): `implements` field schema validation.
- `tests/parser/_shared.test.ts` (NEW): `makeSymbol` opts plumbing for `implements`.
- `tests/tools/_helpers.test.ts` (NEW): `staleToMcpError` envelope shape.
- 5 existing tests in `typescript-extractor-declarations.test.ts` updated: 3 for the `: : ` → `: ` signature fix, 2 for enum members emission.

### Deferred to follow-up

- `tests/fixtures/heritage-coverage/` corpus + `validate-ts-extractor-gaps.ts` script (Task 17a) — pre-merge gate fixture not yet authored.
- `tests/fixtures/perf-bench/` synthetic 200-file corpus + GHA `perf-baseline.yml` workflow (Task 0 / 17b) — requires CI runner baseline capture before extractor changes; not executable in a single dev session.
- CI workflow `extractor-version-guard.yml` + inventory contract test enumerating all MCP tool callsites of `loadIndex` (Task 16) — full per-tool migration deferred; only `getCodeIndex` migrated to `loadIndexOrStale` so far. ~20 other query-side callers across `src/tools/*.ts` still call `loadIndex` directly and would return null silently on stale rather than the structured warning.
- `conversation-tools.ts:245` migration (Task 14) — separate sub-domain (conversation index, not code index); not load-bearing for this ship gate.

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
