# Implementation Plan: Tool Adoption Fixes

**Spec:** docs/specs/2026-04-14-tool-adoption-fixes-spec.md
**spec_id:** 2026-04-14-tool-adoption-fixes-1845
**planning_mode:** spec-driven
**source_of_truth:** approved spec
**plan_revision:** 3
**status:** Approved
**Created:** 2026-04-14
**Tasks:** 8
**Estimated complexity:** 5 standard, 3 complex

## Architecture Summary

Five source files modified, no new files created (tests added to existing test files):

- `src/register-tools.ts` — Tool catalog, CORE_TOOL_NAMES, enableToolByName, extractToolParams, index_folder handler
- `src/tools/plan-turn-tools.ts` — formatPlanTurnResult() output formatting
- `src/server-helpers.ts` — buildResponseHint() H-code emission
- `src/search/tool-ranker.ts` — W_STRUCTURAL weight constant
- `src/instructions.ts` — CODESIFT_INSTRUCTIONS hint legend

Key dependency direction: `plan-turn-tools.ts → register-tools.ts → server-helpers.ts`. No circular imports. `tool-ranker.ts` and `instructions.ts` are leaf nodes with no cross-dependencies to other changed files.

## Technical Decisions

1. **Direct export** of `enableToolByName`, `extractToolParams`, and new `getToolDefinition(name)` — no callback injection needed (no circular import exists)
2. **Lazy schema resolution** handled by extractToolParams itself (Proxy triggers on `Object.entries()`) — no force-resolution needed
3. **H13 regex:** `/\/api\/|endpoint|handler|router\.|middleware|app\.(get|post|put|delete)/i` — matches spec AC6 exactly
4. **H14 regex:** `/api[._-]?key|AWS_|OPENAI_|SECRET_KEY|password|credential/i` — matches spec AC7 exactly (bare "secret" and "token" excluded)
5. **index_folder auto-load:** async handler, `detectAutoLoadToolsCached(args.path)` with `.catch(() => {})` after `indexFolder()` completes
6. **enableToolByName in server-helpers.ts:** Dynamic import to avoid circular dependency. `register-tools.ts` already imports from `server-helpers.ts` (wrapTool), so a static import in the reverse direction would create a cycle. Use `const { enableToolByName } = await import("./register-tools.js")` — same pattern as `index-tools.ts` which uses dynamic import for the same reason.
7. **Lazy schema resolution:** `extractToolParams` calls `Object.entries(def.schema)` which triggers the `lazySchema` Proxy's `ownKeys()` trap, forcing resolution. Verified by Tech Lead: the Proxy factory is a pure `() => ({...})` returning Zod objects — no side effects, no failure modes. Explicit force-resolution is unnecessary. If a tool is not in `TOOL_DEFINITION_MAP`, `getToolDefinition` returns undefined and the params line is skipped (graceful degradation).

## Quality Strategy

- 44 new test cases across `tests/tools/plan-turn.test.ts`, `tests/tools/response-hints.test.ts`, `tests/tools/register-tools.test.ts`, `tests/instructions.test.ts`
- Highest risk: index_folder async conversion (Fix 6) — handler changes from sync to async
- Cross-hint isolation tests needed: H9 must not fire alongside H13, and vice versa
- CQ8 required: `.catch()` on `detectAutoLoadToolsCached` in index_folder handler

## Coverage Matrix

| Row ID | Authority item | Type | Primary task(s) | Notes |
|--------|----------------|------|-----------------|-------|
| AC1 | formatPlanTurnResult includes `params:` line per tool | requirement | Task 3 | |
| AC2 | formatPlanTurnResult does NOT contain "call describe_tools" or "Reveal Required" | requirement | Task 3 | |
| AC3 | review_diff and scan_secrets in CORE_TOOL_NAMES | requirement | Task 2 | |
| AC4 | H9 auto-reveals semantic_search | requirement | Task 5 | |
| AC5 | index_folder calls detectAutoLoadToolsCached(path) | requirement | Task 6 | |
| AC6 | H13 fires on HTTP verb + path queries | requirement | Task 4 | |
| AC7 | H14 fires on secret-pattern queries | requirement | Task 4 | |
| AC8 | W_STRUCTURAL = 0.1 | requirement | Task 7 | |
| AC9 | All existing tests pass | constraint | Task 8 | |
| AC10 | No circular imports | constraint | All tasks | |
| SC1 | describe_tools share drops ≥50% | success | Task 3 | Post-deploy metric |
| SC2 | review_diff ≥5 calls in first week | success | Task 2 | Post-deploy metric |
| SC3 | scan_secrets ≥3 calls in first week | success | Task 2 | Post-deploy metric |
| SC4 | Framework tools appear for GUI-indexed repos | success | Task 6 | Post-deploy metric |
| SC5 | plan_turn share ≥5% | success | Task 3 | Post-deploy metric |

