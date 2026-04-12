# Implementation Plan: Phase 1 Tool Consolidation

**Spec:** inline — no spec
**spec_id:** none
**planning_mode:** inline
**plan_revision:** 1
**status:** Approved
**Created:** 2026-04-12
**Tasks:** 8
**Estimated complexity:** 6 standard, 2 complex

## Architecture Summary

Remove 26 hidden sub-tool TOOL_DEFINITIONS entries from `src/register-tools.ts`, absorbing them into their parent meta-tools. Handler functions remain (called internally). Tool count: 172 → 146 (51 → 38 core visible, 121 → 108 discoverable).

**Groups being consolidated:**

| # | Meta-tool (stays) | Sub-tools removed | Count |
|---|---|---|---|
| 1 | `framework_audit` (Next.js, CORE) | `analyze_nextjs_components`, `nextjs_audit_server_actions`, `nextjs_api_contract`, `nextjs_boundary_analyzer`, `nextjs_link_integrity`, `nextjs_data_flow`, `nextjs_middleware_coverage` | 7 |
| 2 | `nest_audit` (CORE) | `nest_lifecycle_map`, `nest_module_graph`, `nest_di_graph`, `nest_guard_chain`, `nest_route_inventory`, `nest_graphql_map`, `nest_websocket_map`, `nest_schedule_map`, `nest_typeorm_map`, `nest_microservice_map`, `nest_request_pipeline`, `nest_queue_map`, `nest_scope_audit`, `nest_openapi_extract` | 14 |
| 3 | `python_audit` (hidden) | `find_python_circular_imports`, `trace_celery_chain` | 2 |
| 4 | `php_project_audit` (hidden) | `find_php_n_plus_one`, `find_php_god_model`, `analyze_activerecord` | 3 |

**Groups SKIPPED (with justification):**
- Astro (5/6 sub-tools are CORE — visibility regression)
- Hono (no existing orchestration in `analyze_hono_app` — would require new code, not refactoring)
- `run_mypy` (separate file `typecheck-tools.ts`, not called by `python_audit`)

## Technical Decisions

1. **Delete entries entirely** from TOOL_DEFINITIONS (not flag with `absorbed: true`). `discoverTools` iterates TOOL_DEFINITIONS — entries must be gone for count to decrease.
2. **Merge searchHint tokens** from deleted entries into parent meta-tool's searchHint string before deletion.
3. **Clean framework auto-load arrays**: remove `NEXTJS_TOOLS` const entirely (all 7 names absorbed); remove 14 NestJS names from `FRAMEWORK_TOOL_BUNDLES.nestjs`.
4. **Add `checks` param** to `php_project_audit` schema — agents lose granularity otherwise.
5. **Remove unused imports** from register-tools.ts for deleted entries' handler functions (only if the handler was imported solely for the TOOL_DEFINITIONS entry — most handlers are shared with the meta-tool).

## Quality Strategy

**Breaking tests (must update):**
- `tests/tools/framework-auto-enable.test.ts` — NestJS bundle size assertions
- `tests/formatters/nextjs-formatter.test.ts` — registration-check blocks for `analyze_nextjs_components`, `nextjs_boundary_analyzer`
- `tests/tools/php-tools.test.ts` — raw-source assertions scanning register-tools.ts for tool names + CLAUDE.md/README.md name presence
- `tests/instructions.test.ts` — regex `/1[6-9]\d MCP tools/` won't match 146; widen to `/1[4-9]\d/`

**Safe tests (handler logic survives):**
- All `nest-tools.test.ts` and `nest-ext-tools.test.ts` describe blocks (import handlers directly)
- `python-circular-imports.test.ts`, `celery-tools.test.ts`, `python-audit.test.ts`
- `php-nplus1.test.ts`, `php-god-model.test.ts`, `php-relations.test.ts`

**No new tests needed** — parent meta-tools already have coverage.

## Task Breakdown

**NOTE:** Tasks 1-4 all modify `src/register-tools.ts` and MUST run sequentially despite having no data dependencies.

### Task 1: Remove Next.js sub-tools from TOOL_DEFINITIONS (Group 1)
**Files:** `src/register-tools.ts`, `tests/formatters/nextjs-formatter.test.ts`
**Complexity:** complex
**Dependencies:** none (but runs before Task 2-4 due to shared file)
**Execution routing:** deep implementation tier

- [ ] RED: In `tests/formatters/nextjs-formatter.test.ts`, update registration-check describe blocks (lines ~51-58, ~158-165) to assert `analyze_nextjs_components` and `nextjs_boundary_analyzer` are NOT in TOOL_DEFINITIONS. Run test — fails because entries still exist.
- [ ] GREEN: In `src/register-tools.ts`:
  1. Copy unique searchHint tokens from all 7 sub-tool entries into `framework_audit`'s searchHint
  2. Delete all 7 TOOL_DEFINITIONS entries: `analyze_nextjs_components`, `nextjs_audit_server_actions`, `nextjs_api_contract`, `nextjs_boundary_analyzer`, `nextjs_link_integrity`, `nextjs_data_flow`, `nextjs_middleware_coverage`
  3. Delete `const NEXTJS_TOOLS = [...]` array (lines 360-368)
  4. Delete `toEnable.push(...NEXTJS_TOOLS)` call (line 429)
  5. Remove any handler imports that become unused
