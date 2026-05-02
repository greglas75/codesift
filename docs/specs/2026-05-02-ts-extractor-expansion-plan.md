# Implementation Plan: TypeScript Extractor Expansion (P0+P1)

**Spec:** `docs/specs/2026-05-01-ts-extractor-expansion-spec.md`
**spec_id:** 2026-05-01-ts-extractor-expansion-0923
**planning_mode:** spec-driven
**source_of_truth:** approved spec
**plan_revision:** 7
**status:** Approved
**Created:** 2026-05-02
**Tasks:** 21 (Task 0 pre-flight baseline capture + Tasks 1–19 with 17 split into 17a/17b)
**Estimated complexity:** 13 standard + 8 complex (5–7 days implementation)
**Execution order:** Task 0 → 5 → 4 → 1 → (2, 3, 6 parallel after 1) → 7→8→9a→9b→9c→10a→10b→11 → 12 → 13 → 14 → 15 → 16 → 17a → 17b → 18 → 19. Numbering reflects logical grouping; execution order takes precedence where it differs. **Task 2 depends on Task 1** (`makeSymbol` opts type extension requires `CodeSymbol.implements` to exist first) — they cannot run in parallel.

## Architecture Summary

Three new modules + extensions to seven existing files. New deps: `get-tsconfig@^4.13.0`.

**New modules:**
- `src/utils/ts-imports.ts` — tree-sitter AST extractor for TS/TSX imports + re-exports; flags `is_type_only` per statement and per specifier.
- `src/utils/tsconfig-paths.ts` — `get-tsconfig` wrapper resolving `@alias/*` to absolute paths; two-tier in-process cache (`configCache`, `dirToConfigCache`); cleared on `index_folder` start.
- `src/tools/_helpers.ts` — MCP tool-layer utilities; first occupant `staleToMcpError(stale)` converts `IndexOrStaleResult` discriminated union to standard MCP `{isError:true, content}` envelope.

**Modified existing:**
- `src/types.ts` — add `implements?: string[]` to `CodeSymbol` (additive, optional).
- `src/parser/extractors/_shared.ts` — pipe `implements` through `makeSymbol` opts.
- `src/parser/extractors/typescript.ts` (927→~1080L) — 2 new cases (`internal_module`, `ambient_declaration`); 7 case extensions; 5 new private helpers (`getClassHeritage`, `extractHeritageName`, `hasAsyncModifier`, `getModifiers`, `getAccessorKind`); refactor `isReactClassComponent` to share heritage walk; extend `getSignature` for `type_parameters`; wrap top-level `walk()` in `try/catch RangeError`.
- `src/utils/import-graph.ts` — new TS/TSX branch via `extractTypeScriptImports`; **reuses existing module-level `getCachedParse`/`setCachedParse` from `src/parser/parse-cache.ts`** (LRU singleton, 500-entry cap, already imported via line 9 for the Python branch); update `find_circular_deps` filter to `edge.type_only === true` only.
- `src/tools/index-tools.ts` — `loadIndex` returns discriminated union; new `loadIndexOrStale` helper; `clearTsconfigCache()` called at `index_folder` entry; migrate 2 query-side callsites (lines 969, 1022); retain `loadIndex` for 2 saveIncremental-path callers (lines 366, 808). **Safety:** the public single-file `index_file` MCP tool wrapper additionally calls `loadIndexOrStale` at entry — preventing the "saveIncremental on stale index → mixed-schema corruption" risk (Adversarial finding gemini-1). Internal helpers stay on `loadIndex` because by then the index has been version-validated by the entry-level guard.
- `src/tools/conversation-tools.ts` — migrate 1 `loadIndex` callsite (line 245).
- `src/tools/project-tools.ts` — bump `EXTRACTOR_VERSIONS.typescript` from `"2.1.0"` to `"3.0.0"`.

**Dependency direction (no cycles):**
```
types.ts → _shared.ts → typescript.ts
                    ↘ ts-imports.ts ↘
                       tsconfig-paths.ts → get-tsconfig (npm)
                                       ↘ import-graph.ts
_helpers.ts → index-tools.ts ← project-tools.ts
                            ← conversation-tools.ts
```

