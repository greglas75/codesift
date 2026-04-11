# Implementation Plan: Full NestJS Support

**Spec:** inline — no spec
**spec_id:** none
**planning_mode:** inline
**plan_revision:** 3
**status:** Reviewed
**Created:** 2026-04-11
**Tasks:** 15
**Estimated complexity:** 8 standard + 7 complex

## Architecture Summary

**Scope:** 4 quick-win extensions to existing tools (A1-A4) + 5 new NestJS analysis tools (B1-B5) + 1 meta-audit orchestrator (C). All housed in a single new file `src/tools/nest-tools.ts` (B+C), with modifications to 4 existing files (A-series).

**Components involved:**
- `src/utils/framework-detect.ts` — A1: NestJS dead-code whitelist
- `src/tools/pattern-tools.ts` — A2: NestJS anti-patterns
- `src/tools/route-tools.ts` — A3: extended route tracing (empty decorators, regex paths)
- `src/tools/project-tools.ts` — A4: APP_INTERCEPTOR in extractNestConventions
- `src/tools/nest-tools.ts` — NEW: B1-B5 + C (6 tools, ~350-450 lines)
- `src/register-tools.ts` — wiring: tool definitions + discover/describe
- `src/formatters.ts` — new formatter functions

**Data flow:** User calls `nest_audit` (C) → parallel dispatch to `nest_di_graph` (B1), `nest_guard_chain` (B2), `nest_module_graph` (B3), `nest_route_inventory` (B4), `nest_lifecycle_map` (B5), plus `searchPatterns` (A2) and `findDeadCode` (A1-enhanced) → aggregate → scored verdict.

**Dependency direction:** `nest-tools.ts` → `index-tools`, `graph-tools`, `import-graph`, `project-tools`, `route-tools`, `pattern-tools`, `symbol-tools`, `types`. Nothing imports from `nest-tools.ts` except `register-tools.ts`.

## Technical Decisions

- **Single file for B+C tools** (`nest-tools.ts`), following `audit-tools.ts` composite pattern. Split only if >500 lines.
- **Tool-local types** — all 6 result interfaces defined in `nest-tools.ts` (matches codebase convention: tool-specific types live in tool files).
- **Regex-over-source** for decorator parsing (proven by `extractNestConventions`). No AST/tree-sitter changes needed.
- **Additive code path for A3** — existing `findNestJSHandlers` regex untouched; new branch handles empty decorators and regex paths.
- **NestConventions extended in-place** (project-tools.ts) — `global_interceptors?: NestProviderEntry[]` added to interface.
- **No new dependencies** — all capabilities covered by existing infra.
- **B-series tools discoverable** (hidden via `disable()`), C (`nest_audit`) promoted to core.

## Quality Strategy

- **Test framework:** Vitest, `describe`/`it`/`expect` pattern
- **Fixture pattern:** Inline source strings for unit tests (like `NEST_MODULE_SOURCE` in project-tools.test.ts); temp-dir fixtures for integration tests requiring `readFile`
- **Key risk:** `findNestJSHandlers` reads from real FS — B4 integration tests must use temp-dir, assert non-empty results
- **CQ gates activated:** CQ6 + CQ7 (unbounded graphs → cap nodes on B1/B3/B4/B2 with `truncated: true` flag), CQ8 (readFile error handling → negative test per IO-dependent tool), CQ14 (shared parsing helpers extracted at first consumer in Task 6, not speculatively in Task 5)
- **File size exception:** `nest-tools.ts` estimated at 350-450 lines — documented precedent in `context-tools.ts` (582 lines). This is a deliberate composite file, not a CQ11 violation.
- **Execution ordering constraint:** Tasks 1-4 may run in parallel (each touches a different file). Tasks 5-10 are STRICTLY SEQUENTIAL — they all modify `src/tools/nest-tools.ts` and later tasks depend on earlier type/helper definitions. Tasks 12a/12b/12c are sequential (docs before deploy before publish).
- **Malformed source resilience:** Every B-tool must skip unreadable/malformed files with a warning, not abort the scan (CQ8). Each B-tool task has a negative fixture acceptance criterion.
- **New test files:** `tests/utils/framework-detect.test.ts` (A1), `tests/tools/nest-tools.test.ts` (B+C)
- **Existing test updates:** `tests/tools/project-tools.test.ts` (A4), `tests/integration/tools.test.ts` (A2, A3)

## Task Breakdown

