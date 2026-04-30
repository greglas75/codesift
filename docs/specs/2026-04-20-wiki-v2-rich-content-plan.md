# Implementation Plan: Wiki v2 — Rich Content + Agent Integration

**Spec:** docs/specs/2026-04-20-wiki-v2-rich-content-spec.md
**spec_id:** 2026-04-20-wiki-v2-rich-content-0506
**planning_mode:** spec-driven
**source_of_truth:** approved spec
**plan_revision:** 3
**status:** Approved
**Created:** 2026-04-20
**Tasks:** 30
**Estimated complexity:** 12 complex / 18 standard

## Architecture Summary

Two new generator files (`wiki-module-builder.ts` for cascade + overview + dual-write manifest builders, `wiki-hub-ranker.ts` for PageRank + blocklist), ~13 changed files in codesift-mcp, ~6 changed files in codesift-dashboard. The data flow: `generateWiki()` orchestrator fans out 6 parallel analyses (`detectCommunities`, `classifySymbolRoles`, `analyzeHotspots`, `coChangeAnalysis`, `analyzeProject`, `collectImportEdges`), two sequential builder phases run (A: PageRank ranking, B: structured builders), then six page generators produce markdown + summary files. Dashboard reads the v2 manifest via `schema_version === 2` branch. The v1 rollback path uses the same orchestrator with an env-var-selected writer function.

Key dependency direction: `wiki-tools.ts` depends on `wiki-module-builder.ts` + `wiki-hub-ranker.ts` + `wiki-page-generators.ts` (rewritten). Both new files depend on existing `project-tools.ts`, `community-tools.ts`, `graph-tools.ts` (modified), `import-graph.ts` (extended), `wiki-manifest.ts` (schema v2). Cross-repo boundary: `.codesift/wiki/wiki-manifest.json` JSON file.

## Technical Decisions

- **Description cascade:** plain function dispatch table (3 functions called in order, first non-null wins), not visitor/CoR. Level 3 always returns a string (terminal fallback).
- **extractCallSites refactor:** return type changes `Set<string>` → `CallSite[]` with `is_method_call: boolean`. Blast radius is 1 file (`graph-tools.ts` + its test) — verified via `Grep` of external callers.
- **Method-call detection:** regex-based looking back for `.` or `?.` one character before the match. Bracket notation (`arr["map"]()`) is documented out-of-scope. AST-based alternative rejected to preserve `buildAdjacencyIndex` latency.
- **Dual-write v1/v2:** both manifest writer functions live in `wiki-module-builder.ts`. Orchestrator selects via `process.env.CODESIFT_WIKI_V1 === "1"` check. No strategy object — single conditional, one release cycle.
- **Library:** `graphology-metrics` (`graphology` already a dep). Inline PageRank rejected.
- **TOML parsing:** regex-based extraction of `[package]` / `[project]` sections only. No TOML parser lib.
- **File-size mitigation (CQ7):** v1 generator functions moved to `wiki-page-generators-v1.ts` so main file stays under 400 LOC.
- **Monorepo slug collision:** handled INSIDE `buildUniqueSlugs` (workspace-prefix pre-pend when `project_type === "monorepo"`), not as a pre-processing step.
- **`key_exports_approximate` flag:** added per QA Risk 4 — per-module boolean in `ModuleMetadata` when fallback path is used for `is_exported`.

## Quality Strategy

- **Unit tests** for pure functions: cascade levels, PageRank wrapper, builtin blocklist, method-call detection, is_exported AST traversal, summary format regex.
- **Integration tests** via 3 fixture repos (`ts-monorepo/`, `python-fastapi/`, `go-module/`) at `tests/fixtures/wiki-v2/` — snapshot manifest JSON + all generated `.md` pages.
- **CQ7 risk**: split v1 generators to separate file (`wiki-page-generators-v1.ts`).
- **CQ5 risk**: explicit guard clauses for empty import graph, PageRank failure, missing manifest files.
- **CQ8 risk**: hook `parseInt` NaN guard for `CODESIFT_WIKI_SUMMARY_MAX_CHARS`.
- **Regression risk**: existing `graph-tools.test.ts` "should extract method calls" test inverts semantics (method calls should NOT create caller edges). Must update in same commit as the extractCallSites change.
- **Snapshot strategy**: manifest JSON + page markdown from 3 fixture repos; redact volatile fields (`generated_at`, `index_hash`, `git_commit`). Avoid snapshotting PageRank floats, Louvain output, `hubs.md` names.

## Coverage Matrix

| Row ID | Authority item | Type | Primary task(s) | Notes |
|--------|----------------|------|-----------------|-------|
| AC-SHIP-1a | Synthetic hub test: method call does not inflate callers | requirement | Task 10 | Unit test in `wiki-hub-ranker.test.ts` |
| AC-SHIP-1b | Integration: hubs.md top-10 no builtins on codesift-mcp | requirement | Task 27 | Integration test consumes generated fixture output |
| AC-SHIP-2 | No v1 boilerplate substring in v2 community pages | requirement | Task 17 | Verified by Task 26 (integration) |
| AC-SHIP-3 | Manifest schema v2: schema_version, project, modules | requirement | Task 13 | JSON schema validation via Task 2 schema |
| AC-SHIP-4 | Dashboard v1 manifest backward compat | requirement | Task 24 | Dashboard data layer test |
| AC-SHIP-5 | Dashboard v2 rendering: overview card, differentiated excerpts | requirement | Tasks 24, 25, 26 | Dashboard integration |
| AC-SHIP-6 | Hook summary structure (purpose, exports, deps) | requirement | Task 18 | Regex-asserted |
| AC-SHIP-7 | All existing + new tests pass | constraint | All tasks | `npm test` green in CI |
| AC-SHIP-8 | CLI smoke on 3 stacks (TS monorepo, Python, Go) | requirement | Task 30 | Fixture repos + CI step |
| AC-SHIP-9 | Rollback path produces v1 manifest | requirement | Tasks 17, 22 | Env var + test |
| AC-SHIP-10 | TS extractor reindex after version bump | requirement | Task 4, 5 | Fixture + extractor tests |
| AC-SUCCESS-1 | Distinct purpose sentence per module (manual) | deliverable | Task 11, 12 | Human review after generation |
| AC-SUCCESS-2 | Hub symbols are recognizable project symbols (manual) | deliverable | Task 10, 27 | Human review |
| AC-SUCCESS-3 | Hook summary usefulness for 5 modules | deliverable | Task 18 | Automated counts + manual review |
| AC-SUCCESS-4 | Dashboard differentiated excerpts (≥10 cards) | deliverable | Tasks 25, 26 | Automated distinctness + manual screenshot |
| AC-SUCCESS-5 | Framework-aware descriptions for 3 frameworks | deliverable | Task 11, 26 | Fixture integration test |
| AC-SUCCESS-6 | Architecture page content structure | deliverable | Task 18, 26 | Structural regex on `architecture.md` |
| D1 | Full-stack scope (mcp + dashboard) | constraint | Tasks 22-25 | Dashboard tasks in scope |
| D2 | is_exported via ancestor + modifier + default_export | constraint | Task 4 | Fixture tests for 11 syntaxes |
| D3 | Cascade order: framework → dep-lookup → keyword | constraint | Task 11, 12 | Each level testable independently |
| D4 | Hub fix: method-call + PageRank + blocklist | constraint | Task 6, 7, 10 | Three layers mandatory |
| D5 | Structured manifest, no new MCP tool | constraint | Task 13 | Manifest additive, instructions updated |
| D6 | Stable section headers | constraint | Task 17, 18, 19 | Section header ordering in generators |
| D7 | schema_version: 2 in all v2 manifests | constraint | Task 13 | Schema validation |
| D8 | Hook summary budget 2500 + env override | constraint | Task 23 | Env var parsing with NaN guard |
| D9 | Rollback via env + v1 preserved one cycle | constraint | Task 16, 21, 28 | Dual writer functions |

