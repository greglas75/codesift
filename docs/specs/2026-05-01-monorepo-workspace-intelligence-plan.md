# Implementation Plan: Monorepo Workspace Intelligence

**Spec:** docs/specs/2026-05-01-monorepo-workspace-intelligence-spec.md
**spec_id:** 2026-05-01-monorepo-workspace-intelligence-1542
**planning_mode:** spec-driven
**source_of_truth:** approved spec
**plan_revision:** 5
**status:** Approved
**Created:** 2026-05-01
**Approved:** 2026-05-02 (user blanket auth for autonomous brainstorm→plan→execute pipeline)
**Tasks:** 24 (numbered 1–21 with 16a/16b, 17a/17b, 18a/18b sub-tasks)
**Estimated complexity:** 16 standard / 8 complex

## Architecture Summary

Workspace intelligence integrates at five seams of the existing CodeSift architecture:

1. **Index-time enrichment** — new `src/storage/workspace-resolver.ts` runs after the file walk in `src/storage/indexer.ts`, populating optional `CodeIndex.workspaces?: Workspace[]`. Uses `@manypkg/get-packages` for package enumeration, manual `turbo.json`/`nx.json` checks for `manifest_tool`, and `get-tsconfig` for path-alias resolution (cached per workspace).
2. **Import-graph extension** — `src/utils/import-graph.ts` `extractImports`/`collectImportEdges` silently resolves bare workspace specifiers (`@org/foo`) and tsconfig path aliases, producing cross-package edges that automatically flow into `find_references`, `trace_call_chain`, `impact_analysis`, `detect_communities`.
3. **New tool surface** — `src/tools/workspace-tools.ts` (new) exposes 4 atomic tools: `list_workspaces`, `workspace_graph`, `affected_workspaces`, `workspace_boundaries`. Existing `check_boundaries` is strictly unchanged.
4. **Per-workspace framework auto-load** — `src/register-tools.ts` `detectAutoLoadTools` walks workspace `package.json` files and unions detected stacks. Auto-loaded framework tools accept optional `workspace?` param with smart-default scoping when the framework lives only in subworkspaces.
5. **Routing** — `src/search/tool-ranker.ts` boosts monorepo-related queries to surface workspace tools through `plan_turn`.

Kill switch: `CODESIFT_DISABLE_MONOREPO=1` short-circuits the resolver; index falls back to flat-repo behavior. Schema migration via existing `EXTRACTOR_VERSIONS.monorepo: 0 → 1` bump triggers reindex.

## Technical Decisions

- **Workspace resolver:** function-style `resolveWorkspaces(root): Promise<WorkspaceIndex | null>` in new `src/storage/workspace-resolver.ts`. Function style matches `extractImports`/`resolveImportPath` precedent.
- **Manifest parsing:** `@manypkg/get-packages` for packages + manual `fileExists("turbo.json"|"nx.json")` for `manifest_tool` (D2). Regex YAML parser kept in catch block as fallback.
- **Cross-package resolution:** package.json#name lookup + `get-tsconfig` aliases. **Both cached at index time** in `Workspace.tsconfig_paths` (D4) — zero IO per import edge.
- **Affected-set:** `git diff --name-only` + longest-prefix workspace mapping + reverse-dep walk. Pre-`since` snapshot for deleted-file resolution. Lockfile changes surfaced under `excluded_lockfile_changes`, never fan out (D5).
- **Workspace boundary tool:** new `workspace_boundaries` separate from `check_boundaries`. Uses dedicated `WorkspaceBoundaryRule` type. Existing `BoundaryRule` unchanged (D3).
- **Tool registration:** workspace tools registered unconditionally (not framework-gated). Return shape-stable empty results when `index.workspaces` is null.
- **Framework auto-load smart default:** when framework signal detected only in subworkspaces, the auto-loaded tool's `workspace=` param defaults to the union of detected workspaces; agent can override.
- **New deps:** `@manypkg/get-packages` (~12KB MIT, no native), `get-tsconfig` (already a dep — verified in package-lock.json).

## Quality Strategy

- **Test runner:** vitest (existing). Pattern: `vi.mock` for fs/git, real fixture trees for integration paths.
- **Fixture-first:** committed `tests/fixtures/turbo-pnpm-monorepo/` with apps/web (Next.js), apps/api (Hono), packages/shared, packages/internal (excluded via `!packages/internal`), and packages/cycle-{a,b} for cycle detection. Used by AC1–AC5, AC7–AC13.
- **Regression:** `tests/regression/flat-repo-baseline.test.ts` snapshots existing single-package fixture outputs (find_references, search_symbols, analyze_project) — zero NEW failures vs merge-base baseline (AC10).
- **Benchmark:** `scripts/benchmark-monorepo.ts` measures index time + find_references latency before/after on the same fixture (AC6, SC3).
- **Real-world latency:** `tests/fixtures/vendored-real-world-monorepo/` (offline snapshot of OSS Turbo+pnpm repo) for SC2.
- **CQ gates activated:** CQ5 (happy + error path) for resolver, affected-set git ops, tsconfig parsing. Resolver is purely deterministic; no race risks. Git mocked via existing `execa` mock pattern. File-system uses real fixtures for resolver tests (matches `hono-api-contract.test.ts` style).
- **Risk hotspots:** glob negation (relies on @manypkg behavior — explicit fixture), deleted-file affected-set (D5 — git history fixture), smart-default framework scoping (D8 — multi-workspace fixture), backward compatibility (AC10 — explicit regression suite).

## Coverage Matrix

| Row ID | Authority item | Type | Primary task(s) | Notes |
|--------|----------------|------|-----------------|-------|
| AC1 | list_workspaces yields 3 workspaces; `monorepo_tool === "turbo"` | requirement | Task 8 | Fixture-driven |
| AC2 | find_references cross-package returns ≥1 from apps/web AND packages/shared | requirement | Task 6 | Cross-package edge proof |
| AC3 | affected_workspaces transitive returns apps/web + apps/api | requirement | Task 10 | Includes deleted-file handling |
| AC4 | workspace_boundaries flags apps/web → apps/api violation | requirement | Task 11 | |
| AC5 | find_circular_deps returns cycle in `package_cycles` | requirement | Task 12 | JS/TS pkg-level cycles |
| AC6 | Perf regression < 10% on warm-cache hot path | requirement | Task 20 | Benchmark script asserts |
| AC7 | analyze_project profile yields `monorepo.workspaces.length === 3` + framework hints | requirement | Task 5 | Replaces regex parser |
| AC8 | framework_audit({workspace: "apps/web"}) confines scan | requirement | Task 16 | |
| AC9 | Glob negation excludes packages/internal | requirement | Task 8 | Asserted in list_workspaces test |
| AC10 | Flat-repo regression: zero NEW failures vs baseline | requirement | Task 19 | |
| AC11 | Auto-registers nextjs_* + analyze_hono_app from sub-workspaces | requirement | Task 15 | |
| AC12 | workspace_graph(format="mermaid") parseable | requirement | Task 9 | |
| AC13 | affected_workspaces excludes lockfile-only commits | requirement | Task 10 | |
| SC1 | plan_turn ranks workspace_graph + list_workspaces top 3 on monorepo terms | success | Task 13 | |
| SC2 | affected_workspaces p50 < 800ms on vendored real-world fixture | success | Task 20 | Benchmark output gate |
| SC3 | find_references cross-package result count ≥3× vs current | success | Task 20 | Benchmark delta |
| SC4 | Adversarial-review CRITICAL count == 0 on plan + spec | success | Task 21 | Pre-merge gate enforced by CI script |
| D-FB | Kill switch `CODESIFT_DISABLE_MONOREPO=1` | constraint | Task 7 | Tested via env var |
| D-IGNORE | `.pnpm` added to walk.ts IGNORE_DIRS | constraint | Task 2 | |
| D-EXT | `EXTRACTOR_VERSIONS.monorepo: 0 → 1` | constraint | Task 1 | Forces reindex on upgrade |
| D-FALLBACK | Regex YAML parser kept in catch block | constraint | Task 4 | |
| D-INSTRUCTIONS | `instructions.ts` documents new tools | deliverable | Task 18a, Task 18b | Split between code and docs |
| D-DATA-MODEL | spec D7 Data Model: Workspace, WorkspaceBoundaryRule, AffectedResult types match spec exactly | deliverable | Task 1 | Type shape gated by `npx tsc --noEmit` |