## Review Trail

- Plan reviewer: revision 1 → ISSUES FOUND (H13/H14 regex mismatch with spec AC6/AC7, Task 6 complexity, Task 5 file list, Task 7 RED step)
- Plan reviewer: revision 2 → fixed all issues from revision 1
- Cross-model validation: codex-5.3 + gemini + cursor-agent → findings:
  - CRITICAL (gemini): circular dep in Task 5 server-helpers→register-tools — FIXED: use dynamic import
  - CRITICAL (codex+gemini): Task 6 scheduled too late — FIXED: added ordering note to execute after Task 1+2
  - WARNING: Tasks 1,2,6 share register-tools.ts — FIXED: added dependency chain
  - WARNING: Task 5 needs spy pattern for enableToolByName — noted, implementer discretion
  - INFO: H12 clarification — FIXED: added note that H12 already exists in code
  - INFO: Task 8 verify echo — FIXED: dropped echo
- Status gate: Reviewed

## Task Breakdown

### Task 1: Export enableToolByName, extractToolParams, and add getToolDefinition accessor
**Files:** `src/register-tools.ts`, `tests/tools/register-tools.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: In `tests/tools/register-tools.test.ts`, add `describe("exported accessors")` block with tests:
  - Import `enableToolByName`, `extractToolParams`, `getToolDefinition` from `../../src/register-tools.js`
  - Assert `enableToolByName("__not_a_tool__")` returns `false`
  - Assert `getToolDefinition("search_text")` returns object with `name === "search_text"`
  - Assert `getToolDefinition("__nonexistent__")` returns `undefined`
  - Assert `extractToolParams` on a known tool returns array with `name`, `required`, `description` fields
  - Tests fail because these symbols are not exported
- [ ] GREEN: In `src/register-tools.ts`:
  - Change `function enableToolByName` (line 340) to `export function enableToolByName`
  - Change `function extractToolParams` (line 3861) to `export function extractToolParams`
  - Add `export function getToolDefinition(name: string): ToolDefinition | undefined { return TOOL_DEFINITION_MAP.get(name); }` after line 3876
- [ ] Verify: `npx vitest run tests/tools/register-tools.test.ts`
  Expected: all tests pass including new accessor tests
- [ ] Acceptance: AC10 (no circular imports — verified by successful build)
- [ ] Commit: `feat: export enableToolByName, extractToolParams, getToolDefinition for discovery pipeline`

### Task 2: Add review_diff and scan_secrets to CORE_TOOL_NAMES
**Files:** `src/register-tools.ts`, `tests/tools/register-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 1 (shared test file — use separate describe block)
**Execution routing:** default implementation tier

- [ ] RED: In `tests/tools/register-tools.test.ts`, add tests:
  - Assert `CORE_TOOL_NAMES.has("review_diff")` is `true`
  - Assert `CORE_TOOL_NAMES.has("scan_secrets")` is `true`
  - Tests fail because these tools are not in the set
- [ ] GREEN: In `src/register-tools.ts`, add after line 753 (after `nest_audit`):
  ```typescript
  "review_diff",             // 9 parallel static analysis checks on git diffs
  "scan_secrets",            // ~1100 secret detection rules
  ```
- [ ] Verify: `npx vitest run tests/tools/register-tools.test.ts`
  Expected: all tests pass, CORE_TOOL_NAMES now has 53 entries
- [ ] Acceptance: AC3
- [ ] Commit: `feat: add review_diff and scan_secrets to CORE_TOOL_NAMES`

### Task 3: formatPlanTurnResult — inline params + remove Reveal Required
**Files:** `src/tools/plan-turn-tools.ts`, `tests/tools/plan-turn.test.ts`
**Complexity:** complex
**Dependencies:** Task 1 (needs extractToolParams, getToolDefinition exports)
**Execution routing:** deep implementation tier

- [ ] RED: In `tests/tools/plan-turn.test.ts`, add `describe("formatPlanTurnResult")` block:
  - Test basic result: output contains `params:` line with required param names
  - Test hidden tool: output shows `[hidden]` but does NOT contain "call describe_tools" or "Reveal Required"
  - Test gap_analysis early exit: output contains `STOP_AND_REPORT_GAP`, no tools section
  - Test empty tools: fallback `discover_tools` injected
  - Test tool with no params: output shows `params: (none required)`
  - Test symbols/files sections: sliced to 10/5 limits
  - Test already_used section
  - Test flags section (vague_query, stale_index)
  - All fail because current output lacks `params:` and still has "Reveal Required"