### Task 1: NestConventions interface extension + APP_INTERCEPTOR parsing
**Files:** `src/tools/project-tools.ts`, `tests/tools/project-tools.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: Add test in `tests/tools/project-tools.test.ts` within the existing NestJS `describe` block. Create a variant of `NEST_MODULE_SOURCE` that includes `{ provide: APP_INTERCEPTOR, useClass: LoggingInterceptor }` in the providers array plus import for `APP_INTERCEPTOR` from `@nestjs/core`. Assert `extractNestConventions(source, 'test.module.ts').global_interceptors` is an array of length 1 with `name === 'LoggingInterceptor'` and correct `token`, `imported_from`. Also test: multiple APP_INTERCEPTOR entries captured; no cross-contamination with existing APP_GUARD/APP_FILTER arrays.
- [ ] GREEN: Extend `NestConventions` interface (line 144) with `global_interceptors: NestProviderEntry[]`. Add `APP_INTERCEPTOR` regex block in `extractNestConventions` (after the existing `APP_PIPE` block, ~line 956). Initialize `global_interceptors` as empty array. Pattern: same as `APP_GUARD` — scan for `provide:\s*APP_INTERCEPTOR`, look ahead 5 lines for `useClass`.
- [ ] Verify: `npx vitest run tests/tools/project-tools.test.ts`
  Expected: all existing NestJS tests pass + new interceptor tests pass
- [ ] Acceptance: APP_INTERCEPTOR extraction works identically to APP_GUARD/APP_FILTER
- [ ] Commit: `feat: extract APP_INTERCEPTOR from NestJS modules in project analysis`

### Task 2: Extend NestJS dead-code whitelist (guard/interceptor/pipe/filter + bootstrap)
**Files:** `src/utils/framework-detect.ts`, `tests/utils/framework-detect.test.ts` (new)
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

**IMPORTANT — pre-existing state:** `framework-detect.ts:17-18` already has `NESTJS_LIFECYCLE` (all 5 hooks) and `NESTJS_CONTROLLER_FILE` (covers `controller|resolver|gateway` only). Lines 46-49 already have the `if (frameworks.has("nestjs"))` block. This task SURGICALLY EXTENDS that existing block — do NOT recreate it.

- [ ] RED: Create `tests/utils/framework-detect.test.ts`. Test `isFrameworkEntryPoint` with `frameworks = new Set(["nestjs"])`:
  - Regression (existing behavior): Returns `true` for `onModuleInit`, `onModuleDestroy`, `onApplicationBootstrap`, `onApplicationShutdown`, `beforeApplicationShutdown`
  - Regression: Returns `true` for symbols in `*.controller.ts`, `*.resolver.ts`, `*.gateway.ts`
  - **NEW:** Returns `true` for symbols in `*.guard.ts`, `*.interceptor.ts`, `*.pipe.ts`, `*.filter.ts` (these are the gap)
  - **NEW:** Returns `true` for `bootstrap` in `src/main.ts` or `main.ts`
  - Returns `false` for `onModuleInitialize` (partial match — should not whitelist)
  - Returns `false` for lifecycle hook names when frameworks does NOT include `nestjs`
  - Returns `false` for symbols in `users.controller.spec.ts` (spec files excluded — current regex requires `[jt]sx?` immediately after the dot)
  - Returns `false` for `bootstrap` in file other than `main.ts`
  Also test `detectFrameworks`: verify `nestjs` detected when index symbols contain `@nestjs/` imports.
- [ ] GREEN: Two surgical edits in `src/utils/framework-detect.ts`:
  1. Extend `NESTJS_CONTROLLER_FILE` regex (line 18) to include `guard|interceptor|pipe|filter`. New regex: `/\.(controller|resolver|gateway|guard|interceptor|pipe|filter)\.[jt]sx?$/`. Rename constant to `NESTJS_ENTRY_FILE` for clarity.
  2. Add `main.ts` + `bootstrap` check inside the existing `if (frameworks.has("nestjs"))` block (after line 48): match file `/(^|\/)main\.[jt]sx?$/` + name `bootstrap`.
- [ ] Verify: `npx vitest run tests/utils/framework-detect.test.ts`
  Expected: all tests pass (~12 test cases)
- [ ] Acceptance: `find_dead_code` no longer reports NestJS guards, interceptors, pipes, filters, or `main.ts` `bootstrap` as dead code
- [ ] Commit: `feat: extend NestJS dead-code whitelist to guard/interceptor/pipe/filter files and main.ts bootstrap`

### Task 3: NestJS anti-patterns in BUILTIN_PATTERNS
**Files:** `src/tools/pattern-tools.ts`, `tests/integration/tools.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: Add `describe("search_patterns — NestJS anti-patterns")` block in integration tests. For each new pattern, create BOTH a positive fixture (should match) AND a negative fixture (must NOT match). Assert both `matches.length >= 1` on positive and `matches.length === 0` on negative.
  1. `nest-circular-inject` — positive: `@Inject(forwardRef(() => UserService))`; negative: regular `@Inject('TOKEN')`
  2. `nest-catch-all-filter` — positive: `@Catch()` empty; negative: `@Catch(HttpException)`
  3. `nest-request-scope` — positive: `{ scope: Scope.REQUEST }`; negative: `{ scope: Scope.DEFAULT }`
  4. `nest-raw-exception` — positive: `throw new Error('x')` inside `*.controller.ts`; negative: same `throw` inside `*.util.ts`
  5. `nest-any-guard-return` — positive: `canActivate() { return true; }`; negative: `canActivate() { return user.isAdmin; }`
  6. `nest-service-locator` — positive: `this.moduleRef.get(SomeService)`; negative: regular `this.service.getById(...)`
  7. `nest-direct-env` — positive: `process.env.DATABASE_URL` inside `*.service.ts`; negative: same inside `*.config.ts` or `config.service.ts`
  Also test `listPatterns()` count increases by 7.
