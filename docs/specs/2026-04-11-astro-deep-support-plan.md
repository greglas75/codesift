# Implementation Plan: Astro Deep Support for CodeSift MCP

**Spec:** docs/specs/2026-04-11-astro-deep-support-spec.md
**spec_id:** 2026-04-11-astro-deep-support-2017
**planning_mode:** spec-driven
**plan_revision:** 1
**status:** Approved
**Approved:** 2026-04-11T06:02:14Z
**Created:** 2026-04-11
**Tasks:** 22 (Tasks 8+9 merged into one; Task 19 split into 18+19; net same)
**Estimated complexity:** 11 standard, 11 complex

---

## Architecture Summary

**Layer 1 — Foundation fixes** (existing files, extend or bug-fix):
- `src/parser/extractors/astro.ts` — 10 bug fixes + parseAstroTemplate integration
- `src/parser/parser-manager.ts` — `.mdx` → `"markdown"`, export `getParser`
- `src/parser/symbol-extractor.ts` — `case "astro"` dispatch
- `src/types.ts` — `RouteFramework` union
- `src/utils/import-graph.ts` — strip `.astro` extension
- `src/utils/framework-detect.ts` — Astro detection + entry-point rules
- `src/tools/project-tools.ts` — `EXTRACTOR_VERSIONS["astro"]` + `analyzeProject` Astro branch
- `src/tools/route-tools.ts` — export `matchPath`, wire `findAstroHandlers`
- `src/tools/pattern-tools.ts` — 6 Astro patterns
- `src/tools/index-tools.ts` — version check + lockfile re-index (HIGH risk, touches every tool)
- `src/register-tools.ts` — 4 new `TOOL_DEFINITIONS` entries + `CORE_TOOL_NAMES`

**Layer 2 — Shared template parser** (new module, foundation for all new tools):
- `src/parser/astro-template.ts` — `parseAstroTemplate()` + Island/Slot/ComponentUsage/Directive types

**Layer 3 — New tool modules**:
- `src/tools/astro-islands.ts` — `astro_analyze_islands` + `astro_hydration_audit`
- `src/tools/astro-routes.ts` — `astro_route_map` + `findAstroHandlers`
- `src/tools/astro-config.ts` — `astro_config_analyze` + `extractAstroConventions`

**Data flow** (example: `astro_analyze_islands`): MCP → tool handler → `getCodeIndex(repo)` → filter `.astro` files → read source → `parseAstroTemplate(source, frontmatterImports)` → aggregate Island[] → structured JSON

**Critical dependency chain**: Task 7 (`astro-template.ts`) blocks all consumer tools. Task 8 (extractor RED+GREEN) depends on Task 7. Task 9 (`EXTRACTOR_VERSIONS` bump + lockfile re-index) depends on Task 8 so the new symbol format lands before the version snapshot is bumped. Tools (Tasks 10-13) depend on Tasks 7+8 for code correctness; Task 9 is a release-gating dependency (not a code dependency), so parallelism is possible during execution.

## Technical Decisions

**Patterns**:
- **Registry**: `BUILTIN_PATTERNS` and `EXTRACTOR_VERSIONS` stay as plain exported `Record<string, ...>` objects; no factories
- **findXxxHandlers convention**: `findAstroHandlers(index: CodeIndex, searchPath: string): RouteHandler[]`, exported from `astro-routes.ts`, imported by `route-tools.ts`
- **Pure template parser**: `parseAstroTemplate(source, frontmatterImports?)` takes no repo/filePath — enables isolated unit tests
- **JS AST walker** for `astro.config.mjs`: reuses already-loaded `tree-sitter-javascript.wasm` via exported `getParser("javascript")`
- **Lockfile-first-writer-wins**: `fs.openSync(path, "wx")` with 60s stale check + atomic rename for version snapshot

**Existing code to reuse** (per Tech Lead):
- `makeSymbolId`, `tokenizeIdentifier` from `symbol-extractor.ts`
- `getCodeIndex` from `index-tools.ts`
- `matchPath` from `route-tools.ts` (must export)
- `stripSource` from `graph-tools.ts`
- `getParser` from `parser-manager.ts` (must export)
- `createFixture` + `mockIndex` patterns from `project-tools.test.ts`

**No new dependencies**: uses existing `web-tree-sitter`, `zod`, `vitest`, `node:fs`.

**Trade-offs locked**:
- `findAstroHandlers` lives in `astro-routes.ts` (not `route-tools.ts`) to keep file size < 300 lines
- `matchPath` + `getParser` get exported (1-char changes)
- `astro-islands.ts` holds both island tools (~240-290 lines, under limit)
- Inline string fixtures for unit tests, committed `tests/fixtures/astro-project/` for integration test only

**File size estimates**:
- `astro-template.ts`: 200-260 lines (large but under 300 limit)
- `astro-islands.ts`: 240-290 lines (large)
- `astro-routes.ts`: 130-170 lines (medium)
- `astro-config.ts`: 150-200 lines (medium)

## Quality Strategy

**Test framework**: Vitest. File naming: `*.test.ts`. Directory: `tests/<domain>/` mirroring `src/<domain>/`. Helper patterns: `createFixture(tmpdir)` for filesystem tests, inline source strings for pure-function tests.

