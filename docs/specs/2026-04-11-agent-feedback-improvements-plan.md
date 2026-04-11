# Implementation Plan: Agent-Feedback Improvements (5 Features)

**Spec:** inline — no spec
**spec_id:** none
**planning_mode:** inline
**plan_revision:** 2
**status:** Approved
**Created:** 2026-04-11
**Tasks:** 12
**Estimated complexity:** 10 standard, 2 complex

## Architecture Summary

5 independent features based on agent audit feedback. All features touch different subsystems with minimal overlap:

- **F1 (audit_agent_config):** New tool file + register-tools.ts entry
- **F2 (text_stub warning):** 6 additional `checkTextStubHint()` call sites in register-tools.ts (function already exists)
- **F3 (test_impact_analysis):** New tool file wrapping existing impactAnalysis + computeCoChangePairs
- **F4 (.codesiftignore):** walk.ts WalkOptions extension + index-tools.ts reader
- **F5 (H12 hint):** server-helpers.ts session state + buildResponseHint extension

No feature depends on another — all 5 can be implemented in any order.

## Technical Decisions

- **Pattern:** All new tools follow status-tools.ts pattern (export interface + export async function + mock getCodeIndex in tests)
- **F1 token counting:** `content.length / 3.5` (matches CHARS_PER_TOKEN in server-helpers.ts)
- **F1 symbol extraction:** `` /`([A-Za-z_]\w+)`/g `` for backtick identifiers, `/\b[\w./]+\.\w{2,6}\b/g` for file paths
- **F2 placement:** In individual tool handlers (not wrapTool), matching existing call sites at register-tools.ts:420/534
- **F3 confidence:** base 0.5 + 0.3 (naming match) + min(jaccard, 0.2) from co-change
- **F4 glob library:** picomatch (already in deps at ^4.0.4)
- **F4 read location:** indexFolder() reads .codesiftignore, passes patterns to walkDirectory via new WalkOptions.excludePatterns
- **F5 hint code:** H12 (H11 already taken by text_stub warning in register-tools.ts:100)
- **F5 threshold:** 3+ distinct file_pattern values in search_text calls per session

## Quality Strategy

- **CQ3 risk:** F1 (config path input), F4 (malformed glob patterns) — wrap picomatch in try/catch, validate config_path
- **CQ8 risk:** F1 (file read failure), F4 (missing .codesiftignore) — graceful no-op on missing files
- **CQ14 risk:** F2 adds 6 similar call sites — acceptable, function signature is stable
- **Test gap:** walk.ts has zero test coverage. F4 adds integration tests with temp directory.
- **Test gap:** trackSequentialCalls not exported — F5 tested via wrapTool integration pattern (like H5/H6 in usage-optimizations.test.ts)

## Task Breakdown

### Task 1: F4 — Add excludePatterns to WalkOptions + picomatch filter
**Files:** `src/utils/walk.ts`, `tests/utils/walk.test.ts`
**Complexity:** standard
**Dependencies:** none

- [ ] RED: Test walkDirectory with excludePatterns=["dist/**", "*.generated.ts"]. Create temp dir with files in dist/ and a .generated.ts file. Assert they are excluded from results. Also test: empty excludePatterns=[] returns all files; malformed pattern does not throw (graceful skip).
- [ ] GREEN: Add `excludePatterns?: string[] | undefined` to WalkOptions interface. Import picomatch. In walkDirectory, compile patterns once with `picomatch(excludePatterns)`. Before pushing each file to results[], check `!isExcluded(relativePath)`. Wrap picomatch compile in try/catch — on error, log warning and skip pattern filtering.
- [ ] Verify: `npx vitest run tests/utils/walk.test.ts`
  Expected: all new tests pass, no regressions
- [ ] Acceptance: .codesiftignore patterns can exclude files from walk
- [ ] Commit: `feat: add excludePatterns to walkDirectory via picomatch`

### Task 2: F4 — Read .codesiftignore in indexFolder
**Files:** `src/tools/index-tools.ts`, `tests/tools/index-tools-ignore.test.ts`
**Complexity:** standard
**Dependencies:** Task 1