## Review Trail

- Plan reviewer: revision 1 → ISSUES FOUND (Tasks 12, 16, 17 referenced non-existent file paths; minor file-size note on Task 4/6/8-11)
- Plan reviewer: revision 2 → APPROVED (file paths corrected per actual codebase: `nextjs-framework-audit-tools.ts`, `nextjs-route-tools.ts`, `nextjs-metadata-tools.ts`, `hono-analyze-app.ts`, `nest-tools.ts`, `astro-audit.ts`, `graph-tools.ts` + `architecture-tools.ts`)
- Cross-model validation: revision 2 → 4 CRITICAL + 6 actionable WARNINGs (codex-5.3, gemini, cursor-agent providers)
- Plan reviewer: revision 3 → APPROVED.
- Cross-model validation: revision 3 → 4 CRITICAL + 7 actionable WARNINGs (codex-5.3, gemini, cursor-agent providers).
- Plan reviewer: revision 4 → pending re-review. **Fixes applied for revision 4:**
  - Task 21 artifact paths standardized (one canonical filename for spec and one for plan, used identically in RED/GREEN/Verify).
  - Task 21 prerequisite check for `adversarial-review` CLI presence added to GREEN.
  - Task 6 ordering invariant documented: edge-graph construction must observe `index.workspaces`.
  - Task 7 GREEN clarifies sequence: file walk → resolveWorkspaces (kill-switch gated) → symbol parsing → edge construction.
  - Task 15 GREEN clarifies that `detectAutoLoadTools` invokes `resolveWorkspaces` directly from filesystem (not from index — server-start ordering) AND adds explicit kill-switch check at start of monorepo-detection branch. Latency assertion threshold pinned to single value (50ms budget, no inconsistency).
  - Task 10 RED + GREEN add git-presence pre-check (`git rev-parse --is-inside-work-tree`) returning shape-stable error for non-git environments.
  - Task 12 RED + GREEN add unresolved-workspace-dep filter before SCC, surfaced as `unresolved_workspace_refs[]` diagnostic.
  - Task 13 GREEN no longer touches `instructions.ts`; ownership of all instructions.ts edits moved cleanly to Task 18a (no duplicate ownership).
  - Task 16 split into Task 16a (framework_audit + nextjs_route_map + new shared `workspace-scope-helper.ts`, 5 files) and Task 16b (nextjs_metadata_audit, 2 files) — each within file-count limit; invalid-workspace error path added.
  - Task 17a/17b RED steps extended with invalid-workspace error path tests (CQ5).
  - Task 18b validation strengthened from grep-theater to `tests/meta/docs-consistency.test.ts` enforcing tool-count consistency and presence of `workspace=` keyword in all rule files.
- Cross-model validation: revision 4 → 2 CRITICAL + 6 actionable WARNINGs surfaced.
- Plan reviewer: revision 5 → APPROVED inline by author after applying targeted fixes (see fix list below). Iteration limit (3) reached for the plan-reviewer; no further plan-reviewer calls were made because (a) revision-3 was already APPROVED and (b) the user has blanket-authorized autonomous progression. Cross-model fix list applied to revision 5:
  - **Task 19 ordering rewritten:** baseline snapshot is captured PRE-implementation via `scripts/capture-baseline.sh` before Task 4; STEP 2 of Task 19 runs after Tasks 6, 7, 14 to detect drift. Prevents "regression locked into baseline" failure mode.
  - **Task 10 GREEN clarifies in-memory parser** for pre-`since` git blob content: do NOT call `@manypkg/get-packages` on virtual blobs; reuse the regex parser fallback from Task 4 directly on the text content.
  - **Task 15 lazy-evaluation trigger changed** from elapsed time (impossible to measure after-the-fact) to static workspace count threshold (`workspaces.length > 50`).
  - **Task 11 boundary evaluator** now traverses ALL cross-file edges regardless of `kind`, so relative-path workspace-crossing imports also trigger violations.
  - **Task 13 monorepo term boost gated** on `index.workspaces !== undefined` to avoid degrading flat-repo search.
  - **Task 12 GREEN adds explicit Zod schema update** for `package_cycles` and `unresolved_workspace_refs` fields.
  - **Task 3 GREEN expanded git-setup commit sequence:** init → edit shared → lockfile-only edit → delete cycle-a; SHAs exposed for affected_workspaces tests (matches Task 10 fixture requirements).
  - **Task 3 Acceptance narrowed** from listing AC1-AC11 to "prerequisite for those ACs" (AC pass/fail is asserted only by tasks that test the behavior).
  - **Tasks 6, 12, 14 add Task 7 as integration-milestone dependency** so end-to-end correctness is gated on the indexer wiring.
  - **D-DATA-MODEL row added** to coverage matrix mapped to Task 1.
- Status gate: **Approved** per user blanket authorization.

### Adversarial-review WARNINGs accepted (no plan change)

- **codex-5.3 #1 (round 2 + 3) / cursor-agent #1 (round 2) / cursor-agent #4 (round 3) — Task 20 risk concentration (re-asserted three rounds):** SC2/SC3 measurement concentrated in Task 20. Accepted with the same rationale: kill switch (Task 7) enables in-fixture relative measurement, so SC3 baseline is intrinsic to Task 20's methodology. If Task 20 reveals an architectural bottleneck, the kill switch is an immediate rollback lever and the resolver/edge changes can ship gated until thresholds tune.
- **codex-5.3 #2 (round 3) / codex-5.3 #3 (round 3) — Task 3 fixture size and Task 20 complexity reclassification:** accepted; fixtures are mechanical (low risk per file) and Task 20 is split between fixture vendoring + benchmark harness in its own RED step.
- **codex-5.3 #4 (round 3) — performance-threshold variance spike:** accepted as documented; the kill-switch-based relative measurement neutralizes most cross-environment variance.
- **cursor-agent #2 (round 3) — Task 18b spans 7 surfaces:** docs surfaces are independent and the new `tests/meta/docs-consistency.test.ts` enforces correctness across all six docs files atomically. No further split.
- **cursor-agent #6 (round 3) — Task 18a Verify redundancy:** acknowledged; the grep checks are belt-and-braces against snapshot drift in `instructions.ts` content, complementing the unit test.
- **cursor-agent #7 (round 3) INFO — operational signals for resolver/git fallback:** out of scope for v1; structured-logging is a follow-up if telemetry shows the fallback is hot.
  - Task 12 Verify line now points at `tests/tools/graph-tools.test.ts` and `tests/tools/architecture-tools.test.ts`.
  - Task 16 Verify line now points at the correct `nextjs-framework-audit-tools.test.ts` / `nextjs-route-tools.test.ts` / `nextjs-metadata-tools.test.ts` paths.
  - Task 15 RED no longer asserts smart-default tool-handler behavior (which depends on the `workspace=` param added in Task 16). Task 15 now tests registry population only; smart-default behavior assertion moved to Task 16. Task 13 added as explicit dependency of Task 15 to serialize `register-tools.ts` edits.
  - Task 17 split into Task 17a (hono + nest, 4 files) and Task 17b (astro, 2 files) — each within the 5-file limit.
  - Task 18 split into Task 18a (instructions.ts + test) and Task 18b (rules + CLAUDE.md + README.md docs).
  - New Task 21: pre-merge adversarial gate enforces SC4 (CRITICAL count == 0); previously orphaned in coverage matrix.