- [ ] Verify: `npx vitest run tests/formatters/nextjs-formatter.test.ts tests/tools/register-tools.test.ts`
  Expected: all tests pass, no assertion failures on removed tool names
- [ ] Acceptance: 7 Next.js sub-tools no longer appear in `discover_tools` output; `framework_audit` searchHint contains their keywords
- [ ] Commit: `refactor(consolidate): absorb 7 Next.js sub-tools into framework_audit`

### Task 2: Remove NestJS sub-tools from TOOL_DEFINITIONS (Group 2)
**Files:** `src/register-tools.ts`, `tests/tools/framework-auto-enable.test.ts`
**Complexity:** complex
**Dependencies:** none
**Execution routing:** deep implementation tier

- [ ] RED: In `tests/tools/framework-auto-enable.test.ts`, update NestJS bundle assertions:
  1. The test asserting `nest_* tools are disabled by default` — remove all 14 NestJS sub-tool names from the assertion list
  2. The test asserting `enableFrameworkToolBundle('nestjs')` returns 14 names — update to expect empty array (bundle becomes empty after absorption)
  Run test — fails because entries still exist.
- [ ] GREEN: In `src/register-tools.ts`:
  1. Copy unique searchHint tokens from all 14 sub-tool entries into `nest_audit`'s searchHint
  2. Delete all 14 TOOL_DEFINITIONS entries (lines ~2955-3135)
  3. Delete or empty `FRAMEWORK_TOOL_BUNDLES.nestjs` array (lines 223-242)
  4. Remove any handler imports that become unused
- [ ] Verify: `npx vitest run tests/tools/framework-auto-enable.test.ts tests/tools/nest-tools.test.ts tests/tools/nest-ext-tools.test.ts`
  Expected: all tests pass; handler tests (nest-tools.test.ts, nest-ext-tools.test.ts) pass unchanged
- [ ] Acceptance: 14 NestJS sub-tools no longer discoverable; `nest_audit(checks="lifecycle,di,guard,...")` still works
- [ ] Commit: `refactor(consolidate): absorb 14 NestJS sub-tools into nest_audit`

### Task 3: Remove Python sub-tools from TOOL_DEFINITIONS (Group 3)
**Files:** `src/register-tools.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: No test changes needed — Python handler tests don't assert TOOL_DEFINITIONS presence. Verify current state: `npx vitest run tests/tools/python-audit.test.ts tests/tools/python-circular-imports.test.ts tests/tools/celery-tools.test.ts` — all pass.
- [ ] GREEN: In `src/register-tools.ts`:
  1. Copy unique searchHint tokens from `find_python_circular_imports` and `trace_celery_chain` into `python_audit`'s searchHint
  2. Delete both TOOL_DEFINITIONS entries
  3. Remove any handler imports that become unused
- [ ] Verify: `npx vitest run tests/tools/python-audit.test.ts tests/tools/python-circular-imports.test.ts tests/tools/celery-tools.test.ts`
  Expected: all pass (handler tests import functions directly, not via TOOL_DEFINITIONS)
- [ ] Acceptance: `discover_tools(query="celery")` returns `python_audit` (via merged searchHint), not `trace_celery_chain`
- [ ] Commit: `refactor(consolidate): absorb 2 Python sub-tools into python_audit`

### Task 4: Remove PHP sub-tools + add checks param (Group 4)
**Files:** `src/register-tools.ts`, `tests/tools/php-tools.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: In `tests/tools/php-tools.test.ts`:
  1. Update raw-source assertions (lines ~233-257) — remove `toContain("find_php_n_plus_one")`, `toContain("find_php_god_model")`, `toContain("analyze_activerecord")` from TOOL_DEFINITIONS presence checks
  2. Update doc-reference assertions (lines ~262-270) — these will be updated after Task 6 (docs update), so for now change to check `php_project_audit` presence instead
  Run test — fails because entries still exist or doc references still point to old names.
- [ ] GREEN: In `src/register-tools.ts`:
  1. Copy unique searchHint tokens from 3 sub-tool entries into `php_project_audit`'s searchHint
  2. Delete 3 TOOL_DEFINITIONS entries: `find_php_n_plus_one`, `find_php_god_model`, `analyze_activerecord`
  3. Add `checks` param to `php_project_audit` schema: `checks: z.string().optional().describe("Comma-separated checks to run: n_plus_one, god_model, activerecord, security, events, views, services, namespace. Default: all")`
  4. Remove any handler imports that become unused
- [ ] Verify: `npx vitest run tests/tools/php-tools.test.ts`
  Expected: all pass