- [ ] GREEN: Add 7 entries to `BUILTIN_PATTERNS` in `pattern-tools.ts` with regex and description for each. Keep regexes tight to minimize false positives — test both positive and negative fixtures.
- [ ] Verify: `npx vitest run tests/integration/tools.test.ts -t "NestJS"`
  Expected: all 7 pattern tests pass + listPatterns count correct
- [ ] Acceptance: `search_patterns(repo, "nest-*")` returns NestJS-specific findings
- [ ] Commit: `feat: add 7 NestJS anti-pattern detectors to search_patterns`

### Task 4: Extend findNestJSHandlers for empty decorators and regex paths
**Files:** `src/tools/route-tools.ts`, `tests/tools/route-tools.test.ts` (new)
**Complexity:** complex
**Dependencies:** none
**Execution routing:** deep implementation tier

- [ ] RED: Create `tests/tools/route-tools.test.ts`. Write temp-dir fixtures (real files — `findNestJSHandlers` calls `readFile`):
  1. `@Controller('api')` + `@Get()` (empty decorator) → handler found for `/api/`
  2. `@Controller('api')` + `@Get(':id')` → handler found for `/api/123`
  3. `@Controller()` (empty prefix) + `@Get('users')` → handler found for `/users`
  4. `@Get` with no parentheses → should not throw, no match
  5. Regression: `@Controller('api')` + `@Get('users')` → still works (existing behaviour)
  Test both `findNestJSHandlers` directly (export it) and `traceRoute` end-to-end with a NestJS fixture.
- [ ] GREEN: In `route-tools.ts`, add a second pass after the existing regex loop (additive — do NOT modify line 87 regex):
  - Empty decorator match: `@${method}\s*\(\s*\)` → route path is empty string
  - Also handle `@Controller()` (no arg) → empty prefix
  - Export `findNestJSHandlers` for direct testing (currently module-private). Verify no circular dependency introduced: `nest-tools.ts → route-tools.ts` is fine because `route-tools.ts` has no imports from `nest-tools.ts`. No existing consumer of `route-tools.ts` breaks (only `register-tools.ts` imports `traceRoute`).
  QA risk: Do not touch existing regex at line 87. Additive branch only.
- [ ] Verify: `npx vitest run tests/tools/route-tools.test.ts`
  Expected: all 5+ test cases pass, regression case included
- [ ] Acceptance: `trace_route(repo, '/api/')` works with NestJS empty-decorator controllers
- [ ] Commit: `feat: handle empty NestJS decorators and parameterized paths in trace_route`

### Task 4.5: Parser feasibility spike
**Files:** `docs/specs/2026-04-11-nestjs-support-spike.md` (new, throwaway)
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

**Purpose:** De-risk the regex-over-source approach before committing to B1-B5. Reviewers flagged the regex-heavy parsing strategy (dynamic modules, generic types in constructor injection, multi-line decorators) as unproven. Prototype the 3 hardest extraction patterns against real NestJS fixtures and document findings.