- [ ] RED: Test indexFolder with a temp repo containing `.codesiftignore` with `dist/**`. Assert indexed files do NOT include dist/ contents. Also test: missing .codesiftignore → normal indexing (no error).
- [ ] GREEN: In indexFolder(), after resolving rootPath, read `.codesiftignore` from `join(rootPath, ".codesiftignore")`. Parse: split by newlines, strip comments (#), trim, filter empties. Pass as `excludePatterns` to the walkDirectory call. On ENOENT, proceed without patterns.
- [ ] Verify: `npx vitest run tests/tools/index-tools-ignore.test.ts`
  Expected: all tests pass
- [ ] Acceptance: repos with .codesiftignore file have those patterns excluded from index
- [ ] Commit: `feat: read .codesiftignore in indexFolder and pass to walkDirectory`

### Task 3: F2 — Add checkTextStubHint to 6 more tool handlers
**Files:** `src/register-tools.ts`, `tests/tools/text-stub-hint.test.ts`
**Complexity:** standard
**Dependencies:** none

- [ ] RED: For each of the 6 tools (get_symbol, get_symbols, find_references, trace_call_chain, find_dead_code, analyze_complexity), test that when the tool returns empty results and the repo has text_stub files, the response includes a text_stub warning string. Mock getCodeIndex to return an index with text_stub files.
- [ ] GREEN: In register-tools.ts, locate the handler for each of the 6 tools. After the main handler call, call `checkTextStubHint(repo, toolName, isEmpty)` and prepend the result to the response text if non-null. Follow the exact same pattern as search_symbols (line 420) and get_file_outline (line 534).
- [ ] Verify: `npx vitest run tests/tools/text-stub-hint.test.ts`
  Expected: 6 tests pass
- [ ] Acceptance: All symbol-based tools emit text_stub warning when results are empty and repo has stub languages
- [ ] Commit: `feat: emit text_stub warning on 6 additional symbol tools`

### Task 4: F5 — Add H12 session state tracking for search_text file_patterns
**Files:** `src/server-helpers.ts`, `tests/server-helpers/h12-hint.test.ts`
**Complexity:** standard
**Dependencies:** none

- [ ] RED: Test that after 3 search_text calls with 3 different file_pattern values, the response includes `⚡H12(3)`. Also test: 2 distinct patterns → no H12; same pattern 3× → no H12; reset clears state.
- [ ] GREEN: In server-helpers.ts, add `const sessionSearchTextPatterns = new Set<string>()` near line 99 alongside existing session state vars. In `trackSequentialCalls` or `buildResponseHint`: if toolName === "search_text", add `args.file_pattern` (or "none") to the Set. If Set.size >= 3, emit `⚡H12(${Set.size}) ${Set.size}× search_text with different file_patterns — batch into codebase_retrieval(queries=[...])`. Add Set.clear() to `resetSessionState()`. Update the hint code legend comment.
- [ ] Verify: `npx vitest run tests/server-helpers/h12-hint.test.ts`
  Expected: all tests pass
- [ ] Acceptance: Agents see H12 hint after 3+ search_text calls with varying file_patterns
- [ ] Commit: `feat: add H12 hint for repeated search_text with different file_patterns`

### Task 5: F1 — audit_agent_config types and symbol extraction
**Files:** `src/tools/agent-config-tools.ts`, `tests/tools/agent-config-tools.test.ts`
**Complexity:** standard
**Dependencies:** none

- [ ] RED: Test extractSymbolRefs("See `createUser` and `OrderService` in the code") returns ["createUser", "OrderService"]. Test extractFilePaths("Check src/tools/index-tools.ts for details") returns ["src/tools/index-tools.ts"]. Test edge cases: no backticks → empty array; path without extension → not matched; inline code blocks with operators like `a > b` → not matched (too short/no identifier chars).
- [ ] GREEN: Export `extractSymbolRefs(text: string): string[]` using `` /`([A-Za-z_]\w{2,})`/g `` (min 3 chars to skip operator noise). Export `extractFilePaths(text: string): string[]` using `/\b([\w./-]+\.(?:ts|js|tsx|jsx|py|go|rs|md|json|yaml|yml|toml))\b/g`. Export the result interface:
  ```typescript
  export interface AgentConfigAuditResult {
    config_path: string;
    token_cost: number;
    stale_symbols: Array<{ symbol: string; line: number }>;
    dead_paths: Array<{ path: string; line: number }>;
    redundant_blocks: Array<{ text: string; found_in: string[] }>;
    findings: string[];
  }
  ```
- [ ] Verify: `npx vitest run tests/tools/agent-config-tools.test.ts`
  Expected: extraction tests pass
- [ ] Commit: `feat: add symbol and path extraction for agent config audit`

### Task 6: F1 — audit_agent_config cross-ref against index
**Files:** `src/tools/agent-config-tools.ts`, `tests/tools/agent-config-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 5

- [ ] RED: Test auditAgentConfig with a mock config file containing `createUser` (exists in index) and `deletedFunction` (not in index) and `src/real.ts` (exists in index.files) and `src/gone.ts` (not in index.files). Assert: stale_symbols includes deletedFunction, dead_paths includes src/gone.ts, token_cost > 0. Also test redundancy: provide two config files (global + project) with overlapping content blocks (>3 lines identical), assert redundant_blocks is populated.
- [ ] GREEN: Export `async function auditAgentConfig(repo: string, options?: { config_path?: string; compare_with?: string }): Promise<AgentConfigAuditResult>`. Implementation: read config file (default: CLAUDE.md relative to index.root), extract symbols + paths, cross-ref symbols against `index.symbols[].name`, cross-ref paths against `index.files[].path`, compute token_cost as `content.length / 3.5`. If `compare_with` provided (e.g. global rules file), split both files into line blocks (5+ consecutive lines) and find duplicates → populate `redundant_blocks`. On file read error, throw informative error.
- [ ] Verify: `npx vitest run tests/tools/agent-config-tools.test.ts`
  Expected: all tests pass
- [ ] Acceptance: audit_agent_config identifies stale symbols and dead file paths in agent configs
- [ ] Commit: `feat: cross-ref agent config symbols and paths against CodeSift index`

### Task 7: F1 — Register audit_agent_config tool
**Files:** `src/register-tools.ts`
**Complexity:** standard
**Dependencies:** Task 6
**Note (ADV):** Tasks 3, 7, 10 all edit register-tools.ts — execute sequentially, not in parallel. Add `discover_tools("audit_agent_config")` assertion to verify registration.

- [ ] RED: (no separate test — verified by calling discover_tools in Task 6 tests)
- [ ] GREEN: Add import of `auditAgentConfig` from `./tools/agent-config-tools.js`. Add TOOL_DEFINITIONS entry: name `audit_agent_config`, category `meta`, searchHint `"audit agent config CLAUDE.md cursorrules stale symbols dead paths token waste"`, schema: `{ repo: z.string().optional(), config_path: z.string().optional().describe("Path to config file (default: CLAUDE.md)") }`. Handler builds opts, calls `auditAgentConfig`, formats output inline (simple text: stale_symbols list + dead_paths list + token_cost).
- [ ] Verify: `npx vitest run tests/tools/agent-config-tools.test.ts`
  Expected: all tests pass
- [ ] Commit: `feat: register audit_agent_config MCP tool`

### Task 8: F3 — test_impact_analysis confidence scoring
**Files:** `src/tools/test-impact-tools.ts`, `tests/tools/test-impact-tools.test.ts`
**Complexity:** standard
**Dependencies:** none

- [ ] RED: Test computeTestConfidence: base 0.5, naming match adds 0.3, jaccard capped at 0.2. Test cases: (1) naming match + jaccard 0.8 → confidence = 0.5 + 0.3 + 0.2 = 1.0; (2) no naming match + jaccard 0.1 → 0.5 + 0.0 + 0.1 = 0.6; (3) no naming match + no co-change → 0.5.
- [ ] GREEN: Export interface and confidence function:
  ```typescript
  export interface TestImpactResult {
    affected_tests: Array<{ test_file: string; confidence: number; reasons: string[] }>;
    suggested_command: string;
    changed_files: string[];
  }
  export function computeTestConfidence(hasNamingMatch: boolean, jaccard: number): number
  ```
  Implementation: `Math.min(1.0, 0.5 + (hasNamingMatch ? 0.3 : 0) + Math.min(jaccard, 0.2))`.
  Also export `matchTestFile(prodFile: string, testFiles: string[]): string | null` — checks `*.test.ts`, `*.spec.ts`, `__tests__/*.test.ts` patterns.
- [ ] Verify: `npx vitest run tests/tools/test-impact-tools.test.ts`
  Expected: confidence + naming match tests pass
- [ ] Commit: `feat: add test confidence scoring and naming convention matcher`

### Task 9: F3 — test_impact_analysis main function
**Files:** `src/tools/test-impact-tools.ts`, `tests/tools/test-impact-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 8

- [ ] RED: Test testImpactAnalysis with mocked impactAnalysis returning 2 affected tests, mocked computeCoChangePairs returning pairs with jaccard values. Assert: affected_tests have confidence scores, suggested_command contains `vitest run <paths>`. Also test: no affected tests → empty array + empty command. Test: detect test runner from repo files (vitest.config.ts → vitest, jest.config.ts → jest, pytest.ini → pytest).
- [ ] GREEN: Export `async function testImpactAnalysis(repo, options?)`. Implementation:
  1. Call `impactAnalysis(repo, { since })` → get `result.affected_tests`
  2. Call `computeCoChangePairs(index.root)` → get co-change pairs
  3. For each affected test: compute confidence using `computeTestConfidence` + jaccard lookup
  4. Also scan `index.files` for test files matching changed prod files via `matchTestFile`
  5. Deduplicate, sort by confidence desc
  6. Detect test runner from repo root files, build `suggested_command`
- [ ] Verify: `npx vitest run tests/tools/test-impact-tools.test.ts`
  Expected: all tests pass
- [ ] Acceptance: test_impact_analysis returns prioritized test list with confidence scores
- [ ] Commit: `feat: implement test_impact_analysis with confidence scoring`

### Task 10: F3 — Register test_impact_analysis tool
**Files:** `src/register-tools.ts`, `src/formatters.ts`
**Complexity:** standard
**Dependencies:** Task 9
**Note (ADV):** Execute after Task 7 (both edit register-tools.ts). Add `discover_tools("test_impact_analysis")` assertion.

- [ ] RED: (verified via Task 9 tests)
- [ ] GREEN: Add import of `testImpactAnalysis` from `./tools/test-impact-tools.js`. Add formatter `formatTestImpact` to formatters.ts. Add TOOL_DEFINITIONS entry: name `test_impact_analysis`, category `analysis`, searchHint `"test impact analysis affected tests changed files CI confidence"`, schema: `{ repo: z.string().optional(), since: z.string().optional().describe("Git ref (default: HEAD~1)"), until: z.string().optional() }`.
- [ ] Verify: `npx vitest run tests/tools/test-impact-tools.test.ts`
  Expected: all tests pass
- [ ] Commit: `feat: register test_impact_analysis MCP tool with formatter`

### Task 11: Update instructions.ts hint codes + tool counts
**Files:** `src/instructions.ts`, `CLAUDE.md`, `README.md`, `rules/codesift.md`
**Complexity:** standard
**Dependencies:** Tasks 3, 4, 7, 10

- [ ] RED: Existing instructions.test.ts will catch if hint codes are stale
- [ ] GREEN: Add H12 to the hint code legend in instructions.ts. Update tool mapping tables in rules files to include audit_agent_config and test_impact_analysis. Update tool counts if changed. Add .codesiftignore mention to CLAUDE.md architecture section.
- [ ] Verify: `npx vitest run tests/instructions.test.ts`
  Expected: pass (or update char budget if needed)
- [ ] Commit: `docs: add H12 hint code and new tools to instructions and rules`

### Task 12: Integration smoke test
**Files:** `tests/integration/new-features-smoke.test.ts`
**Complexity:** standard
**Dependencies:** Tasks 1-10

- [ ] RED: Test ALL 5 features end-to-end:
  (F4) .codesiftignore: create temp repo with .codesiftignore, index it, verify excluded files not in index.
  (F1) audit_agent_config: create temp CLAUDE.md with known symbols, index repo, run audit, verify stale symbols detected.
  (F3) test_impact_analysis: create temp repo with changed files, run analysis, verify affected_tests returned.
  (F2) text_stub warning: index a repo with only .kt files (text_stub), call search_symbols, verify warning in response.
  (F5) H12 hint: call search_text 3× with different file_patterns via wrapTool, verify H12 hint emitted.
- [ ] GREEN: Tests exercise the real tool functions (not mocks) on temp directories. F2 and F5 may need lightweight wrapTool integration harness.
- [ ] Verify: `npx vitest run tests/integration/new-features-smoke.test.ts`
  Expected: all 5 smoke tests pass
- [ ] Commit: `test: add integration smoke tests for 5 agent-feedback features`

## Verification

After all tasks:
1. `npx vitest run` — full suite passes
2. `npm run build` — TypeScript compiles
3. Manual: start MCP server, call `discover_tools(query="audit_agent_config")`, call tool