## Technical Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Walk structure | Single `walk()` switch with inline cases | Established convention (15+ existing cases). Adds ~150L; total stays under 1100L. No precedent for sub-handlers. |
| Helper placement | File-private functions in `typescript.ts` | Matches `getNodeName`, `getDocstring`, `getSignature` precedent. No external reuse needed. |
| `getClassHeritage` reuse | Refactor out of `isReactClassComponent`, both functions share AST walk | Eliminates only existing heritage-walk duplication. |
| `staleToMcpError` location | `src/tools/_helpers.ts` (NEW) | `index-tools.ts` already 1006L; `_helpers.ts` follows `_shared.ts` precedent for tool-layer utilities. |
| `loadIndex` migration | Single PR, 3 query-side callsites migrated (2 in `index-tools.ts`: lines 969, 1022; 1 in `conversation-tools.ts`: line 245). 2 saveIncremental-path callers in `index-tools.ts` (lines 366, 808) retain `loadIndex` — they read-then-mutate-then-saveIncremental and are not user-query surfaces. | Inventory contract test (AC#6) enumerates registered MCP tools; saveIncremental paths are not registered, so they're naturally excluded. |
| Parse cache reuse | Existing module-level singleton in `src/parser/parse-cache.ts` (LRU, 500-entry cap, hit/miss counters, `resetParseCache()` for tests) | Already battle-tested for Python; TS branch imports it identically. NO new cache layer. Reset via existing `resetParseCache()` in `beforeEach` for tests. |
| tsconfig resolver lib | `get-tsconfig@^4.13.0` (zero transitive deps; MIT) | Handles `extends` chains, cyclic guard, BOM, node_modules-extends. Replaces ~150L of fragile regex. |
| L11 vs React classification | Anonymous default returning JSX → `kind: "default_export"` (per spec AC#10), record `meta.is_react_component: true` for JSX detection | Honors spec's explicit kind choice while preserving React-tool discoverability. |
| Test conventions | Inline source strings + real parser; one describe per gap | Matches `python-imports.test.ts` pattern; spec AC#1 mandates one file with one describe per gap. |

## Quality Strategy

**Test pyramid:**
- Unit: `ts-imports.test.ts` (7 import shapes), `tsconfig-paths.test.ts` (6 resolver scenarios), `_helpers.test.ts` (1 envelope shape).
- Module: `typescript-extractor-gaps.test.ts` (one describe per L1–L12 gap with `.ts` AND `.tsx` fixture per case).
- Integration: `index-tools-stale.test.ts` (contract test: every registered MCP tool returns `isError:true` on stale fixture index); `import-graph.test.ts` extension (TS branch + cycle filter); `tsconfig-paths.test.ts` monorepo fixture.
- Regression: existing 96 typescript-extractor tests must remain green throughout.

**CQ gates activated:**
- **CQ6 (unbounded data):** caches in `tsconfig-paths.ts` documented as bounded by tsconfig file count; parse cache GC'd by function scope.
- **CQ8 (error handling):** every `get-tsconfig` call wrapped in try/catch with warn log + null-return fallback. Verified by malformed-tsconfig fixture test.
- **CQ14 (duplication):** `isReactClassComponent` MUST call `getClassHeritage` post-refactor (no copy-paste).
- **CQ19 (API contract):** stale-index MCP error envelope contract test asserts `isError:true` AND text contains `extractor_version_mismatch`.

**Risk areas (from QA report):**
1. Regression on 96 existing TS tests — required CI gate before new tests merge.
2. Missed `loadIndex` callsite — CQ19 contract test catches.
3. `tsconfig-paths.ts` cache inter-test contamination — `clearTsconfigCache()` in `beforeEach`.
4. Cross-grammar TSX divergence — `.ts` + `.tsx` fixture per new case.
5. `getCachedParse` already module-level singleton in `parse-cache.ts` — TS branch reuses it; tests call existing `resetParseCache()` in `beforeEach`.
6. CI runner perf variability — accepted; ratio gate is informational if flaky.

## Coverage Matrix

| Row ID | Authority item | Type | Primary task(s) | Notes |
|---|---|---|---|---|
| AC1 | `typescript-extractor-gaps.test.ts` exists, describe per gap | requirement | Tasks 7, 8, 9a, 9b, 9c, 10a, 10b, 11 | Each L-task creates its describe block; AC1 listed in each task's Acceptance |
| AC2 | `tsconfig-paths.test.ts` covers 6 cases | requirement | Task 4 | |
| AC3 | `ts-imports.test.ts` covers 7 import shapes (no dynamic) | requirement | Task 3 | |
| AC4 | `EXTRACTOR_VERSIONS.typescript = "3.0.0"` + CI guard active | requirement | Tasks 15, 16 | |
| AC5 | `get-tsconfig` in `dependencies` (not `devDependencies`) | requirement | Task 5 | |
| AC6 | `class Foo extends Bar implements Baz<T>` → normalized arrays | requirement | Task 7 | Heritage normalization |
| AC7 | `enum Direction { North = 1, South }` → 1 enum + 2 constants parented | requirement | Task 9a | |
| AC8 | `function identity<T extends Foo>(x: T): T` → signature has `<T extends Foo>` | requirement | Task 8 | |
| AC9 | `import type {X}` → `type_only:true`; mixed → `type_only:false` | requirement | Tasks 3, 12 | AST-level detection + edge propagation |
| AC10 | `export default function() { return <div/> }` → name=default, kind=default_export | requirement | Task 10a | |
| AC11 | `declare module "x" { export function bar() }` → `x` namespace, `bar` exported | requirement | Task 10b | ambient_declaration + internal_module |
| AC12 | `namespace M { export class C {} }` → M (namespace) + C (parented class) | requirement | Task 10b | |
| AC13 | Monorepo `@shared/*` resolves edge | requirement | Tasks 4, 12 | Resolver + import-graph integration |
| ACS1 | `meta.modifiers` populated (static/abstract/readonly/private/public/protected/override) | requirement | Task 9c | |
| ACS2 | `meta.accessor_kind` populated on get/set | requirement | Task 9c | |
| ACS3 | `is_async: true` on async TS functions/methods/arrows | requirement | Task 9b | |
| ACS4 | Every new case has `.ts` AND `.tsx` fixture | requirement | Tasks 7–10 | Per-task fixture pair |
| ACS5 | `loadIndex` returns discriminated union | requirement | Task 13 | |
| ACS6 | All 5 callsites migrated, contract test asserts no orphans | requirement | Tasks 13, 14, 16 | |
| ACE1 | `try/catch RangeError` on top-level walk; logs + partial | requirement | Task 11 | |
| ACE2 | Malformed tsconfig caught, warn log, no-alias fallback | requirement | Task 4 | |
| ACE3 | ERROR nodes warn-log without crash | requirement | Task 11 | |
| ACE4 | `find_circular_deps` doesn't regress on existing JS cycles | requirement | Task 12 | filter is `type_only===true` only |
| SC1 | Heritage capture ≥80% on `tests/fixtures/heritage-coverage/` | success | Task 17a | Validation script |
| SC2 | Alias resolution edges match `tests/fixtures/tsconfig-monorepo/` hand-traced graph | success | Tasks 4, 12 | Integration test in `tsconfig-paths.test.ts` + `import-graph.test.ts` |
| SC3 | Performance ≤1.8× recorded baseline (baseline captured pre-change in Task 0) | success | Task 17b | validates against Task 0's recorded `baseline.json` |
| SC4 | Type-only cycle eliminated on `tests/fixtures/type-only-cycle/` | success | Task 12 | Cycle count = 1 after, =2 before; fixture lives with Task 12 |
| SC5 | `scripts/validate-ts-extractor-gaps.ts` wired into CI | success | Task 17a | wiring lives where script is authored |
| D1 | `src/utils/ts-imports.ts` | deliverable | Task 3 | |
| D2 | `src/utils/tsconfig-paths.ts` | deliverable | Task 4 | |
| D3 | `src/tools/_helpers.ts` | deliverable | Task 6 | |
| D4 | `src/types.ts` `CodeSymbol.implements` | deliverable | Task 1 | |
| D5 | `src/parser/extractors/_shared.ts` `makeSymbol` opts | deliverable | Task 2 | |
| D6 | `src/parser/extractors/typescript.ts` walk extensions + 5 helpers | deliverable | Tasks 7–11 | |
| D7 | `src/utils/import-graph.ts` TS branch + getCachedParse | deliverable | Task 12 | |
| D8 | `src/tools/index-tools.ts` discriminated union + 4 callsites + clearTsconfigCache call | deliverable | Task 13 | |
| D9 | `src/tools/conversation-tools.ts` 1 callsite migration | deliverable | Task 14 | |
| D10 | `src/tools/project-tools.ts` version bump | deliverable | Task 15 | |
| D11 | `package.json` get-tsconfig dep | deliverable | Task 5 | |
| D12 | `.github/workflows/extractor-version-guard.yml` | deliverable | Task 16 | |
| D13 | `scripts/validate-ts-extractor-gaps.ts` | deliverable | Task 17a | |
| D14 | `scripts/bench-index.sh` | deliverable | Task 0 (harness) + Task 17b (validation) | |
| D15 | `tests/fixtures/tsconfig-monorepo/` | deliverable | Task 4 | |
| D16 | `tests/fixtures/heritage-coverage/` + expected.json | deliverable | Task 17a | 20-file NestJS-shaped corpus |
| D17 | `tests/fixtures/type-only-cycle/` + expected.json | deliverable | Task 12 | committed alongside import-graph TS branch |
| D18 | `tests/fixtures/perf-bench/` + baseline.json | deliverable | Task 0 | pre-change baseline; Task 17b validates against it |
| D19 | `tests/tools/index-tools-stale.test.ts` (inventory) | deliverable | Task 16 | |
| C1 | TS/TSX dual-grammar parity | constraint | Tasks 7–11 | enforced via fixture pairs |
| C2 | All 3 **query-side** `loadIndex` callsites migrated to `loadIndexOrStale`; 2 saveIncremental-path callers retain `loadIndex` (lines 366, 808 in `index-tools.ts`) and are explicitly out of the inventory check | constraint | Tasks 13, 14, 16 | inventory test enumerates only registered MCP tools, naturally excluding internal saveIncremental helpers |
| C3 | `getClassHeritage` shared by `isReactClassComponent` (DRY) | constraint | Task 7 | post-refactor regression test |
| C4 | Parse cache reused from existing `parse-cache.ts` (no new cache layer) | constraint | Task 12 | reuse via import; reset in tests via `resetParseCache()` |

## Review Trail

- **Plan reviewer rev 1 → ISSUES FOUND:** (a) Task 12 created phantom function-scoped `getCachedParse`, but `src/parser/parse-cache.ts` already exports a module-level LRU singleton — would have caused build/dead-code conflict. (b) Task 17 originally bundled 226+ files (validation script + 20-file heritage fixture + 200-file perf corpus + scripts + baselines) — exceeded 1–5 file boundary. (c) Plus self-discovered correction: callsite count was overstated as 4+1=5; actual query-side migration is 2+1=3 (saveIncremental retentions: 2).
- **Plan revision 2 fixes:** (a) Task 12 + Architecture Summary + Technical Decisions table all rewritten to reuse existing `parse-cache.ts` (with `resetParseCache()` in tests). (b) Task 17 split into 17a (validation script + heritage fixture, SC1+SC5+D13+D16) and 17b (perf benchmark + synthetic corpus + baseline, SC3+D14+D18). (c) Task 13 description corrected to 2 query-side migrations (lines 969, 1022) + retention of saveIncremental callers (lines 366, 808) with explanatory comment.
- **Plan reviewer rev 2 → ISSUES FOUND:** Coverage Matrix rows D13/D14/D16/D17/D18 still pointed to monolithic "Task 17" after the split — dead references.
- **Plan revision 3 fixes:** Coverage Matrix retargeted: D13→17a, D14→17b, D16→17a (with note), D17→12 (note), D18→17b (note).
- **Plan reviewer rev 3 → APPROVED.**
- **Adversarial review (cross-model: codex-5.3, gemini, cursor-agent) → 5 CRITICAL + 5 WARNING.**
- **Plan revision 4 fixes:** (a) Task 4↔5 execution-order ambiguity — added "Execution note: run Task 5 before Task 4" wording. (b) `find_circular_deps` filter wording corrected — EXCLUDE `type_only===true` edges (not include). (c) C2 row updated — 3 query-side migrations + 2 saveIncremental retentions explicitly stated; not "all 5". (d) Tasks 13/14 RED tests now mock `EXTRACTOR_VERSIONS.typescript` via `vi.spyOn` so they don't depend on Task 15's bump landing first. (e) New Task 0 (pre-flight) captures perf baseline against `main` BEFORE any extractor changes; old Task 17b becomes pure validation against Task 0's baseline. (f) `index_file` MCP wrapper gets entry-level `loadIndexOrStale` guard, eliminating saveIncremental-on-stale-index corruption risk; internal helpers retain `loadIndex` only behind that guard. (g) Inventory contract test stub created in Task 13 (RED-style discovery) so missed callsites surface during Task 13/14, not at Task 16.
- **Open warnings accepted:** Task 12 size (multi-concern) — accepted as cohesive integration unit; Tasks 18/19 doc verification weakness — release housekeeping, low risk.
- **Adversarial review iter-2 (rev-4) → 3 CRITICAL + 5 WARNING + 2 INFO.**
- **Plan revision 5 fixes:** (a) Execution-order parallel statement corrected — Task 2 depends on Task 1 (cannot parallelize). (b) Task 0 baseline.json commit-back path made explicit via `workflow_dispatch` GHA workflow that commits to feature branch before extractor changes; verification check added (`git log baseline.json` confirms pre-Task-1 commit). (c) Task 16 inventory test no longer invokes MCP tools blindly — uses regex grep over `src/tools/*.ts` files at test runtime to enumerate `loadIndex(` callsites; only the 2 saveIncremental retentions are allowed. (d) Tasks 13/14 RED corrected: `vi.replaceProperty()` instead of `vi.spyOn()` (Vitest cannot spy on primitive string properties). (e) Task 16 CI guard scoped to AST-relevant identifier diffs in `typescript.ts`, not pure comment/whitespace changes. (f) SC5 wiring step added to existing `ci.yml` workflow in Task 16 GREEN. (g) Task 16 fan-back wording removed — rev-4 moved discovery to Task 13 RED; Task 16 now strictly verifies, doesn't discover. (h) AC1 added to Tasks 7–11 Acceptance fields; SC2 added to Tasks 4 and 12 Acceptance fields.
- **Adversarial iter-2 INFO/medium accepted:** Task 12 size (cohesive integration), Task 17b late perf detection (mitigated by Task 0 pre-baseline + interim `time` checks during dev), structured logging beyond unit tests (out of scope for this spec).
- **Adversarial iter-3 (rev-5) → 4 CRITICAL + 5 WARNING.**
- **Plan revision 6 fixes:** (a) Task 16 wired SC5 to a script that didn't exist yet (Task 17a authors the script). Moved SC5 wiring to Task 17a GREEN step (4); Task 16 scope is now strictly CI version guard + inventory test. (b) Inventory test grep updated — allowed `loadIndex(` count in `index-tools.ts` is **3** (2 saveIncremental retentions + 1 internal delegation inside `loadIndexOrStale` itself), not 2; the test excludes the wrapper's internal call by line marker. (c) Task 13 Acceptance no longer claims ACE2 (which Task 4 owns for malformed-tsconfig); replaced with note that `clearTsconfigCache` integration is part of D8.
- **Adversarial iter-3 WARNING accepted:** Task 0 size (cohesive baseline-capture unit; splitting reduces traceability); Task 17b risk concentration (same as iter-2; Task 0 mitigates); generic `vitest run` verification (existing pattern; per-task assertions are explicit elsewhere).
- **False positive:** "Plan not self-contained — Task 17b missing" — Task 17b is present (lines 384–399); adversarial misread.
- **Adversarial pre-execute pass (rev-6 → 4 CRITICAL + 6 WARNING):** Hook fired on `zuvo:execute` startup; cross-provider review of staged spec+plan caught 4 REAL pseudocode bugs that 3 prior plan-reviewer + 3 prior adversarial passes missed:
  1. **`extractHeritageName` missed `identifier` node** — `extends Foo` parses as `identifier`, NOT `type_identifier`; without the case, all standard ES6 class inheritance was silently dropped.
  2. **Intersection/union types truncated to first element** — pseudocode said "callers handle list expansion" but didn't actually expand; `extends A & B` would record only `["A"]`.
  3. **Empty-string probe matched directories** — `TS_EXTENSIONS[0] === ""` + `existsSync` returns true for both files and dirs → alias `@/components/Button` (directory) resolves to dir path → fails `normalizedPaths.get` (file-only) → edge silently dropped.
  4. **AST-failure path log+skip instead of regex fallback** — Task 12 GREEN said `catch (err) { /* log + skip */ }` despite spec/Rollback claiming regex fallback; would lose all imports for parser-erroring files.
- **Plan revision 7 fixes (load-bearing pre-implementation):** (1) `extractHeritageNames` (renamed; returns `string[]`) handles `identifier` AND `type_identifier`; recursion expands intersection/union via `flatMap`. (2) Spec § Detailed Design code sketch updated to match. (3) Task 7 GREEN explicitly lists 5 required test fixtures including `extends Foo`, `extends Foo & Bar`. (4) `tsconfig-paths.ts` empty-string probe gates with `statSync(candidate).isFile()` to reject directories. (5) Task 4 RED test list grows from 6 to 7 cases (added "alias to directory resolves to index.ts, not dir"). (6) Task 12 GREEN includes explicit regex-fallback pseudocode in `catch` block instead of "log + skip". 
- Cross-model validation: rev-7 — adversarial findings address all 4 CRITICAL pseudocode bugs. Further iterations would converge on prose nitpicks; ship rev-7 to execute.
- Status gate: Draft → Approved (user authorized via "panuj" + "ODPAALJ"; rev-7 fixes are pre-implementation pseudocode corrections that prevent CRITICAL bugs from reaching code).

## Task Breakdown

### Task 1: Add `implements?: string[]` to `CodeSymbol`
**Files:** `src/types.ts`, `tests/types.test.ts` (or extend existing)
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: In `tests/types.test.ts`, add `it("CodeSymbol accepts implements field")`. Construct a `CodeSymbol` literal with `implements: ["Foo", "Bar"]` and assert via `expect(sym.implements).toEqual(["Foo", "Bar"])`. Compile must fail before edit (TS error: property does not exist).
- [ ] GREEN: Add `implements?: string[]` to `CodeSymbol` interface at `src/types.ts:42-57`. Place adjacent to existing `extends?: string[]`.
- [ ] Verify: `npx tsc --noEmit && npx vitest run tests/types.test.ts`
  Expected: `Tests: 1 passed` and zero `tsc` errors.
- [ ] Acceptance: D4
- [ ] Commit: `add implements field to CodeSymbol schema`

### Task 2: Pipe `implements` through `makeSymbol`
**Files:** `src/parser/extractors/_shared.ts`, `tests/parser/_shared.test.ts` (new)
**Complexity:** standard
**Dependencies:** Task 1
**Execution routing:** default

- [ ] RED: New `tests/parser/_shared.test.ts` with `it("makeSymbol propagates implements")`. Call `makeSymbol(node, "Foo", "class", file, src, repo, { implements: ["Bar"] })` and assert `sym.implements === ["Bar"]`. Fails because opts type currently has no `implements`.
- [ ] GREEN: Extend opts type at `src/parser/extractors/_shared.ts:30-38` to include `implements?: string[]`. After existing `if (opts?.extends && opts.extends.length > 0) sym.extends = opts.extends;` add `if (opts?.implements && opts.implements.length > 0) sym.implements = opts.implements;`.
- [ ] Verify: `npx vitest run tests/parser/_shared.test.ts`
  Expected: `Tests: 1 passed`. Existing `_shared` callers still compile.
- [ ] Acceptance: D5
- [ ] Commit: `pipe implements field through makeSymbol opts`

### Task 3: New `ts-imports.ts` AST extractor
**Files:** `src/utils/ts-imports.ts`, `tests/utils/ts-imports.test.ts`
**Complexity:** standard
**Dependencies:** none (uses existing `web-tree-sitter`)
**Execution routing:** default

- [ ] RED: New `tests/utils/ts-imports.test.ts` mirrors `tests/utils/python-imports.test.ts` pattern. Add 7 named `it` blocks covering: (1) `import type { X } from "./y"` → `type_only:true`, (2) `import { type X, Y } from "./y"` → `type_only:false` (any runtime present), (3) `import { X } from "./y"` → `type_only:false`, (4) `import * as ns from "./y"` → runtime, (5) `import "./side-effect"` → runtime, default + type, (6) `export { X } from "./y"` → runtime, (7) `export type { X } from "./y"` → `type_only:true`. All fail with module-not-found.
- [ ] GREEN: Create `src/utils/ts-imports.ts` exporting `interface TsImportEdge { path: string; is_type_only: boolean; specifiers: string[] }` and `function extractTypeScriptImports(tree: Parser.Tree): TsImportEdge[]`. Walk `import_statement` and `export_statement` nodes (when `source` field present). Detect statement-level `type` modifier child; per-specifier `type` keyword on `import_specifier`. Edge is `type_only:true` only when ALL specifiers are typed OR statement-level `type` is present. ≤90 LOC.
- [ ] Verify: `npx vitest run tests/utils/ts-imports.test.ts`
  Expected: `Tests: 7 passed`.
- [ ] Acceptance: AC3, AC9 (extractor side), D1
- [ ] Commit: `add tree-sitter AST extractor for TS imports and re-exports`

### Task 4: New `tsconfig-paths.ts` resolver + monorepo fixture
**Files:** `src/utils/tsconfig-paths.ts`, `tests/parser/tsconfig-paths.test.ts`, `tests/fixtures/tsconfig-monorepo/{tsconfig.json, tsconfig.base.json, packages/foo/tsconfig.json, packages/foo/src/x.ts, packages/shared/utils.ts}`
**Complexity:** complex
**Dependencies:** Task 5 (`get-tsconfig` must be installed FIRST)
**Execution routing:** deep
**Execution note:** despite the lower task number, **execute Task 5 before Task 4** — Task 4 imports `get-tsconfig` which Task 5 installs. The numbering reflects logical grouping (resolver design before package install), not execution order.

- [ ] RED: New `tests/parser/tsconfig-paths.test.ts` with 7 `it` blocks: simple `@/foo` alias resolves to `.ts`; nested package config with `extends` chain; BOM-prefixed tsconfig parses; cyclic `extends` does not hang (10s timeout); missing `extends` target → warn log, returns null; alias mapped to non-existent file → returns null after probing all extensions; **alias mapped to a directory (e.g., `@/components/Button` where `Button` is a directory with `index.ts`) → resolves to `Button/index.ts`, NOT the directory itself** (regression guard for the empty-string probe + directory-match bug). Add `clearTsconfigCache()` in `beforeEach`. All fail with module-not-found.
- [ ] GREEN: Create `src/utils/tsconfig-paths.ts` per spec § Detailed Design. Two `Map` caches (`configCache`, `dirToConfigCache`). `TS_EXTENSIONS = ["", ".ts", ".tsx", ".d.ts", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"]` — empty string FIRST so exact-file aliases work. **CRITICAL**: when the empty-string probe hits, verify `statSync(candidate).isFile()` is TRUE before returning. `existsSync` returns true for both files AND directories; without the `isFile()` check, alias `@/components/Button` (a directory containing `index.ts`) would resolve to the directory path, then fail the `normalizedPaths.get(resolved)` lookup downstream (which contains files only), silently dropping the edge. The fix: the empty-string probe is `existsSync(candidate) && statSync(candidate).isFile()`; for `/index.ts` and other suffixed probes, `existsSync` alone is fine. Walk up via `dirToConfigCache`. Use `getTsconfig()` for parsing + extends resolution. Wrap all calls in try/catch with `console.warn` and null fallback. Export `resolveTsAliasedImport`, `clearTsconfigCache`. ≤140 LOC. Plus monorepo fixture: root tsconfig with `paths: { "@shared/*": ["packages/shared/*"] }`, package tsconfig with `extends: "../../tsconfig.base.json"`.
- [ ] Verify: `npx vitest run tests/parser/tsconfig-paths.test.ts`
  Expected: `Tests: 6 passed`. Cyclic test completes within 10s.
- [ ] Acceptance: AC2, AC13 (resolver side), ACE2, SC2 (alias resolver side), D2, D15, CQ8
- [ ] Commit: `add tsconfig.json paths resolver via get-tsconfig`

### Task 5: Add `get-tsconfig` dependency
**Files:** `package.json`, `package-lock.json`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: Docs/config-only — RED step is the absence of `get-tsconfig` in `dependencies`. Verify `! grep -q '"get-tsconfig"' package.json` succeeds.
- [ ] GREEN: Run `npm install --save get-tsconfig@^4.13.0`. Confirm new entry under `dependencies`, NOT `devDependencies`.
- [ ] Verify: `node -e "require('get-tsconfig'); console.log('ok')" && grep '"get-tsconfig"' package.json | grep -v devDependencies`
  Expected: prints `ok` and grep finds entry under `dependencies`.
- [ ] Acceptance: AC5, D11
- [ ] Commit: `add get-tsconfig dependency for tsconfig paths resolution`

### Task 6: New `_helpers.ts` with `staleToMcpError`
**Files:** `src/tools/_helpers.ts`, `tests/tools/_helpers.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: New `tests/tools/_helpers.test.ts` with `it("staleToMcpError produces MCP isError envelope")`. Assert `result.isError === true`, `result.content[0].type === "text"`, `/extractor_version_mismatch/.test(result.content[0].text)`, `/expected 3.0.0/.test(...)`, `/got 2.1.0/.test(...)`. Fails with module-not-found.
- [ ] GREEN: Create `src/tools/_helpers.ts` per spec § Detailed Design. Export `staleToMcpError(stale: { reason: string; expected_version: string; actual_version: string }): { isError: true; content: [{ type: "text"; text: string }] }`. ≤40 LOC.
- [ ] Verify: `npx vitest run tests/tools/_helpers.test.ts`
  Expected: `Tests: 1 passed`.
- [ ] Acceptance: D3, CQ19
- [ ] Commit: `add staleToMcpError helper for MCP error envelope conversion`

### Task 7: Extractor — L4 heritage (`extends`/`implements`) + `getClassHeritage` refactor
**Files:** `src/parser/extractors/typescript.ts`, `tests/parser/typescript-extractor-gaps.test.ts` (NEW), `tests/fixtures/ts/heritage.ts`, `tests/fixtures/tsx/heritage.tsx`
**Complexity:** complex
**Dependencies:** Task 1, Task 2
**Execution routing:** deep

- [ ] RED: New `tests/parser/typescript-extractor-gaps.test.ts` with `describe("L4 heritage")` containing: (a) `class Foo extends Bar implements Baz<T>` → `sym.extends===["Bar"]`, `sym.implements===["Baz"]`. (b) `class A extends ns.Base` → `["ns.Base"]` preserved. (c) `class A extends Foo & Bar` → `["Foo", "Bar"]` (intersection split). (d) Existing React class component test still detects `class C extends React.Component` as `kind: "component"`. (e) `.tsx` fixture with same shape produces identical heritage arrays. All fail because `sym.implements` is currently never populated.
- [ ] GREEN: In `typescript.ts`, add private `getClassHeritage(node)` and `extractHeritageNames(typeNode)` (returns `string[]`, not `string|null`) per spec § Detailed Design. **The helper MUST handle the `identifier` node type** — `extends Foo` parses as `identifier` (runtime value position), NOT `type_identifier`. Without this case, all standard ES6 class inheritance is silently dropped. **Intersection/union types expand via `flatMap`**, not first-element-only. Refactor `isReactClassComponent` to call `getClassHeritage` instead of duplicating heritage walk (CQ14). In `class_declaration` / `abstract_class_declaration` cases, call `getClassHeritage` and pass `extends`/`implements` arrays through `makeSymbol` opts. Test fixtures MUST cover: (1) `extends Foo` (single identifier), (2) `extends Foo & Bar` (intersection, both elements present), (3) `implements I, J` (multiple clauses), (4) `extends Foo<T>` (generic, type args stripped), (5) `extends ns.Base` (qualified name preserved).
- [ ] Verify: `npx vitest run tests/parser/typescript-extractor-gaps.test.ts -t "L4" && npx vitest run tests/parser/typescript-extractor.test.ts -t "React class"`
  Expected: L4 tests pass; existing React class component tests still pass.
- [ ] Acceptance: AC1, AC6, ACS4 (heritage case), C1, C3, partial D6
- [ ] Commit: `extract class heritage as extends/implements; share AST walk with React detection`

### Task 8: Extractor — L7 generics in `getSignature`
**Files:** `src/parser/extractors/typescript.ts`, `tests/parser/typescript-extractor-gaps.test.ts`, `tests/fixtures/ts/generics.ts`, `tests/fixtures/tsx/generics.tsx`
**Complexity:** standard
**Dependencies:** Task 7
**Execution routing:** default

- [ ] RED: Add `describe("L7 generics in signature")` with: `function identity<T extends Foo>(x: T): T` → `sym.signature` includes `<T extends Foo>`. `class Box<T = string> { constructor(x: T) }` → constructor signature includes `<T = string>`. Method with generics. `.tsx` parity case. Fails because current `getSignature` ignores `type_parameters`.
- [ ] GREEN: Modify `getSignature(node, source)` per spec — prepend `type_parameters` slice when present. Do NOT prepend `: ` to return type (the `return_type` field already includes the colon).
- [ ] Verify: `npx vitest run tests/parser/typescript-extractor-gaps.test.ts -t "L7" && npx vitest run tests/parser/typescript-extractor.test.ts`
  Expected: L7 tests pass; existing 96 tests still pass.
- [ ] Acceptance: AC1, AC8, ACS4, C1, partial D6
- [ ] Commit: `include type parameters in extracted function signatures`

### Task 9a: Extractor — L3 enum members
**Files:** `src/parser/extractors/typescript.ts`, `tests/parser/typescript-extractor-gaps.test.ts`, `tests/fixtures/ts/enum.ts`, `tests/fixtures/tsx/enum.tsx`
**Complexity:** standard
**Dependencies:** Task 8
**Execution routing:** default

- [ ] RED: Add `describe("L3 enum members")`: `enum Direction { North = 1, South }` → 1 enum container + 2 `kind:"constant"` members with `parent === enum.id`. `enum_assignment` and `property_identifier` both handled. `.tsx` parity. Fails because current `enum_declaration` case breaks without walking body.
- [ ] GREEN: Modify `enum_declaration` case per spec — replace `break` with body walk emitting members as `constant` parented to the enum. Handle `enum_assignment` (with value) and `property_identifier` (no value).
- [ ] Verify: `npx vitest run tests/parser/typescript-extractor-gaps.test.ts -t "L3"`
  Expected: 4 L3 tests pass.
- [ ] Acceptance: AC1, AC7, ACS4, C1, partial D6
- [ ] Commit: `extract enum members as parented constants`

### Task 9b: Extractor — L5 `is_async` flag
**Files:** `src/parser/extractors/typescript.ts`, `tests/parser/typescript-extractor-gaps.test.ts`, `tests/fixtures/ts/async.ts`, `tests/fixtures/tsx/async.tsx`
**Complexity:** standard
**Dependencies:** Task 9a
**Execution routing:** default

- [ ] RED: Add `describe("L5 is_async")`: `async function foo() {}` → `is_async:true`; `function bar() {}` → `is_async:undefined`; `const baz = async () => {}` → `is_async:true`; `class C { async m() {} }` → method `is_async:true`. `.tsx` parity. Fails because TS extractor never sets `is_async`.
- [ ] GREEN: Add private helper `hasAsyncModifier(node): boolean` checking children for `async` keyword token. Apply in `function_declaration`, `generator_function_declaration`, `method_definition`, `abstract_method_signature`, and arrow assignments inside `lexical_declaration`. Pass `is_async` through `makeSymbol` opts.
- [ ] Verify: `npx vitest run tests/parser/typescript-extractor-gaps.test.ts -t "L5"`
  Expected: 4 L5 tests pass.
- [ ] Acceptance: AC1, ACS3, ACS4, C1, partial D6
- [ ] Commit: `set is_async flag on async TS functions methods and arrows`

### Task 9c: Extractor — L8/L9 modifiers + accessor kind
**Files:** `src/parser/extractors/typescript.ts`, `tests/parser/typescript-extractor-gaps.test.ts`, `tests/fixtures/ts/modifiers.ts`, `tests/fixtures/tsx/modifiers.tsx`
**Complexity:** complex
**Dependencies:** Task 9b
**Execution routing:** deep

- [ ] RED: Add `describe("L8 modifiers")`: `class C { static private readonly x: number; protected override foo() {}; abstract bar(): void }` → field `meta.modifiers===["private","readonly","static"]`, method foo `meta.modifiers===["protected","override"]`, abstract method `meta.modifiers===["abstract"]`. Add `describe("L9 accessor kind")`: getter `get name()` → `meta.accessor_kind:"get"`; setter `set name(v)` → `"set"`; auto-accessor `accessor name` → `"accessor"`. `.tsx` parity. All fail because no modifier or accessor kind capture exists.
- [ ] GREEN: Add private helpers `getModifiers(node): string[]` (collects `accessibility_modifier` text + presence of `static`/`abstract`/`readonly`/`override` keyword children) and `getAccessorKind(node): "get"|"set"|"accessor"|undefined` (reads `kind` field of `method_definition` for get/set; checks for `accessor` keyword child for auto-accessor). Apply in `method_definition`, `abstract_method_signature`, `public_field_definition`, `field_definition`. Set via `meta.modifiers` / `meta.accessor_kind` keys.
- [ ] Verify: `npx vitest run tests/parser/typescript-extractor-gaps.test.ts -t "L8|L9"`
  Expected: tests for L8 + L9 pass.
- [ ] Acceptance: AC1, ACS1, ACS2, ACS4, C1, partial D6
- [ ] Commit: `capture method/field modifiers and accessor kind into meta`

### Task 10a: Extractor — L11 anonymous default export
**Files:** `src/parser/extractors/typescript.ts`, `tests/parser/typescript-extractor-gaps.test.ts`, `tests/fixtures/ts/default-export.ts`, `tests/fixtures/tsx/default-export.tsx`
**Complexity:** standard
**Dependencies:** Task 9c
**Execution routing:** default

- [ ] RED: Add `describe("L11 anonymous default")`: `export default function() { return 1 }` → `name:"default"`, `kind:"default_export"`, `is_exported:true`. `export default class {}` → same kind. `.tsx`: `export default function() { return <div/> }` → `kind:"default_export"`, `meta.is_react_component:true`. All fail because anonymous functions/classes inside `export_statement` are silently dropped today.
- [ ] GREEN: In `export_statement` case handler, when iterating children with `isExported=true`, detect unnamed `function_declaration`/`generator_function_declaration`/`class_declaration`/`arrow_function`/`function_expression` and synthesize `name:"default"`, `kind:"default_export"`. For JSX-returning anonymous defaults, also set `meta.is_react_component:true` to preserve React-tool discoverability.
- [ ] Verify: `npx vitest run tests/parser/typescript-extractor-gaps.test.ts -t "L11"`
  Expected: 3 L11 tests pass.
- [ ] Acceptance: AC1, AC10, ACS4, C1, partial D6
- [ ] Commit: `synthesize default name for anonymous default exports`

### Task 10b: Extractor — L2 namespace + L12 ambient declaration
**Files:** `src/parser/extractors/typescript.ts`, `tests/parser/typescript-extractor-gaps.test.ts`, `tests/fixtures/ts/{namespace.ts,ambient.d.ts}`, `tests/fixtures/tsx/namespace.tsx`
**Complexity:** complex
**Dependencies:** Task 10a
**Execution routing:** deep

- [ ] RED: Add `describe("L2 namespace + L12 ambient")`: (a) `namespace M { export class C {} }` → M (kind=namespace, is_exported derived from outer context), C parented to M with kind=class. (b) `module M { ... }` (modern) → kind=namespace. (c) `declare module "x" { export function bar(): void }` (ambient) → x emitted with kind=namespace, `is_exported:true` (special-case for STRING-named module); bar parented with `is_exported:true`. (d) `declare const X: number` → emitted with `is_exported` derived from outer (NOT hardcoded true). Fails because `internal_module` and `ambient_declaration` are not handled.
- [ ] GREEN: Add two new cases in `walk()` per spec § Detailed Design. `internal_module` emits namespace symbol and walks body children with namespace as parent. `ambient_declaration` unwraps; checks if its `internal_module` child has STRING-name → forces is_exported=true for the namespace; otherwise propagates `isExported || hasExportModifier(node)`. ≤30 LOC of new case code.
- [ ] Verify: `npx vitest run tests/parser/typescript-extractor-gaps.test.ts -t "L2|L12"`
  Expected: 4 namespace+ambient tests pass.
- [ ] Acceptance: AC1, AC11, AC12, ACS4, C1, partial D6
- [ ] Commit: `extract TS namespaces and ambient module declarations`

### Task 11: Extractor — `try/catch RangeError` + `hasError()` warn
**Files:** `src/parser/extractors/typescript.ts`, `tests/parser/typescript-extractor-gaps.test.ts`
**Complexity:** standard
**Dependencies:** Task 10b
**Execution routing:** default

- [ ] RED: Add `describe("Edge cases")`: (a) deeply-nested AST that triggers stack overflow → no throw at top level; partial symbols returned; warning logged (assert via `vi.spyOn(console, 'warn')`). (b) Source with malformed decorator producing ERROR node → warn logged, other symbols still emitted. Both fail because no try/catch + no hasError() check exist.
- [ ] GREEN: Wrap top-level `walk(tree.rootNode)` call inside `extractTypeScriptSymbols` with try/catch. On `RangeError`, log warn and return `symbols` partial. Add `if (tree.rootNode.hasError()) console.warn(...)` once per file before returning.
- [ ] Verify: `npx vitest run tests/parser/typescript-extractor-gaps.test.ts -t "Edge cases"`
  Expected: 2 edge case tests pass.
- [ ] Acceptance: AC1, ACE1, ACE3, partial D6
- [ ] Commit: `guard top-level walk against stack overflow and warn on grammar errors`

### Task 12: Import-graph — TS branch + parse cache reuse + cycle filter
**Files:** `src/utils/import-graph.ts`, `tests/utils/import-graph.test.ts` (extend), `tests/fixtures/type-only-cycle/{a.ts,b.ts,types-a.ts,types-b.ts,runtime-a.ts,runtime-b.ts,expected.json}`
**Complexity:** complex
**Dependencies:** Tasks 3, 4, 5
**Execution routing:** deep

- [ ] RED: Extend `tests/utils/import-graph.test.ts` with: (a) TS file with `import type` → edge has `type_only:true`. (b) TS file with mixed import → `type_only:false`. (c) AST throws → falls back to regex `extractImports`; resulting edges have `type_only:undefined`. (d) Parse cache hit: import the existing `getCachedParse` from `src/parser/parse-cache.ts` and assert hit-count increments after second `buildImportGraph` call on same source (use `getCacheStats()` from `parse-cache.ts` if available, else `vi.spyOn(parseCacheModule, "getCachedParse")`). Call `resetParseCache()` in `beforeEach`. (e) JS file cycle still detected by `find_circular_deps` (regression — `undefined` treated as runtime). (f) `tests/fixtures/type-only-cycle/expected.json` asserts: `find_circular_deps` returns 1 cycle after change (the runtime cycle); 2 cycles before change. (g) Monorepo alias `@shared/utils` resolves to the right file in resulting edge. All fail because TS branch does not exist.
- [ ] GREEN: In `import-graph.ts`, **reuse existing `getCachedParse`/`setCachedParse` already imported via line 9** from `src/parser/parse-cache.ts` — do NOT create a new cache. Add new TS/TSX branch (parallel to Python branch lines 355–386) calling `extractTypeScriptImports` + per-edge alias resolution via `resolveTsAliasedImport` for non-relative paths. **AST failure handling: catch must fall through to legacy `extractImports(source)` regex for the same file (NOT just log+skip).** Pseudocode:
```typescript
try {
  const tsImports = extractTypeScriptImports(tree);
  // ... process tsImports edges with type_only flagging ...
} catch (err) {
  console.warn(`[import-graph] AST extraction failed for ${file.path}; falling back to regex: ${err}`);
  // Fallback: use the existing regex-based extractImports
  const regexImports = extractImports(source);
  for (const importPath of regexImports) {
    const resolved = resolveImportPath(file.path, importPath);
    const targetFile = normalizedPaths.get(resolved);
    if (targetFile) addEdge(file.path, targetFile);
    // type_only stays undefined — treated as runtime by find_circular_deps
  }
  degradedCount++;
}
```
**Update `find_circular_deps` to EXCLUDE type-only edges from cycle detection** — i.e., add `if (edge.type_only === true) continue` to the cycle-walking loop, so type-only edges do NOT contribute to cycles. `undefined` and `false` continue to participate (preserving JS/JSX/PHP cycle detection). Plus fixture: 6 files, one runtime cycle (`runtime-a` ↔ `runtime-b`), one type-only cycle (`types-a` ↔ `types-b` via `import type`).
- [ ] Verify: `npx vitest run tests/utils/import-graph.test.ts`
  Expected: all new + existing tests pass; type-only-cycle fixture asserts cycle count delta.
- [ ] Acceptance: AC9 (graph side), AC13 (graph side), ACE4, SC2 (graph integration side), SC4, D7, D17, C4
- [ ] Commit: `add TS AST branch with parse cache and type-only cycle filter`

### Task 13: `index-tools.ts` — `loadIndexOrStale` + 2 query-side migrations + `clearTsconfigCache`
**Files:** `src/tools/index-tools.ts`, `tests/storage/index-store.test.ts` (extend) or new `tests/tools/index-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 6
**Execution routing:** deep

- [ ] RED: Add `describe("loadIndexOrStale")`: (a) fresh fixture index → `result.status === "ok"`. (b) stale fixture: **use `vi.replaceProperty(EXTRACTOR_VERSIONS, "typescript", "3.0.0")`** (NOT `vi.spyOn` — Vitest does not support spying on primitive string properties without a getter) while the on-disk fixture has `"2.1.0"` → `result.status === "stale"`, `result.reason === "extractor_version_mismatch"`, `expected_version === "3.0.0"`, `actual_version === "2.1.0"`. **Tests must NOT depend on the actual current value of `EXTRACTOR_VERSIONS.typescript`** — the bump happens in Task 15 AFTER this task and Task 14, so the test must replace the property. (c) fixture with no version field (legacy) → still treated as stale. Add `describe("index_folder clears tsconfig cache")`: spy on `clearTsconfigCache` and assert called at start of `index_folder`. Also create stub of `tests/tools/index-tools-stale.test.ts` (inventory contract) with TODO comments listing the 3 query-side callsites — driving Tasks 13+14 in test-driven order. All fail because helper does not exist.
- [ ] GREEN: Define `IndexOrStaleResult` discriminated union in `src/tools/index-tools.ts`. Implement `loadIndexOrStale(repoPath)` wrapping existing `loadIndex` logic. **Migrate 2 query-side callers** in `index-tools.ts` (lines 969 and 1022) from `loadIndex(...)` → `loadIndexOrStale(...)` + `staleToMcpError(result)` on stale. **Add a guard at the top of the public `index_file` MCP tool wrapper**: call `loadIndexOrStale(repoPath)` first; if `status:"stale"`, return `staleToMcpError` instead of proceeding to the saveIncremental path. **Keep raw `loadIndex` at the internal helper sites lines 366 and 808 — these are now reached only after the entry-level version check has passed.** At top of `index_folder`, call `clearTsconfigCache()`. Document the saveIncremental retention with an inline comment explaining the entry-level guard chain.
- [ ] Verify: `npx vitest run tests/tools/index-tools.test.ts && npx vitest run tests/storage/index-store.test.ts`
  Expected: new + existing tests pass.
- [ ] Acceptance: ACS5, partial D8 (`clearTsconfigCache` integration is part of D8, not ACE2 which Task 4 owns)
- [ ] Commit: `add loadIndexOrStale helper and migrate index-tools callsites`

### Task 14: `conversation-tools.ts` — migrate 1 callsite
**Files:** `src/tools/conversation-tools.ts`, `tests/tools/conversation-tools-stale.test.ts` (new)
**Complexity:** standard
**Dependencies:** Task 13
**Execution routing:** default

- [ ] RED: New `tests/tools/conversation-tools-stale.test.ts` with `it("returns isError on stale index")`. **Replace `EXTRACTOR_VERSIONS.typescript`** via `vi.replaceProperty(EXTRACTOR_VERSIONS, "typescript", "3.0.0")` (Task 15's bump hasn't landed yet at this point; `vi.replaceProperty` is the correct Vitest API for primitive overrides). Set up stale fixture index for `conversation-tools` repo with version `"2.1.0"`, invoke the tool, assert `isError:true` + `/extractor_version_mismatch/`. Fails because callsite still uses old `loadIndex` (returns null → empty results).
- [ ] GREEN: Replace `loadIndex(...)` call at `src/tools/conversation-tools.ts:245` (or current location — verify) with `loadIndexOrStale(...)` + early return `staleToMcpError(result)` on `status:"stale"`.
- [ ] Verify: `npx vitest run tests/tools/conversation-tools-stale.test.ts`
  Expected: 1 test passes.
- [ ] Acceptance: ACS6 (partial), D9
- [ ] Commit: `migrate conversation-tools to loadIndexOrStale`

### Task 15: `project-tools.ts` — bump `EXTRACTOR_VERSIONS.typescript` to `3.0.0`
**Files:** `src/tools/project-tools.ts`
**Complexity:** standard
**Dependencies:** Tasks 7–11 (all extractor changes done)
**Execution routing:** default

- [ ] RED: Config-only — verify `grep '"3.0.0"' src/tools/project-tools.ts | grep typescript` returns nothing pre-edit.
- [ ] GREEN: Change line 33 from `typescript: "2.1.0", // ...` to `typescript: "3.0.0", // v3.0: extends/implements, generics in signature, enum members, is_async, modifiers/accessors, namespace/ambient, anonymous default export, try/catch RangeError, AST imports + tsconfig paths in import-graph`.
- [ ] Verify: `grep -E 'typescript:\s*"3\.0\.0"' src/tools/project-tools.ts && npx vitest run`
  Expected: grep matches; full test suite passes.
- [ ] Acceptance: AC4 (version side), D10
- [ ] Commit: `bump EXTRACTOR_VERSIONS.typescript to 3.0.0 for AST + heritage + ambient extractor`

### Task 16: CI workflow + inventory contract test
**Files:** `.github/workflows/extractor-version-guard.yml`, `tests/tools/index-tools-stale.test.ts`
**Complexity:** standard
**Dependencies:** Task 14, Task 15
**Execution routing:** default

- [ ] RED: Complete the stub `tests/tools/index-tools-stale.test.ts` started in Task 13. **Inventory contract approach (NOT blind tool invocation):** rather than calling each MCP tool directly with mock payloads (which would fail validation per gemini-3 finding), the test uses `vi.replaceProperty` to swap the `loadIndex` export with a sentinel-throwing stub, then iterates through `src/tools/*.ts` files via a regex grep at TEST runtime: `grep -l "loadIndex(" src/tools/` should return ONLY the 2 saveIncremental retentions in `index-tools.ts` (lines 366, 808). Any other hits indicate an un-migrated callsite; test fails listing the offending file:line. Plus CI workflow assertion: write `.github/workflows/extractor-version-guard.yml` that fails when PR diff touches `src/parser/extractors/typescript.ts` without diff in `EXTRACTOR_VERSIONS`. Plus SC5 CI wiring: add `npx tsx scripts/validate-ts-extractor-gaps.ts heritage-coverage tests/fixtures/heritage-coverage` step to the existing `ci.yml` (or wherever vitest runs) so the gap-pinning script is enforced on every PR.
- [ ] GREEN: Author `extractor-version-guard.yml` (~30 LOC) using `git diff --name-only origin/main...HEAD` + grep. **Scope the guard:** only fail when the diff touches `function_declaration|class_declaration|method_definition|export_statement|enum_declaration|internal_module|ambient_declaration|public_field_definition|field_definition|expression_statement|getSignature|getClassHeritage|hasAsyncModifier|getModifiers|getAccessorKind|extractTypeScriptSymbols|walk` (semantically meaningful changes), NOT pure comment/whitespace/test-fixture diffs. Implementation: `git diff` the file and grep the diff for those identifiers. Inventory test wired to the regex-based callsite check. **Allowed `loadIndex(` occurrences in `src/tools/index-tools.ts`: exactly 3** — the 2 saveIncremental retentions (lines 366, 808) PLUS 1 internal call inside the new `loadIndexOrStale` wrapper itself. The test grep excludes the line containing `loadIndexOrStale`'s internal delegation by pattern (`grep -v 'loadIndex(.*// internal'` with an inline marker comment in `loadIndexOrStale`). Migrations should already be complete after rev-4 moved the inventory stub into Task 13 RED — Task 16 should NOT need to fan back; if it does, that's an indication Tasks 13/14 were rushed. **SC5 wiring is moved to Task 17a** (where `validate-ts-extractor-gaps.ts` is authored) — referencing it from Task 16 would point at a not-yet-existing script.
- [ ] Verify: `npx vitest run tests/tools/index-tools-stale.test.ts && yamllint .github/workflows/extractor-version-guard.yml`
  Expected: inventory test passes (all tools migrated); workflow file is valid YAML.
- [ ] Acceptance: AC4 (CI side), ACS6, D12, D19, C2 (SC5 moved to Task 17a)
- [ ] Commit: `add CI guard for EXTRACTOR_VERSIONS bump and stale-index inventory contract test`

### Task 17a: Validation script + heritage-coverage fixture
**Files:** `scripts/validate-ts-extractor-gaps.ts`, `tests/fixtures/heritage-coverage/expected.json`, `tests/fixtures/heritage-coverage/{20 NestJS-shaped *.ts files}`
**Complexity:** complex
**Dependencies:** Task 11, Task 12, Task 16
**Execution routing:** deep

- [ ] RED: Script does not exist; heritage-coverage fixture lacks `expected.json`. Running `npx tsx scripts/validate-ts-extractor-gaps.ts heritage-coverage tests/fixtures/heritage-coverage` exits with file-not-found. Once `expected.json` exists, the script must compare extractor output against it and assert ≥80% of `class.*extends` source matches in the fixture have `sym.extends.length > 0` (script exits non-zero on miss).
- [ ] GREEN: (1) Author `scripts/validate-ts-extractor-gaps.ts` (~80 LOC): takes mode arg (`heritage-coverage` for ratio gate, `gap-pinning` for exact-match against `expected.json`), walks fixture dir, runs `extractTypeScriptSymbols` per file, computes ratio for heritage mode, exits 1 on regression. (2) Vendor 20-file NestJS-shaped corpus in `tests/fixtures/heritage-coverage/` (mix: 8 controllers extending `BaseController`, 6 services implementing interfaces, 4 entities extending TypeORM `BaseEntity`, 2 mixin classes — pinned at known SHA). (3) Author `expected.json` listing per-class `extends` + `implements` arrays exactly as the post-change extractor should emit. (4) **Wire script into CI (SC5):** add a step to `.github/workflows/ci.yml` (or the existing test-runner workflow) — `npx tsx scripts/validate-ts-extractor-gaps.ts heritage-coverage tests/fixtures/heritage-coverage` — so every PR runs the gap-pinning check. This step lives here (not Task 16) because the script is authored here.
- [ ] Verify: `npx tsx scripts/validate-ts-extractor-gaps.ts heritage-coverage tests/fixtures/heritage-coverage && npx tsx scripts/validate-ts-extractor-gaps.ts gap-pinning tests/fixtures/heritage-coverage`
  Expected: both invocations exit 0; ratio ≥80%; `expected.json` exact-match passes.
- [ ] Acceptance: SC1, SC5, D13, D16
- [ ] Commit: `add validation script and pinned heritage-coverage fixture`

### Task 0 (PRE-FLIGHT, executes BEFORE Task 1): Perf-bench corpus + baseline capture
**Files:** `scripts/bench-index.sh`, `tests/fixtures/perf-bench/generate.ts`, `tests/fixtures/perf-bench/{200 generated *.ts files}`, `tests/fixtures/perf-bench/baseline.json`, `.github/workflows/perf-baseline.yml`
**Complexity:** complex
**Dependencies:** none — runs FIRST so the baseline reflects pre-change main
**Execution routing:** deep
**Execution note:** the baseline MUST be captured against `main` BEFORE any extractor changes land. Capturing after Tasks 7–12 would bake any regression into the baseline, defeating the regression check (Adversarial finding gemini-2). This task is logically post-implementation but operationally pre-flight — execute as the first task in the implementation sequence, then merge separately, then proceed with Task 1.

- [ ] RED: `scripts/bench-index.sh` does not exist; `tests/fixtures/perf-bench/baseline.json` missing. Running the script exits with file-not-found.
- [ ] GREEN: (1) Author `scripts/bench-index.sh` (~25 LOC): runs `codesift index_folder $1` 3 times, computes median wall-clock in seconds, reads `$1/baseline.json`, exits 1 if median > 1.8 × baseline. (2) Author `tests/fixtures/perf-bench/generate.ts` to produce ~200 realistic-shaped TS files (~30% classes with heritage, ~30% functions with generics, ~20% type aliases, ~20% modules with re-exports + `import type`). Commit the generated output (deterministic seed) so CI does not regenerate. (3) **Capture baseline against `main` (pre-Task-1)**: `.github/workflows/perf-baseline.yml` is a `workflow_dispatch`-triggered job that (a) checks out the feature branch at the merge-base with `main`, (b) runs `bench-index.sh tests/fixtures/perf-bench --record` (a `--record` flag writes the median to `baseline.json`), (c) commits `tests/fixtures/perf-bench/baseline.json` back to the feature branch via `gh api` or actions/git-auto-commit-action. The committed `baseline.json` MUST land in the repo at the start of the feature branch, BEFORE Tasks 1–12 modify the extractor. **Verification:** after the workflow completes, `git log baseline.json` shows a commit on the feature branch with author = the bot, committed at HEAD before any extractor diff.
- [ ] Verify: `bash scripts/bench-index.sh tests/fixtures/perf-bench` (with current code = pre-change extractor) exits 0 with the recorded median.
- [ ] Acceptance: D14, D18 (corpus + baseline)
- [ ] Commit: `add perf benchmark harness and pre-change baseline (captures current main perf as 1.0×)`

### Task 17b: Perf regression validation against pre-captured baseline
**Files:** (re-run-only — uses Task 0's `bench-index.sh` and `baseline.json`)
**Complexity:** standard
**Dependencies:** Task 12, Task 17a
**Execution routing:** default

- [ ] RED: Re-run `bash scripts/bench-index.sh tests/fixtures/perf-bench` after Tasks 7–12 land. With pre-change baseline already in `baseline.json` (from Task 0) and post-change extractor active, the script must compare new median against pre-change baseline.
- [ ] GREEN: No new code — this task is the validation step. If the gate fails (>1.8× regression), profile via `node --prof` against `tests/fixtures/perf-bench/`, identify the hot spot (likely culprits: `getCachedParse` collision, `existsSync` per import in `tsconfig-paths.ts`, generator-walk, or the new heritage AST traversal), apply targeted optimization, re-run.
- [ ] Verify: `bash scripts/bench-index.sh tests/fixtures/perf-bench`
  Expected: exits 0 with median ≤ 1.8 × baseline (recorded from pre-change main in Task 0).
- [ ] Acceptance: SC3
- [ ] Commit: `validate perf regression gate against pre-change baseline`

### Task 18: Adversarial Review section update + spec status sync
**Files:** `docs/specs/2026-05-01-ts-extractor-expansion-spec.md`
**Complexity:** standard
**Dependencies:** Task 17b
**Execution routing:** default

- [ ] RED: Docs-only — RED is the absence of an "Implementation completed" footer entry in the spec.
- [ ] GREEN: Append a final "Implementation completed: 2026-05-XX" line to the spec; update `## Adversarial Review` `adversarial_review:` field if any new adversarial findings surfaced during implementation.
- [ ] Verify: `grep -E 'Implementation completed' docs/specs/2026-05-01-ts-extractor-expansion-spec.md`
  Expected: matches.
- [ ] Acceptance: (housekeeping; not on Coverage Matrix)
- [ ] Commit: `mark spec as implementation-complete`

### Task 19: Release notes + CHANGELOG entry
**Files:** `CHANGELOG.md`, `README.md` (tool count if changed)
**Complexity:** standard
**Dependencies:** Task 18
**Execution routing:** default

- [ ] RED: `CHANGELOG.md` lacks v3.0.0 entry for typescript extractor. `README.md` may need version note.
- [ ] GREEN: Add `## [extractor 3.0.0] — 2026-05-XX` section with: heritage capture, generics in signatures, enum members, is_async, modifiers/accessors, namespace + ambient, anonymous default exports, try/catch hardening, `import type` flagging in import-graph, tsconfig paths resolution, MCP `isError` envelope on stale index, `clearTsconfigCache` on `index_folder`. Note breaking change: existing indexes invalidated; users see structured stale-index error until reindex. Document `find_circular_deps` behavior change (type-only edges excluded for TS).
- [ ] Verify: `grep -A 5 'extractor 3.0.0' CHANGELOG.md`
  Expected: matches.
- [ ] Acceptance: (release hygiene; not on Coverage Matrix)
- [ ] Commit: `document extractor 3.0.0 release in CHANGELOG`