- [ ] RED: No test — spike task.
- [ ] GREEN: Write a throwaway spike file at `docs/specs/2026-04-11-nestjs-support-spike.md` with:
  1. **Constructor injection extraction** — validate regex against fixtures: simple (`constructor(private u: UserService)`), multi-line, with generics (`Repository<User>`), with decorators (`@Optional() u: UserService`), with `forwardRef(() => X)`. Document pass/fail per fixture.
  2. **@Injectable class detection** — validate against: exported class, nested namespace, class with multiple decorators stacked, abstract class.
  3. **@UseGuards chain extraction** — validate against: single guard, multiple guards, composed decorator (`@Auth()` wrapping `@UseGuards()`).
  For each fixture, note whether regex parsing is sufficient or whether a fallback (tree-sitter, manual AST) is needed. Lock invariants.
- [ ] Verify: Spike document exists with at least 3 fixtures per pattern + pass/fail matrix
  Expected: feasibility verdict PASS (regex sufficient) or PIVOT (need tree-sitter enhancement)
- [ ] Acceptance: Clear go/no-go decision before Task 5 begins. If PIVOT, update plan revision before proceeding.
- [ ] Commit: `spike: validate regex-over-source parsing for NestJS decorator extraction`

### Task 5: NestJS tool types and nest_lifecycle_map
**Files:** `src/tools/nest-tools.ts` (new), `tests/tools/nest-tools.test.ts` (new)
**Complexity:** standard
**Dependencies:** Task 4.5 (spike feasibility verdict must be PASS)
**Execution routing:** default implementation tier

- [ ] RED: Create `tests/tools/nest-tools.test.ts`. Define a `describe("nest_lifecycle_map")` block. Fixture: inline source strings for 2-3 classes implementing lifecycle hooks (`async onModuleInit()`, `onApplicationBootstrap()`, `onModuleDestroy()`). Mock `getCodeIndex` to return a `CodeIndex` with these files/symbols. Assert:
  - Returns array of `NestLifecycleEntry` with correct `class_name`, `file`, `hook` fields
  - Async hooks detected (`async onModuleInit()`)
  - Multiple hooks on same class all listed
  - Empty result (no hooks in codebase) returns empty array, not error
  - **CQ8:** Malformed source (unbalanced braces, syntax error) does NOT throw — returns warning in result, skips file
- [ ] GREEN: Create `src/tools/nest-tools.ts`. Define all B-series result interfaces (`NestDINode`, `NestDIEdge`, `NestDIGraphResult`, `NestGuardChainEntry`, `NestGuardChainResult`, `NestModuleNode`, `NestModuleGraphResult`, `NestRouteEntry`, `NestRouteInventoryResult`, `NestLifecycleEntry`, `NestLifecycleMapResult`, `NestAuditCheck`, `NestAuditResult`). Each result type MUST include an `errors?: Array<{file: string; reason: string}>` field for per-file skip warnings. Implement `nestLifecycleMap(repo)`: scan symbols for lifecycle hook method names (`onModuleInit`, `onModuleDestroy`, `onApplicationBootstrap`, `onApplicationShutdown`, `beforeApplicationShutdown`). Return structured results with `errors` field.
- [ ] Verify: `npx vitest run tests/tools/nest-tools.test.ts -t "lifecycle"`
  Expected: all lifecycle tests pass including malformed-source skip case
- [ ] Acceptance: `nest_lifecycle_map` returns all lifecycle hooks; malformed files skipped gracefully. Interfaces defined but shared parsing helpers (e.g., `parseUseGuards`) are NOT required here — they will be introduced at their first consumer (Task 6 for module parsing, Task 8 for guard parsing) to avoid speculative scaffolding.
- [ ] Commit: `feat: add NestJS tool types and nest_lifecycle_map tool`

