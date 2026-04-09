# Implementation Plan: Session-Aware Context

**Spec:** docs/specs/2026-04-07-session-aware-context-spec.md
**spec_id:** 2026-04-07-session-aware-context-1845
**plan_revision:** 1
**status:** Approved
**Created:** 2026-04-07
**Tasks:** 12
**Estimated complexity:** 8 standard + 4 complex

## Architecture Summary

One new module (`src/storage/session-state.ts`) acts as a singleton for in-memory session state. It connects to the existing codebase through 3 integration points:
1. `wrapTool()` in `server-helpers.ts` — calls `recordToolCall()` on every tool call (sync)
2. `watcher.ts` callback via `index-tools.ts` — calls `invalidateNegativeEvidence()` on file changes
3. `register-tools.ts` — exposes `get_session_snapshot` (core) and `get_session_context` (deferred) as MCP tools

A sidecar JSON file (`~/.codesift/session-<id>.json`) bridges the in-memory state to the PreCompact CLI hook (separate process). Writes are debounced (~1s) and atomic (tmp + rename).

Dependencies flow one direction: `server-helpers.ts` → `session-state.ts` ← `usage-tracker.ts` (for SESSION_ID and extractResultChunks).

## Technical Decisions

- **No new npm dependencies.** Debounce via setTimeout/clearTimeout. Atomic write via writeFile to .tmp then renameSync.
- **Shared `formatSnapshot()`** in session-state.ts used by both the MCP tool and the CLI hook.
- **Custom LRU** via `lastSeen` field scan at eviction time. Max 500 symbols, 300 files — linear scan is negligible at these sizes.
- **Deferred tool mechanism:** `get_session_context` excluded from `CORE_TOOL_NAMES` — the existing `disable()` / `discover_tools` path handles it automatically.
- **H10 flag** stored in SessionState (reset by `resetSession()` for test isolation).

## Quality Strategy

- **File size exemption:** `src/storage/session-state.ts` is expected to reach ~400-500 lines (types, state, recording, eviction, snapshot, sidecar). This exceeds the 300-line service limit but is a single-responsibility module (session state singleton). The alternative — splitting into 3 files — would scatter tightly-coupled logic. Exemption accepted; the module has a clean API boundary and is thoroughly tested.
- **Test framework:** Vitest, `singleFork: true`. Tests call `resetSession()` in `beforeEach`.
- **Key CQ gates:** CQ6 (memory caps), CQ8 (sidecar I/O error handling), CQ22 (timer cleanup), CQ23 (TTL invalidation).
- **Risks:** (1) wrapTool cache-hit path must call recordToolCall, (2) debounce timer needs cleanup in resetSession, (3) formatSnapshot shared — no drift, (4) SEARCH_TOOL_SET must not include session tools.
- **Mock boundaries:** `node:os` for homedir redirect (sidecar tests), `vi.useFakeTimers` for TTL tests, `vi.spyOn(process, 'exit')` for hook tests.

## Task Breakdown