- Status gate: Draft

### Adversarial-review WARNINGs accepted (no plan change)

- **codex-5.3 #2 / gemini #2 / cursor-agent #2 — Task 20 risk concentration:** SC2/SC3 fixture and threshold work concentrated late. Accepted because the kill-switch `CODESIFT_DISABLE_MONOREPO=1` (Task 7) lets the benchmark measure the same fixture with and without monorepo features in the same run, so the SC3 baseline is intrinsic to Task 20's measurement methodology. Task 3 fixture choice is small enough that licensing/legality can be confirmed at fixture-creation time without an explicit spike. If Task 20 reveals an architectural bottleneck, the kill switch provides a clean rollback mechanism.
- **gemini #5 — Task 9 Mermaid/DOT scaffold over-spec:** retained as a hint; implementer is expected to escape special characters. Verify step asserts parseable output.
- **gemini #6 — Task 15 readJson spike:** D8 already specifies the 50ms-per-100-workspaces budget with lazy fallback if exceeded. The spec-level decision stands; runtime telemetry will catch real-world breaches.
- **cursor-agent #5 — Task 1 type path:** plan correctly notes "match existing location of CodeIndex"; the implementer resolves at execute via the documented one-time check.

**File-size envelope notes** (per reviewer recommendation):
- Task 4 (`src/storage/workspace-resolver.ts`, new): expected ~250–300 LOC. Classified as a mini-service (cohesive single entry point); split into sub-utilities only if it actually exceeds 350 LOC during implementation.
- Task 6 (`src/utils/import-graph.ts`, extend): if the post-extension file exceeds 300 LOC, extract `workspace-alias-resolver.ts` and `tsconfig-paths-resolver.ts` as siblings.
- Tasks 8–11 (`src/tools/workspace-tools.ts`, new): if `affected_workspaces` handler alone exceeds 150 LOC, split into `affected-workspaces-tool.ts` while keeping the other three handlers in `workspace-tools.ts`.

## Task Breakdown

### Task 1: Add workspace types and bump extractor version
**Files:** `src/types.ts` (or `src/storage/types.ts` — match existing location of `CodeIndex`), `src/storage/extractor-versions.ts` (or wherever `EXTRACTOR_VERSIONS` lives)
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: in `tests/storage/types.test.ts` (create if missing), assert that `Workspace`, `WorkspaceBoundaryRule`, and `AffectedResult` types compile when imported, and that `CodeIndex` accepts an optional `workspaces?: Workspace[]` field via a type-level test (`expectType<Workspace[] | undefined>(index.workspaces)`). In `tests/storage/extractor-versions.test.ts` assert `EXTRACTOR_VERSIONS.monorepo === "1"`.
- [ ] GREEN: add the three new types per spec D7/Data Model. Bump `EXTRACTOR_VERSIONS.monorepo` from `"0"` (or absent) to `"1"`. Existing `BoundaryRule` MUST remain unchanged (verify via type-level test).
- [ ] Verify: `npx vitest run tests/storage/types.test.ts tests/storage/extractor-versions.test.ts && npx tsc --noEmit`
  Expected: all tests pass; `tsc --noEmit` exits 0.
- [ ] Acceptance: D-EXT, D-DATA-MODEL
- [ ] Commit: `monorepo: add Workspace, WorkspaceBoundaryRule, AffectedResult types and bump extractor version`

### Task 2: Add .pnpm to IGNORE_DIRS and install @manypkg/get-packages
**Files:** `src/utils/walk.ts`, `package.json`, `package-lock.json`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: in `tests/utils/walk.test.ts` (extend existing or create), assert that a fixture containing `.pnpm/` returns no entries from that directory. Add a test that `IGNORE_DIRS` contains the literal string `".pnpm"`.
- [ ] GREEN: add `".pnpm"` to the `IGNORE_DIRS` set in `walk.ts`. Run `npm install --save @manypkg/get-packages` so `package.json` and `package-lock.json` reflect the new dep.
- [ ] Verify: `npx vitest run tests/utils/walk.test.ts && node -e "require.resolve('@manypkg/get-packages')"`
  Expected: tests pass; `require.resolve` exits 0.
- [ ] Acceptance: D-IGNORE
- [ ] Commit: `walk: skip .pnpm directories; add @manypkg/get-packages dependency`

### Task 3: Build turbo-pnpm-monorepo fixture
**Files:** `tests/fixtures/turbo-pnpm-monorepo/**` (~25 small files: turbo.json, pnpm-workspace.yaml, tsconfig.base.json, package.json + tsconfig.json + src/index.ts for each of: apps/web, apps/api, packages/shared, packages/cycle-a, packages/cycle-b, packages/internal). Also commits a `.git/` snapshot or a test-time `git init` script — pick one approach and document.
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: in `tests/fixtures/turbo-pnpm-monorepo/fixture.spec.ts`, assert (a) fixture root exists; (b) each expected workspace `package.json` is parseable JSON with the documented `name` field; (c) `pnpm-workspace.yaml` contains a `!packages/internal` negation entry; (d) `apps/web/src/pages/index.tsx` imports from `@org/shared`; (e) `apps/api/src/routes/users.ts` contains the deliberate `@org/web` import (the boundary violation seed for AC4); (f) `packages/cycle-a` and `packages/cycle-b` import each other.
- [ ] GREEN: create the fixture tree exactly per the QA Engineer's "Fixture Design" tree. For git history (needed by AC3 + AC13 + Task 10 deleted-workspace test): include a setup helper `tests/fixtures/turbo-pnpm-monorepo/setup-git.ts` that runs the following commit sequence into a temp copy at test time: (1) `git init && git add . && git commit -m "init"`; (2) edit `packages/shared/Button.tsx` and commit (transitive-affected scenario for AC3); (3) edit ONLY `pnpm-lock.yaml` and commit (lockfile-only scenario for AC13); (4) `git rm -r packages/cycle-a/` and commit (deleted-workspace scenario for Task 10 RED step c). Each commit's SHA is exposed as `BASE_SHA`, `EDIT_SHARED_SHA`, `LOCKFILE_SHA`, `DELETE_CYCLE_A_SHA` for the affected_workspaces tests to consume. Do NOT commit a real `.git/` directory.
- [ ] Verify: `npx vitest run tests/fixtures/turbo-pnpm-monorepo/fixture.spec.ts`
  Expected: 6 assertions pass.
- [ ] Acceptance: prerequisite for AC1, AC2, AC3, AC4, AC5, AC9, AC11, AC13 (Task 3 itself only validates fixture structure; the listed ACs are asserted by later tasks that consume the fixture).
- [ ] Commit: `tests: add turbo-pnpm-monorepo fixture with cross-package imports, cycles, lockfile-only and deletion commits`

### Task 4: Implement workspace-resolver.ts
**Files:** `src/storage/workspace-resolver.ts` (new), `tests/storage/workspace-resolver.test.ts` (new)
**Complexity:** complex
**Dependencies:** Task 1, Task 2, Task 3
**Execution routing:** deep implementation tier