## Review Trail
- Plan reviewer: revision 1 -> ISSUES FOUND (7 blocking + 7 non-blocking: Coverage Matrix task renumbering, Task 10 empty-graph contradiction, Task 11 ProjectProfile field mapping gaps, Task 13 cascade trigger conditions, Orphan shallow-clone handling, plus 7 smaller items).
- Plan reviewer: revision 2 -> addressed all blocking + non-blocking items. Coverage Matrix corrected. Task 10 RED + GREEN aligned with spec Failure Modes (no classifySymbolRoles fallback). Task 11 GREEN now enumerates all ProjectProfile field mappings + shallow-clone detection via `git rev-parse --is-shallow-repository`. Task 13 GREEN enumerates four cascade advancement conditions from spec D3 + test-community description template. Task 8 RED de-contradicted. Task 15 GREEN clarifies export migration. Task 22 re-rated complex. Task 25 RED specifies Astro Container render test. Task 16 GREEN enumerates all fixture files including builtin-collision triggers. File-size mitigation split wiki-module-builder.ts into overview-sources + cascade helpers.
- Cross-model validation (round 1, 2026-04-20T06:03Z): 5 critical + 8 warning + 2 info. All critical + most warnings addressed in revision 3:
  - Task 22 dep added: Task 15 (v1 writer existence)
  - Task 15 GREEN now specifies build-safe 3-step migration with intermediate import to v1 writer
  - Task 13 dep added: Task 14 (monorepo slug generation before cross-community deps mapped)
  - Task 11 dep added: Task 16 (fixtures needed for tests)
  - Task 11 shallow-clone wrapped in try/catch (guards missing git, non-repo)
  - Task 16 re-rated complex with explicit per-fixture file enumeration
  - Task 25 Verify now runs the render-contract test
  - Task 21 thin-slice integration test pulled forward; structural assertions added alongside snapshot
  - Task 15 re-rated complex; spans 4 files
  - Coverage Matrix D8 → Task 23 (was Task 20)
  - Task 3 Verify filter added
  - Task 17 commit rephrased to emphasize behavioral invariant
- Status gate: Reviewed

## Task Breakdown