- [ ] GREEN: In `src/tools/plan-turn-tools.ts`:
  - Import `extractToolParams`, `getToolDefinition` from `../register-tools.js`
  - In `formatPlanTurnResult()`, after each tool line (line 621), add compact params line:
    ```typescript
    const def = getToolDefinition(t.name);
    if (def) {
      const params = extractToolParams(def);
      const paramStr = params.length > 0
        ? params.map(p => `${p.name}${p.required ? "" : "?"}`).join(", ")
        : "(none required)";
      lines.push(`    params: ${paramStr}`);
    }
    ```
  - Remove the "Reveal Required" section entirely (lines 630-635)
- [ ] Verify: `npx vitest run tests/tools/plan-turn.test.ts`
  Expected: all tests pass, new formatPlanTurnResult tests green
- [ ] Acceptance: AC1, AC2
- [ ] Commit: `feat: inline params in plan_turn output, remove Reveal Required section`

### Task 4: New H13 (route nudge) and H14 (secrets nudge) hint codes
**Files:** `src/server-helpers.ts`, `tests/tools/response-hints.test.ts`
**Complexity:** complex
**Dependencies:** none
**Execution routing:** deep implementation tier

- [ ] RED: In `tests/tools/response-hints.test.ts`, add `describe("H13 — route nudge")` and `describe("H14 — secrets nudge")`:
  - H13 positive: `search_text` with query `"GET /api/users"` → hint contains `H13`
  - H13 positive: `search_text` with query `"router.get handler"` → hint contains `H13`
  - H13 positive: `search_text` with query `"middleware auth"` → hint contains `H13`
  - H13 positive: `search_text` with query `"endpoint configuration"` → hint contains `H13`
  - H13 negative: `search_text` with query `"getUser"` → hint does NOT contain `H13`
  - H13 negative: non-search_text tool with route query → no `H13`
  - H14 positive: `search_text` with query `"api_key configuration"` → hint contains `H14`
  - H14 positive: `search_text` with query `"AWS_SECRET_ACCESS_KEY"` → hint contains `H14`
  - H14 positive: `search_text` with query `"OPENAI_API_KEY"` → hint contains `H14`
  - H14 positive: `search_text` with query `"password validation"` → hint contains `H14`
  - H14 negative: `search_text` with query `"normal search query"` → no `H14`
  - H14 negative: `search_text` with query `"secret santa feature"` → no `H14` (bare "secret" excluded per spec)
  - Cross-hint isolation: question-word query `"how does auth work"` → H9 yes, H13 no
  - Tests fail because H13/H14 don't exist
- [ ] GREEN: In `src/server-helpers.ts`, in `buildResponseHint()`:
  - Add constants matching spec AC6/AC7:
    ```typescript
    const ROUTE_PATTERN = /\/api\/|endpoint|handler|router\.|middleware|app\.(get|post|put|delete)/i;
    const SECRET_PATTERN = /api[._-]?key|AWS_|OPENAI_|SECRET_KEY|password|credential/i;
    ```
  - Add H13 branch: if `toolName === "search_text"` and query matches `ROUTE_PATTERN`, push `⚡H13 route query → try trace_route(path=) for full endpoint tracing`
  - Add H14 branch: if `toolName === "search_text"` and query matches `SECRET_PATTERN`, push `⚡H14 secret pattern → try scan_secrets(min_confidence="high")`
- [ ] Verify: `npx vitest run tests/tools/response-hints.test.ts`
  Expected: all tests pass including new H13/H14 tests
- [ ] Acceptance: AC6, AC7
- [ ] Commit: `feat: add H13 route nudge and H14 secrets nudge hint codes`

### Task 5: H9 auto-reveal semantic_search
**Files:** `src/server-helpers.ts`, `tests/tools/response-hints.test.ts`
**Complexity:** standard
**Dependencies:** Task 1 (needs enableToolByName export), Task 4 (both modify server-helpers.ts)
**Execution routing:** default implementation tier

- [ ] RED: In `tests/tools/response-hints.test.ts`, add test:
  - After `search_text` with question-word query triggers H9, assert `enableToolByName` was called with `"semantic_search"`
  - Test fails because H9 handler doesn't call enableToolByName
