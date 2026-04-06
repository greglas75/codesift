# Implementation Plan: Token & Agent Optimization Suite

**Spec:** docs/specs/2026-04-05-token-agent-optimization-spec.md
**spec_id:** 2026-04-05-token-agent-optimization-1830
**plan_revision:** 1
**status:** Approved
**Created:** 2026-04-05
**Tasks:** 12
**Estimated complexity:** 9 standard, 3 complex

## Architecture Summary

5 features touching 8 files. Core pipeline: `server.ts` → `registerTools()` → `wrapTool()` → `formatResponse()`. All tool responses flow through `formatResponse` in `server-helpers.ts` (line 238) — this is the single chokepoint for F4. Tool registration happens once at startup in `register-tools.ts`. CLI is independent.

**Implementation order:** F2 → F1 → F4 → F3 → F5 (F4 depends on F2's formatTable; F3 and F5 are independent)

**Key dependency:** `server-helpers.ts` imports nothing from `register-tools.ts` (one-way coupling: register-tools → server-helpers). F4's `registerShortener` is exported from server-helpers and called by register-tools.

## Technical Decisions

- **F1:** Use MCP SDK `registeredTool.disable()` API (confirmed in SDK). Delete existing minimal-schema stub (lines 1541-1558). Capture all RegisteredTool handles in Map.
- **F2:** Pure `formatTable()` utility — space-padded columns, dash separator, maxColWidth option.
- **F3:** New `src/cli/hooks.ts` module (not inline in commands.ts). Hook installation in `settings.local.json` only.
- **F4:** Cascade unified with existing hard-cap (not separate sequential checks). `SHORTENING_REGISTRY` Map + `registerShortener()` export. Skip for `codebase_retrieval` and explicit `detail_level`/`token_budget`.
- **F5:** `ranked` guard placed BEFORE `useCompact`/`shouldGroup` branches (line 587). Defensive sort on symbols by `start_line`. `ranked: true` takes precedence over `auto_group` (ranked runs first, then auto_group is skipped). Pipeline extracted to new `src/tools/search-ranker.ts` to keep search-tools.ts under 700L.

**File limit policy:** Pre-existing large files (register-tools.ts at 1560L, search-tools.ts at 653L, formatters.ts at 509L) are NOT split in this plan — they predate this work. New code is extracted to separate modules where practical: compact/counts formatters → `src/formatters-shortening.ts`, 4-phase pipeline → `src/tools/search-ranker.ts`.

## Quality Strategy

- **Test framework:** Vitest, globals enabled, singleFork (state persists — call reset functions in afterEach)
- **CQ gates activated:** CQ3 (F1 names[], F3 env parsing), CQ6 (F1 names[] cap, F5 stat() cap), CQ8 (F3 exit codes, F5 ENOENT), CQ14 (F1 share param extraction with discoverTools, F2 replace manual padding)
- **Risk areas:** formatResponse has zero tests (mitigated by T4 baseline); F5 ranked+auto_group interaction (mitigated by explicit precedence rule); module-level state bleed (mitigated by resetShorteningRegistry)

## Task Breakdown

---

### Task 1: formatTable utility function
**Files:** `src/formatters.ts`, `tests/formatters/format-table.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: Write tests for `formatTable(headers, rows, options?)` in new `tests/formatters/format-table.test.ts`
  - Test aligned columns: `formatTable(["Name","Score"], [["foo","99"],["barbaz","1"]])` produces header row, dash separator, data rows with space padding
  - Test empty rows: `formatTable(["A","B"], [])` returns header + separator only
  - Test maxColWidth: cell content longer than 40 chars is truncated with `...`
  - Test mismatched columns: row with fewer cols than headers pads with empty, row with more cols truncates
- [ ] GREEN: Add `export function formatTable(headers: string[], rows: Array<string[]>, options?: { maxColWidth?: number }): string` to `src/formatters.ts`
  - Compute per-column width as max of header and all row values, capped at `maxColWidth` (default 40)
  - Join cells with 2-space gap, separator row with dashes
- [ ] Verify: `npx vitest run tests/formatters/format-table.test.ts`
  Expected: 4+ tests passed
- [ ] Acceptance: Spec F2 — formatTable helper
- [ ] Commit: `feat: add formatTable utility for tabular output formatting`

---

### Task 2: Apply formatTable to existing formatters
**Files:** `src/formatters.ts`, `src/storage/usage-stats.ts`, `tests/formatters/format-table.test.ts`
**Complexity:** standard
**Dependencies:** Task 1
**Execution routing:** default

- [ ] RED: Add snapshot regression tests for `formatHotspots`, `formatComplexity`, `formatClones` output structure (header row present, columns aligned) in `tests/formatters/format-table.test.ts`
  - Test `formatHotspots` with 3 entries produces tabular output with FILE, SCORE, COMMITS, CHANGED columns
  - Test `formatComplexity` with 2 entries produces CC, NEST, LINES columns
  - Test `formatClones` with 1 entry produces SIM%, SHARED columns
- [ ] GREEN: Refactor `formatHotspots` (line 141), `formatComplexity` (line 116), `formatClones` (line 129) to use `formatTable`. Import `formatTable` in `usage-stats.ts` and replace manual padding in `formatUsageReport` (line 247-256).
- [ ] Verify: `npx vitest run tests/formatters/`
  Expected: all tests passed, output structure preserved
- [ ] Acceptance: Spec F2 — tabular output for stats/clones/hotspots
- [ ] Commit: `refactor: use formatTable in hotspots, complexity, clones, usage report formatters`

---

### Task 3: describeTools function
**Files:** `src/register-tools.ts`, `tests/tools/describe-tools.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: Create `tests/tools/describe-tools.test.ts`
  - Test `describeTools(["search_text"])` returns `tools[0]` with name, category, description, is_core=true, params array with correct required/optional markers
  - Test `describeTools(["nonexistent"])` returns `not_found: ["nonexistent"]`, `tools: []`
  - Test `describeTools(["search_text", "nonexistent"])` returns 1 tool + 1 not_found (partial results)
  - Test `describeTools([])` returns empty arrays, no throw
  - Test param extraction: `search_text` has `repo` (required), `query` (required), `file_pattern` (optional)
- [ ] GREEN: Add `export function describeTools(names: string[]): DescribeToolsResult` to `src/register-tools.ts`
  - Reuse Zod param extraction logic from `discoverTools` (lines 1479-1485) — extract into shared helper `extractToolParams(tool: ToolDefinition)`
  - Lookup each name in `TOOL_DEFINITIONS`, populate `tools[]` or `not_found[]`
  - Cap `names` at 100 entries (CQ6)
- [ ] Verify: `npx vitest run tests/tools/describe-tools.test.ts`
  Expected: 5 tests passed
- [ ] Acceptance: Spec AC #1
- [ ] Commit: `feat: add describeTools function for on-demand tool schema retrieval`

---

### Task 4: Tool visibility — disable non-core + describe_tools MCP tool
**Files:** `src/register-tools.ts`, `tests/tools/describe-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 3
**Execution routing:** deep

- [ ] RED: Extend `tests/tools/describe-tools.test.ts`
  - Test that after `registerTools(mockServer, { deferNonCore: true })`, non-core tools have `handle.disable()` called
  - Test that `describe_tools` is registered as MCP tool with schema `{ names: z.array(z.string()), reveal: z.boolean().optional() }`
  - Test that `describe_tools(["find_dead_code"])` returns valid result via MCP handler path
  - Test `describe_tools(["find_dead_code"], reveal: true)` calls `handle.enable()` on the tool
  - Regression: existing `discoverTools` tests in `tests/tools/discover-tools.test.ts` still pass
- [ ] GREEN: Modify `registerTools()` in `src/register-tools.ts`:
  - Store RegisteredTool handles: `const toolHandles = new Map<string, RegisteredTool>()`
  - After registering each tool via `server.tool()`, store handle in map
  - For non-core tools, call `handle.disable()` immediately after storage
  - DELETE existing minimal-schema stub loop (lines 1541-1558) — replaced by disable()
  - Register `describe_tools` MCP tool with handler calling `describeTools(args.names)`
  - If `args.reveal === true`, enable requested tools via stored handles
  - Extract shared `extractToolParams()` helper used by both `discoverTools` and `describeTools`
- [ ] Verify: `npx vitest run tests/tools/describe-tools.test.ts tests/tools/discover-tools.test.ts`
  Expected: all tests passed, 0 regressions
- [ ] Acceptance: Spec AC #1, AC #2, Should-have #1
- [ ] Commit: `feat: disable non-core tools in ListTools, add describe_tools meta-tool`

---

### Task 5: formatResponse baseline tests
**Files:** `tests/server-helpers/format-response.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: Create `tests/server-helpers/format-response.test.ts` testing current `formatResponse` behavior:
  - Test short response (<1000 chars) passes through unchanged (plus savings hint)
  - Test response > 105K chars (MAX_RESPONSE_TOKENS × CHARS_PER_TOKEN) is hard-truncated with warning
  - Test response > 200K chars triggers persistLargeOutput (mock fs, verify tmp file path in output)
  - Test hint codes: H1 fires for >50 results, H3 fires for repeated list_repos
  - Call `resetSessionState()` in afterEach
- [ ] GREEN: No production code changes — these tests validate existing behavior as a safety net before F4
- [ ] Verify: `npx vitest run tests/server-helpers/format-response.test.ts`
  Expected: 4+ tests passed
- [ ] Acceptance: QA Risk #1 mitigation — formatResponse baseline coverage
- [ ] Commit: `test: add baseline tests for formatResponse before cascade changes`

---

### Task 6: Progressive response shortening — registry + cascade
**Files:** `src/server-helpers.ts`, `tests/server-helpers/format-response.test.ts`
**Complexity:** complex
**Dependencies:** Task 5
**Execution routing:** deep

- [ ] RED: Extend `tests/server-helpers/format-response.test.ts`
  - Test `registerShortener("test_tool", { compact: () => "compact", counts: () => "3 items" })` registers successfully
  - Test response > 52.5K chars with registered shortener → `[compact]` annotation + compact text returned
  - Test response > 87.5K chars → `[counts]` annotation + counts text returned
  - Test response > 105K chars → hard truncate (existing behavior preserved)
  - Test `codebase_retrieval` response > 52.5K → cascade SKIPPED
  - Test args with `detail_level: "full"` and response > 52.5K → cascade SKIPPED
  - Test args with `token_budget: 5000` and response > 52.5K → cascade SKIPPED
  - Test `detail_level: false` (falsy non-string) → cascade NOT skipped (typeof guard)
  - Test unregistered tool with response > 52.5K → cascade skipped gracefully, falls through to hard truncate
  - Call `resetSessionState()` AND new `resetShorteningRegistry()` in afterEach
- [ ] GREEN: In `src/server-helpers.ts`:
  - Add `SHORTENING_REGISTRY: Map<string, ShorteningEntry>` at module level
  - Add `export function registerShortener(toolName, entry)` and `export function resetShorteningRegistry()`
  - Modify `formatResponse()`: insert cascade logic BEFORE existing hard-truncate block
  - Cascade thresholds: `COMPACT_THRESHOLD = 52_500`, `COUNTS_THRESHOLD = 87_500` (reuse existing `MAX_RESPONSE_TOKENS * CHARS_PER_TOKEN` for hard-cap)
  - Skip conditions: toolName === "codebase_retrieval" || typeof args?.detail_level === "string" || typeof args?.token_budget === "number"
  - Unify cascade with existing hard-cap — cascade IS the truncation path, not a separate pre-check
- [ ] Verify: `npx vitest run tests/server-helpers/format-response.test.ts`
  Expected: all tests passed including new cascade tests
- [ ] Acceptance: Spec AC #7, AC #8
- [ ] Commit: `feat: add progressive response shortening cascade in formatResponse`

---

### Task 7: Compact/counts formatters + registration
**Files:** `src/formatters.ts`, `src/register-tools.ts`, `tests/formatters/shortening.test.ts`
**Complexity:** standard
**Dependencies:** Task 1, Task 6
**Execution routing:** default

- [ ] RED: Create `tests/formatters/shortening.test.ts`
  - Test `formatComplexityCompact(data)` with 30 functions → max 25 entries, uses formatTable, no nest column
  - Test `formatComplexityCounts(data)` → returns "30 functions, avg_cc=5, max_cc=15" string
  - Test `formatClonesCompact(data)` with 25 clones → max 20, basenames only
  - Test `formatClonesCounts(data)` → returns "25 clone pairs (threshold=0.7)" string
  - Test `formatHotspotsCompact(data)` → max 15 entries
  - Test `formatHotspotsCounts(data)` → returns "20 hotspots, period: 90d" string
- [ ] GREEN: Add 6 new formatter functions to new `src/formatters-shortening.ts` (keeps formatters.ts under 540L). In `src/register-tools.ts`, import from `formatters-shortening.ts` and add `registerShortener()` calls for `analyze_complexity`, `find_clones`, `analyze_hotspots` at end of `registerTools()`.
- [ ] Verify: `npx vitest run tests/formatters/shortening.test.ts`
  Expected: 6 tests passed
- [ ] Acceptance: Spec F4 — compact/counts formatters registered
- [ ] Commit: `feat: add compact and counts formatters for complexity, clones, hotspots`

---

### Task 8: PreToolUse hook — precheck-read
**Files:** `src/cli/hooks.ts`, `tests/cli/hooks.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: Create `tests/cli/hooks.test.ts`
  - Test `handlePrecheckRead` with HOOK_TOOL_INPUT = `.ts` file > 200 lines → process.exit(2) + redirect message
  - Test `.ts` file with 199 lines → process.exit(0)
  - Test `.json` file (non-code) with 500 lines → process.exit(0)
  - Test HOOK_TOOL_INPUT not set → process.exit(0), no throw
  - Test malformed JSON in HOOK_TOOL_INPUT → process.exit(0), no throw
  - Test file not found (ENOENT) → process.exit(0)
  - Test CODESIFT_READ_HOOK_MIN_LINES=50 → threshold is 50
  - Test CODESIFT_READ_HOOK_MIN_LINES=abc → uses default 200
  - Mock process.exit, process.env, fs.stat
- [ ] GREEN: Create `src/cli/hooks.ts` with:
  - `CODE_EXTENSIONS: ReadonlySet<string>` (18 extensions)
  - `export async function handlePrecheckRead()`: parse HOOK_TOOL_INPUT, check extension, count lines via stat or readFile, exit 0 or 2
  - Wrap everything in try/catch → exit 0 on any error (CQ8)
- [ ] Verify: `npx vitest run tests/cli/hooks.test.ts`
  Expected: 8 tests passed
- [ ] Acceptance: Spec AC #4
- [ ] Commit: `feat: add precheck-read hook for enforcing CodeSift tool usage`

---

### Task 9: PostToolUse hook + setup integration
**Files:** `src/cli/hooks.ts`, `src/cli/setup.ts`, `src/cli/commands.ts`, `src/cli/help.ts`, `tests/cli/hooks.test.ts`, `tests/cli/setup.test.ts`
**Complexity:** complex
**Dependencies:** Task 8
**Execution routing:** deep

- [ ] RED: Extend `tests/cli/hooks.test.ts`:
  - Test `handlePostindexFile` with Edit event on `.ts` file → calls `indexFile(path)` (mock indexFile)
  - Test `.json` file → indexFile NOT called
  - Test HOOK_TOOL_INPUT not set → exits 0, indexFile NOT called
  Add to `tests/cli/setup.test.ts`:
  - Test `setup("claude", { hooks: true })` creates `.claude/settings.local.json` with PreToolUse + PostToolUse entries
  - Test idempotency: run twice → no duplicate hooks (AC #6)
  - Test `setup("claude")` without hooks → does NOT write hook entries
  - Test existing settings.local.json with other hooks → merged, not overwritten
- [ ] GREEN:
  - Add `handlePostindexFile()` to `src/cli/hooks.ts` — parse HOOK_TOOL_INPUT, call indexFile if code extension
  - Add `setupClaudeHooks()` to `src/cli/setup.ts` — read/merge/write settings.local.json, idempotency check by matcher string
  - Extend `setup()` signature with `{ hooks?: boolean }` option
  - Add `"precheck-read"` and `"postindex-file"` entries to COMMAND_MAP in `src/cli/commands.ts`
  - Add `--hooks` flag handling in setup command
- [ ] Verify: `npx vitest run tests/cli/hooks.test.ts tests/cli/setup.test.ts`
  Expected: all tests passed
- [ ] Acceptance: Spec AC #5, AC #6
- [ ] Commit: `feat: add postindex-file hook and setup --hooks integration`

---

### Task 10: ContainingSymbol type + TextMatch extension
**Files:** `src/types.ts`, `src/tools/search-tools.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: Create `tests/search/search-ranked.test.ts`
  - Test that `TextMatch` interface accepts optional `containing_symbol` field (type-level test)
  - Test that `ContainingSymbol` has required fields: name (string), kind (SymbolKind), start_line (number), end_line (number), in_degree (number)
  - Test `SearchTextOptions` accepts `ranked?: boolean`
- [ ] GREEN:
  - Add `ContainingSymbol` interface to `src/types.ts` with fields: `name: string`, `kind: SymbolKind`, `start_line: number`, `end_line: number`, `in_degree: number`
  - Add `containing_symbol?: ContainingSymbol` to `TextMatch` interface
  - Add `ranked?: boolean` to `SearchTextOptions` in `src/tools/search-tools.ts`
  - Add `ranked` param to `search_text` schema in `src/register-tools.ts`
- [ ] Verify: `npx vitest run tests/search/search-ranked.test.ts && npx tsc --noEmit`
  Expected: tests passed, type check clean
- [ ] Acceptance: Spec F5 types
- [ ] Commit: `feat: add ContainingSymbol type and ranked param for search_text v2`

---

### Task 11: classifyHitsWithSymbols — 4-phase pipeline
**Files:** `src/tools/search-ranker.ts`, `tests/search/search-ranked.test.ts`
**Complexity:** complex
**Dependencies:** Task 10
**Execution routing:** deep

- [ ] RED: Extend `tests/search/search-ranked.test.ts`
  - Test Phase 2 (classify): hit on line 10 inside function at lines 5-30 → containing_symbol populated with correct name/kind/start_line/end_line
  - Test hit outside any symbol → containing_symbol undefined
  - Test stale index (mtime mismatch) → hits returned without containing_symbol, no crash
  - Test file deleted after grep (ENOENT) → hits returned unclassified, no crash
  - Test Phase 3 (dedup): 5 hits in same function → max 2 retained, chosen by content diversity
  - Test Phase 4 (rank): function with in_degree=10 ranks above in_degree=0
  - Test empty matches → returns [] immediately
  - Test empty symbol index → returns hits unclassified
  - Test unsorted symbols → defensive sort by start_line before binary search
  - Mock fs.stat for mtime/ENOENT scenarios
- [ ] GREEN: Create new `src/tools/search-ranker.ts` with `classifyHitsWithSymbols(matches: TextMatch[], index: CodeIndex, bm25Idx: BM25Index): Promise<TextMatch[]>` (keeps search-tools.ts under 670L)
  - Phase 2: sort symbols by start_line, binary search for containing symbol per hit, mtime guard (stat cap at 50 files, Promise.all for parallel stat)
  - Phase 3: group by containing_symbol.name, keep max 2 per function (most diverse content by trimmed string comparison)
  - Phase 4: score = `in_degree * 0.5 + label_bonus + match_count * 0.3`, sort descending
  - label_bonus: function=1.0, method=0.9, class=0.8, type=0.5, other=0.3
- [ ] Verify: `npx vitest run tests/search/search-ranked.test.ts`
  Expected: 9+ tests passed
- [ ] Acceptance: Spec AC #10, AC #11
- [ ] Commit: `feat: add 4-phase symbol promotion pipeline for search_text`

---

### Task 12: Wire ranked mode into searchText
**Files:** `src/tools/search-tools.ts`, `tests/search/search-ranked.test.ts`
**Complexity:** standard
**Dependencies:** Task 11
**Execution routing:** default

- [ ] RED: Extend `tests/search/search-ranked.test.ts` with integration tests using real indexed fixture:
  - Test `searchText(repo, "export", { ranked: true })` returns TextMatch[] with some containing_symbol populated
  - Test `searchText(repo, "export", { ranked: false })` returns TextMatch[] without containing_symbol (backward compat)
  - Test `searchText(repo, "export")` (no ranked param) → same as ranked: false
  - Test `ranked: true` takes precedence over `auto_group: true` (ranked runs, auto_group skipped)
  - Test pipeline respects SEARCH_TIMEOUT_MS
  - Test MCP response envelope: ranked result passed through wrapTool→formatResponse produces valid `{ content: [{ type: "text", text }] }` (integration test verifying the full path)
- [ ] GREEN: In `searchText()` (src/tools/search-tools.ts), add guard after ripgrep/Node match collection (before useCompact/shouldGroup branches):
  ```
  if (options?.ranked && matches.length > 0) {
    const bm25Idx = await getBM25Index(repo);
    if (bm25Idx && index) {
      matches = await classifyHitsWithSymbols(matches, index, bm25Idx);
    }
    // Skip auto_group when ranked — ranked output is already structured
    return matches;
  }
  ```
- [ ] Verify: `npx vitest run tests/search/ && npx vitest run tests/tools/discover-tools.test.ts`
  Expected: all tests passed, 0 regressions
- [ ] Acceptance: Spec AC #9
- [ ] Commit: `feat: wire ranked mode into searchText with auto_group precedence`

---

## Final Verification

After all 12 tasks:
```bash
npx vitest run                    # 0 regressions (544+ baseline)
npx tsc --noEmit                  # clean compile (only pre-existing reranker errors)
```