### Task 6: nest_module_graph — module dependency + boundary graph
**Files:** `src/tools/nest-tools.ts`, `tests/tools/nest-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 1 (NestConventions with global_interceptors), Task 5 (types)
**Execution routing:** deep implementation tier

- [ ] RED: Add `describe("nest_module_graph")` in nest-tools.test.ts. Fixture: 3 inline module sources (`AppModule` importing `AuthModule` + `PrismaModule`, `AuthModule` importing `PrismaModule`, `PrismaModule` standalone). Mock `getCodeIndex` with corresponding files. Assert:
  - `modules` array has 3 entries with correct names and files
  - `edges` include `AppModule → AuthModule`, `AppModule → PrismaModule`, `AuthModule → PrismaModule`
  - `@Global()` module flagged with `is_global: true`
  - Mermaid output format produces valid mermaid graph syntax
  - Empty repo (no module files) returns empty graph
  - `forRoot()`/`forRootAsync()` dynamic modules handled (class name extracted, not the call expression)
- [ ] GREEN: Implement `nestModuleGraph(repo, options?)` in nest-tools.ts:
  - Use `getCodeIndex` → filter `*.module.ts` files → read source → call `extractNestConventions` per file
  - **CQ14:** Extract shared helper `parseModuleMetadata(source)` here — this is the first consumer. Helper must be reusable by B3/B7
  - Build module nodes from all discovered modules
  - Build edges from `imports` arrays (resolve module names to files via import map)
  - Detect circular module imports (DFS on the edge graph)
  - **CQ7 cap:** `max_modules: number` option (default 200) — stop processing if exceeded, return `truncated: true` flag
  - **CQ8:** Wrap `readFile` in try/catch — missing/unreadable files append to `errors` array, do not abort scan
  - Support `output_format: "mermaid"` for diagram output
  Additional RED cases: malformed module file does not crash; `truncated: true` set when fixture exceeds `max_modules: 2`; unreadable file appended to `errors` array
- [ ] Verify: `npx vitest run tests/tools/nest-tools.test.ts -t "module_graph"`
  Expected: all module graph tests pass including truncation and error path
- [ ] Acceptance: `nest_module_graph` produces correct module dependency graph with circular detection
- [ ] Commit: `feat: add nest_module_graph tool for NestJS module dependency analysis`

### Task 7: nest_di_graph — DI provider dependency graph
**Files:** `src/tools/nest-tools.ts`, `tests/tools/nest-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 5 (types), Task 6 (module graph for cross-module warnings)
**Execution routing:** deep implementation tier

- [ ] RED: Add `describe("nest_di_graph")` block. Fixture: inline sources for 3 providers — `AuthService` injecting `UserService` and `ConfigService` via constructor, `UserService` injecting `PrismaService`, `PrismaService` with no deps. Assert:
  - `nodes` array contains all 4 providers with name, file, kind
  - `edges` include `AuthService → UserService`, `AuthService → ConfigService`, `UserService → PrismaService`
  - Provider with zero deps has no outgoing edges
  - Circular DI detected (add fixture: `A → B → A`)
  - Cross-module injection warning when provider used outside its declared module
  - Cap: max 200 nodes (CQ6 — unbounded graph)
- [ ] GREEN: Implement `nestDIGraph(repo, options?)`:
  - **CQ14:** Extract shared helpers `parseInjectableClasses(source)` and `parseConstructorInjects(source, className)` — reusable by Task 8 and future tools
  - Use invariants locked in Task 4.5 spike (generics, forwardRef, @Optional handling)
  - Build directed graph: provider → injected types
  - Detect cycles via DFS
  - Cross-reference with module graph for cross-module warnings
  - **CQ7 cap:** `max_nodes: 200` default; set `truncated: true` if exceeded
  - **CQ8:** try/catch per file; errors → `errors` array
  - Support `output_format: "mermaid"`, `focus` path filter
- [ ] Verify: `npx vitest run tests/tools/nest-tools.test.ts -t "di_graph"`
  Expected: all DI graph tests pass including cycle detection, truncation flag on oversized fixture, graceful skip of malformed source
- [ ] Acceptance: `nest_di_graph` visualizes provider injection chain with cycle and cross-module warnings
- [ ] Commit: `feat: add nest_di_graph tool for NestJS dependency injection analysis`

### Task 8: nest_guard_chain — guard/interceptor/pipe chain per route
**Files:** `src/tools/nest-tools.ts`, `tests/tools/nest-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 1 (NestConventions with interceptors), Task 5 (types)
**Execution routing:** deep implementation tier

- [ ] RED: Add `describe("nest_guard_chain")`. Fixture: controller source with `@UseGuards(AuthGuard)` at class level, `@UseGuards(RolesGuard)` + `@UseInterceptors(LoggingInterceptor)` at method level. Module source with global `APP_GUARD: ThrottlerGuard`. Assert:
  - Chain for specific route includes 3 layers: global → controller → method
  - Global guard `ThrottlerGuard` appears first
  - Controller-level `AuthGuard` appears second
  - Method-level `RolesGuard` + `LoggingInterceptor` appear third
  - Route with no guards returns empty chain (not undefined)
  - `@UseGuards()` with empty args → no guard added (not crash)
  - `@UsePipes(ValidationPipe)` detected in chain
- [ ] GREEN: Implement `nestGuardChain(repo, options?)`:
  - Parse global guards/interceptors/pipes from `extractNestConventions`
  - **CQ14:** Extract shared helper `parseUseGuards(source)` + `parseUseInterceptors(source)` + `parseUsePipes(source)` here (first consumer)
  - Scan controller sources at class and method level
  - Build chain per route: global → controller → method ordering
  - Support `path` filter to return chain for specific route
  - **CQ7 cap:** `max_routes: 300` default; `truncated: true` if exceeded
  - **CQ8:** try/catch per file; errors → `errors` array
  - Support `output_format: "mermaid"` for visualization
- [ ] Verify: `npx vitest run tests/tools/nest-tools.test.ts -t "guard_chain"`
  Expected: all guard chain tests pass
- [ ] Acceptance: `nest_guard_chain` shows full execution chain (global → controller → method) for each route
- [ ] Commit: `feat: add nest_guard_chain tool for NestJS middleware chain analysis`

### Task 9: nest_route_inventory — full route map
**Files:** `src/tools/nest-tools.ts`, `tests/tools/nest-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 4 (extended findNestJSHandlers), Task 8 (guard chain)
**Execution routing:** default implementation tier