**Test count target**: 87 new tests (matches spec AC #22):
- `astro-template.test.ts`: 25 cases
- `astro-extractor.test.ts`: 15 cases
- `astro-islands.test.ts`: 12 cases (1 per AH code + 6 analyze cases — 18 total, but spec minimum is 12)
- `astro-routes.test.ts`: 10 cases
- `astro-config.test.ts`: 10 cases
- Extensions to 5 existing test files: 15 cases total

**Active CQ gates** (per QA Engineer):
- **CQ3** (validation) — Zod schemas on all 4 new tools
- **CQ6** (unbounded data) — 500KB template size guard in `parseAstroTemplate`; `path_prefix` filter support
- **CQ8** (error handling) — try/catch around AST parse; `config_resolution: "dynamic"` fallback; handle missing `src/pages/`
- **CQ14** (duplication) — all 4 consumers MUST call `parseAstroTemplate`, never reimplement island detection inline
- **CQ19** (API contract) — 4 new `TOOL_DEFINITIONS` entries must match existing shape exactly; `SymbolKind: "component"` is a documented breaking change
- **CQ21** (concurrency) — lockfile first-writer-wins for re-index; stale cleanup at 60s
- **CQ23** (cache TTL) — lockfile stale mtime check is the TTL gate
- **CQ25** (pattern consistency) — schema conformance test for new tool definitions

**Top risk areas** (ranked):
1. **`index-tools.ts` concurrent re-index** — called by every tool; bug cascades to all tools in all repos
2. **`parseAstroTemplate()` correctness** — all 4 consumers + 12 AH detectors depend on its output
3. **`EXTRACTOR_VERSIONS` bump** — existing tests use additive `.toHaveProperty()` so they're safe, but downstream behavior for Astro users changes
4. **`register-tools.ts` schema typos** — 1946-line file, no schema conformance test exists
5. **`SymbolKind: "component"` behavioral change** — `search_symbols({kind:"function"})` no longer returns Astro components (intentional but documented)

---

## Task Breakdown

### Task 1: Add `.mdx` to EXTENSION_MAP in parser-manager.ts
**Files:** `src/parser/parser-manager.ts`, `tests/parser/parser-manager.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: Add test case to `tests/parser/parser-manager.test.ts`: `expect(getLanguageForFile("foo.mdx")).toBe("markdown")`. Test fails because `.mdx` is not in `EXTENSION_MAP`.
- [ ] GREEN: Add single entry `[".mdx", "markdown"]` to `EXTENSION_MAP` in `src/parser/parser-manager.ts`. Do not add `.mdx` as its own language — map to existing markdown extractor.
- [ ] Verify: `npx vitest run tests/parser/parser-manager.test.ts`
  Expected: `Tests: N passed, N total` with the new case green.
- [ ] Acceptance: Spec AC Ship #9 (`.mdx` files are mapped to `"markdown"` in `EXTENSION_MAP` and indexed).
- [ ] Commit: `feat: index .mdx files as markdown (Astro blog format support)`

---

### Task 2: Export `getParser` from parser-manager.ts and `matchPath` from route-tools.ts
**Files:** `src/parser/parser-manager.ts`, `src/tools/route-tools.ts`, `tests/parser/parser-manager.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: Add import-level test in `tests/parser/parser-manager.test.ts`: `import { getParser } from "../../src/parser/parser-manager.js"; expect(typeof getParser).toBe("function")`. Similarly for `matchPath` from route-tools if a test file exists, or add a smoke test to `tests/tools/route-tools.test.ts`. Test fails because both symbols are currently module-private.
- [ ] GREEN: Prefix `getParser` in `parser-manager.ts` with `export`. Prefix `matchPath` in `route-tools.ts` with `export`. No behavior changes — only visibility.
- [ ] Verify: `npx vitest run tests/parser/parser-manager.test.ts tests/tools/route-tools.test.ts && npx tsc --noEmit`
  Expected: all tests pass, no TypeScript errors.
- [ ] Acceptance: Enables Tasks 13 (astro-config AST walker) and 14 (astro-routes findAstroHandlers).
- [ ] Commit: `refactor: export getParser and matchPath for cross-module reuse`

---

### Task 3: Extend Framework type and detection with Astro in framework-detect.ts
**Files:** `src/utils/framework-detect.ts`, `tests/utils/framework-detect.test.ts` (create if missing)
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: Write 4 tests in `tests/utils/framework-detect.test.ts`:
  1. `detectFrameworks({ dependencies: { astro: "^5.0.0" } })` returns array including `"astro"`
  2. `detectFrameworks({ devDependencies: { astro: "^5.0.0" } })` returns `"astro"` (both dep locations)
  3. `isFrameworkEntryPoint("src/pages/index.astro")` returns `true`
  4. `isFrameworkEntryPoint("src/pages/api/data.ts")` returns `true` (endpoint)
  5. Symbol-level entry point: `isFrameworkEntryPoint(..., { name: "getStaticPaths" })` returns `true`
  6. Symbol-level: `prerender`, `GET`, `POST`, `PUT`, `DELETE`, `PATCH` all return `true`
  All fail because Astro is not in the Framework union.
- [ ] GREEN:
  - Extend `Framework` union: `"react" | "nestjs" | "nextjs" | "express" | "test" | "astro"`
  - Add `detectFrameworks` check: if `pkg.dependencies?.astro || pkg.devDependencies?.astro || files.some(f => f.endsWith(".astro"))` then push `"astro"`
  - Add `isFrameworkEntryPoint` rules: path matches `src/pages/**/*.{astro,ts,js}` OR symbol name is in `["getStaticPaths","prerender","GET","POST","PUT","DELETE","PATCH"]`
- [ ] Verify: `npx vitest run tests/utils/framework-detect.test.ts`
  Expected: all 6 new tests pass.
- [ ] Acceptance: Spec AC Ship #10 (`detectFrameworks()` returns `"astro"`; `isFrameworkEntryPoint()` correctly classifies Astro pages).
- [ ] Commit: `feat: detect Astro framework and classify page/endpoint entry points`

---

### Task 4: Add RouteFramework union to types.ts
**Files:** `src/types.ts`, `src/tools/route-tools.ts` (use the new type)
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: Add a type-level test in `tests/tools/route-tools.test.ts` (or a new `tests/types.test.ts`): import `RouteFramework`, assert via assignability that `"astro"` is a valid value (`const x: RouteFramework = "astro"` must compile). If `types.test.ts` is new, add a trivial runtime `expect(true).toBe(true)` alongside. The TypeScript compile check is the real assertion.
- [ ] GREEN: Export `type RouteFramework = "nestjs" | "nextjs" | "express" | "astro" | "unknown"` from `src/types.ts`. Update `RouteHandler` interface in `route-tools.ts` to use `RouteFramework` for its `framework` field (note: `RouteHandler` remains local to `route-tools.ts` per Tech Lead's finding — only `RouteFramework` type moves to `types.ts`).
- [ ] Verify: `npx tsc --noEmit && npx vitest run tests/tools/route-tools.test.ts`
  Expected: TypeScript compiles without errors.
- [ ] Acceptance: Enables Task 14 (`findAstroHandlers` returning `framework: "astro"`).
- [ ] Commit: `feat: add RouteFramework union type with astro variant`

---

### Task 5: Normalize `.astro` extension in import-graph.ts
**Files:** `src/utils/import-graph.ts`, `tests/utils/import-graph.test.ts` (extend)
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: Add 4 tests in `tests/utils/import-graph.test.ts`:
  1. `resolveImportPath("./Card.astro", ...)` resolves to the indexed `Card.astro` file
  2. Idempotency: `normalize(normalize(path)) === normalize(path)` for paths ending in `.astro`
  3. `buildNormalizedPathMap` includes entries keyed by both with-and-without `.astro` extension
  4. `.astro` does NOT get double-stripped to `.astr` or `.ast` (regex precision)
  All fail because current regex on line 83 doesn't include `.astro`.
- [ ] GREEN: In `src/utils/import-graph.ts`, modify the extension-strip regex in `resolveImportPath` and `buildNormalizedPathMap` to include `.astro`. One-char addition: change `/\.(ts|tsx|js|jsx|mjs|cjs|php)$/` to `/\.(astro|ts|tsx|js|jsx|mjs|cjs|php)$/`. `.astro` must come first to avoid ambiguity with `.astro`-to-`.astr` over-strip.
- [ ] Verify: `npx vitest run tests/utils/import-graph.test.ts`
  Expected: 4 new tests pass; all existing tests still green.
- [ ] Acceptance: Spec AC Ship #8 (`resolveImportPath()` and `buildNormalizedPathMap()` strip `.astro` extensions).
- [ ] Commit: `fix: normalize .astro extension in import graph resolver`

---

### Task 6: Add `case "astro"` dispatch in symbol-extractor.ts
**Files:** `src/parser/symbol-extractor.ts`, `tests/parser/symbol-extractor.test.ts` (create if missing)
**Complexity:** standard
**Dependencies:** none (current extractor already works as fallback)
**Execution routing:** default implementation tier

- [ ] RED: Add regression test: `const symbols = extractSymbols(astroSource, "test.astro", "repo", null /* tree */); expect(symbols.length).toBeGreaterThan(0)`. Test fails if the dispatch accidentally routes astro files through the generic tree-sitter path which returns empty when there's no tree.
- [ ] GREEN: Ensure `extractSymbols` dispatch in `symbol-extractor.ts` has an explicit `case "astro": return extractAstroSymbols(source, filePath, repo);` branch, not a fall-through. This is a protective change — confirms the current re-export behavior is explicit.
- [ ] Verify: `npx vitest run tests/parser/symbol-extractor.test.ts`
  Expected: regression test passes; no other tests affected.
- [ ] Acceptance: Protects against silent fall-through bug identified in spec Failure Modes.
- [ ] Commit: `refactor: add explicit astro case in symbol-extractor dispatch`

---

### Task 7: Create astro-template.ts with types and parseAstroTemplate implementation
**Files:** `src/parser/astro-template.ts` (new), `tests/parser/astro-template.test.ts` (new)
**Complexity:** complex
**Dependencies:** none
**Execution routing:** deep implementation tier

- [ ] RED: Write 25 test cases in `tests/parser/astro-template.test.ts`:
  1. Parses all 6 directive types: `client:load`, `client:idle`, `client:visible`, `client:media`, `client:only`, `server:defer`
  2. `client:only="react"` captures `directive_value: "react"`, sets `framework_hint: "react"`
  3. `frontmatterImports` map resolves `.astro` path → `target_kind: "astro"` (ERROR case)
  4. `frontmatterImports` resolves `.tsx/.vue/.svelte` → `target_kind: "framework"` with correct `framework_hint`
  5. Default slot `<slot />` extracted with `name: "default"`, `has_fallback: false`
  6. Named slot `<slot name="sidebar"/>` extracted with correct name
  7. Slot with fallback: `<slot>fallback content</slot>` → `has_fallback: true`
  8. HTML comments containing `<X client:load/>` do NOT produce false-positive islands (comment stripping)
  9. CRLF line endings normalized; `\r\n` source parses identically to `\n` source
  10. BOM (0xFEFF) prefix stripped before scan
  11. Balanced-brace counter: `{items.map(i => <X client:load/>)}` → `in_loop: true`
  12. Conditional detection: `{show && <X client:load/>}` → `conditional: true`
  13. Ternary: `{cond ? <A client:idle/> : <B client:visible/>}` → both islands marked `conditional: true`
  14. Spread attributes: `<X {...props} client:load/>` → `uses_spread: true`
  15. Template >500KB returns `parse_confidence: "degraded"`, islands empty, `scan_errors` populated
  16. Unbalanced `{` at depth >100 returns `parse_confidence: "degraded"`
  17. `document_order` increments per island (0-based)
  18. `parent_tag` captures immediate enclosing tag name in lowercase
  19. `is_inside_section` returns `"footer"` when island is inside `<footer>...</footer>`
  20. `is_inside_section` returns `null` when no landmark ancestor
  21. Component usages: two-pass scan finds `<Footer />` tag matching frontmatter import
  22. Imported component not rendered → omitted from `component_usages`
  23. Dynamic component `<Comp client:load/>` where `Comp` is lowercase → `target_kind: "unknown"`
  24. Empty template section returns empty `AstroTemplateParse` with `parse_confidence: "high"`
  25. Mixed frameworks: template with React island + Svelte island tracked separately by `framework_hint`
  All fail because `astro-template.ts` does not exist.
- [ ] GREEN: Create `src/parser/astro-template.ts`:
  - Export types: `Island`, `Slot`, `ComponentUsage`, `Directive`, `AstroTemplateParse` per spec Detailed Design > Data Model
  - Export `parseAstroTemplate(source: string, frontmatterImports?: Map<string, string>): AstroTemplateParse`
  - Normalize CRLF/BOM at entry
  - Split frontmatter from template by finding first `---\n...\n---` block
  - Strip HTML comments (`/<!--[\s\S]*?-->/g`) before scan
  - 500KB size guard: if `template.length > 512000`, return degraded parse
  - Directive scanner: regex over template `/<([A-Z][\w]*)[^>]*?(client:[a-z]+|server:defer)(?:=["']([^"']+)["'])?[^>]*?\/?>/g`
  - Balanced-brace depth counter walking char-by-char tracking position inside `{...}` blocks
  - Conditional/loop detection: track if current `{...}` block starts with `.map(`, `&&`, or `? :` pattern
  - Two-pass component_usages: collect capitalized tags, diff against `frontmatterImports`
  - Slot scanner: regex `/<slot(?:\s+name=["']([^"']+)["'])?\s*(\/>|>([\s\S]*?)<\/slot>)/g`
  - Landmark ancestor tracking for `is_inside_section` via tag stack walk
  - `document_order` is a counter incremented per island found
- [ ] Verify: `npx vitest run tests/parser/astro-template.test.ts`
  Expected: `Tests: 25 passed, 25 total`. All tests green before moving on.
- [ ] Acceptance: Spec AC Ship #13 (extracts all 6 directive types), #14 (distinguishes Astro vs framework targets), #19 (config_resolution honesty).
- [ ] Commit: `feat: add parseAstroTemplate shared parser with island/slot/directive extraction`

> **Adversarial review note**: The regex provided in the GREEN step above is illustrative, not prescriptive. The 25 unit tests are the contract; use any implementation approach (state machine, multi-pass regex, tokenizer) that makes all 25 pass. Pay special attention to tests 14 (spread attributes), 23 (lowercase/dynamic component), and attribute order variations not explicitly tested.

---

### Task 8: Fix 10 bugs in extractAstroSymbols + integrate parseAstroTemplate (full RED → GREEN)
**Files:** `src/parser/extractors/astro.ts`, `tests/parser/astro-extractor.test.ts` (new)
**Complexity:** complex
**Dependencies:** Task 7 (parseAstroTemplate must exist)
**Execution routing:** deep implementation tier

This task is split into two halves within one commit: write 15 failing tests, then fix the bugs. Keeping both halves in one commit avoids the "known-failing suite" problem that splitting RED and GREEN would introduce.

- [ ] RED: Create `tests/parser/astro-extractor.test.ts` with 15 test cases as **normal** positive assertions (no `test.fails()` wrapper). Each must fail against the current buggy extractor for a specific reason:
  1. Multi-line function has `end_line > start_line` (current bug: always equal)
  2. Props interface symbol has non-empty `tokens` field
  3. Const symbol has non-empty `tokens` field
  4. Function symbol has non-empty `tokens` field
  5. Component symbol has `kind: "component"` not `"function"`
  6. Component symbol on template-only file has sanitized source (no raw HTML attribute noise)
  7. CRLF file parses identical symbols to LF file
  8. BOM-prefixed file parses correctly
  9. Frontmatter-only file does NOT emit zero-content function symbols (EC-2)
  10. `interface Props extends BaseProps { ... }` — Props symbol detected (EC-16)
  11. `type Props = { items: Item[] }` — Props symbol detected (EC-17)
  12. `export const prerender = false` — emits constant symbol
  13. `export async function getStaticPaths() { ... }` — emits function symbol
  14. `export const getStaticPaths = async () => { ... }` — also emits function symbol (const arrow form)
  15. `export async function GET(context) { ... }` — emits endpoint handler symbol
  Run `npx vitest run tests/parser/astro-extractor.test.ts` and confirm 15 failures (each with a specific error: `AssertionError: expected 5 to be greater than 5` for end_line, etc.) — NOT an import error. Do not proceed until each failure is specific to its bug.
- [ ] GREEN: Rewrite `src/parser/extractors/astro.ts` incrementally, running the test suite after each logical group of changes to narrow failures:
  - Group A — Infrastructure fixes: CRLF/BOM normalization, `kind: "component"` assignment, `tokenizeIdentifier` on all symbols, function `end_line` via body brace tracking, template-only source sanitization, frontmatter-only zero-content guard
  - Group B — Props variants: accept both `interface Props` (with `extends` clause) and `type Props = {...}` alias
  - Group C — SSR exports: regex for `export (const|async function) (GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|ALL)\b`, `export const prerender = (true|false)`, `export (const|async function) getStaticPaths\b` (both forms)
  - Group D — Template integration: call `parseAstroTemplate(source, frontmatterImports)` where `frontmatterImports` is built from the frontmatter's import statements; use the result to augment indexed symbols (islands become metadata attached to the component symbol)
  - Invariants: file must stay under 300 lines; must not break existing tests in `tests/parser/` or `tests/tools/`
- [ ] Verify: `npx vitest run tests/parser/` and `npx vitest run tests/tools/`
  Expected: 15 new extractor tests pass + 25 template tests (Task 7) pass + all existing parser/tool tests still green.
- [ ] Acceptance: Spec AC Ship #1, #2, #3, #4, #5 (10 extractor bugs fixed); integrates Task 7 output.
- [ ] Commit: `fix: resolve 10 bugs in Astro extractor and integrate template parser`

---

### Task 9: Add EXTRACTOR_VERSIONS["astro"] + version check + lockfile re-index
**Files:** `src/tools/project-tools.ts`, `src/tools/index-tools.ts`, `tests/tools/index-tools.test.ts` (extend)
**Complexity:** complex
**Dependencies:** Task 8 (extractor must emit new format before version bump)
**Execution routing:** deep implementation tier

- [ ] RED: Add 6 tests to `tests/tools/index-tools.test.ts`:
  1. `EXTRACTOR_VERSIONS.astro === "1.0.0"` (imported from project-tools.ts)
  2. Version mismatch between stored snapshot and current map triggers re-extraction of all `.astro` files
  3. After successful re-extract, `astro-reindex.lock` file is removed
  4. Second concurrent session (simulated by creating the lockfile manually) does NOT re-extract — logs "Re-index in progress by another session"
  5. Stale lockfile (mtime > 60s via `fs.utimesSync`) is overwritten — re-extract proceeds
  6. Version snapshot file at `.codesift/extractor-versions.json` is written via atomic rename (temp file + rename)
  All fail because `EXTRACTOR_VERSIONS` lacks astro and `getCodeIndex` has no version check.
- [ ] GREEN:
  - In `src/tools/project-tools.ts`: add `"astro": "1.0.0"` to `EXTRACTOR_VERSIONS` const
  - In `src/tools/index-tools.ts`: inside `getCodeIndex()`, after index load, compare stored snapshot (read from `<indexRoot>/.codesift/extractor-versions.json`) with current `EXTRACTOR_VERSIONS`
  - If `stored.astro !== current.astro`:
    - Acquire lockfile: `fs.openSync(lockPath, "wx")`. Catch EEXIST: check lockfile mtime via `fs.statSync`; if mtime > 60000ms ago, delete orphan lock and retry once; otherwise log "Re-index in progress" and return current (stale) index
    - Inside try/finally: re-extract all files where `language === "astro"` via `extractAstroSymbols`, replacing their symbols in the index
    - Log progress every 100 files
    - Write updated snapshot atomically: `fs.writeFileSync(tmpPath, JSON.stringify(current))` + `fs.renameSync(tmpPath, finalPath)`
    - Release: `fs.unlinkSync(lockPath)` in finally
- [ ] Verify: `npx vitest run tests/tools/index-tools.test.ts tests/tools/project-tools.test.ts`
  Expected: 6 new tests pass; existing `getExtractorVersions` tests still green (semver loop handles new key automatically).
- [ ] Acceptance: Spec AC Ship #6, #7 (`EXTRACTOR_VERSIONS` includes astro, auto re-index on version mismatch).
- [ ] Commit: `feat: add EXTRACTOR_VERSIONS check with lockfile-protected auto re-index`

> **Adversarial review note**: This is the highest-risk task in the plan — it modifies `getCodeIndex`, the hot path for every tool. Consider a 15-minute spike before starting: prototype `fs.openSync("wx")` + stale-lock detection in isolation (e.g., `/tmp/lock-spike.ts`) to validate Node.js semantics on both macOS (BSD) and Linux before integrating into the real code path.

---

### Task 10: Implement astro_analyze_islands tool
**Files:** `src/tools/astro-islands.ts` (new, partial — islands tool only), `tests/tools/astro-islands.test.ts` (new, partial)
**Complexity:** complex
**Dependencies:** Task 7 (parseAstroTemplate), Task 8 (extractor fixes — required for Island data), Task 9 (release gate for re-index)
**Execution routing:** deep implementation tier

- [ ] RED: Write 6 test cases in `tests/tools/astro-islands.test.ts`:
  1. Empty index returns `{ islands: [], summary: { total_islands: 0, ... }, server_islands: [] }`
  2. Index with 1 `.astro` file containing 1 React island returns correct `islands[0]` with all fields populated
  3. Mixed frameworks (React + Svelte in same project) group correctly in `summary.by_framework`
  4. `summary.by_directive` counts `client:load`, `client:idle`, `client:visible` correctly
  5. `path_prefix: "src/pages/"` filters islands to only pages (excludes layouts/components)
  6. `server:defer` component appears in `server_islands[]`, not in main `islands[]`
  All fail because `astro-islands.ts` does not exist.
- [ ] GREEN: Create `src/tools/astro-islands.ts`:
  - Import `parseAstroTemplate` from `../parser/astro-template.js`
  - Import `getCodeIndex` from `./index-tools.js`
  - Export `astroAnalyzeIslands({ repo, path_prefix, include_recommendations })`
  - Filter `.astro` files by `language === "astro"` and optional `path_prefix`
  - For each file: read source (via `fs.readFileSync` or existing index source field), build `frontmatterImports` map from existing symbols, call `parseAstroTemplate`
  - Aggregate all `Island[]`, split out `server:defer` islands into separate array
  - Compute `summary`: totals + group-by directive + group-by framework
  - Return typed JSON matching spec API surface
- [ ] Verify: `npx vitest run tests/tools/astro-islands.test.ts`
  Expected: 6 tests pass.
- [ ] Acceptance: Spec AC Ship #15 (`astro_analyze_islands` returns structured results).
- [ ] Commit: `feat: add astro_analyze_islands tool for hydration directive analysis`

---

### Task 11: Implement astro_hydration_audit with 12 AH detectors
**Files:** `src/tools/astro-islands.ts` (extend), `tests/tools/astro-islands.test.ts` (extend)
**Complexity:** complex
**Dependencies:** Task 10 (shared file)
**Execution routing:** deep implementation tier

- [ ] RED: Add 12 test cases — one per AH code — plus 3 scoring tests:
  1. AH01: client:load on .astro component resolves via frontmatterImports → `code: "AH01", severity: "error"`
  2. AH02: island inside `{items.map(...)}` loop → `code: "AH02", severity: "warning"`
  3. AH03: framework import used without client directive → `code: "AH03", severity: "warning"`
  4. AH04: island with `document_order > 3` OR `is_inside_section === "footer"` → `code: "AH04", severity: "warning"`
  5. AH05: `client:only` without framework hint → `code: "AH05", severity: "error"`
  6. AH06: layout file root tag is framework component with client:* → `code: "AH06"`
  7. AH07: client:load with all-static props → `code: "AH07", severity: "info"`
  8. AH08: 2+ different frameworks imported in same file → `code: "AH08"`
  9. AH09: client:load with import from `chart.js` / `mapbox-gl` / etc → `code: "AH09", severity: "info"`
  10. AH10: `server:defer` with no fallback slot → `code: "AH10"`
  11. AH11: `transition:persist` without `transition:persist-props` → `code: "AH11"`
  12. AH12: client:* on lowercase/variable tag name → `code: "AH12"`
  13. Score: 0 errors + 2 warnings → `score: "A"`
  14. Score: 2 errors → `score: "C"`
  15. Score: 3+ errors → `score: "D"`
  All fail because `astroHydrationAudit` does not exist.
- [ ] GREEN: In `src/tools/astro-islands.ts`:
  - Export `astroHydrationAudit({ repo, severity, path_prefix })`
  - Reuse same file-walk + `parseAstroTemplate` pipeline as Task 11
  - Run 12 detector functions (one per AH code) against parsed data
  - Each detector returns `Issue[]` or `[]`
  - AH09 heavy library list: const array of known npm package patterns
  - Filter by `severity` parameter
  - Compute `score` per spec A/B/C/D table: `errors === 0 && warnings <= 2 → "A"` etc.
  - Return `{ issues, anti_patterns_checked: ["AH01",...,"AH12"], score }`
  - Total file stays under 290 lines (per Tech Lead estimate)
- [ ] Verify: `npx vitest run tests/tools/astro-islands.test.ts`
  Expected: all 12 detector tests + 3 scoring tests pass (18 total in this file including Task 11's 6).
- [ ] Acceptance: Spec AC Ship #16 (detects all 12 AH codes with severity, file, line, fix fields).
- [ ] Commit: `feat: add astro_hydration_audit with 12 anti-pattern detectors (AH01-AH12)`

---

### Task 12: Implement astro_route_map and findAstroHandlers
**Files:** `src/tools/astro-routes.ts` (new), `tests/tools/astro-routes.test.ts` (new)
**Complexity:** complex
**Dependencies:** Task 2 (matchPath export), Task 4 (RouteFramework), Task 7 (parseAstroTemplate for layout chains)
**Execution routing:** deep implementation tier

- [ ] RED: Write 10 test cases:
  1. Static route: `src/pages/about.astro` → `{ path: "/about", type: "page", rendering: "static" }`
  2. Dynamic route: `src/pages/blog/[slug].astro` → `{ path: "/blog/[slug]", dynamic_params: ["slug"], has_getStaticPaths: true }` (when file exports getStaticPaths)
  3. Rest route: `src/pages/docs/[...path].astro` → `{ path: "/docs/[...path]", dynamic_params: ["...path"] }`
  4. API endpoint: `src/pages/api/data.ts` with `export GET` → `{ type: "endpoint", methods: ["GET"] }`
  5. Endpoint with multiple methods: `src/pages/api/items.ts` exports GET+POST → `methods: ["GET","POST"]`
  6. Missing getStaticPaths warning: dynamic route without `getStaticPaths` export → `warnings[]` contains the file path
  7. Route conflict warning: both `[slug].astro` and `[...rest].astro` under same prefix → conflict warning
  8. Route ordering: static routes sort before dynamic, dynamic before rest
  9. Empty `src/pages/` directory → `{ routes: [], summary: { total_routes: 0 } }`
  10. `findAstroHandlers(index, "/blog/hello")` returns matching handler with `framework: "astro"`
  All fail because `astro-routes.ts` does not exist.
- [ ] GREEN: Create `src/tools/astro-routes.ts`:
  - Import `matchPath` from `./route-tools.js` (requires Task 2)
  - Export `findAstroHandlers(index: CodeIndex, searchPath: string): RouteHandler[]`
  - Export `astroRouteMap({ repo, include_endpoints, output_format })`
  - Walk files under `src/pages/**` (both `.astro` and `.ts`/`.js`)
  - File path → route path: strip `src/pages/`, strip extension, replace `index` → `/`
  - Detect dynamic params by scanning for `[name]` and `[...name]` segments
  - For `.astro` pages: check symbols for `getStaticPaths` (both function and const forms), `prerender` constant
  - For `.ts`/`.js` endpoints: scan symbols for exported `GET`, `POST`, etc.
  - Compute rendering mode: endpoint → `"server"`, page with `prerender === "true"` → `"static"`, default per output mode (from config if known)
  - Sort routes by specificity (static count > dynamic param count > rest param)
  - Detect conflicts: any two routes with overlapping specificity on same prefix
  - Emit `virtual_routes_disclaimer` listing any `@astrojs/sitemap`, `@astrojs/rss` integrations detected
  - File size < 170 lines
- [ ] Verify: `npx vitest run tests/tools/astro-routes.test.ts`
  Expected: 10 tests pass.
- [ ] Acceptance: Spec AC Ship #17 (`astro_route_map` enumerates pages + endpoints sorted by priority), #18 (detects route conflicts).
- [ ] Commit: `feat: add astro_route_map tool and findAstroHandlers for file-based routing`

---

### Task 13: Implement astro_config_analyze + extractAstroConventions (AST walker)
**Files:** `src/tools/astro-config.ts` (new), `tests/tools/astro-config.test.ts` (new)
**Complexity:** complex
**Dependencies:** Task 2 (getParser export)
**Execution routing:** deep implementation tier

- [ ] RED: Write 10 test cases:
  1. Literal config (`output: 'static'`, integrations: [react(), tailwind()]) → `config_resolution: "static"`, full `AstroConventions` populated
  2. Ternary config (`output: env.FOO ? 'server' : 'static'`) → `config_resolution: "partial"`, `output_mode: null`
  3. Missing config file → `config_resolution: "dynamic"`, `config_file: null`, empty conventions
  4. AST parse error on malformed config → graceful `config_resolution: "dynamic"`
  5. Config file at `.ts` fallback: `.mjs` missing, `.ts` present → reads `.ts` successfully
  6. Config file at `.cjs` fallback
  7. i18n extraction: `i18n: { defaultLocale: "en", locales: ["en","es"] }` → `i18n: { default_locale: "en", locales: ["en","es"] }`
  8. Redirects extraction: `redirects: { "/old": "/new" }` → `redirects: { "/old": "/new" }`
  9. Adapter extraction: `adapter: vercel()` → `adapter: "@astrojs/vercel"` (resolve from import statements)
  10. Missing `site` URL emits issue in `issues[]`
  All fail because `astro-config.ts` does not exist.
- [ ] GREEN: Create `src/tools/astro-config.ts`:
  - Import `getParser` from `../parser/parser-manager.js` (requires Task 2)
  - Export `extractAstroConventions(files: FileEntry[], projectRoot: string): AstroConventions`
  - Export `astroConfigAnalyze({ repo })`
  - Locate config file: try `astro.config.mjs` → `astro.config.ts` → `astro.config.cjs` in project root
  - Parse with `getParser("javascript")` wrapped in try/catch → fallback to empty result
  - Walk AST to find `export default defineConfig({...})` — accept any call whose callee name is `defineConfig`
  - For each top-level property of the object literal: classify value as literal (string_literal / number_literal / true/false / array of literals / object of literals) vs non-literal (identifier, ternary, spread, call expression other than integration factories)
  - Integration detection: function calls inside `integrations: [...]` → extract function name → look up corresponding import to map `react()` → `"@astrojs/react"`
  - Return `AstroConventions` with populated fields per decision table; set `config_resolution` by counting non-literal fields (0 → static; ≥1 → partial; parse error → dynamic)
  - Emit issues: missing `site`, deprecated `@astrojs/lit`, etc.
  - File size < 200 lines
- [ ] Verify: `npx vitest run tests/tools/astro-config.test.ts`
  Expected: 10 tests pass.
- [ ] Acceptance: Spec AC Ship #19 (parses .mjs/.ts/.cjs), #20 (config_resolution honesty).
- [ ] Commit: `feat: add astro_config_analyze tool with JS AST walker for astro.config`

> **Adversarial review note**: Before writing the AST walker, spend 15 minutes exploring tree-sitter-javascript node types for a minimal astro.config sample. Log the parse tree via a throwaway script to confirm node names (`string`, `ternary_expression`, `call_expression`, `identifier`, `object`, `pair`, etc.). Knowing the exact node names up front prevents mid-implementation discovery of classification gaps between literal and dynamic values.

---

### Task 14: Add Astro branch to analyzeProject in project-tools.ts
**Files:** `src/tools/project-tools.ts`, `tests/tools/project-tools.test.ts` (extend)
**Complexity:** standard
**Dependencies:** Task 13 (extractAstroConventions)
**Execution routing:** default implementation tier

- [ ] RED: Add 3 tests in `tests/tools/project-tools.test.ts`:
  1. `analyzeProject` on Astro fixture returns `status: "complete"` (not `"partial"`)
  2. Response includes `astro_conventions` object with populated `output_mode`, `integrations`, `pages` fields
  3. `buildConventionsSummary` produces an astro section in the summary
  Tests fail because no astro branch exists.
- [ ] GREEN: In `src/tools/project-tools.ts`:
  - Import `extractAstroConventions` from `./astro-config.js`
  - In `analyzeProject()` dispatch (currently at ~line 1713-1754): add `else if (fw === "astro") { astroConventions = extractAstroConventions(index.files, projectRoot); status = "complete"; }`
  - In `buildConventionsSummary()`: add astro branch returning one-line summary of output mode + integration count + route count
  - Return `astro_conventions` in the orchestrator output object
- [ ] Verify: `npx vitest run tests/tools/project-tools.test.ts`
  Expected: 3 new tests pass; all existing tests still green.
- [ ] Acceptance: Spec AC Ship #11 (`analyzeProject()` returns `status: "complete"` with `astro_conventions`).
- [ ] Commit: `feat: add Astro conventions branch to analyzeProject orchestrator`

---

### Task 15: Wire findAstroHandlers into traceRoute dispatch
**Files:** `src/tools/route-tools.ts`, `tests/tools/route-tools.test.ts` (extend)
**Complexity:** standard
**Dependencies:** Task 12 (findAstroHandlers exists)
**Execution routing:** default implementation tier

- [ ] RED: Add 2 tests in `tests/tools/route-tools.test.ts`:
  1. `traceRoute("/blog/hello")` on Astro fixture returns handler from `[slug].astro` with `framework: "astro"`
  2. `traceRoute("/api/data")` on fixture with `src/pages/api/data.ts` returns endpoint handler
  Tests fail because `traceRoute` doesn't call `findAstroHandlers`.
- [ ] GREEN: In `src/tools/route-tools.ts`:
  - Import `findAstroHandlers` from `./astro-routes.js`
  - Add call to `findAstroHandlers(index, searchPath)` in the dispatch fan-out alongside `findNestJSHandlers`, `findNextJSHandlers`, etc.
  - Merge results into the combined handler array
- [ ] Verify: `npx vitest run tests/tools/route-tools.test.ts`
  Expected: 2 new tests pass; existing route-tools tests still green.
- [ ] Acceptance: Spec AC Ship #12 (`trace_route` resolves Astro routes via `findAstroHandlers`).
- [ ] Commit: `feat: wire findAstroHandlers into traceRoute dispatch`

---

### Task 16: Add 6 Astro patterns to BUILTIN_PATTERNS
**Files:** `src/tools/pattern-tools.ts`, `tests/tools/pattern-tools.test.ts` (extend)
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: Write 12 test cases in `tests/tools/pattern-tools.test.ts` (1 positive + 1 negative per pattern):
  1. `astro-client-on-astro` matches `<Card client:load/>` where `Card.astro` is imported
  2. `astro-client-on-astro` does not match `<Card client:load/>` where `Card.tsx` is imported
  3. `astro-glob-usage` matches `Astro.glob('./posts/*.md')`
  4. `astro-glob-usage` does not match `import.meta.glob('./posts/*.md')`
  5. `astro-set-html-xss` matches `<div set:html={userInput}/>`
  6. `astro-set-html-xss` does not match `<div set:html="static string"/>`
  7. `astro-img-element` matches `<img src="..."/>` in `.astro` file
  8. `astro-img-element` does not match `<Image src="..."/>` (from `astro:assets`)
  9. `astro-missing-getStaticPaths` matches `[slug].astro` without `getStaticPaths` export
  10. `astro-missing-getStaticPaths` does not match `[slug].astro` WITH `getStaticPaths`
  11. `astro-legacy-content-collections` matches files at `src/content/config.ts`
  12. `astro-legacy-content-collections` does not match `src/content.config.ts`
  All fail because patterns don't exist.
- [ ] GREEN: Add 6 entries to `BUILTIN_PATTERNS` object in `src/tools/pattern-tools.ts`. Each entry: `{ regex: RegExp, description: string }`. Pattern keys exactly as listed above.
- [ ] Verify: `npx vitest run tests/tools/pattern-tools.test.ts`
  Expected: 12 new tests pass.
- [ ] Acceptance: Spec AC Ship #21 (6 new Astro built-in patterns).
- [ ] Commit: `feat: add 6 Astro anti-pattern detectors to BUILTIN_PATTERNS`

---

### Task 17: Register 4 new MCP tools in register-tools.ts
**Files:** `src/register-tools.ts`, `tests/tools/register-tools.test.ts` (create if missing)
**Complexity:** standard
**Dependencies:** Tasks 10, 11, 12, 13 (all 4 tools implemented)
**Execution routing:** default implementation tier

- [ ] RED: Add schema conformance tests:
  1. Import `TOOL_DEFINITIONS`; assert all 4 new tools (`astro_analyze_islands`, `astro_hydration_audit`, `astro_route_map`, `astro_config_analyze`) exist in the array
  2. Each has required fields: `name`, `category`, `description`, `schema`, `handler`
  3. Each `schema` is a valid Zod schema (can call `.parse({})` or `.safeParse`)
  4. All 4 tool names appear in `CORE_TOOL_NAMES`
  Tests fail because tool definitions are not registered.
- [ ] GREEN: In `src/register-tools.ts`:
  - Import the 4 handler functions from `./tools/astro-islands.js`, `./tools/astro-routes.js`, `./tools/astro-config.js`
  - Add 4 `ToolDefinition` objects to `TOOL_DEFINITIONS` array with Zod schemas matching spec API Surface section
  - Add 4 tool names to `CORE_TOOL_NAMES` set/array
  - Match existing schema shape exactly (use existing tools as template)
- [ ] Verify: `npx vitest run tests/tools/register-tools.test.ts && npx tsc --noEmit`
  Expected: all conformance tests pass; TypeScript compiles.
- [ ] Acceptance: Spec AC Ship #23 (all 4 new tools in `CORE_TOOL_NAMES`).
- [ ] Commit: `feat: register 4 Astro MCP tools as core tools`

---

### Task 18: Create integration test fixture (fixture files only, no test)
**Files:** `tests/fixtures/astro-project/` (new directory with 9 files)
**Complexity:** standard
**Dependencies:** none (pure file creation, independent of tool implementations)
**Execution routing:** default implementation tier

- [ ] RED: Write a single smoke test in `tests/fixtures/astro-project.smoke.test.ts`: `expect(fs.existsSync("tests/fixtures/astro-project/package.json")).toBe(true)` and similar `existsSync` checks for each of the 9 fixture files. Test fails because no fixture directory exists.
- [ ] GREEN: Create the fixture directory with 9 files:
  - `package.json`: includes `astro`, `@astrojs/react`, `@astrojs/tailwind` in dependencies (~15 lines)
  - `astro.config.mjs`: static output, react + tailwind integrations, i18n with en+es locales (~20 lines)
  - `src/pages/index.astro`: imports `Counter` from `../components/Counter` and renders `<Counter client:visible count={0} />` in the template; extends BaseLayout (~20 lines). **This is the only file where `client:visible` appears** — it is an Astro template directive applied to a React component import, NOT a prop on the React component itself.
  - `src/pages/blog/[slug].astro`: dynamic route with `export async function getStaticPaths() { return [{params: {slug: "hello"}}]; }` (~20 lines)
  - `src/pages/api/data.ts`: `export const GET = () => new Response("data")` (~5 lines)
  - `src/layouts/BaseLayout.astro`: layout with `<slot/>` and `<Footer/>` (~15 lines)
  - `src/components/Counter.tsx`: React component — plain `useState` counter, NO Astro directives (directives live in .astro files only) (~15 lines)
  - `src/components/Footer.astro`: Astro component (static HTML, ~10 lines)
  - `src/content.config.ts`: minimal blog collection via `defineCollection` + Zod schema (~15 lines)
- [ ] Verify: `npx vitest run tests/fixtures/astro-project.smoke.test.ts`
  Expected: 9 `existsSync` checks pass.
- [ ] Acceptance: Prerequisite for Task 19b integration test and Task 20 validate script.
- [ ] Commit: `test: add Astro integration fixture project (9 files)`

---

### Task 19: Write end-to-end integration test against fixture
**Files:** `tests/integration/astro-pipeline.test.ts` (new)
**Complexity:** complex
**Dependencies:** Task 18 (fixture exists), Tasks 10-17 (all tools implemented and registered)
**Execution routing:** deep implementation tier

- [ ] RED: Create `tests/integration/astro-pipeline.test.ts` with 8 end-to-end assertions:
  - `beforeAll`: `await indexFolder("tests/fixtures/astro-project")`, capture repo name
  - Assertion 1: all expected fixture files indexed with `language === "astro"` (count: 4 `.astro` files)
  - Assertion 2: `astroAnalyzeIslands({repo})` returns 1 React island (`Counter` with `client:visible`) in `islands[0]`
  - Assertion 3: `astroHydrationAudit({repo})` returns empty `issues[]` + `score: "A"` (clean fixture)
  - Assertion 4: `astroRouteMap({repo})` returns 3 routes (`/`, `/blog/[slug]`, `/api/data`) with correct `rendering` per route
  - Assertion 5: `astroConfigAnalyze({repo})` returns `config_resolution: "static"`, `integrations: ["react","tailwind"]`, populated `i18n`
  - Assertion 6: `analyzeProject({repo})` returns `status: "complete"` with non-null `astro_conventions`
  - Assertion 7: `traceRoute({repo, path: "/api/data"})` returns handler at `src/pages/api/data.ts` with `framework: "astro"`
  - Assertion 8: `searchSymbols({repo, query: "Footer"})` includes an entry where `file === ".../Footer.astro"` AND `kind === "component"`
  All assertions fail because the tools either aren't implemented (if run before Tasks 11-18) or the fixture isn't loaded correctly. Since this task depends on Tasks 11-18 being complete, the tests should PASS on first run after implementation.
- [ ] GREEN: No new code — the test just runs against already-implemented tools. If any assertion fails, debug the relevant tool (not the integration test itself).
- [ ] Verify: `npx vitest run tests/integration/astro-pipeline.test.ts`
  Expected: 8 assertions all green.
- [ ] Acceptance: Spec Validation Methodology "Integration test" section; validates cross-tool interactions end-to-end.
- [ ] Commit: `test: add end-to-end Astro pipeline integration test`

---

### Task 20: Create validate-astro-support.sh + compute-set-metrics.js + Vitest wrapper
**Files:** `scripts/validate-astro-support.sh` (new), `scripts/compute-set-metrics.js` (new), `tests/fixtures/astro-snapshots/astro-project/expected-islands.json` (new), `tests/fixtures/astro-snapshots/astro-project/expected-routes.json` (new), `tests/integration/validate-astro-script.test.ts` (new)
**Complexity:** standard
**Dependencies:** Task 18 (fixture), Task 19 (tool outputs verified)
**Execution routing:** default implementation tier

- [ ] RED: Create `tests/integration/validate-astro-script.test.ts` with 3 assertions:
  1. `execSync("./scripts/validate-astro-support.sh tests/fixtures/astro-project", { encoding: "utf-8" })` does not throw
  2. Script stdout contains lines matching `/island_precision\s+\d+\.\d+\s+\d+\.\d+\s+PASS/`, `/island_recall\s+.*PASS/`, `/route_coverage\s+.*PASS/`
  3. Exit code is 0
  Tests fail because neither the script nor the metrics module exists.
- [ ] GREEN:
  - Create `scripts/validate-astro-support.sh` with the exact body specified in spec Validation Methodology section (indexes repo, calls 4 tools via CLI, compares against snapshots, emits TSV metrics)
  - Create `scripts/compute-set-metrics.js` computing precision/recall/coverage by tuple-key set comparison (islands tuple: `file:line:directive:component_name`; routes tuple: `path:rendering`)
  - `chmod +x scripts/validate-astro-support.sh`
  - Create `tests/fixtures/astro-snapshots/astro-project/expected-islands.json` (hand-curated: 1 island — the `Counter` with `client:visible`)
  - Create `tests/fixtures/astro-snapshots/astro-project/expected-routes.json` (hand-curated: 3 routes — `/`, `/blog/[slug]`, `/api/data`)
- [ ] Verify: `npx vitest run tests/integration/validate-astro-script.test.ts`
  Expected: 3 Vitest assertions pass. Also manually run `./scripts/validate-astro-support.sh tests/fixtures/astro-project` and confirm TSV output showing all metrics as PASS with exit code 0.
- [ ] Acceptance: Spec Validation Methodology requires this script as a prerequisite; Success Criteria 1 and 2 depend on it. Vitest wrapper gates the script into CI.
- [ ] Commit: `test: add validate-astro-support script with precision/recall metrics and CI wrapper`

---

### Task 21: Update tool count in documentation (72→76 total, 36→40 core)
**Files:** `CLAUDE.md`, `src/instructions.ts`, `README.md`
**Complexity:** standard
**Dependencies:** Task 17 (tools registered)
**Execution routing:** default implementation tier

- [ ] RED: Run `grep -rn "72 tools\|72 MCP\|36 core" src/ CLAUDE.md README.md` — expect occurrences that need updating.
- [ ] GREEN:
  - `CLAUDE.md`: update "72 MCP tools (36 core + 36 discoverable)" to "76 MCP tools (40 core + 36 discoverable)"; update architecture section
  - `src/instructions.ts`: update `CODESIFT_INSTRUCTIONS` if tool count is mentioned
  - `README.md`: update tool count references
  - (Website files in `../codesift-website/` are deferred to a follow-up PR per CLAUDE.md checklist — do NOT modify here)
- [ ] Verify: `grep -rn "72 tools\|72 MCP\|36 core" src/ CLAUDE.md README.md 2>/dev/null; echo "exit=$?"`
  Expected: no matches, grep exits with code 1 (success: no stale counts).
- [ ] Acceptance: Spec AC Ship #24 (both deltas updated; grep verification returns no stale occurrences).
- [ ] Commit: `docs: bump tool count to 76 total / 40 core for 4 new Astro tools`

---

### Task 22: Run full test suite and validation gates
**Files:** none (verification only)
**Complexity:** standard
**Dependencies:** all prior tasks
**Execution routing:** default implementation tier

- [ ] RED: N/A (verification task; no new test to write)
- [ ] GREEN: N/A (no code changes)
- [ ] Verify (all 5 gates must pass; zero ambiguity allowed):
  1. `npx vitest run` → exit code 0 AND output line matches `/Tests:\s+\d+\s+passed/` with passed count ≥ 1031 (baseline 944 + 87 new). Fewer = regression.
  2. `npx tsc --noEmit` → exit code 0, zero errors emitted to stdout/stderr.
  3. `./scripts/validate-astro-support.sh tests/fixtures/astro-project` → exit code 0 AND stdout contains 3 PASS lines for `island_precision`, `island_recall`, `route_coverage`.
  4. `grep -rn "72 tools\|72 MCP\|36 core" src/ CLAUDE.md README.md 2>/dev/null; [ $? -eq 1 ]` → grep exits 1 (no stale counts remain).
  5. `node dist/cli.js call get_extractor_versions` → JSON output includes `"astro": "1.0.0"` field.
  Any gate failing blocks merge. No "looks good" judgments.
- [ ] Acceptance: Spec Success Criteria — all ship gates pass; feature is ready for merge.
- [ ] Commit: none (no changes); this is a gate task.

> **Adversarial review note**: This task is a hard gate — no subjective language. Each of the 5 verify steps is a concrete command with a binary pass/fail. If any fails, the feature is not ready; do not proceed to merge. Dogfood against real OSS Astro repos (codesift-website, Astro starter-blog, Astro docs) is tracked separately as Success Criteria 1/2 via Task 20's validate script and is NOT part of this local gate.

---

## Task Dependency Graph

```
1 (.mdx)          ─┐
2 (exports)       ─┤
3 (framework-det) ─┤
4 (RouteFrame)    ─┤─── Foundation (parallel) ───┐
5 (import-graph)  ─┤                              │
6 (dispatch case) ─┘                              │
                                                  │
7 (astro-template) ───── Shared parser ──────────┤
                                                  │
8 (extractor RED+GREEN, 10 bug fixes)             │
                │                                 │
                ▼                                 │
        9 (EXTRACTOR_VERSIONS + lockfile) ────────┤
                │                                 │
                ▼                                 │
        10 (astro_analyze_islands)                │
                │                                 │
                ▼                                 │
        11 (astro_hydration_audit) ───────────────┤
                                                  │
        12 (astro_route_map) ─────────────────────┤
                                                  │
        13 (astro_config) ────────────────────────┤
                │                                 │
                ▼                                 │
        14 (analyzeProject branch)                │
                                                  │
        15 (traceRoute wiring) ───────────────────┤
                                                  │
        16 (6 patterns) ──────────────────────────┘
                │
                ▼
        17 (register-tools)
                │
                ▼
        18 (fixture files)
                │
                ▼
        19 (integration test)
                │
                ▼
        20 (validate script + wrapper)
                │
                ▼
        21 (docs tool count)
                │
                ▼
        22 (final verification)
```

Tasks 1-6 are fully parallel (foundation). Task 7 is the critical path. Tasks 10-16 can parallelize once Tasks 7+8 are done (10/11 share file, 12/13 independent, 14 depends on 13, 15 depends on 12, 16 independent).

## Acceptance Coverage Matrix

| Spec AC | Task(s) covering it |
|---------|---------------------|
| Ship #1 (CRLF/BOM) | Task 8 |
| Ship #2 (end_line correct) | Task 8 |
| Ship #3 (tokens populated) | Task 8 |
| Ship #4 (kind: "component") | Task 8 |
| Ship #5 (template-only sanitized) | Task 8 |
| Ship #6 (EXTRACTOR_VERSIONS astro) | Task 9 |
| Ship #7 (auto re-index) | Task 9 |
| Ship #8 (import-graph .astro) | Task 5 |
| Ship #9 (.mdx mapping) | Task 1 |
| Ship #10 (framework-detect) | Task 3 |
| Ship #11 (analyzeProject complete) | Task 14 |
| Ship #12 (trace_route Astro) | Task 15 |
| Ship #13 (6 directives) | Task 7 |
| Ship #14 (target_kind distinction) | Task 7 |
| Ship #15 (astro_analyze_islands) | Task 10 |
| Ship #16 (astro_hydration_audit AH01-12) | Task 11 |
| Ship #17 (astro_route_map) | Task 12 |
| Ship #18 (route conflicts) | Task 12 |
| Ship #19 (config parser) | Task 13 |
| Ship #20 (config_resolution) | Task 13 |
| Ship #21 (6 patterns) | Task 16 |
| Ship #22 (87 tests) | All test tasks |
| Ship #23 (CORE_TOOL_NAMES) | Task 17 |
| Ship #24 (tool count docs) | Task 21 |
| Success #1 (90% precision) | Task 20 (validate script) |
| Success #2 (95% coverage) | Task 20 |
| Success #3 (analyze_project complete) | Task 14 + Task 19 |
| Success #4 (trace_route Astro) | Task 15 + Task 19 |
| Success #5 (hydration audit signal) | Task 11 |
| Success #6 (dogfood) | Task 22 |

All spec ACs have task coverage. No orphan criteria.

## Estimated Effort

- **Foundation (Tasks 1-6)**: ~1 hour total (6 standard tasks × ~10 min each)
- **Template parser (Task 7)**: ~45 min (complex, 25 tests + implementation)
- **Extractor overhaul (Tasks 8-9)**: ~45 min (RED tests + GREEN fixes)
- **Cache invalidation (Task 10)**: ~45 min (complex, concurrent I/O)
- **New tools (Tasks 11-14)**: ~2.5 hours (4 complex tool implementations)
- **Integrations (Tasks 15-17)**: ~30 min (3 standard wiring tasks)
- **Registration + integration (Tasks 18-19)**: ~45 min
- **Validation + docs (Tasks 20-22)**: ~30 min

**Total estimated effort**: ~7 hours of focused implementation work, assuming tests are written first and verified after each task.