### Task 1: Session state types and data structures
**Files:** `src/storage/session-state.ts`, `tests/storage/session-state.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: Test that `resetSession()` produces a clean state with `sessionId`, `startedAt`, `callCount=0`, empty maps and arrays. Test that importing the module gives initial state with `sessionId` matching `getSessionId()` from usage-tracker.
- [ ] GREEN: Create `src/storage/session-state.ts` with `SessionState`, `SymbolEntry`, `FileEntry`, `QueryEntry`, `NegativeEntry` interfaces. Initialize module-level `state: SessionState`. Export `resetSession()`, `getCallCount()`, `getSessionState()`. Import `getSessionId` from `usage-tracker.ts`.
- [ ] Verify: `npx vitest run tests/storage/session-state.test.ts`
  Expected: All tests pass
- [ ] Acceptance: AC-15 (resetSession clears all state)
- [ ] Commit: `add session-state module with types and reset function`

### Task 2: recordToolCall — basic tracking (symbols, files, queries)
**Files:** `src/storage/session-state.ts`, `tests/storage/session-state.test.ts`
**Complexity:** complex
**Dependencies:** Task 1
**Execution routing:** deep implementation tier

- [ ] RED: Test `recordToolCall("search_symbols", {query:"foo", repo:"local/test"}, 3, {symbols:[{id:"s1",name:"fn1",file:"a.ts"},{id:"s2",name:"fn2",file:"b.ts"},{id:"s3",name:"fn3",file:"c.ts"}]})` → `exploredSymbols` has 3 entries with correct symbolId/name/file. Test calling again with same symbolId → `accessCount` increments, `lastSeen` updates. Test `exploredFiles` populated from `get_file_outline` result. Test `args.file_path` extraction for single-file tools (Edit, Write). Test `queries` array appended with tool/query/repo/ts/resultCount.
- [ ] GREEN: Implement `recordToolCall(tool, args, resultChunks, resultData)`. Extract symbols from `resultData.symbols`, files from `resultData.files`/`resultData.matches` and `args.file_path`/`args.path`. Append to `queries` if `args.query` exists. Increment `callCount`. Use `extractResultChunks` from `usage-tracker.ts` for result counting. Per-tool field mapping table (like `TOOL_ARG_FIELDS` in usage-tracker) for symbol/file extraction. Also implement `recordCacheHit(tool, args)` — increments callCount and updates lastSeen on existing entries but does NOT evaluate negative evidence (no result data available).
- [ ] Verify: `npx vitest run tests/storage/session-state.test.ts`
  Expected: All tests pass
- [ ] Acceptance: AC-4 (wrapTool records every call)
- [ ] Commit: `add recordToolCall with symbol, file, and query extraction`

### Task 3: Negative evidence recording and TTL staleness
**Files:** `src/storage/session-state.ts`, `tests/storage/session-state.test.ts`
**Complexity:** complex
**Dependencies:** Task 2
**Execution routing:** deep implementation tier

- [ ] RED: Test `recordToolCall("search_text", {query:"missing", repo:"local/test"}, 0, {matches:[]})` → `negativeEvidence` has 1 entry with `stale: false`. Test non-search tool with zero results → no negative entry. Test `SEARCH_TOOL_SET` does not include `get_session_snapshot` or `get_session_context`. Test with `vi.useFakeTimers`: entry < 120s → stale=false at read time; advance 121s → stale=true at read time. Test `invalidateNegativeEvidence("local/test")` with subtree match → entry marked stale. Test unrelated subtree → entry NOT marked stale.
- [ ] GREEN: Define `SEARCH_TOOL_SET = new Set(["search_text", "search_symbols", "codebase_retrieval", "semantic_search", "find_references"])`. In `recordToolCall`, if tool in set AND `extractResultChunks(resultData) === 0`, append `NegativeEntry`. Implement `invalidateNegativeEvidence(repo)` with subtree matching. Implement `isStale(entry)` helper that checks TTL (120s) lazily.
- [ ] Verify: `npx vitest run tests/storage/session-state.test.ts`
  Expected: All tests pass
- [ ] Acceptance: AC-5, AC-6, AC-7, AC-8, AC-21
- [ ] Commit: `add negative evidence recording with TTL and watcher invalidation`

### Task 4: Cap enforcement with LRU/FIFO eviction
**Files:** `src/storage/session-state.ts`, `tests/storage/session-state.test.ts`
**Complexity:** standard
**Dependencies:** Task 3 (shares session-state.ts — must serialize)
**Execution routing:** default implementation tier

- [ ] RED: Test filling `exploredSymbols` to 501 → oldest by `lastSeen` evicted, size stays 500. Test filling `queries` to 201 → first (oldest) entry removed. Test filling `negativeEvidence` to 301 with some stale → stale evicted first. Test `exploredFiles` to 301 → LRU eviction.
- [ ] GREEN: Implement `evictLRU(map, maxSize)` helper that removes entry with min `lastSeen`. Implement FIFO trim for arrays. Implement stale-first eviction for negativeEvidence: sort by stale desc then ts asc, remove first.
- [ ] Verify: `npx vitest run tests/storage/session-state.test.ts`
  Expected: All tests pass
- [ ] Acceptance: AC-9 (caps enforced)
- [ ] Commit: `add session state cap enforcement with LRU and stale-first eviction`

### Task 5: formatSnapshot — priority-tiered 700-char snapshot
**Files:** `src/storage/session-state.ts`, `tests/storage/session-state.test.ts`
**Complexity:** complex
**Dependencies:** Task 3, Task 4
**Execution routing:** deep implementation tier

- [ ] RED: Test empty state → header-only output (~15 tokens). Test populated state → all 5 tiers present, under 700 chars. Test 500 symbols → `+N more` suffix in tier 3. Test overflow: force all tiers max → tier 5 dropped, then 4. Test `repo` filter → only symbols/files/queries for that repo. Test stale negative evidence excluded. Test deterministic: call twice with same state → identical output. Test hard cap: output.length <= 700.
- [ ] GREEN: Implement `formatSnapshot(state: SessionState, repo?: string)` as a **pure function** (takes state as parameter, does not read module-level state). Sequential string builders: Tier 1 header, Tier 2 top 5 files by accessCount, Tier 3 top 10 symbols by lastSeen, Tier 4 top 5 non-stale negative evidence by ts, Tier 5 last 3 queries. Running char budget with `+N more` truncation. Drop tiers 5, then 4 if over 700. Must be pure so CLI hook can deserialize sidecar JSON and call the same function.
- [ ] Verify: `npx vitest run tests/storage/session-state.test.ts`
  Expected: All tests pass
- [ ] Acceptance: AC-1, AC-2, AC-8, AC-20
- [ ] Commit: `add formatSnapshot with priority-tiered 700-char budget`

### Task 6: Sidecar file management (debounced write, atomic, cleanup)
**Files:** `src/storage/session-state.ts`, `tests/storage/session-state.test.ts`
**Complexity:** complex
**Dependencies:** Task 4 (shares session-state.ts — must serialize)
**Execution routing:** deep implementation tier

- [ ] RED: Test `flushSidecar()` writes JSON to `session-<id>.json`. Test Map roundtrip: write state with populated exploredSymbols Map → read sidecar JSON → assert Map contents preserved (Object.fromEntries for serialization, new Map(Object.entries) for deserialization). Test atomic: `.tmp` file removed after rename. Test `cleanupSidecar()` removes the sidecar file. Test `cleanupOrphanSidecars()` removes files older than 24h, keeps fresh ones. Test write failure → error suppressed, no throw. Test debounce: multiple `scheduleSidecarFlush()` calls within 1s → only one write. Test CQ22: `scheduleSidecarFlush()` then `resetSession()` then advance 2s with `vi.useFakeTimers` → no file write (timer cancelled). Use `vi.mock("node:os")` to redirect homedir.
- [ ] GREEN: Implement `serializeState(state)` that converts Maps to plain objects via `Object.fromEntries()` and `deserializeState(json)` that reconstructs Maps via `new Map(Object.entries())`. Implement `flushSidecar()` (serializeState → writeFileSync to .tmp, renameSync to final), `cleanupSidecar()` (unlinkSync, catch errors), `cleanupOrphanSidecars()` (readdirSync, filter by mtime, unlinkSync). Implement `scheduleSidecarFlush()` with setTimeout/clearTimeout debounce (~1s). Clear timer in `resetSession()`. Export `deserializeState` for CLI hook use.
- [ ] Verify: `npx vitest run tests/storage/session-state.test.ts`
  Expected: All tests pass
- [ ] Acceptance: AC-12, AC-18, AC-19
- [ ] Commit: `add sidecar file management with atomic writes and orphan cleanup`

### Task 7: getContext — full session state as JSON
**Files:** `src/storage/session-state.ts`, `tests/storage/session-state.test.ts`
**Complexity:** standard
**Dependencies:** Task 3
**Execution routing:** default implementation tier

- [ ] RED: Test `getContext()` returns structured JSON with all fields: session_id, started_at, call_count, explored_files, explored_symbols, queries, negative_evidence, caps. Test `repo` filter works. Test `include_stale=false` → stale entries absent. Test `include_stale=true` → stale entries present. Test `caps` object reports correctly when capped.
- [ ] GREEN: Implement `getContext(repo?, includeStale?)` that serializes SessionState to the JSON shape from the spec. Apply TTL staleness lazily. Filter by repo if provided.
- [ ] Verify: `npx vitest run tests/storage/session-state.test.ts`
  Expected: All tests pass
- [ ] Acceptance: AC-3
- [ ] Commit: `add getContext for full session state as structured JSON`

### Task 8: Integrate recordToolCall into wrapTool + H10 hint
**Files:** `src/server-helpers.ts`, `tests/tools/response-hints.test.ts`
**Complexity:** standard
**Dependencies:** Task 2
**Execution routing:** default implementation tier

- [ ] RED: Test that after calling a wrapped tool, `getCallCount()` from session-state returns 1. Test cache-hit path also increments callCount (call same tool twice with caching). Test cache-hit on search_text with prior results does NOT append to negativeEvidence (non-regression for false negative evidence). Test `buildResponseHint()` returns H10 text after 50 calls. Test H10 emitted only once. Test `resetSessionState()` delegates to `resetSession()` — callCount back to 0.
- [ ] GREEN: In `wrapTool()` in server-helpers.ts: import `recordToolCall`, `recordCacheHit` from session-state. Call `recordToolCall(tool, args, extractResultChunks(data), data)` on cache-miss path after fn() resolves. Call `recordCacheHit(tool, args)` on cache-hit early return — this increments callCount and updates lastSeen but does NOT evaluate negative evidence (no resultData to inspect). In `buildResponseHint()`: import `getCallCount`, `isH10Emitted`, `markH10Emitted` from session-state. Add H10 block. In `resetSessionState()`: call `resetSession()`.
- [ ] Verify: `npx vitest run tests/tools/response-hints.test.ts`
  Expected: All tests pass
- [ ] Acceptance: AC-4, AC-13
- [ ] Commit: `integrate session tracking into wrapTool and add H10 hint code`

### Task 9: Register get_session_snapshot and get_session_context tools
**Files:** `src/register-tools.ts`, `tests/tools/session-context.test.ts`
**Complexity:** standard
**Dependencies:** Task 5, Task 7
**Execution routing:** default implementation tier

- [ ] RED: Test `get_session_snapshot` is in `CORE_TOOL_NAMES`. Test `get_session_context` is NOT in `CORE_TOOL_NAMES`. Test both are in `TOOL_DEFINITIONS`. Test calling `get_session_snapshot` handler returns string ≤700 chars. Test calling `get_session_context` handler returns JSON object. Test `registerShortener` called for `get_session_context`.
- [ ] GREEN: Add `get_session_snapshot` and `get_session_context` to `TOOL_DEFINITIONS` with Zod schemas, descriptions, category `"session"`, searchHint. Add `"get_session_snapshot"` to `CORE_TOOL_NAMES`. Import `getSnapshot`, `getContext` from `session-state.ts`. Register shortener for `get_session_context` with compact and counts formatters.
- [ ] Verify: `npx vitest run tests/tools/session-context.test.ts`
  Expected: All tests pass
- [ ] Acceptance: AC-14, AC-17
- [ ] Commit: `register session snapshot and context as MCP tools`

### Task 10: PreCompact CLI hook and command
**Files:** `src/cli/hooks.ts`, `src/cli/commands.ts`, `tests/cli/hooks.test.ts`
**Complexity:** standard
**Dependencies:** Task 5, Task 6
**Execution routing:** default implementation tier

- [ ] RED: Test `handlePrecompactSnapshot()` with valid HOOK_TOOL_INPUT containing session_id → reads sidecar file, writes snapshot to stdout, exits 0. Test missing sidecar file → exits 0, empty stdout. Test malformed JSON in HOOK_TOOL_INPUT → exits 0. Test empty session_id in hook input → exits 0. Test `COMMAND_MAP` has `"precompact-snapshot"` entry.
- [ ] GREEN: Add `handlePrecompactSnapshot()` to `src/cli/hooks.ts` following existing handler pattern (read env, parse JSON, try/catch, exit 0). Read sidecar JSON file from disk (`~/.codesift/session-<session_id>.json`), deserialize into `SessionState` shape, pass to `formatSnapshot(state)` — the pure function exported from `session-state.ts`. Do NOT import the live module-level singleton (CLI runs as a separate process with empty state). Add `"precompact-snapshot"` to COMMAND_MAP in commands.ts.
- [ ] Verify: `npx vitest run tests/cli/hooks.test.ts`
  Expected: All tests pass
- [ ] Acceptance: AC-10
- [ ] Commit: `add precompact-snapshot CLI hook for context compaction survival`

### Task 11: PreCompact hook installation + watcher invalidation
**Files:** `src/cli/setup.ts`, `src/tools/index-tools.ts`, `tests/cli/setup.test.ts`
**Complexity:** standard
**Dependencies:** Task 3, Task 10
**Execution routing:** default implementation tier

- [ ] RED: Test `setupClaudeHooks()` installs PreCompact hook entry in settings.local.json alongside PreToolUse/PostToolUse. Test idempotent (no duplicates). Test watcher onChange callback calls `invalidateNegativeEvidence(repoName)`.
- [ ] GREEN: Add `PRECOMPACT_HOOK` constant in setup.ts. Extend `setupClaudeHooks()` with PreCompact array guard + push. In `index-tools.ts` handleFileChange callback (which is the watcher.ts onChange consumer — spec says watcher.ts but the callback registration is in index-tools.ts), import and call `invalidateNegativeEvidence(repoName)`. No changes to watcher.ts itself.
- [ ] Verify: `npx vitest run tests/cli/setup.test.ts`
  Expected: All tests pass
- [ ] Acceptance: AC-6, AC-11, AC-21
- [ ] Commit: `install PreCompact hook and wire watcher to negative evidence invalidation`

### Task 12: Server wiring, instructions, and documentation
**Files:** `src/server.ts`, `src/instructions.ts`, `CLAUDE.md`
**Complexity:** standard
**Dependencies:** Task 6, Task 9
**Execution routing:** default implementation tier

- [ ] RED: Test `process.on('exit')` handler is registered (spy on process.on). Test `resetSessionState` from server.ts re-export calls `resetSession()`. Test instructions text mentions `get_session_snapshot` and `get_session_context`.
- [ ] GREEN: In `server.ts`: import `cleanupSidecar` from session-state, register `process.on('exit', cleanupSidecar)`. Re-export `resetSession`. In `instructions.ts`: add session tools to CODESIFT_INSTRUCTIONS. Update `CLAUDE.md`: tool count 64→66, add H10 to hint legend, add session-state.ts to architecture.
- [ ] Verify: `npx vitest run tests/server.test.ts && npx vitest run tests/instructions.test.ts && grep -E '66 (MCP )?tools' CLAUDE.md && npx vitest run`
  Expected: All tests pass. grep confirms tool count updated to 66. Full suite run verifies AC-16 (no regressions).
- [ ] Acceptance: AC-16
- [ ] Commit: `wire session cleanup on exit and update instructions and docs`