### Task 1: Add `is_exported?: boolean` to CodeSymbol
**Files:** `src/types.ts`, `src/parser/extractors/_shared.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: Add test in `tests/parser/shared.test.ts` (or extend existing) asserting that `makeSymbol({ name: "foo", kind: "function", is_exported: true, ... })` produces a `CodeSymbol` whose `is_exported === true`. Assert that omitting the field produces a symbol where `is_exported` is `undefined` (not `false`) under `exactOptionalPropertyTypes: true`.
- [ ] GREEN: Add `is_exported?: boolean` field to `CodeSymbol` interface in `src/types.ts`. Update `makeSymbol` in `src/parser/extractors/_shared.ts` to propagate the field via `if (opts.is_exported !== undefined) symbol.is_exported = opts.is_exported`. Do NOT default to `false`.
- [ ] Verify: `npx tsc --noEmit && npx vitest run tests/parser/shared.test.ts`
  Expected: 0 TypeScript errors, target test passes
- [ ] Acceptance: D2, AC-SHIP-10
- [ ] Commit: `feat(types): add is_exported optional field to CodeSymbol`

### Task 2: Add WikiManifestV2 types + JSON schema
**Files:** `src/tools/wiki-manifest.ts`, `schemas/wiki-manifest-v2.schema.json`
**Complexity:** standard
**Dependencies:** Task 1
**Execution routing:** default implementation tier

- [ ] RED: Add test in `tests/tools/wiki-manifest.test.ts` constructing a minimal `WikiManifestV2` object and asserting its shape: `schema_version === 2`, `project` is an object with required subfields, `modules` is an array. Add ajv-based validation test loading `schemas/wiki-manifest-v2.schema.json` and validating the sample.
- [ ] GREEN: Add interfaces to `src/tools/wiki-manifest.ts`: `WikiManifestV2`, `ProjectOverview`, `ModuleMetadata`, `KeyExport`, `DependencySummary`, `RankedHubSymbol`, `ModuleRole` union type, `LensData` (if not already present). Keep existing `WikiManifest` (v1) type exported. Create `schemas/wiki-manifest-v2.schema.json` per spec Data Model section. Add `ajv` as devDependency if absent.
- [ ] Verify: `npx vitest run tests/tools/wiki-manifest.test.ts`
  Expected: all tests pass, JSON schema validates sample
- [ ] Acceptance: AC-SHIP-3, D7
- [ ] Commit: `feat(wiki-manifest): add v2 schema types and JSON Schema file`

### Task 3: Add ModuleMetadata.key_exports_approximate field
**Files:** `src/tools/wiki-manifest.ts`
**Complexity:** standard
**Dependencies:** Task 2
**Execution routing:** default implementation tier

- [ ] RED: Extend the `WikiManifestV2` shape test to include `modules[0].key_exports_approximate` as optional boolean. Assert the field is valid when set to `true` and when omitted.
- [ ] GREEN: Add `key_exports_approximate?: boolean` to `ModuleMetadata` interface. Update schema JSON accordingly. Purpose: flag whether the `is_exported` fallback was used for this module (per QA Risk 4 mitigation).
- [ ] Verify: `npx vitest run tests/tools/wiki-manifest.test.ts -t "key_exports_approximate"`
  Expected: the new filtered test passes; no other tests matched
- [ ] Acceptance: D2 fallback signaling
- [ ] Commit: `feat(wiki-manifest): flag approximate key_exports for pre-reindex state`

### Task 4: TypeScript extractor `is_exported` via AST traversal
**Files:** `src/parser/extractors/typescript.ts`, `tests/parser/typescript-extractor.test.ts`
**Complexity:** complex
**Dependencies:** Task 1
**Execution routing:** deep implementation tier

- [ ] RED: Add 11 fixture test cases to `tests/parser/typescript-extractor.test.ts`, each a minimal TS source string exercising one export syntax: `export const x`, `export function f()`, `export class C`, `export interface I`, `export type T`, `export enum E`, `export default function named()`, `export default class Named`, `export { X }`, `export { X as Y } from "./m"`, `export * as ns from "./m"`. For each, assert the resulting `CodeSymbol` for the named entity has `is_exported === true`. Add negative fixture: plain `const x = 1` inside a module, assert `is_exported` is NOT `true` (may be `undefined` or `false`).
- [ ] GREEN: In `typescript.ts`, during symbol walk, check three conditions per D2: (a) AST has ancestor node type `export_statement`, (b) current declaration node has a child of type `export` (modifier), (c) node classification yields `default_export` kind with a name. Set `is_exported: true` when ANY condition holds. Pass `is_exported` through to `makeSymbol`. Keep the traversal minimal — do not add unrelated AST logic.
- [ ] Verify: `npx vitest run tests/parser/typescript-extractor.test.ts`
  Expected: all 11 new tests pass + all 430 existing lines of tests still pass
- [ ] Acceptance: AC-SHIP-10, D2
- [ ] Commit: `feat(extractor/ts): detect is_exported via ancestor + modifier + default_export`

### Task 5: Bump TypeScript EXTRACTOR_VERSION
**Files:** Wherever `EXTRACTOR_VERSIONS` is declared (likely `src/parser/extractors/index.ts` or `src/types.ts`)
**Complexity:** standard
**Dependencies:** Task 4
**Execution routing:** default implementation tier

- [ ] RED: Add test (or extend existing `tests/storage/extractor-version.test.ts` if present) asserting that loading a stale cache (with old `typescript` extractor version string) schedules a reparse of TS files. If no existing test covers this path, add one that constructs a mock index with stale version, calls the cache validation function, and asserts an invalidation signal is produced. Locate actual path with `grep -n EXTRACTOR_VERSIONS src/`.
- [ ] GREEN: Increment the `typescript` key in `EXTRACTOR_VERSIONS` (e.g., from `"2"` to `"3"` — check current value first). No other logic change.
- [ ] Verify: `grep -n "EXTRACTOR_VERSIONS" src/ && npx vitest run tests/storage`
  Expected: incremented value visible, tests pass
- [ ] Acceptance: AC-SHIP-10
- [ ] Commit: `feat(extractor/ts): bump version to force reparse for is_exported`

### Task 6: Refactor extractCallSites to return CallSite[] with is_method_call
**Files:** `src/tools/graph-tools.ts`, `tests/tools/graph-tools.test.ts`
**Complexity:** complex
**Dependencies:** none (can run in parallel with Task 4/5)
**Execution routing:** deep implementation tier

- [ ] RED: Update existing `graph-tools.test.ts` "should extract method calls" test (around line 37 per QA report) to assert NEW semantics: the returned array contains `{ name: "doWork", is_method_call: true }`. Add new tests: (a) `arr.map(...)` → `is_method_call: true`, (b) `arr?.map(...)` → `is_method_call: true`, (c) plain `map(...)` → `is_method_call: false`, (d) `arr["map"](...)` documented as `is_method_call: false` (out of scope for v2), (e) `buildAdjacencyIndex` over source containing `arr.map()` produces ZERO caller edges for a project-defined `map` function.
- [ ] GREEN: Change `extractCallSites` signature from `Set<string>` to return `CallSite[]` where `interface CallSite { name: string; is_method_call: boolean }`. Detect method calls by looking backward one character from the match position for `.` or `?.`. In `buildAdjacencyIndex`, when iterating call sites, skip entries where `is_method_call === true` when creating caller edges. Export `CallSite` type. Do NOT change the signatures of `buildAdjacencyIndex`, `classifySymbolRoles`, or any other function in this file.
- [ ] Verify: `npx vitest run tests/tools/graph-tools.test.ts tests/integration/tools.test.ts`
  Expected: all graph-tools tests pass (including updated semantics), findDeadCode integration test passes (review for false dead-code positives)
- [ ] Acceptance: AC-SHIP-1a (partial — Task 10 completes), D4 Layer 1
- [ ] Commit: `fix(graph-tools): exclude method calls from caller edges`

### Task 7: Add builtin name blocklist constant
**Files:** `src/tools/wiki-hub-ranker.ts` (new file)
**Complexity:** standard
**Dependencies:** Task 6
**Execution routing:** default implementation tier

- [ ] RED: Create `tests/tools/wiki-hub-ranker.test.ts`. Add one test asserting that the exported `JS_BUILTIN_METHOD_NAMES` constant is a Set containing at least 40 entries including `map`, `filter`, `reduce`, `slice`, `now`, `get`, `then`, `valueOf`, `toString`.
- [ ] GREEN: Create `src/tools/wiki-hub-ranker.ts`. Export `JS_BUILTIN_METHOD_NAMES: ReadonlySet<string>` containing ~60 names covering Array/String/Object/Promise/Map/Set prototype methods plus common short names (`get`/`set`/`has`/`now`/`then`/`catch`/`finally`). Per spec D4 Layer 3 and QA note: shared constant, must not be duplicated in generators.
- [ ] Verify: `npx vitest run tests/tools/wiki-hub-ranker.test.ts`
  Expected: constant size test passes
- [ ] Acceptance: D4 Layer 3
- [ ] Commit: `feat(wiki-hub-ranker): add builtin method name blocklist`

### Task 8: Add graphology-metrics dependency
**Files:** `package.json`, `package-lock.json` (or equivalent lockfile)
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: Add a minimal smoke test in `tests/deps.test.ts` (create the file if it does not exist; reuse if present): `import { pagerank } from "graphology-metrics/centrality/pagerank"; expect(typeof pagerank).toBe("function")`. The import resolving and function type is the verification — no additional unit test required.
- [ ] GREEN: Run `npm install --save graphology-metrics@^2.x` (pin to latest minor of 2.x). Verify `package.json` contains the entry. Verify `package-lock.json` regenerated.
- [ ] Verify: `npx vitest run tests/deps.test.ts` (or equivalent import-smoke) and `node -e "require('graphology-metrics/centrality/pagerank')"`
  Expected: import resolves, function type is `"function"`
- [ ] Acceptance: D4 Layer 2
- [ ] Commit: `chore(deps): add graphology-metrics for PageRank hub ranking`

### Task 9: Add buildFilePageRank utility to import-graph.ts
**Files:** `src/utils/import-graph.ts`, `tests/utils/import-graph.test.ts`
**Complexity:** standard
**Dependencies:** Task 8
**Execution routing:** default implementation tier

- [ ] RED: Add 5 tests in `tests/utils/import-graph.test.ts`: (a) empty edge array → returns empty Map, (b) single edge `A → B` → Map contains both file paths, (c) cycle `A → B → A` → returns valid Map, (d) disconnected components (2 islands) → all files present with finite scores, (e) isolated node (file with zero in/out edges) → excluded from the map (pre-filter guard per spec Failure Modes).
- [ ] GREEN: Add `export function buildFilePageRank(edges: ImportEdge[]): Map<string, number>`. Construct a `graphology` DirectedGraph, add nodes for each unique file in edges (skip isolated nodes via pre-filter), add edges, call `pagerank()` from `graphology-metrics/centrality/pagerank` with default damping factor. Return the resulting node-score map. Catch errors from pagerank → return empty Map.
- [ ] Verify: `npx vitest run tests/utils/import-graph.test.ts`
  Expected: all 5 new tests pass
- [ ] Acceptance: D4 Layer 2
- [ ] Commit: `feat(import-graph): add buildFilePageRank utility`

### Task 10: Create rankHubsByPageRank in wiki-hub-ranker.ts (AC-SHIP-1a gate)
**Files:** `src/tools/wiki-hub-ranker.ts`, `tests/tools/wiki-hub-ranker.test.ts`
**Complexity:** complex
**Dependencies:** Task 2, 6, 7, 9
**Execution routing:** deep implementation tier

- [ ] RED: Add synthetic AC-SHIP-1a test: build a minimal ImportEdge[] (file A imports file B; file A defines symbol `map`; file B calls `arr.map(...)`). Feed through `extractCallSites` + `buildAdjacencyIndex` (from Task 6). Pass to `rankHubsByPageRank(edges, symbolRoles, { topK: 10 })`. Assert: `map` from file A does NOT appear in the returned top-10. Add tests for: (a) empty edges → returns `{ hubs: [], degraded_reason: "import_graph_empty" }` (NO fallback to classifySymbolRoles per spec Failure Modes); (b) PageRank computation throw (graphology internal error caught) → returns empty hubs + degraded reason `"pagerank_unavailable"` (still no classifySymbolRoles fallback — empty is correct when no structural anchor); (c) blocklist exemption for project symbol `map` when it lives in a `file_rank ≤ 20` file (symbol preserved in top-10).
- [ ] GREEN: Add `rankHubsByPageRank(edges, symbolRoles, options?: { topK?: number })` to `wiki-hub-ranker.ts`. Return shape: `{ hubs: RankedHubSymbol[]; degraded_reason?: string }`. Empty-edges guard: if `edges.length === 0`, return `{ hubs: [], degraded_reason: "import_graph_empty" }` immediately. Call `buildFilePageRank(edges)` internally wrapped in try/catch. On success: compute `file_rank` (1-based position sorted by PageRank desc), map `symbolRoles` to `RankedHubSymbol` with `pagerank` and `file_rank`. Apply blocklist filter: drop entries where `name ∈ JS_BUILTIN_METHOD_NAMES && file_rank > 20`. Sort by `pagerank desc, callers desc`. Slice to `topK` (default 30). On PageRank throw: return `{ hubs: [], degraded_reason: "pagerank_unavailable" }`.
- [ ] Verify: `npx vitest run tests/tools/wiki-hub-ranker.test.ts`
  Expected: AC-SHIP-1a synthetic test passes, all 15 ranker tests green
- [ ] Acceptance: AC-SHIP-1a, D4 Layers 2+3
- [ ] Commit: `feat(wiki-hub-ranker): rank hubs by PageRank with builtin blocklist gate`

### Task 11: buildProjectOverview in wiki-module-builder.ts
**Files:** `src/tools/wiki-module-builder.ts` (new), `src/tools/wiki-overview-sources.ts` (new, split for CQ7), `tests/tools/wiki-module-builder.test.ts` (new)
**Complexity:** complex
**Dependencies:** Task 2, Task 16
**Execution routing:** deep implementation tier

- [ ] RED: Create `tests/tools/wiki-module-builder.test.ts`. Test `buildProjectOverview` with:
  (a) TS project fixture (full `ProjectProfile` with stack, scripts) → asserts `name === projectResult.identity.project_name`, `stack.language === "TypeScript"`, `scripts` equals `projectResult.stack.scripts ?? {}` (from analyzeProject's `detectStack` which parses package.json scripts), `entry_points` equals `projectResult.dependency_graph.entry_points`, `git_remote === projectResult.identity.git_remote`, `project_type === projectResult.identity.project_type`, `workspaces === projectResult.identity.workspaces ?? []`;
  (b) Go-only fixture (no `package.json`, only `go.mod` content, `projectResult.stack.package_manager === null`) → asserts name extracted via regex `/^module\s+(\S+)/m` from on-disk `go.mod`, `stack.language === "Go"`;
  (c) Python fixture with `pyproject.toml` → asserts regex `[project]` section parsed for `name`/`version`/`description`, and `[project.dependencies]` array parsed (best-effort) into `DependencySummary.key`;
  (d) missing all manifests → asserts fallback to `codeIndex.root` directory basename for `name`;
  (e) shallow clone detection → fixture where `projectResult.git_health === null` OR `git rev-parse --is-shallow-repository` returns `true` via a mocked `execFileSync`; asserts `stats.total_commits === null`, `stats.contributors === null`, and returned value includes degraded-signal that orchestrator can surface as `degraded_reasons` entry `"shallow_clone_or_insufficient_history"`;
  (f) DependencySummary assembly → assert `prod_total` equals `projectResult.dependency_health.prod ?? 0`, `dev_total` equals `projectResult.dependency_health.dev ?? 0`, `key[]` contains up to 15 entries selected by architectural relevance (framework, test runner, DB, build tool). Construct `ProjectProfile` inputs via shared `makeProjectProfile()` helper at top of test file.
- [ ] GREEN: Create `src/tools/wiki-module-builder.ts`. Export `buildProjectOverview(projectResult: ProjectProfile, codeIndex: CodeIndex): ProjectOverview`. Field mappings (explicit):
  - `name` ← `projectResult.identity?.project_name ?? basename(codeIndex.root)`
  - `git_remote` ← `projectResult.identity?.git_remote ?? null`
  - `project_type` ← `projectResult.identity?.project_type ?? "single"`
  - `stack.language` ← `projectResult.stack?.language ?? "unknown"`, similarly for other `stack` fields
  - `scripts` ← `projectResult.stack?.scripts ?? {}` (existing `detectStack` already parses `package.json` scripts)
  - `entry_points` ← `projectResult.dependency_graph?.entry_points ?? []`
  - `workspaces` ← `projectResult.identity?.monorepo?.workspaces ?? []`
  - `dependencies` ← built from `projectResult.dependency_health` (`prod_total`, `dev_total`) + a helper `selectKeyDependencies(projectResult)` that picks ~15 architecturally-relevant packages
  - `known_gotchas` ← `projectResult.known_gotchas?.auto_detected ?? []`
  - `stats.total_files` ← `codeIndex.file_count`
  - `stats.total_commits`, `stats.contributors` ← `projectResult.git_health?.total_commits ?? null`, `projectResult.git_health?.contributors ?? null`. Detect shallow clone via helper `isShallowClone(root)` that wraps the git call in try/catch: `try { return execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: root, stdio: ["ignore","pipe","ignore"] }).toString().trim() === "true"; } catch { return false; }`. This guards against missing `git` binary, non-repo directories, and permission errors. When `git_health === null` OR `isShallowClone(codeIndex.root)` is true, set both stats fields to `null` and return a side-channel signal (e.g., via a `_degraded: "shallow_clone_or_insufficient_history"` property on the returned object that `wiki-tools.ts` reads and pushes to `degraded_reasons`, then strips before manifest write).
  Non-JS fallback helpers live in a separate file `src/tools/wiki-overview-sources.ts` (CQ7 split): `parseGoMod(source: string): { name: string | null; deps: string[] }`, `parsePyprojectToml(source: string): { name, version, description, deps }`, `parseCargoToml(source: string)`, `selectKeyDependencies(projectResult)`. Keep `wiki-module-builder.ts` under 200 LOC after this task; `wiki-overview-sources.ts` under 150 LOC.
- [ ] Verify: `npx vitest run tests/tools/wiki-module-builder.test.ts -t buildProjectOverview`
  Expected: all 6 overview tests pass
- [ ] Acceptance: AC-SUCCESS-5 (framework portion), D5 (project overview field), spec Edge Case "Shallow clone"
- [ ] Commit: `feat(wiki-module-builder): buildProjectOverview with multi-language fallback and shallow-clone detection`

### Task 12: buildModuleMetadata cascade level 1 (framework-aware)
**Files:** `src/tools/wiki-module-builder.ts`, `tests/tools/wiki-module-builder.test.ts`
**Complexity:** complex
**Dependencies:** Task 11
**Execution routing:** deep implementation tier

- [ ] RED: Add tests: (a) community of files under `src/controllers/` in a project with `nest_conventions.controllers.length > 0` → `role === "framework-routes"`, description mentions "NestJS controllers" and controller count; (b) community with Next.js pages → description mentions "Next.js routes"; (c) community under Hono project with routes → description mentions Hono; (d) non-framework project → level 1 returns `null`, cascade advances.
- [ ] GREEN: Add `describeViaFrameworkConventions(community, projectResult)` to `wiki-module-builder.ts`. Inspect `projectResult.nest_conventions`, `projectResult.next_conventions`, `projectResult.react_conventions`, and Hono/Astro/Python framework signals. Per-framework template string builder. Return `null` if no framework signal matches this community's files.
- [ ] Verify: `npx vitest run tests/tools/wiki-module-builder.test.ts -t "cascade level 1"`
  Expected: all 4 tests pass
- [ ] Acceptance: AC-SUCCESS-5, D3 (level 1)
- [ ] Commit: `feat(wiki-module-builder): cascade level 1 — framework-aware descriptions`

### Task 13: buildModuleMetadata cascade levels 2+3 + full metadata assembly
**Files:** `src/tools/wiki-module-builder.ts`, `tests/tools/wiki-module-builder.test.ts`
**Complexity:** complex
**Dependencies:** Task 10, 12, 14
**Execution routing:** deep implementation tier

- [ ] RED: Add tests: (a) level 2 dep-lookup — community imports `prisma` → description mentions "Prisma data access"; (b) level 3 keyword — community under `src/utils/` with no framework/dep signal → description uses keyword "utilities"; (c) full `buildModuleMetadata` — community with `is_exported` symbols → `key_exports` top-5 populated; (d) fallback path — `CodeSymbol.is_exported === undefined` → `key_exports_approximate: true` set, fan-in-top-5 from imported files used; (e) test-only community (all files match `*.test.*`/`*.spec.*`/`__tests__/*`) → `role === "tests"` AND description uses the test-suite template `"Test suite for {inferred_target}"` where `{inferred_target}` is the module with the most import edges FROM this test community (inferred from `importEdges`); (f) micro-module (<4 files) → `role === "micro-module"`, no Hub Symbols; (g) cross-community `depends_on`/`depended_by` derived from real import edges; (h) cascade trigger condition tests — assert advancement from level 1 → 2 when: (1) framework data source returns `null`/`undefined`, (2) returns empty collection (e.g., `nest_conventions.controllers.length === 0` for a community claiming NestJS), (3) community has zero files matching the level's selector path (e.g., level 1 NestJS requires ≥1 file under a conventions-known path), (4) template function throws (per-community try/catch catches and advances).
- [ ] GREEN: Add `describeViaDependencyLookup`, `describeViaFilePatterns`, cascade dispatch driver. Curated package-to-role table (50-80 entries covering `express`/`fastify`/`prisma`/`pg`/`drizzle`/`graphql`/`redis`/etc). Implement `buildModuleMetadata(communities, projectResult, codeIndex, importEdges, fileHotspots, rankedHubs)`. Cascade dispatch driver checks the four advancement conditions from spec D3 in order for each level: (1) primary data source null/undefined, (2) empty collection, (3) zero matching files, (4) template throws (per-community try/catch). Level 3 is terminal — always returns a non-empty string ("module of N files" fallback if no signal). Implement test-community detection via file-pattern regex: `/\.test\.(ts|js|py|go)$|\.spec\.(ts|js)$|__tests__\//`. For test communities, set `role = "tests"` and use template `"Test suite for {inferred_target}"` where `{inferred_target}` is the most-imported community name from this test community's outgoing edges (fall back to `"this project"` if no cross-community edges). Populate `key_exports` (top-5 by fan-in filtered by `is_exported === true`, or fallback via `collectImportEdges` `to` list if all undefined with `key_exports_approximate: true`). Compute `depends_on`/`depended_by` by walking importEdges and mapping files to community slugs. Keep `wiki-module-builder.ts` under 300 LOC total across Tasks 11+12+13 (CQ7); extract cascade helpers to a separate `src/tools/wiki-cascade.ts` file (≤150 LOC) if the driver+cascade functions exceed that budget.
- [ ] Verify: `npx vitest run tests/tools/wiki-module-builder.test.ts`
  Expected: all cascade + buildModuleMetadata tests pass (target ~20 tests)
- [ ] Acceptance: AC-SUCCESS-1, AC-SUCCESS-3 (exports list), D3 (levels 2+3), key_exports_approximate
- [ ] Commit: `feat(wiki-module-builder): cascade levels 2+3 and full module assembly`

### Task 14: Monorepo workspace-prefix in buildUniqueSlugs
**Files:** `src/tools/wiki-manifest.ts`, `tests/tools/wiki-manifest.test.ts`
**Complexity:** standard
**Dependencies:** Task 2
**Execution routing:** default implementation tier

- [ ] RED: Add test: two communities with identical directory name `src/utils` but in different workspaces `apps/web` and `apps/api` (monorepo context). Call `buildUniqueSlugs(communities, { monorepo: true, workspaces: ["apps/web", "apps/api"] })`. Assert returned slugs are `apps-web-src-utils` and `apps-api-src-utils` (distinct, no numeric suffix).
- [ ] GREEN: Extend `buildUniqueSlugs` (or add a sibling `buildUniqueSlugsMonorepo`) in `wiki-manifest.ts`. When the `monorepo` option is true, prepend the workspace path fragment to the slug based on file membership. Preserve existing behavior for non-monorepo path. Numeric-suffix collision handling remains the ultimate fallback.
- [ ] Verify: `npx vitest run tests/tools/wiki-manifest.test.ts -t "monorepo"`
  Expected: monorepo slug test passes, existing slug tests still pass
- [ ] Acceptance: D1 (full-stack monorepo support), spec Edge Case row
- [ ] Commit: `feat(wiki-manifest): prepend workspace path in monorepo slug generation`

### Task 15: buildWikiManifest v2 + v1 writers
**Files:** `src/tools/wiki-module-builder.ts`, `src/tools/wiki-manifest.ts`, `src/tools/wiki-tools.ts`, `tests/tools/wiki-manifest.test.ts`
**Complexity:** complex
**Dependencies:** Task 13, 14
**Execution routing:** deep implementation tier

- [ ] RED: Test `buildWikiManifest(opts)` returns object with `schema_version: 2`, `project`, `modules` populated from inputs. Test `buildWikiManifestV1(opts)` returns object WITHOUT `schema_version`, `project`, `modules` — matches v1 shape exactly. Both writers produce valid `pages`, `slug_redirects`, `file_to_community`, `lens_data`.
- [ ] GREEN: In `wiki-module-builder.ts`, add `buildWikiManifest(opts: BuildWikiManifestOptions): WikiManifestV2` and `buildWikiManifestV1(opts: BuildWikiManifestV1Options): WikiManifestV1`. The v2 writer consumes `ProjectOverview` and `ModuleMetadata[]`; v1 writer omits them. **Export migration (build-safe two-step):** Step 1 — Move the existing `buildWikiManifest` function body from `wiki-manifest.ts` into `buildWikiManifestV1` inside `wiki-module-builder.ts`. Step 2 — In `src/tools/wiki-tools.ts`, update the existing import from `buildWikiManifest` to import `buildWikiManifestV1` temporarily (this keeps wiki-tools.ts building — it will be rewired to `buildWikiManifest` (v2) in Task 21). Step 3 — Delete the original `buildWikiManifest` export from `wiki-manifest.ts`. `wiki-manifest.ts` retains ONLY type exports (`WikiManifest`, `WikiManifestV2`, `ModuleMetadata`, etc.), `buildUniqueSlugs`, and `PageInfo` — no more manifest builder. Verify the full `npx tsc --noEmit` passes after the three steps — wiki-tools.ts + wiki-module-builder.ts both compile, call sites resolved.
- [ ] Verify: `npx vitest run tests/tools/wiki-manifest.test.ts`
  Expected: both writer tests pass
- [ ] Acceptance: AC-SHIP-3, AC-SHIP-9, D9
- [ ] Commit: `feat(wiki-module-builder): dual-write manifest writers for v1 and v2`

### Task 16: Commit fixture repos at tests/fixtures/wiki-v2/
**Files:** `tests/fixtures/wiki-v2/ts-monorepo/`, `tests/fixtures/wiki-v2/python-fastapi/`, `tests/fixtures/wiki-v2/go-module/`, `tests/fixtures/wiki-v2/fixtures-exist.test.ts`
**Complexity:** complex
**Dependencies:** none
**Execution routing:** deep implementation tier

- [ ] RED: This task is fixture-data only. Add a smoke test in `tests/fixtures/wiki-v2/fixtures-exist.test.ts` asserting that each fixture directory contains: (a) a root manifest file (`package.json` / `pyproject.toml` / `go.mod`), (b) at least 4 source files for `ts-monorepo`, 5 for `python-fastapi`, 4 for `go-module`, (c) at least one file defining a symbol named `map` (per QA Risk 2 — needed for AC-SHIP-1a triggering on fixtures).
- [ ] GREEN: Create the three fixture directories. `ts-monorepo/` = pnpm workspace. Root files: `package.json` (`name: "ts-monorepo-fixture"`, `workspaces: ["apps/*"]`), `pnpm-workspace.yaml` (workspaces glob). `apps/web/` (Next.js minimal — 5 files): `package.json` (deps: `next`, `react`, `react-dom`), `next.config.js`, `pages/index.tsx`, `pages/api/users.ts`, `lib/data.ts`. `apps/api/` (Hono minimal — 5 files): `package.json` (deps: `hono`), `src/index.ts`, `src/routes/users.ts`, `src/middleware/auth.ts`, `src/util.ts`. **Method-call trigger files** (required for AC-SHIP-1a integration validity per QA Risk 2): `apps/web/lib/map-helper.ts` exports `export function map(x: unknown) { return x; }`; `apps/web/pages/index.tsx` contains `const items = [1,2,3].map(n => n+1);`. `python-fastapi/` = `pyproject.toml` + `app/main.py` + `app/routers/users.py` + `app/models.py` + `tests/test_users.py` (5 files). `go-module/` = `go.mod` + `main.go` + `handlers.go` + `models.go` + `main_test.go` (4 files). Include at least one language-equivalent builtin-name collision in Python/Go fixtures: `python-fastapi/app/main.py` defines `def map(...)`; `go-module/main.go` defines `func get(...)`.
- [ ] Verify: `npx vitest run tests/fixtures/wiki-v2/fixtures-exist.test.ts`
  Expected: all file-presence assertions pass
- [ ] Acceptance: AC-SHIP-8 (smoke fixtures), AC-SUCCESS-5 (framework-aware test input)
- [ ] Commit: `test(fixtures): add wiki-v2 fixture repos for 3 stacks`

### Task 17: Extract v1 page generators to wiki-page-generators-v1.ts
**Files:** `src/tools/wiki-page-generators.ts`, `src/tools/wiki-page-generators-v1.ts` (new)
**Complexity:** standard
**Dependencies:** Task 2
**Execution routing:** default implementation tier

- [ ] RED: Add test in `tests/tools/wiki-page-generators-v1.test.ts` that imports `generateCommunityPage_v1` from the new file and asserts it still produces the v1 boilerplate `"A community is a group of files that are more tightly connected"` substring.
- [ ] GREEN: Create `src/tools/wiki-page-generators-v1.ts`. Move functions `generateCommunityPage` → `generateCommunityPage_v1`, `generateCommunitySummary` → `generateCommunitySummary_v1`, `generateIndexPage` → `generateIndexPage_v1`, `generateHubsPage` → `generateHubsPage_v1`, `generateSurprisePage` → `generateSurprisePage_v1`, `generateHotspotsPage` → `generateHotspotsPage_v1`, `generateFrameworkPage` → `generateFrameworkPage_v1` from `wiki-page-generators.ts`. Export from new file. Do NOT change behavior. CQ7 mitigation per QA Risk 3.
- [ ] Verify: `npx vitest run tests/tools/wiki-page-generators-v1.test.ts && npx tsc --noEmit`
  Expected: v1 boilerplate test passes; no broken imports
- [ ] Acceptance: AC-SHIP-9 (rollback pages), CQ7 mitigation
- [ ] Commit: `refactor(wiki-page-generators): preserve v1 output unchanged for rollback compatibility`

### Task 18: Rewrite v2 generateCommunityPage + generateCommunitySummary
**Files:** `src/tools/wiki-page-generators.ts`, `tests/tools/wiki-page-generators.test.ts`
**Complexity:** complex
**Dependencies:** Task 13, 17
**Execution routing:** deep implementation tier

- [ ] RED: Update `tests/tools/wiki-page-generators.test.ts`. Test `generateCommunityPage(data, module)` produces markdown with sections in order: `## Overview`, `## Key Exports`, `## Files`, `## Dependencies`, `## Hub Symbols`, `## Hotspots`. Assert description from `module.description` appears in the Overview section. Assert no `"A community is a group"` substring. Test `generateCommunitySummary(data, module)` matches hook contract regex `/^## .+\n\n.+\n\n\*\*Role\*\*:.+\*\*Files\*\*:.+\n\n\*\*Key exports\*\*:/m`, total length ≤ 2500 chars.
- [ ] GREEN: Rewrite `generateCommunityPage(data, module: ModuleMetadata)` and `generateCommunitySummary(data, module: ModuleMetadata)` in `wiki-page-generators.ts` per spec API Surface. Use shared helpers `renderSection(header, lines)` and `formatFileList(files, max)` to avoid duplication (CQ2). Section order and labels are the stable contract per spec D6. Ensure summary file starts with `## {module.name}` and ends within 2500 chars.
- [ ] Verify: `npx vitest run tests/tools/wiki-page-generators.test.ts -t "v2"`
  Expected: all v2 community page + summary tests pass
- [ ] Acceptance: AC-SHIP-2, AC-SHIP-6, AC-SUCCESS-3, D6
- [ ] Commit: `feat(wiki-page-generators): rewrite community page + summary for v2`

### Task 19: Add generateOverviewPage + generateArchitecturePage
**Files:** `src/tools/wiki-page-generators.ts`, `tests/tools/wiki-page-generators.test.ts`
**Complexity:** standard
**Dependencies:** Task 13, 18
**Execution routing:** default implementation tier

- [ ] RED: Test `generateOverviewPage(project, modules)` contains: project name, `stack.language`, script names if any, entry_points list, blockquote summary line. Test `generateArchitecturePage(modules)` (when `modules.length >= 3`): at least one `[[slug]]` wikilink per module, a summary sentence, a "key relationships" section listing at least 5 cross-module edges (or all edges if fewer).
- [ ] GREEN: Add `generateOverviewPage(project: ProjectOverview, modules: ModuleMetadata[]): string` and `generateArchitecturePage(modules: ModuleMetadata[]): string`. Overview page structure: H1 = project name, blockquote summary, `## Stack`, `## Setup` (scripts), `## Entry Points`, `## Modules`, `## Known Issues` if gotchas present. Architecture page: H1 = "Architecture", blockquote summary, module list with wikilinks, `## Key Relationships` section with top-5 cross-module edges by weight (derived from `modules[].depends_on`).
- [ ] Verify: `npx vitest run tests/tools/wiki-page-generators.test.ts -t "overview|architecture"`
  Expected: both page tests pass
- [ ] Acceptance: AC-SUCCESS-6, D5 (overview page)
- [ ] Commit: `feat(wiki-page-generators): add overview and architecture page generators`

### Task 20: Rewrite generateHubsPage + generateIndexPage for v2
**Files:** `src/tools/wiki-page-generators.ts`, `tests/tools/wiki-page-generators.test.ts`
**Complexity:** standard
**Dependencies:** Task 10, 19
**Execution routing:** default implementation tier

- [ ] RED: Test `generateHubsPage(rankedHubs: RankedHubSymbol[])` includes `pagerank` column / visible ordering; test `generateIndexPage(pages, project)` contains project name + module section organized by role. Assert hubs output does NOT contain symbol names from `JS_BUILTIN_METHOD_NAMES` in top-10 rows.
- [ ] GREEN: Update `generateHubsPage` signature to accept `RankedHubSymbol[]`. Display symbol name, file, role, callers, file_rank (optional — not persisted but shown in markdown for debugging). Update `generateIndexPage(pages, project: ProjectOverview)` to group pages by type and open with project name + a blockquote summary.
- [ ] Verify: `npx vitest run tests/tools/wiki-page-generators.test.ts -t "hubs|index"`
  Expected: v2 hubs + index tests pass
- [ ] Acceptance: AC-SHIP-1b (partial — completes in Task 27), AC-SUCCESS-2
- [ ] Commit: `feat(wiki-page-generators): rewrite hubs and index pages for v2`

### Task 21: Wire orchestrator v2 path in wiki-tools.ts
**Files:** `src/tools/wiki-tools.ts`, `tests/tools/wiki-tools.test.ts`, `tests/integration/wiki-v2-thin-slice.test.ts` (new — thin-slice smoke test)
**Complexity:** complex
**Dependencies:** Task 11, 13, 15, 16, 18, 19, 20
**Execution routing:** deep implementation tier

- [ ] RED: Two test surfaces:
  (1) Update snapshot tests in `tests/tools/wiki-tools.test.ts`. Alongside snapshot, add NON-SNAPSHOT structural assertions (so the merge gate doesn't depend purely on reviewer-approved snapshot regen): `manifest.schema_version === 2`, `typeof manifest.project === "object"`, `manifest.project !== null`, `Array.isArray(manifest.modules) && manifest.modules.length >= 1`, every `module.description` is a non-empty string, `pages` includes an entry with `type === "overview"`, when `communities.length >= 3` there is an entry with `type === "architecture"`. Keep existing lockfile and atomic-write tests passing.
  (2) NEW thin-slice integration test at `tests/integration/wiki-v2-thin-slice.test.ts`: run `generateWiki` against the `ts-monorepo` fixture (requires Task 16), assert exit is normal, assert manifest parses as valid JSON, assert `schema_version === 2`, assert at least 2 communities have distinct `description` strings. This is the early integration validation pulled forward per adversarial review.
- [ ] GREEN: In `wiki-tools.ts`, after the 6-way parallel `allSettled`, run: (1) `buildFilePageRank(importEdges)`; (2) `rankHubsByPageRank(importEdges, symbolRoles)`; (3) `buildProjectOverview(projectResult, index)`; (4) `buildModuleMetadata(communities, projectResult, index, importEdges, hotspots, rankedHubs)`. Pass `ModuleMetadata` into `generateCommunityPage` / `generateCommunitySummary`. Add `overview` and `architecture` pages to `contentPages`. Call `buildWikiManifest(...)` (v2 writer) to produce the manifest. Preserve existing lockfile + atomic write + stale-cleanup behavior. Do NOT touch the v1 path in this task.
- [ ] Verify: `npx vitest run tests/tools/wiki-tools.test.ts tests/integration/wiki-v2-thin-slice.test.ts`
  Expected: structural assertions pass independent of snapshot regen, lockfile test passes, atomic write test passes, thin-slice integration test passes on `ts-monorepo` fixture
- [ ] Acceptance: AC-SHIP-3, AC-SHIP-7, D5, early-integration-validation per adversarial review
- [ ] Commit: `feat(wiki-tools): wire v2 orchestrator with rich module metadata`

### Task 22: V1 rollback path via env var and --v1 flag
**Files:** `src/tools/wiki-tools.ts`, `src/cli/wiki-commands.ts`, `tests/cli/wiki-v1-rollback.test.ts` (new)
**Complexity:** complex
**Dependencies:** Task 15, 17, 21
**Execution routing:** deep implementation tier

- [ ] RED: Create `tests/cli/wiki-v1-rollback.test.ts`. Test: set `process.env.CODESIFT_WIKI_V1 = "1"`, run `generateWiki(repo)`, assert written manifest lacks `schema_version`, lacks `project` and `modules` top-level keys; community pages contain v1 boilerplate `"A community is a group of files"`; community pages do NOT contain `## Overview` or `## Key Exports` headers. Test `--v1` CLI flag produces the same output.
- [ ] GREEN: In `wiki-tools.ts`, at the start of `generateWiki`, check `process.env.CODESIFT_WIKI_V1 === "1"`. If true, branch to a v1 code path that uses `wiki-page-generators-v1.ts` + `buildWikiManifestV1`. In `src/cli/wiki-commands.ts`, add `--v1` flag handling that sets the same env var before invoking `generateWiki`.
- [ ] Verify: `npx vitest run tests/cli/wiki-v1-rollback.test.ts`
  Expected: all 4 rollback assertions pass
- [ ] Acceptance: AC-SHIP-9, D9
- [ ] Commit: `feat(wiki-tools): add v1 rollback path via env var and CLI flag`

### Task 23: Raise hook summary budget to 2500 + env override with NaN guard
**Files:** `src/cli/hooks.ts`, `tests/cli/hooks.test.ts`
**Complexity:** standard
**Dependencies:** none (can run in parallel)
**Execution routing:** default implementation tier

- [ ] RED: Add tests: (a) default budget is 2500 after change, (b) `CODESIFT_WIKI_SUMMARY_MAX_CHARS=3000` env var raises the budget to 3000, (c) invalid env var `"abc"` falls back to 2500 (NaN guard), (d) summary > budget is truncated at budget, (e) hook never throws even when env var is undefined.
- [ ] GREEN: In `src/cli/hooks.ts`, update `WIKI_SUMMARY_MAX_CHARS` to 2500. Add env-var override: `const parsed = parseInt(process.env.CODESIFT_WIKI_SUMMARY_MAX_CHARS ?? "", 10); const budget = Number.isFinite(parsed) && parsed > 0 ? parsed : WIKI_SUMMARY_MAX_CHARS`. Use `Number.isFinite` (not just `Number.isNaN`) to catch `Infinity` edge case too. Keep the existing try/catch so hook never crashes.
- [ ] Verify: `npx vitest run tests/cli/hooks.test.ts`
  Expected: all hook tests pass (existing + 5 new)
- [ ] Acceptance: D8, CQ8 (hook never crashes)
- [ ] Commit: `feat(hooks): raise wiki summary budget to 2500 with env override`

### Task 24: Dashboard WikiManifest v2 types + conditional readers
**Files:** `../codesift-dashboard/src/lib/wiki-data.ts`, `../codesift-dashboard/tests/lib/wiki-data.test.ts` (new if absent)
**Complexity:** standard
**Dependencies:** Task 2
**Execution routing:** default implementation tier

- [ ] RED: In the dashboard repo, add `tests/lib/wiki-data.test.ts`. Test: (a) `getProjectOverview(repoName)` returns null when manifest is absent or lacks `schema_version`; (b) returns the `project` object when `schema_version === 2`; (c) `getModuleMetadata(repoName, slug)` returns null for v1 manifest; (d) returns the matching module for v2; (e) `getWikiManifest` successfully parses a v2 fixture without throwing.
- [ ] GREEN: In `../codesift-dashboard/src/lib/wiki-data.ts`, extend the `WikiManifest` interface (add optional `schema_version`, `project`, `modules`, `modules_truncated` fields). Add helpers: `getProjectOverview(repoName)`, `getModuleMetadata(repoName, slug)`. Both return null if `schema_version !== 2`. Wrap JSON parse in try/catch (malformed manifest → null, not throw).
- [ ] Verify: In dashboard repo: `npm test -- tests/lib/wiki-data.test.ts`
  Expected: all 5 tests pass
- [ ] Acceptance: AC-SHIP-4, D1 (dashboard)
- [ ] Commit: `feat(dashboard/wiki-data): add v2 types and conditional readers`

### Task 25: Dashboard ProjectOverviewCard component
**Files:** `../codesift-dashboard/src/components/ProjectOverviewCard.astro` (new), `../codesift-dashboard/src/styles/global.css`
**Complexity:** standard
**Dependencies:** Task 24
**Execution routing:** default implementation tier

- [ ] RED: Since Astro components lack a fast unit-test harness in this dashboard repo (verified by checking `../codesift-dashboard/package.json` test scripts), write a render-contract test at `../codesift-dashboard/tests/components/ProjectOverviewCard.test.ts` using a lightweight string assertion on the compiled HTML output: use `experimental_AstroContainer` from `astro/container` to render the component with a synthetic `ProjectOverview` prop, then assert the rendered HTML string contains: project name, `stack.language` value, each script key, each entry_point, and an "Issues" heading when gotchas are non-empty. The visual/styling correctness is validated via the Task 26 integration.
- [ ] GREEN: Create `ProjectOverviewCard.astro`. Accept `project: ProjectOverview` prop. Render sections: project name (H2), stack badges (language, framework, test_runner, package_manager, build_tool), a "Scripts" list, an "Entry Points" list, a "Known Issues" list if gotchas present. Use existing dashboard CSS variables (`--text-primary`, `--bg-elevated`, `--border-default`). Keep file under 150 LOC.
- [ ] Verify: `cd ../codesift-dashboard && npx astro check && npm test -- tests/components/ProjectOverviewCard.test.ts`
  Expected: no type errors AND the render-contract test written in RED passes
- [ ] Acceptance: AC-SHIP-5 (card presence), AC-SUCCESS-4 (card visible)
- [ ] Commit: `feat(dashboard): add ProjectOverviewCard component for wiki index`

### Task 26: Dashboard wiki index rendering with overview + differentiated excerpts
**Files:** `../codesift-dashboard/src/pages/wiki/[namespace]/[repo]/index.astro`, `../codesift-dashboard/src/components/WikiPageList.tsx`, `../codesift-dashboard/src/styles/global.css`
**Complexity:** standard
**Dependencies:** Task 24, 25
**Execution routing:** default implementation tier

- [ ] RED: Integration test (or dashboard Playwright if available) loading a v2 fixture manifest into `getWikiManifest`. Assert rendered DOM contains: (a) project name text, (b) stack label text, (c) at least 5 `WikiPageList` card elements, (d) no two cards share the same excerpt text. Fall back to a JSDOM-based render test if full Playwright setup is absent.
- [ ] GREEN: In `index.astro`, render `<ProjectOverviewCard project={project} />` above the community grid when `schema_version === 2`. Update `WikiPageList.tsx` to accept `modules?: ModuleMetadata[]` prop. When `modules` is provided, use `module.description` as the excerpt; fall back to the existing markdown-scrape excerpt when `modules` is absent (v1 manifests).
- [ ] Verify: `cd ../codesift-dashboard && npm run dev` (manual) + automated test if available
  Expected: project overview card visible at `/wiki/{namespace}/{repo}`, excerpts differ by module
- [ ] Acceptance: AC-SHIP-5, AC-SUCCESS-4
- [ ] Commit: `feat(dashboard): render project overview and module descriptions on wiki index`

### Task 27: Integration test — generate v2 wiki on codesift-mcp for AC-SHIP-1b
**Files:** `tests/integration/wiki-v2-codesift-mcp.test.ts` (new)
**Complexity:** standard
**Dependencies:** Task 21
**Execution routing:** default implementation tier

- [ ] RED: Create `tests/integration/wiki-v2-codesift-mcp.test.ts`. Run `generateWiki` against codesift-mcp's own index (or a reusable snapshot of it). Parse the generated `hubs.md`. Assert: (a) no symbol name in the top-10 hub rows matches the imported `JS_BUILTIN_METHOD_NAMES` Set, (b) `modules[]` in the generated manifest contains ≥ 15 entries (codesift-mcp has >15 communities), (c) each module has a non-empty `description` that does not exactly match any other module's description.
- [ ] GREEN: No production code change — this task just writes the integration assertion. May need to skip-if-no-index or use a snapshot of the index for portability.
- [ ] Verify: `npx vitest run tests/integration/wiki-v2-codesift-mcp.test.ts`
  Expected: all 3 AC-SHIP-1b + AC-SUCCESS-1 assertions pass
- [ ] Acceptance: AC-SHIP-1b, AC-SUCCESS-1, AC-SUCCESS-2
- [ ] Commit: `test(integration): AC-SHIP-1b on codesift-mcp hub output`

### Task 28: Integration test — 3 fixture repos snapshot tests
**Files:** `tests/integration/wiki-v2-fixtures.test.ts` (new)
**Complexity:** standard
**Dependencies:** Task 16, 21
**Execution routing:** default implementation tier

- [ ] RED: For each of the 3 fixture repos (`ts-monorepo`, `python-fastapi`, `go-module`): run `generateWiki`, snapshot the manifest JSON (redact `generated_at`, `index_hash`, `git_commit`), snapshot each `.md` page. Add ajv-validation assertion against `schemas/wiki-manifest-v2.schema.json`. Add AC-SUCCESS-5 assertion: for the `ts-monorepo` fixture with Next.js, the Next.js workspace's overview or community page contains the word "Next.js".
- [ ] GREEN: No production code — this is the full pipeline integration test. Write `vitest` snapshot `.snap` files and commit them. Ensure test runs fast enough (<5s per fixture) to stay in the default suite.
- [ ] Verify: `npx vitest run tests/integration/wiki-v2-fixtures.test.ts`
  Expected: snapshots match (or are regenerated with `--update-snapshots` flag), schema validations pass, Next.js keyword found
- [ ] Acceptance: AC-SHIP-3, AC-SHIP-8 (fixture half), AC-SUCCESS-5, AC-SUCCESS-6
- [ ] Commit: `test(integration): snapshot tests for 3 wiki-v2 fixture repos`

### Task 29: Update src/instructions.ts with wiki agent guidance
**Files:** `src/instructions.ts`
**Complexity:** standard
**Dependencies:** Task 21
**Execution routing:** default implementation tier

- [ ] RED: This task is docs-only (the instructions string is static data). Add a test in `tests/instructions.test.ts` asserting that `CODESIFT_INSTRUCTIONS` contains the phrase `"wiki-manifest.json"` and the phrase `"structured project overview"` — per spec Integration Points language.
- [ ] GREEN: Update the wiki-related line in `CODESIFT_INSTRUCTIONS` in `src/instructions.ts` per spec: include the agent consumption model and the TOOL MAPPING entry pointing agents to read the manifest for project overview.
- [ ] Verify: `npx vitest run tests/instructions.test.ts`
  Expected: both string-presence assertions pass
- [ ] Acceptance: D5 (agent consumption documented)
- [ ] Commit: `docs(instructions): document wiki-manifest.json agent consumption`

### Task 30: CLI smoke test for 3 stacks (AC-SHIP-8)
**Files:** `tests/cli/wiki-generate-smoke.test.ts` (new)
**Complexity:** standard
**Dependencies:** Task 16, 22, 28
**Execution routing:** default implementation tier

- [ ] RED: Add `tests/cli/wiki-generate-smoke.test.ts`. For each of the 3 fixture repos: exec `codesift wiki-generate` as a subprocess with CWD set to the fixture, assert exit code 0, assert `.codesift/wiki/wiki-manifest.json` exists with `schema_version: 2`, assert no stderr output beyond expected warnings. Keep runtime under 30s total (skip on CI with timeout flag if needed).
- [ ] GREEN: No production code — the CLI handler (`handleWikiGenerate`) already exists; this test exercises the full CLI → generator path.
- [ ] Verify: `npx vitest run tests/cli/wiki-generate-smoke.test.ts`
  Expected: all 3 fixtures produce valid v2 manifests via CLI
- [ ] Acceptance: AC-SHIP-8
- [ ] Commit: `test(cli): smoke test wiki-generate on 3 stacks`