- [ ] Acceptance: `php_project_audit(checks="n_plus_one")` runs only N+1 check; `discover_tools(query="god model")` returns `php_project_audit`
- [ ] Commit: `refactor(consolidate): absorb 3 PHP sub-tools into php_project_audit with checks param`

### Task 5: Update instructions.ts + test regex
**Files:** `src/instructions.ts`, `tests/instructions.test.ts`
**Complexity:** standard
**Dependencies:** Tasks 1-4 (tool count must be finalized)
**Execution routing:** default implementation tier

- [ ] RED: In `tests/instructions.test.ts` line 46, widen regex from `/1[6-9]\d MCP tools/` to `/1[4-9]\d MCP tools/` to accommodate 146. Run test — fails because instructions.ts still says 172.
- [ ] GREEN: In `src/instructions.ts`:
  1. Update header line from `172 MCP tools (51 core, 121 hidden via disable())` to `146 MCP tools (38 core, 108 hidden via disable())`
  2. Update DISCOVERY section from `121 hidden/niche tools` to `108 hidden/niche tools`
  3. Update `discover_tools` description from `all 172 tools` to `all 146 tools`
- [ ] Verify: `npx vitest run tests/instructions.test.ts`
  Expected: 10 tests pass
- [ ] Acceptance: CODESIFT_INSTRUCTIONS string starts with `CodeSift — 146 MCP tools`
- [ ] Commit: `docs(instructions): update tool count 172→146 after Phase 1 consolidation`

### Task 6: Update documentation (CLAUDE.md, README.md, rules/*.md)
**Files:** `CLAUDE.md`, `README.md`, `rules/codesift.md`, `rules/codesift.mdc`, `rules/codex.md`, `rules/gemini.md`
**Complexity:** standard
**Dependencies:** Tasks 1-4 (final tool count), Task 5 (instructions alignment)
**Execution routing:** default implementation tier

- [ ] RED: N/A — documentation-only changes, TDD protocol does not apply per tdd-protocol.md ("Configuration changes, documentation changes" are exempt)
- [ ] GREEN: Across all 6 files:
  1. Update all tool counts: 172→146, 51→38 core, 121→108 hidden
  2. Remove absorbed sub-tool names from tool mapping tables in rules/*.md (replace with parent meta-tool name + `checks` param example where relevant)
  3. In CLAUDE.md: update Architecture section tool count, category table counts (analysis decreases by ~2, nestjs goes from 15→1, etc.), source layout counts
  4. In README.md: update MCP tools section header and table, Evidence Map tool count
  5. In rules/*.md: update Tool Discovery section counts, remove tool-name rows for absorbed tools from Tool Mapping and Situational Triggers tables
- [ ] Verify: `npx vitest run tests/instructions.test.ts tests/tools/php-tools.test.ts` (php-tools.test.ts asserts doc presence)
  Expected: all pass
- [ ] Acceptance: `grep -rn "172\|161\|48 core\|51 core\|113\|121" CLAUDE.md README.md rules/ src/instructions.ts` returns 0 matches
- [ ] Commit: `docs: update tool counts and remove absorbed sub-tool references (172→146)`

### Task 7: Update plan-turn benchmark fixture
**Files:** `tests/fixtures/plan-turn-benchmark.jsonl`
**Complexity:** standard
**Dependencies:** Tasks 1-4 (tool names finalized)
**Execution routing:** default implementation tier

- [ ] RED: N/A — fixture data update, no production code. But verify benchmark test: `npx vitest run tests/tools/plan-turn.test.ts` — should still pass (uses mocked definitions).
- [ ] GREEN: In `tests/fixtures/plan-turn-benchmark.jsonl`:
  1. Replace `analyze_nextjs_components` references with `framework_audit`
  2. Replace `nextjs_middleware_coverage` references with `framework_audit`
  3. Replace any other absorbed tool names with their parent meta-tool
- [ ] Verify: `npx vitest run tests/tools/plan-turn.test.ts tests/search/tool-ranker.test.ts`
  Expected: 50 tests pass
- [ ] Acceptance: No absorbed tool names appear in benchmark fixture's `expected_tools` arrays
- [ ] Commit: `test(plan-turn): update benchmark fixture for consolidated tool names`

### Task 8: Final verification — full build + test suite
**Files:** none (verification only)
**Complexity:** standard
**Dependencies:** Tasks 1-7
**Execution routing:** default implementation tier

- [ ] RED: N/A — verification task
- [ ] GREEN: N/A
- [ ] Verify:
  1. `npm run build` — 0 TypeScript errors
  2. `npx vitest run` — full suite passes (2900+ tests)
  3. `grep -rn "172 MCP\|172 tools\|51 core\|121 hidden\|121 discoverable" src/ rules/ CLAUDE.md README.md` — 0 stale references
  4. Verify `discover_tools` still finds parent meta-tools when searching absorbed keywords
- [ ] Acceptance: Clean build, clean test suite, zero stale tool count references
- [ ] Commit: N/A (no changes — verification only)