- [ ] RED: Add `describe("nest_route_inventory")`. Integration test: write 2 controller fixtures to temp dir (users controller with 3 routes, auth controller with 2 routes). Index folder. Assert:
  - `routes` array has 5 entries
  - Each entry has `method`, `path`, `handler`, `controller`, `file`
  - Guards populated from `@UseGuards` decorators
  - `@Param('id')` and `@Body()` decorators extracted into `params` array
  - `stats.total_routes === 5`, `stats.protected` counts routes with guards
  - `stats.unprotected` counts routes without guards
  Note: This test needs real files (temp dir) because it calls `findNestJSHandlers` which uses `readFile`.
- [ ] GREEN: Implement `nestRouteInventory(repo, options?)`:
  - Scan ALL `*.controller.ts` files (not path-matching like `traceRoute`)
  - Reuse `findNestJSHandlers` logic for route extraction (import — Task 4 exported it)
  - For each route, scan source for `@UseGuards`, `@Param`, `@Body`, `@Query` decorators
  - Build stats summary: total, protected (has guards), unprotected
  - **CQ7 cap:** `max_routes: number` option (default 500) — truncate if exceeded
  - Support `include_chain` to embed full guard chain per route (calls B2 logic)
- [ ] Verify: `npx vitest run tests/tools/nest-tools.test.ts -t "route_inventory"`
  Expected: all route inventory tests pass
- [ ] Acceptance: `nest_route_inventory` produces complete route map with guard + param annotations
- [ ] Commit: `feat: add nest_route_inventory tool for NestJS route discovery`

### Task 10: nest_audit — meta orchestrator
**Files:** `src/tools/nest-tools.ts`, `tests/tools/nest-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 2 (A1), Task 3 (A2), Task 4 (A3 — transitive via B4), Task 5-9 (B1-B5)
**Execution routing:** deep implementation tier

- [ ] RED: Add `describe("nest_audit")`. Two test levels:
  - **Unit (mocked B-tools):** Mock all 5 `nestXxx` functions. Call `nestAudit(repo)`. Assert: returns combined object with `di_graph`, `guard_chain`, `module_graph`, `route_inventory`, `lifecycle_map`, `anti_patterns`, `dead_code` keys. Summary has `total_routes`, `cycles`, `violations`, `anti_pattern_hits` counts.
  - **Partial failure:** Mock one sub-tool to throw. Assert: result includes partial results for successful tools + `errors` array for failed tool. Does NOT propagate the error.
  - **Non-NestJS repo:** Mock `detectFrameworks` to not include `nestjs`. Assert: early return with `{ framework_detected: false }`.
  - **Checks filter:** `nestAudit(repo, { checks: ["routes", "guards"] })` runs only B4 + B2.
- [ ] GREEN: Implement `nestAudit(repo, options?)` following `auditScan` pattern:
  - Detect NestJS framework first (early exit if not NestJS)
  - Define `ALL_CHECKS` array: `["modules", "routes", "di", "guards", "lifecycle", "patterns", "dead-code"]`
  - Run enabled checks in parallel via `Promise.allSettled` (not `Promise.all` — partial failure tolerance)
  - Aggregate results into `NestAuditResult`
  - Compute summary stats — **including `failed_checks: number` and `truncated_checks: string[]`**. Score calculation MUST count failed checks as non-passing (not as absent — avoid false green).
  - Propagate per-check `errors` arrays into top-level `warnings` field so callers see truncation/read errors at the top level, not buried in sub-results
  - Support `token_budget` for output capping
  Additional RED assertions: `summary.failed_checks` counts thrown sub-tools; `summary.truncated_checks` lists sub-tools that hit their cap; score is "warn" (not "pass") when any sub-tool failed
- [ ] Verify: `npx vitest run tests/tools/nest-tools.test.ts -t "nest_audit"`
  Expected: all audit tests pass including partial-failure and non-NestJS cases
- [ ] Acceptance: `nest_audit` orchestrates all NestJS checks in one call with scored output
- [ ] Commit: `feat: add nest_audit meta-tool orchestrating all NestJS analysis`

### Task 11: Tool registration and formatters
**Files:** `src/register-tools.ts`, `src/formatters.ts`, `tests/tools/describe-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 5-10 (all nest-tools implementations)
**Execution routing:** default implementation tier