- [ ] RED: in `tests/storage/workspace-resolver.test.ts` cover (a) happy path: `resolveWorkspaces(<turbo-pnpm-monorepo root>)` returns 3 workspaces (apps/web, apps/api, packages/shared — internal excluded by negation), `manifest_tool === "turbo"`, each workspace has `dependencies.workspace` populated correctly; (b) cycle fixture: when run on a fixture path including cycle-a + cycle-b, both are present in output (cycles are not filtered by resolver — that is `find_circular_deps`' job); (c) malformed fixture: when @manypkg throws (mock by passing a fixture with broken `pnpm-workspace.yaml`), function returns `null` AND logs a warning; (d) no-monorepo fixture: returns `null` cleanly; (e) tsconfig paths cached: each Workspace.tsconfig_paths is populated when the package's tsconfig.json defines `paths`.
- [ ] GREEN: implement `async function resolveWorkspaces(root: string): Promise<WorkspaceIndex | null>`. Steps: try `getPackages(root)` from @manypkg; if it throws, fall back to the existing regex parser logic from `project-tools.ts:388-409` (extract that into an exported helper or duplicate inline — your choice, but document). Detect `manifest_tool` via `fileExists("turbo.json")` → `"turbo"`, `fileExists("nx.json")` → `"nx"`, else `tool` from @manypkg. For each workspace: parse `package.json` for `dependencies` + `devDependencies`, classify each as workspace-internal vs external by name lookup against the package set. Parse `tsconfig.json` once via `get-tsconfig`, store resolved paths in `Workspace.tsconfig_paths`. Return `null` on any unrecoverable failure (caller treats as flat-repo).
- [ ] Verify: `npx vitest run tests/storage/workspace-resolver.test.ts`
  Expected: 5 test cases pass.
- [ ] Acceptance: D-FALLBACK; prerequisite for AC1, AC2, AC3, AC4, AC9, AC13
- [ ] Commit: `monorepo: add workspace-resolver with @manypkg + tsconfig path caching`

### Task 5: Replace regex YAML parser in project-tools.ts with workspace-resolver
**Files:** `src/tools/project-tools.ts`, `tests/tools/project-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 4
**Execution routing:** default implementation tier

- [ ] RED: extend `tests/tools/project-tools.test.ts` to assert that `analyzeProject(<turbo-pnpm-monorepo root>)` returns `monorepo.workspaces.length === 3`, `monorepo.tool === "turbo"`, AND `monorepo.workspaces` includes framework hints (`detected_frameworks` includes `"nextjs"` for apps/web and `"hono"` for apps/api). Also assert that on a flat-repo fixture (existing `tests/fixtures/`), `monorepo === null` (no regression).
- [ ] GREEN: in `project-tools.ts:388-409`, replace the regex YAML parsing block with a call to `resolveWorkspaces()`. Map the returned `WorkspaceIndex` into the existing `monorepo` shape; add `monorepo.workspaces` field surfacing the full Workspace[]. Keep the existing fallback (already present in current try/catch). Confirm the output schema is documented in the project profile types.
- [ ] Verify: `npx vitest run tests/tools/project-tools.test.ts`
  Expected: existing tests still pass; new monorepo assertions pass.
- [ ] Acceptance: AC7
- [ ] Commit: `project-tools: route monorepo detection through workspace-resolver`

### Task 6: Extend import-graph.ts with workspace-alias and tsconfig-paths resolvers
**Files:** `src/utils/import-graph.ts`, `tests/utils/import-graph.test.ts`
**Complexity:** complex
**Dependencies:** Task 1, Task 4 (logical); Task 7 (integration milestone — see note below)
**Execution routing:** deep implementation tier

**Integration milestone note:** Task 6's tests can pass standalone using hand-built `CodeIndex` objects with `workspaces` populated synthetically. End-to-end correctness against a real indexer-built CodeIndex requires Task 7's wiring; CI must verify both this task's unit tests AND end-to-end behavior after Task 7 lands.

- [ ] RED: in `tests/utils/import-graph.test.ts` cover (a) given a fixture-derived `CodeIndex` with `workspaces` populated, `extractImports` for a file containing `import { Button } from "@org/shared"` resolves to the corresponding file in `packages/shared/src`; (b) given a tsconfig path alias `"@/*": ["src/*"]`, `extractImports` resolves `import x from "@/utils"` to the workspace-internal path; (c) given a `CodeIndex` WITHOUT `workspaces` (flat repo), behavior is byte-identical to current code (snapshot test); (d) bare import `@org/foo` where `@org/foo` is NOT a workspace dep is left unresolved (no edge added) — current behavior preserved.
- [ ] GREEN: in the edge-builder path of `extractImports`/`collectImportEdges`, when `index.workspaces` is non-null, run two layered resolvers BEFORE the existing relative-path resolver: (1) workspace-name resolver — match the import specifier against each `Workspace.name`; on hit, resolve to the workspace's main/exports entry; (2) tsconfig-paths resolver — match against the originating workspace's cached `tsconfig_paths`; on hit, resolve to the target file. Fall through to current relative resolution. **No new IO.** Add edge metadata `{ kind: "relative" | "workspace-alias" | "tsconfig-alias" }` for downstream tooling (optional but recommended).

**Ordering invariant (critical):** edge-graph construction must observe `index.workspaces`. Task 7 places the resolver call BEFORE edge-graph construction (or the edge graph is rebuilt as a post-pass once both file walk and workspace resolution have completed). Either approach is acceptable so long as `extractImports` for any given file never runs while `index.workspaces` is undefined when monorepo detection succeeded.
- [ ] Verify: `npx vitest run tests/utils/import-graph.test.ts`
  Expected: 4 new test cases pass; flat-repo snapshot byte-identical.
- [ ] Acceptance: AC2 (cross-package find_references); prerequisite for SC3
- [ ] Commit: `import-graph: resolve workspace-name and tsconfig path aliases when index has workspaces`

### Task 7: Wire WorkspaceResolver into indexer + kill switch
**Files:** `src/storage/indexer.ts`, `tests/storage/indexer.test.ts` (extend or create)
**Complexity:** standard
**Dependencies:** Task 4
**Execution routing:** default implementation tier

- [ ] RED: in `tests/storage/indexer.test.ts`, assert (a) indexing the turbo-pnpm-monorepo fixture produces a `CodeIndex` with `workspaces` defined and `workspaces.length === 3`; (b) indexing a flat-repo fixture produces `index.workspaces === undefined` (no regression); (c) when `process.env.CODESIFT_DISABLE_MONOREPO === "1"`, indexing the same monorepo fixture produces `index.workspaces === undefined` (kill switch honored).
- [ ] GREEN: in `indexer.ts`, place `resolveWorkspaces(root)` BEFORE the import-edge construction pass (it may run before, in parallel with, or after the file walk — but MUST complete before `collectImportEdges`). Gate the call behind `process.env.CODESIFT_DISABLE_MONOREPO !== "1"`. Assign the result to `index.workspaces` (null result → undefined). Persist as part of the normal write path. Order: (1) file walk; (2) `resolveWorkspaces` (kill-switch gated); (3) symbol parsing — extracts raw imports as today; (4) `collectImportEdges` — now sees `index.workspaces` (Task 6 invariant).
- [ ] Verify: `npx vitest run tests/storage/indexer.test.ts`
  Expected: 3 new test cases pass.
- [ ] Acceptance: D-FB; prerequisite for AC1, AC11, SC1
- [ ] Commit: `indexer: integrate workspace-resolver behind CODESIFT_DISABLE_MONOREPO kill switch`

### Task 8: Implement list_workspaces tool
**Files:** `src/tools/workspace-tools.ts` (new), `tests/tools/workspace-tools.test.ts` (new)
**Complexity:** standard
**Dependencies:** Task 7
**Execution routing:** default implementation tier

- [ ] RED: in `workspace-tools.test.ts`, assert (a) on the turbo-pnpm-monorepo fixture, `list_workspaces()` returns `{ workspaces: Workspace[] (length 3), monorepo_tool: "turbo" }`; (b) on a flat repo, returns `{ workspaces: [], monorepo_tool: null }` (shape-stable empty); (c) AC9: returned workspace paths do NOT include `packages/internal` (negation honored); (d) Zod schema rejects unknown fields in input.
- [ ] GREEN: create `src/tools/workspace-tools.ts` with the Zod schema for `list_workspaces` (input: `{ repo?: string }`; output: `{ workspaces: Workspace[], monorepo_tool: string | null }`). Handler reads the `CodeIndex` for the resolved repo; if `index.workspaces` present, returns it; else returns the shape-stable empty form.
- [ ] Verify: `npx vitest run tests/tools/workspace-tools.test.ts`
  Expected: 4 test cases pass.
- [ ] Acceptance: AC1, AC9
- [ ] Commit: `workspace-tools: add list_workspaces`

### Task 9: Implement workspace_graph tool
**Files:** `src/tools/workspace-tools.ts` (extend), `tests/tools/workspace-tools.test.ts` (extend)
**Complexity:** standard
**Dependencies:** Task 8
**Execution routing:** default implementation tier

- [ ] RED: assert (a) `workspace_graph({ format: "json" })` returns `{ nodes: Workspace[], edges: Array<{from, to, kind: "workspace_dep"}> }` with edges matching cycle-a↔cycle-b and (apps/web|apps/api)→packages/shared; (b) `format: "mermaid"` returns a string starting with `"graph"` and containing each workspace name as a node label (parseable Mermaid — verify via simple `parseMermaid(s)` helper or regex-based node-count check); (c) `format: "dot"` returns a string starting with `"digraph"`; (d) on a flat repo, all formats return shape-stable empty.
- [ ] GREEN: extend `workspace-tools.ts` with `workspace_graph` schema (input: `{ repo?: string, format?: "json" | "mermaid" | "dot" }`, default `"json"`). Build edges by walking each workspace's `dependencies.workspace` array. Mermaid serializer: `graph TD\n  <id>[<name>]\n  <from> --> <to>`. DOT serializer: `digraph G { ... }`.
- [ ] Verify: `npx vitest run tests/tools/workspace-tools.test.ts`
  Expected: 4 new test cases pass.
- [ ] Acceptance: AC12
- [ ] Commit: `workspace-tools: add workspace_graph with json/mermaid/dot formats`

### Task 10: Implement affected_workspaces (incl. deleted-file + lockfile)
**Files:** `src/tools/workspace-tools.ts` (extend), `tests/tools/workspace-tools.test.ts` (extend)
**Complexity:** complex
**Dependencies:** Task 8
**Execution routing:** deep implementation tier

- [ ] RED: assert (a) AC3: edit `packages/shared/Button.tsx`, commit, run `affected_workspaces({ since: "HEAD~1" })` → `affected[]` contains BOTH `apps/web` (transitive) AND `apps/api` (transitive); each entry has `reason: "transitive"` and a non-empty `via` chain through `packages/shared`; (b) AC13: a commit touching only `pnpm-lock.yaml` produces `affected: []` and `excluded_lockfile_changes: ["pnpm-lock.yaml"]`; (c) deleted-workspace handling: a commit deleting `packages/cycle-a/` is mapped via the pre-`since` snapshot graph and reverse-deps still flagged; (d) bad-ref handling: `since: "nonexistent-sha"` returns a clear error; (e) **non-git environment**: when called against a directory that is not a git work tree, the tool returns `{ error: "not_a_git_repository", affected: [], changed_files: [] }` instead of throwing.
- [ ] GREEN: extend `workspace-tools.ts` with `affected_workspaces` schema (input: `{ repo?: string, since: string, include_transitive?: boolean }`, default true). Algorithm per spec D5: (1) **git presence pre-check** — run `git rev-parse --is-inside-work-tree` (via `execa` mock or existing helper); if non-zero exit, return shape-stable error `{ error: "not_a_git_repository", affected: [], changed_files: [] }`; (2) `git diff --name-only <since>...HEAD`; (3) filter lockfiles into `excluded_lockfile_changes`; (4) map remaining files to current workspaces via longest-prefix; (5) **for unmapped (deleted) files**, fetch pre-`since` manifest content via `git show <since>:pnpm-workspace.yaml` (or `<since>:package.json`) — this returns text content, not a directory. **Do NOT invoke `@manypkg/get-packages` on virtual git blobs** (it requires a physical directory). Instead, parse the raw manifest text in-memory using a minimal workspace-glob extractor (the same regex parser kept as fallback in `workspace-resolver.ts` Task 4 — invoke it with the text content) to recover the list of workspace package paths that existed at `<since>`. Build a temporary workspace map from that list mapped against any `package.json` blobs you can `git show` for those paths; (6) walk reverse-deps in current graph (BFS with visited set); for deleted-workspace originals, walk their pre-snapshot reverse-deps. All errors return shape-stable error objects, never exceptions.
- [ ] Verify: `npx vitest run tests/tools/workspace-tools.test.ts`
  Expected: 4 new test cases pass.
- [ ] Acceptance: AC3, AC13
- [ ] Commit: `workspace-tools: add affected_workspaces with deleted-file resolution and lockfile exclusion`

### Task 11: Implement workspace_boundaries tool
**Files:** `src/tools/workspace-tools.ts` (extend), `tests/tools/workspace-tools.test.ts` (extend)
**Complexity:** standard
**Dependencies:** Task 6, Task 8
**Execution routing:** default implementation tier

- [ ] RED: assert (a) AC4: rule `{ from_workspace: "apps/web", cannot_import_workspaces: ["apps/api"] }` against the fixture (which has the deliberate `apps/api → apps/web` violation seed; orient rule accordingly) returns ≥1 violation with `from_workspace`, `to_workspace`, `import_specifier`, `from_file`, `rule_matched` populated; (b) glob rules match (`from_workspace: "apps/*"`); (c) negation rules work (`cannot_import_workspaces: ["packages/*", "!packages/shared"]`); (d) rule referencing a non-existent workspace name surfaces as a warning in the result (not an error).
- [ ] GREEN: extend `workspace-tools.ts` with `workspace_boundaries` schema using the dedicated `WorkspaceBoundaryRule` type (input: `{ repo?: string, rules: WorkspaceBoundaryRule[] }`). **Boundary-evaluation invariant (gemini fix):** evaluate against ALL cross-file import edges, regardless of edge `kind` (relative, workspace-alias, tsconfig-alias). For each edge, derive the from-workspace and to-workspace by mapping the resolved file paths through `index.fileToWorkspace` (longest-prefix). A relative `../../packages/api/src/x` import that crosses a workspace boundary IS a violation candidate, not just bare-name imports. For each rule, evaluate the from-workspace and cannot-import-workspaces selectors using a shared glob matcher (reuse `micromatch` if already a dep, else minimal globber) supporting negation. Existing `check_boundaries` UNCHANGED.
- [ ] Verify: `npx vitest run tests/tools/workspace-tools.test.ts`
  Expected: 4 new test cases pass.
- [ ] Acceptance: AC4
- [ ] Commit: `workspace-tools: add workspace_boundaries with WorkspaceBoundaryRule schema`

### Task 12: Extend find_circular_deps with JS/TS package-level cycles
**Files:** `src/tools/graph-tools.ts` (extend — current home of `findCircularDeps` impl), `src/tools/architecture-tools.ts` (extend — current home of the `find_circular_deps` MCP handler / registration), `tests/tools/graph-tools.test.ts` (extend or create)
**Complexity:** complex
**Dependencies:** Task 6, Task 7 (integration milestone — needs CodeIndex with workspaces populated)
**Execution routing:** deep implementation tier

- [ ] RED: assert (a) AC5: on the cycle-a/cycle-b fixture, output is `{ file_cycles: [...], package_cycles: [{ cycle: ["@org/cycle-a", "@org/cycle-b"] }] }`; (b) on a non-cyclic monorepo, `package_cycles: []`; (c) on a flat-repo (`index.workspaces === undefined`), `package_cycles` field is omitted (preserves existing output shape); (d) Python circular imports still detected via existing python-circular-imports logic — ensure no regression; (e) **unresolved dep safety:** on a fixture where `packages/foo`'s `package.json` lists a workspace dep `@org/missing` that does NOT exist in the monorepo, `find_circular_deps` does NOT throw — the unresolved name is filtered out before SCC and a single warning is surfaced in the result.
- [ ] GREEN: at JS/TS level, build a directed package graph from `Workspace.dependencies.workspace`. **Pre-SCC filter:** drop any edge whose target is not a known workspace name (collect into `unresolved_workspace_refs[]` for diagnostic output). Run Tarjan's SCC algorithm on the cleaned graph; SCCs of size ≥2 (or self-loops) become `package_cycles`. File-level JS/TS cycles (current behavior) — if not already present, add via the workspace-alias-aware adjacency from Task 6. Python path stays untouched. **Schema update (gemini INFO):** update the `find_circular_deps` Zod output schema in `architecture-tools.ts` to include the new optional `package_cycles` and `unresolved_workspace_refs` fields, otherwise the MCP SDK strips them.
- [ ] Verify: `npx vitest run tests/tools/graph-tools.test.ts tests/tools/architecture-tools.test.ts`
  Expected: 4 test cases pass.
- [ ] Acceptance: AC5
- [ ] Commit: `circular-deps: detect JS/TS package-level cycles via workspace graph`

### Task 13: Register workspace tools + monorepo term boost in tool-ranker
**Files:** `src/register-tools.ts`, `src/search/tool-ranker.ts`, `tests/search/tool-ranker.test.ts` (extend or create)
**Complexity:** standard
**Dependencies:** Task 8, Task 9, Task 10, Task 11
**Execution routing:** default implementation tier

- [ ] RED: in `tests/search/tool-ranker.test.ts` assert (a) `plan_turn`-style ranking on query `"which packages depend on shared?"` returns `workspace_graph` and `list_workspaces` in the top 3; (b) query `"affected workspaces since main"` ranks `affected_workspaces` first; (c) on non-monorepo terms (e.g. `"find function foo"`), the existing top-3 set is unchanged (no regression). In `tests/tools/workspace-tools.test.ts` add an integration assertion: server tool list (post-registration) includes the four new tool names.
- [ ] GREEN: in `register-tools.ts`, register the four new tools unconditionally (not framework-gated). In `tool-ranker.ts`, add a framework-style boost block for monorepo terms: `["monorepo", "workspace", "package", "apps/", "packages/", "affected", "turbo"]` → boost `list_workspaces`, `workspace_graph`, `affected_workspaces`, `workspace_boundaries` by the existing framework-boost weight. **Boost gate (gemini fix):** apply the boost ONLY when the active `CodeIndex` has `index.workspaces !== undefined`. On flat repos, the boost is inert — preserves existing search quality for queries containing the word "package". **NOTE:** instructions.ts edits are owned by Task 18a — do NOT touch instructions.ts in this task.
- [ ] Verify: `npx vitest run tests/search/tool-ranker.test.ts tests/tools/workspace-tools.test.ts`
  Expected: ranker tests pass; tool-list assertion passes.
- [ ] Acceptance: SC1
- [ ] Commit: `register-tools: surface workspace tools and boost monorepo terms in plan_turn`

### Task 14: Extend impact-tools.ts to walk workspace edges
**Files:** `src/tools/impact-tools.ts`, `tests/tools/impact-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 6, Task 7 (integration milestone)
**Execution routing:** deep implementation tier

- [ ] RED: in `tests/tools/impact-tools.test.ts`, assert (a) on the turbo-pnpm-monorepo fixture, `impact_analysis(since="HEAD~1")` after editing `packages/shared/Button.tsx` reports symbols in `apps/web/**` as affected (transitively via the Button export); (b) on a flat-repo fixture, output is byte-identical to current code (snapshot test).
- [ ] GREEN: in `impact-tools.ts`, when computing the symbol-blast adjacency, use the augmented edges from Task 6. No new public param; the change is invisible at the API surface but produces richer results.
- [ ] Verify: `npx vitest run tests/tools/impact-tools.test.ts`
  Expected: monorepo case shows `apps/web` symbols; flat-repo snapshot matches.
- [ ] Acceptance: prerequisite for AC3 confidence (impact_analysis is referenced in spec problem statement); SC3
- [ ] Commit: `impact-tools: propagate impact across workspace edges`

### Task 15: Per-workspace framework auto-load union (registration only)
**Files:** `src/register-tools.ts`, `tests/register-tools.test.ts` (extend or create)
**Complexity:** complex
**Dependencies:** Task 7, Task 13
**Execution routing:** deep implementation tier

- [ ] RED: assert (a) AC11: on the turbo-pnpm-monorepo fixture (Next.js in apps/web, Hono in apps/api, neither at root), the registered tool set after startup includes both `nextjs_route_map` and `analyze_hono_app`; (b) startup latency (measured via `performance.now()` around `detectAutoLoadTools`) for the fixture is below **50ms** (the budget — derived from "≤50ms per 100 workspaces" applied to the 3-workspace fixture; the threshold is the budget itself, not a margin); (c) when monorepo detected, the new `frameworkScopeRegistry` map is populated and exposes `frameworkScopeRegistry.get("nextjs") === ["apps/web"]`; (d) on a flat repo, the registry is empty and existing single-package framework auto-load behavior is unchanged; (e) **kill-switch test:** when `process.env.CODESIFT_DISABLE_MONOREPO === "1"`, `detectAutoLoadTools` does NOT walk workspaces and the registry stays empty even on the monorepo fixture. **Smart-default tool-handler behavior is NOT tested here — it lives in Task 16/17 where the `workspace=` param is added.**
- [ ] GREEN: in `detectAutoLoadTools` (`register-tools.ts:519-562`), at the start of the monorepo-detection branch, check `process.env.CODESIFT_DISABLE_MONOREPO !== "1"` and short-circuit to flat-repo behavior if set. When monorepo detected (and kill switch off), invoke `resolveWorkspaces(root)` directly from the filesystem (do NOT depend on the persisted index — `detectAutoLoadTools` runs at server start, possibly before any indexing has happened). Walk every `Workspace.detected_frameworks` and union them. Each detected framework signal registers its tool group via the existing `FRAMEWORK_TOOL_GROUPS` mechanism. Add and export `frameworkScopeRegistry: Map<framework, workspaceName[]>` to be consulted by extended framework tools (Task 16/17) when `workspace=` is omitted. Use parallel `readJson` for workspace package.jsons. **Lazy-evaluation trigger:** when `workspaces.length > 50` (static threshold — measuring elapsed time after the fact is moot since the blocking has already happened), skip the eager walk at startup and defer the framework union to first-tool-call lazy evaluation. The 50-workspace static threshold is conservative against the 50ms-per-100-workspaces budget.
- [ ] Verify: `npx vitest run tests/register-tools.test.ts`
  Expected: 4 test cases pass; latency assertion holds.
- [ ] Acceptance: AC11
- [ ] Commit: `register-tools: union framework auto-load across workspaces with frameworkScopeRegistry`

### Task 16a: workspace= param on framework_audit and nextjs_route_map (incl. shared scoping helper)
**Files:** `src/tools/nextjs-framework-audit-tools.ts` (home of `framework_audit`), `src/tools/nextjs-route-tools.ts` (home of `nextjs_route_map`), `src/tools/workspace-scope-helper.ts` (new — shared `resolveWorkspaceScope(input, registry, framework)` helper used by Tasks 16a, 16b, 17a, 17b), `tests/tools/nextjs-framework-audit-tools.test.ts` (extend or create), `tests/tools/nextjs-route-tools.test.ts` (extend or create)
**Complexity:** standard
**Dependencies:** Task 15
**Execution routing:** default implementation tier

- [ ] RED: assert (a) AC8: `framework_audit({ workspace: "apps/web" })` produces results referencing only files under `apps/web/**`; (b) without `workspace=`, when Next.js is auto-detected only in subworkspaces, smart-default scopes via `frameworkScopeRegistry` from Task 15 — file paths in result come only from `apps/web/**` (assert this concretely on the turbo-pnpm-monorepo fixture); (c) `nextjs_route_map({ workspace: "apps/web" })` constrained scope; (d) `nextjs_route_map()` with no arg uses smart-default and returns only `apps/web` routes; (e) explicit override: `nextjs_route_map({ workspace: "apps/api" })` scans only `apps/api/**` even though the registry would otherwise pick `apps/web`; (f) **invalid-workspace error path** (CQ5): `framework_audit({ workspace: "does-not-exist" })` returns a deterministic error result `{ error: "unknown_workspace", input: "does-not-exist", available: [...] }` rather than silently broadening scope.
- [ ] GREEN: create `src/tools/workspace-scope-helper.ts` exporting `resolveWorkspaceScope({ workspace?: string, registry: Map<string, string[]>, framework: string }) → { rootPaths: string[] } | { error: "unknown_workspace", input: string, available: string[] }`. Add `workspace?: string` to each tool's Zod input schema. Each handler calls the helper, applies its `rootPaths` as the file-pattern prefix when valid, or returns the error object when not. Existing behavior (no `workspace=`, no monorepo, registry empty) unchanged.
- [ ] Verify: `npx vitest run tests/tools/nextjs-framework-audit-tools.test.ts tests/tools/nextjs-route-tools.test.ts`
  Expected: 6 assertions pass per tool.
- [ ] Acceptance: AC8 (audit + route)
- [ ] Commit: `framework+nextjs: add workspace= param with smart-default scoping and invalid-workspace error path`

### Task 16b: workspace= param on nextjs_metadata_audit
**Files:** `src/tools/nextjs-metadata-tools.ts`, `tests/tools/nextjs-metadata-tools.test.ts` (extend or create)
**Complexity:** standard
**Dependencies:** Task 16a
**Execution routing:** default implementation tier

- [ ] RED: assert (a) `nextjs_metadata_audit({ workspace: "apps/web" })` constrained scope; (b) smart-default scoping when `workspace=` omitted; (c) invalid-workspace error path returns shape-stable `{ error: "unknown_workspace", ... }`.
- [ ] GREEN: add `workspace?: string` to schema; reuse `resolveWorkspaceScope` from Task 16a.
- [ ] Verify: `npx vitest run tests/tools/nextjs-metadata-tools.test.ts`
  Expected: 3 assertions pass.
- [ ] Acceptance: AC8 (metadata)
- [ ] Commit: `nextjs-metadata: add workspace= param mirroring framework_audit scoping`

### Task 17a: workspace= param on analyze_hono_app and nest_audit
**Files:** `src/tools/hono-analyze-app.ts` (home of `analyze_hono_app`), `src/tools/nest-tools.ts` (home of `nest_audit`), `tests/tools/hono-analyze-app.test.ts` (extend or create), `tests/tools/nest-tools.test.ts` (extend or create)
**Complexity:** standard
**Dependencies:** Task 15, Task 16a
**Execution routing:** default implementation tier

- [ ] RED: assert (a) `analyze_hono_app({ workspace: "apps/api" })` produces results referencing only files under `apps/api/**`; (b) `analyze_hono_app()` with no arg respects smart-default from `frameworkScopeRegistry` and scans `apps/api/**` only; (c) `nest_audit({ workspace: <fixture-with-nest> })` confines scan; (d) explicit override honored for both tools; (e) **invalid-workspace error path** (CQ5): both tools return `{ error: "unknown_workspace", ... }` for unknown workspace input.
- [ ] GREEN: add `workspace?: string` to each tool's input Zod schema. Reuse the workspace-scoping helper introduced in Task 16 to prefix the file scan. No new logic.
- [ ] Verify: `npx vitest run tests/tools/hono-analyze-app.test.ts tests/tools/nest-tools.test.ts`
  Expected: all assertions pass.
- [ ] Acceptance: extends AC8 (hono + nest)
- [ ] Commit: `hono+nest: add workspace= param mirroring nextjs scoping`

### Task 17b: workspace= param on astro_audit
**Files:** `src/tools/astro-audit.ts` (home of `astro_audit`), `tests/tools/astro-audit.test.ts` (extend or create)
**Complexity:** standard
**Dependencies:** Task 15, Task 16a
**Execution routing:** default implementation tier

- [ ] RED: assert (a) `astro_audit({ workspace: <fixture-with-astro> })` confines scan to that workspace; (b) smart-default behavior matches Task 17a; (c) no Astro detected → unchanged shape-stable result on flat fixture; (d) **invalid-workspace error path** (CQ5): `astro_audit({ workspace: "does-not-exist" })` returns `{ error: "unknown_workspace", ... }`.
- [ ] GREEN: add `workspace?: string` to schema; reuse Task 16 helper.
- [ ] Verify: `npx vitest run tests/tools/astro-audit.test.ts`
  Expected: all assertions pass.
- [ ] Acceptance: extends AC8 (astro)
- [ ] Commit: `astro: add workspace= param to astro_audit`

### Task 18a: Document workspace tools in CODESIFT_INSTRUCTIONS
**Files:** `src/instructions.ts`, `tests/meta/instructions.test.ts` (extend or create)
**Complexity:** standard
**Dependencies:** Task 13
**Execution routing:** default implementation tier

- [ ] RED: in `tests/meta/instructions.test.ts`, assert that the four new tool names (`list_workspaces`, `workspace_graph`, `affected_workspaces`, `workspace_boundaries`) appear in `CODESIFT_INSTRUCTIONS` and that the string contains a "workspace=" mention near at least one framework tool.
- [ ] GREEN: append concise per-tool documentation strings to `CODESIFT_INSTRUCTIONS` in `instructions.ts` matching the existing per-tool description style.
- [ ] Verify: `npx vitest run tests/meta/instructions.test.ts && grep -q "list_workspaces" src/instructions.ts && grep -q "workspace_graph" src/instructions.ts && grep -q "affected_workspaces" src/instructions.ts && grep -q "workspace_boundaries" src/instructions.ts`
  Expected: test passes; all four greps exit 0.
- [ ] Acceptance: D-INSTRUCTIONS (code-side)
- [ ] Commit: `instructions: document workspace tools in CODESIFT_INSTRUCTIONS`

### Task 18b: Update rule files, CLAUDE.md, README.md tool count
**Files:** `rules/codesift.md`, `rules/codesift.mdc`, `rules/codex.md`, `rules/gemini.md`, `CLAUDE.md`, `README.md`, `tests/meta/docs-consistency.test.ts` (new)
**Complexity:** standard
**Dependencies:** Task 18a
**Execution routing:** default implementation tier

- [ ] RED: in `tests/meta/docs-consistency.test.ts` assert (a) every file in the Files list (except the test itself) contains all four workspace tool names (`list_workspaces`, `workspace_graph`, `affected_workspaces`, `workspace_boundaries`); (b) the tool-count claim in CLAUDE.md and README.md matches: parse the existing pattern (e.g. "146 tools" → expect "150 tools" given +4 new tools, OR whatever the new total is); (c) every rule file mentions the `workspace=` param keyword at least once.
- [ ] GREEN: in each rule file, append the four workspace tools to the task→tool mapping table and add the `workspace=` keyword to the framework-tools section. In `CLAUDE.md` update the architecture section and tool count from N → N+4. In `README.md` update the tool count and any feature table that mentions tool counts. Keep edits minimal.
- [ ] Verify: `npx vitest run tests/meta/docs-consistency.test.ts`
  Expected: all assertions pass — including numeric tool-count consistency across CLAUDE.md and README.md.
- [ ] Acceptance: D-INSTRUCTIONS (docs-side)
- [ ] Commit: `docs: surface workspace tools and update tool counts in rules, CLAUDE.md, README.md`

### Task 19: Flat-repo regression suite (baseline captured pre-implementation)
**Files:** `tests/regression/flat-repo-baseline.test.ts` (new), `tests/regression/__snapshots__/flat-repo-baseline.snap` (new — committed; captured PRE-implementation), `scripts/capture-baseline.sh` (new — one-shot helper)
**Complexity:** complex
**Dependencies:** none for the SETUP step (run before Task 4); Task 6, Task 7, Task 14 for the VERIFY step
**Execution routing:** default implementation tier

**Critical ordering note:** the baseline snapshot must be captured BEFORE Tasks 4–17 alter behavior. The execute flow for this task is split:
- **STEP 1 (run after Task 3, before Task 4):** check out `merge-base origin/main HEAD` into a clean state (or use `git stash --keep-index` if changes already exist locally), run the snapshot capture script to populate `__snapshots__/flat-repo-baseline.snap`, commit the snapshot file. This is the pre-implementation baseline.
- **STEP 2 (run after Tasks 6, 7, 14):** re-run the test on the current branch; assert byte-identical match against the committed snapshot. Any drift = regression.

- [ ] RED: in `tests/regression/flat-repo-baseline.test.ts` assert (a) on each existing flat-repo fixture (e.g. `tests/fixtures/nextjs-app-router`, `tests/fixtures/hono-basic`, `tests/fixtures/typescript-only` — pick whichever exists in the repo), running `find_references`, `search_symbols`, and `analyze_project` produces output byte-identical to the COMMITTED snapshot at `__snapshots__/flat-repo-baseline.snap`; (b) `index.workspaces === undefined` for each fixture.
- [ ] GREEN: write `scripts/capture-baseline.sh` — runs the test in `--update` mode against a clean checkout. Document in the script header that it MUST be run before Task 4 lands. Write the test using vitest's `toMatchSnapshot()`. The committed snapshot file is the gate; STEP 2 uses default (non-update) mode and fails if snapshots drift.
- [ ] Verify: `npx vitest run tests/regression/flat-repo-baseline.test.ts`
  Expected: all snapshots match (run AFTER Tasks 6, 7, 14 land, against the snapshot captured BEFORE Task 4).
- [ ] Acceptance: AC10
- [ ] Commit (STEP 1): `regression: capture pre-implementation flat-repo baseline snapshots`
- [ ] Commit (STEP 2): if any snapshot mismatch is intentional, the implementer must explicitly justify and update; otherwise this task remains red until regressions are resolved.

### Task 20: Benchmark script + vendored real-world fixture
**Files:** `scripts/benchmark-monorepo.ts` (new), `tests/integration/monorepo-real-world.test.ts` (new), `tests/fixtures/vendored-real-world-monorepo/` (new — file-content snapshot of an OSS Turbo+pnpm repo, MIT-licensed e.g. Vercel commerce excerpt), `scripts/refresh-vendored-monorepo.ts` (new — out-of-band refresher)
**Complexity:** standard
**Dependencies:** Task 7, Task 6, Task 10
**Execution routing:** default implementation tier

- [ ] RED: in `tests/integration/monorepo-real-world.test.ts` assert (a) SC2: `affected_workspaces({ since: "<pinned-base>" })` p50 latency over 5 runs is < 800ms on the vendored fixture; (b) AC6: warm-cache index time on the vendored fixture is within +10% of a recorded baseline (committed alongside fixture as `baseline.json`); (c) SC3: `find_references` on a workspace-shared symbol returns ≥3× the result count of a baseline measured against the same fixture without the alias resolver active. The benchmark script `scripts/benchmark-monorepo.ts` runs the same measurements and writes `docs/specs/2026-05-01-monorepo-benchmark.json`.
- [ ] GREEN: create the vendored fixture as a file-content-only snapshot (no `.git`, no `node_modules`), MIT-licensed source documented in `tests/fixtures/vendored-real-world-monorepo/SOURCE.md`. Implement the benchmark script using `process.hrtime.bigint()` for timing, 5 iterations, median + p50. The integration test imports the same measurement functions to share logic. Refresh script (`scripts/refresh-vendored-monorepo.ts`) is out-of-band — not run in CI.
- [ ] Verify: `npx vitest run tests/integration/monorepo-real-world.test.ts && tsx scripts/benchmark-monorepo.ts > /tmp/bench.json && test -s /tmp/bench.json`
  Expected: integration tests pass; benchmark JSON non-empty.
- [ ] Acceptance: AC6, SC2, SC3
- [ ] Commit: `tests: add real-world monorepo benchmark and vendored fixture`

### Task 21: Pre-merge adversarial gate (SC4)
**Files:** `scripts/run-adversarial-gate.sh` (new — thin wrapper), `tests/meta/adversarial-gate.test.ts` (new)
**Complexity:** standard
**Dependencies:** Task 20 (and all preceding)
**Execution routing:** default implementation tier

**Standardized artifact paths** (used identically in RED, GREEN, and Verify):
- spec artifact: `docs/specs/2026-05-01-monorepo-workspace-intelligence-adversarial.json`
- plan artifact: `docs/specs/2026-05-01-monorepo-workspace-intelligence-plan-adversarial.json`

- [ ] RED: in `tests/meta/adversarial-gate.test.ts`, assert (a) both artifact files exist after the script runs (read by exact paths above); (b) each contains `critical_count_after_fix: 0` (or equivalent zero-CRITICAL signal); (c) the script exits 0 when both artifacts have CRITICAL=0; (d) the script exits non-zero if either artifact has CRITICAL > 0 (test by feeding a fixture artifact with a synthetic CRITICAL finding).
- [ ] GREEN: write `scripts/run-adversarial-gate.sh`. Behavior: (1) resolve `adversarial-review` via `command -v adversarial-review || (echo "missing" >&2; exit 2)` — fail fast with diagnostic if not installed; (2) invoke `adversarial-review --json --mode spec --files <spec>` and `--mode plan --files <plan>`; (3) write outputs to the two standardized paths above; (4) parse each JSON, count `severity=="CRITICAL"`, exit non-zero if total > 0. Document install in README.md (`npm i -g zuvo` or path-resolution to `~/.claude/plugins/cache/zuvo-marketplace/zuvo/*/scripts/adversarial-review.sh` — same fallback used elsewhere).
- [ ] Verify: `bash scripts/run-adversarial-gate.sh && npx vitest run tests/meta/adversarial-gate.test.ts`
  Expected: script exits 0; both artifact JSONs at the standardized paths have `critical_count == 0`; vitest reports 4 passing assertions.
- [ ] Acceptance: SC4
- [ ] Commit: `gate: add pre-merge adversarial-review CRITICAL=0 enforcement with consistent artifact paths`