- [ ] GREEN: In `src/server-helpers.ts`:
  - In the H9 branch (line 252-254), add dynamic import + call to avoid circular dep:
    ```typescript
    import("./register-tools.js").then(m => m.enableToolByName("semantic_search")).catch(() => {});
    ```
  - Same dynamic import pattern as `index-tools.ts` uses for `register-tools.ts`
- [ ] Verify: `npx vitest run tests/tools/response-hints.test.ts`
  Expected: all tests pass, H9 now auto-reveals semantic_search
- [ ] Acceptance: AC4
- [ ] Commit: `feat: H9 auto-reveals semantic_search via enableToolByName`

### Task 6: index_folder auto-loads framework tools after indexing (HIGHEST RISK — execute early after Task 1+2)
**Files:** `src/register-tools.ts`, `tests/tools/register-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 1 (needs getToolDefinition for testing), Task 2 (shared register-tools.ts)
**Execution routing:** deep implementation tier
**Ordering note:** All 3 adversarial reviewers recommend executing this task immediately after Tasks 1+2, before Tasks 3-5. This is the highest-risk architectural change (sync→async handler). Fail fast.

- [ ] RED: In `tests/tools/register-tools.test.ts`, add `describe("index_folder auto-load")`:
  - Assert that after calling index_folder handler with a path containing a React project (package.json with react dep + .tsx files), React tools are enabled
  - Assert that if detectAutoLoadToolsCached throws, handler still returns successfully
  - Tests fail because handler doesn't call detectAutoLoadToolsCached
- [ ] GREEN: In `src/register-tools.ts`, change the index_folder handler (line 802):
  ```typescript
  handler: async (args) => {
    const result = await indexFolder(args.path as string, {
      incremental: args.incremental as boolean | undefined,
      include_paths: args.include_paths as string[] | undefined,
    });
    try {
      const toEnable = await detectAutoLoadToolsCached(args.path as string);
      for (const name of toEnable) enableToolByName(name);
    } catch { /* best-effort */ }
    return result;
  },
  ```
- [ ] Verify: `npx vitest run tests/tools/register-tools.test.ts`
  Expected: all tests pass, auto-load fires on indexed path
- [ ] Acceptance: AC5
- [ ] Commit: `feat: index_folder auto-loads framework tools for indexed path`

### Task 7: Reduce W_STRUCTURAL from 0.4 to 0.1
**Files:** `src/search/tool-ranker.ts`, `tests/search/tool-ranker.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: In `tests/search/tool-ranker.test.ts`, add new test:
  - Create two tools: `tool_a` with high BM25 match (query contains tool name) + usage=1, `tool_b` with low BM25 match + usage=1000
  - Assert `tool_a` ranks above `tool_b` — lexical relevance beats popularity
  - At W_STRUCTURAL=0.4 this test may fail (structural signal could boost tool_b enough to win). At W_STRUCTURAL=0.1, lexical dominates.
- [ ] GREEN: In `src/search/tool-ranker.ts`, change line 71:
  ```typescript
  const W_STRUCTURAL = 0.1;
  ```
- [ ] Verify: `npx vitest run tests/search/tool-ranker.test.ts`
  Expected: all tests pass, existing structural signal test still green (100:1 ratio dominates even at 0.1)
- [ ] Acceptance: AC8
- [ ] Commit: `feat: reduce W_STRUCTURAL from 0.4 to 0.1 to lower popularity bias in plan_turn`

### Task 8: Update instructions.ts hint legend + verify all tests
**Files:** `src/instructions.ts`, `tests/instructions.test.ts`
**Complexity:** standard
**Dependencies:** Task 4 (H13/H14 must exist before adding to legend)
**Execution routing:** default implementation tier

- [ ] RED: In `tests/instructions.test.ts`, add assertions:
  - Assert `CODESIFT_INSTRUCTIONS` contains `H12` (H12 already implemented in server-helpers.ts line 266, only missing from legend)
  - Assert `CODESIFT_INSTRUCTIONS` contains `H13`
  - Assert `CODESIFT_INSTRUCTIONS` contains `H14`
  - Tests fail because legend only has H1-H11
- [ ] GREEN: In `src/instructions.ts`, after line 20 (after H11), add:
  ```
  H12    → batch search_text into codebase_retrieval
  H13    → use trace_route for endpoints   H14 → use scan_secrets for credentials
  ```
- [ ] Verify: `npx vitest run`
  Expected: exit code 0, full test suite passes, no regressions
- [ ] Acceptance: AC9
- [ ] Commit: `feat: add H12, H13, H14 to CODESIFT_INSTRUCTIONS hint legend`