**Baseline note:** `register-tools.ts` currently contains **75** `ToolDefinition` entries (verified `grep -c "^    name:"`). CLAUDE.md and README say "72" or "66" — stale documentation. Task 12 updates documentation. To avoid brittle hardcoded counts that break if another branch adds tools between plan and execution, use **dynamic baseline**: capture baseline length in a `beforeAll` via a pre-computed snapshot, then assert `baseline + 6`.

- [ ] RED: In existing `tests/tools/describe-tools.test.ts`, verify:
  - Capture pre-implementation baseline: import current `TOOL_DEFINITIONS.length` snapshot, assert `post === baseline + 6` (dynamic, not hardcoded "81")
  - `getToolDefinitions().filter(t => t.name.startsWith("nest_")).length === 6`
  - Assert exact names present: `["nest_di_graph", "nest_guard_chain", "nest_module_graph", "nest_route_inventory", "nest_lifecycle_map", "nest_audit"]`
  - `discoverTools({query: "nestjs"})` returns all 6 new tools
  - `CORE_TOOL_NAMES.has("nest_audit") === true`
  - `CORE_TOOL_NAMES.has("nest_di_graph") === false` (hidden)
  - Each tool has correct `category: "nestjs"`, `searchHint`, and valid Zod schema
- [ ] GREEN: In `register-tools.ts`:
  - Import all 6 handler functions from `nest-tools.ts`
  - Add 6 `ToolDefinition` entries to `TOOL_DEFINITIONS` array with name, `category: "nestjs"`, searchHint, description, Zod schema, handler
  - Add `"nest_audit"` to `CORE_TOOL_NAMES` set
  - B1-B5 remain hidden (discoverable via `discover_tools`)
  In `formatters.ts`:
  - Add formatter functions: `formatNestDIGraph`, `formatNestGuardChain`, `formatNestModuleGraph`, `formatNestRouteInventory`, `formatNestLifecycleMap`, `formatNestAudit`
  - Wire formatters in ToolDefinition entries
- [ ] Verify: `npx vitest run tests/tools/describe-tools.test.ts`
  Expected: dynamic baseline+6 assertion passes, all 6 nest_* tools registered, nest_audit is core, 5 others are discoverable
- [ ] Acceptance: All 6 NestJS tools accessible via MCP — `nest_audit` visible, B1-B5 discoverable via `discover_tools(query="nestjs")`
- [ ] Commit: `feat: register 6 NestJS tools (1 core + 5 discoverable) in MCP server`

### Task 12a: Repo documentation and instructions update
**Files:** `src/instructions.ts`, `CLAUDE.md`, `README.md`, `rules/codesift.md`, `rules/codesift.mdc`, `rules/codex.md`, `rules/gemini.md`
**Complexity:** standard
**Dependencies:** Task 11 (registration complete)
**Execution routing:** default implementation tier

**Reviewer note:** Reviewers flagged the prior monolithic Task 12 as CRITICAL risk — docs + deploy + publish bundled with no rollback. Split into 12a (reversible local edits), 12b (website — external system), 12c (npm publish — irreversible). Each has explicit verification.

**Baseline tool count discrepancy:** README/CLAUDE.md say 66 or 72 (stale); actual is 75 (verified); post-implementation is 81. Task 12a reconciles all references to 81.

- [ ] RED: Write a small test at `tests/meta/doc-tool-count.test.ts` that reads each documentation file and asserts it contains "81" (not "66", "72", or "75"). This lets the task have a proper RED phase.
- [ ] GREEN: Update:
  - `src/instructions.ts`: Add NestJS tools (especially `nest_audit`) to ALWAYS rules; update tool count from 66 → 81
  - `CLAUDE.md`: Update architecture "66 MCP tools" → "81 MCP tools"; add `nest-tools.ts` to `src/tools/` listing; add NestJS feature note
  - `README.md`: Update tool count and feature table to include NestJS analysis tools
  - `rules/codesift.md` + `rules/codesift.mdc` + `rules/codex.md` + `rules/gemini.md`: Add NestJS tool mapping rows (nest_audit, nest_di_graph, nest_guard_chain, nest_module_graph, nest_route_inventory, nest_lifecycle_map)
- [ ] Verify: `npx vitest run tests/meta/doc-tool-count.test.ts` passes AND `grep -rn "66 tools\|72 tools\|75 tools\|66 MCP\|72 MCP\|75 MCP" src/ rules/ CLAUDE.md README.md 2>/dev/null` returns zero matches
  Expected: no stale counts, test green
- [ ] Acceptance: All repo documentation reflects 81 tools with NestJS tool rows in rules/ tables
- [ ] Commit: `docs: update repo documentation to reflect 81 tools with NestJS support`

### Task 12b: Website content and deployment
**Files:** `../codesift-website/src/components/Hero.astro`, `FeatureGrid`, `Footer`, `Problem`, `Nav`, `Pricing`, `BaseLayout`, `../codesift-website/src/pages/index.astro`, `tools/index.astro`, `how-it-works.astro`, `benchmarks.astro`, `articles/index.astro`, `../codesift-website/public/llms.txt`, `../codesift-website/public/llms-full.txt`
**Complexity:** complex
**Dependencies:** Task 12a (repo docs aligned first)
**Execution routing:** deep implementation tier

**Risk:** `wrangler pages deploy` is an external-system action with production visibility. Reviewers flagged this as CRITICAL. Staging preview deploy REQUIRED before production.

- [ ] RED: No automated test — mechanical + manual verification.
- [ ] GREEN: Update website files:
  - `public/llms.txt`: Update features and tool count (→ 81)
  - `public/llms-full.txt`: Update header with NestJS support section
  - Components: Hero, FeatureGrid, Footer, Problem, Nav, Pricing, BaseLayout — update tool count
  - Pages: index, tools/index, how-it-works, benchmarks, articles/index — update tool count
  - **Preview deploy first:** `cd ../codesift-website && npm run build` (must exit 0)
  - Manual visual check: open built `dist/index.html` locally, verify tool count renders as 81
  - **Production deploy:** `wrangler pages deploy dist --project-name codesift-website --commit-dirty=true`
  - Post-deploy smoke test: `curl -s https://codesift.dev/llms.txt | grep -c "81"` should return ≥1
- [ ] Verify: `cd ../codesift-website && grep -rn "66 tools\|72 tools\|75 tools" src/ public/ 2>/dev/null` returns zero; build succeeds; post-deploy smoke test passes
  Expected: website reflects 81 tools in prod
- [ ] Acceptance: Website build green, preview verified, production deploy succeeds, smoke test passes
- [ ] Rollback path: `wrangler pages deployment list` → `wrangler pages deployment rollback <previous-id>` if issues detected
- [ ] Commit: `docs(website): update tool count to 81 and add NestJS support section`

### Task 12c: Version bump and npm publish
**Files:** `package.json`, `package-lock.json`
**Complexity:** complex
**Dependencies:** Task 12a (repo docs), Task 12b (website deployed), manual user confirmation
**Execution routing:** deep implementation tier

**IRREVERSIBLE ACTION — requires explicit user confirmation before execution.** Reviewers flagged `npm publish` inside a "standard" task as CRITICAL. Publish cannot be undone (unpublish window is limited to 72h and leaves gaps).

- [ ] RED: No automated test — release operation.
- [ ] GREEN:
  - **Dry-run first:** `npm publish --dry-run --ignore-scripts` — review file list, verify no secrets/unwanted files included
  - **User confirmation gate:** Ask user to confirm publish before proceeding. Do NOT auto-proceed.
  - `npm version minor` (adds new tools → minor bump, not patch). Commits the version bump automatically.
  - `npm publish --ignore-scripts`
  - Post-publish verification: `npm view codesift-mcp version` matches new version; `npx codesift-mcp@latest --version` runs
- [ ] Verify: `npm view codesift-mcp version` returns the new minor version; `npm view codesift-mcp@latest dist-tags.latest` matches
  Expected: new version published and fetchable
- [ ] Acceptance: New minor version live on npm; installable via `npx codesift-mcp@latest`
- [ ] Rollback path: `npm unpublish codesift-mcp@<new-version>` within 72h if critical bug found (but prefer forward-fix with patch version). Document issue in backlog.
- [ ] Commit: (automatic from `npm version minor`) — additional commit not needed
