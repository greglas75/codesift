# Implementation Plan: CodeSift Tool Runtime Optimization (usage.jsonl-driven)

**Spec:** inline — no spec
**spec_id:** none
**planning_mode:** inline
**source_of_truth:** inline brief (usage.jsonl analysis, 21 713 entries, since 2026-06-01)
**plan_revision:** 4
**status:** Approved
**Created:** 2026-07-10
**Tasks:** 5
**Estimated complexity:** 2 complex (wrapper module + registration wiring), 3 standard

## Problem (evidence from `usage_hotspots` / `optimization_candidates`)
- **`usage_stats` is broken** — `Cannot find module '../package.json'` from `dist/register-tool-groups/meta.js` (relative-require regression after the `register-tools` → `register-tool-groups/` split). Ships in the pending 0.9.6.
- **Token sinks:** `get_file_tree` 881 calls / **1.10M tok**, `find_references` 605 calls / **909K tok**, `describe_tools` 571K, `initial_instructions` 461K.
- **Pathological latency (missing timeouts):** `analyze_complexity` max **16.7 min**, `search_conversations` **15.5 min**, `get_repo_outline` **9.6 min**, `audit_scan` **8.8 min**, `scan_secrets` **7 min**.
- **Duplicate calls:** **2 357 repeats within 60s** (e.g. `audit_scan` 8× and `index_file` 16× in one session) — the tool's own recommendation: "add debounce hints or response-cache coverage."

## Architecture Summary
Tools are declared as `ToolDefinitionEntry { order, definition }` in `src/register-tool-groups/*.ts`, aggregated in `index.ts` (`TOOL_ENTRIES` / `TOOL_DEFINITIONS`). Handlers are bound in `registerToolDefinition` (`src/register-tools/runtime.ts:55`), which **already** wraps each call as `wrapTool(tool.name, args, () => tool.handler(args))` (from `src/server-helpers.ts`). That existing wrap site — NOT `getRegisterToolRuntime`, which only returns `{ detectAutoLoadToolsCached, enableToolByName }` and never touches `handler` — is the correct injection point: compose the new timeout+cache decorators there so every tool is covered without per-tool handler edits. `ToolDefinition` (`shared.ts:78`, `handler` at line 82) gains opt-in cache metadata; the definitions themselves live in the group files (`core.ts`, `analysis.ts`, …), so cache-tagging edits those files, not `index.ts`.

- `get_file_tree` + `find_references` definitions live in `src/register-tool-groups/core.ts` (lines 232, 412); formatters (`formatFileTree`, `formatRefsCompact`) in `deps.ts`.
- `usage_stats` handler in `src/register-tool-groups/meta.ts:269`.
- Existing compact infra to reuse: `src/formatters-shortening.ts` (progressive cascade), `formatRefsCompact` in `deps.ts`.

## Technical Decisions
- **One decorator module** (`handler-wrappers.ts`) exporting pure, composable `withTimeout(handler, ms)` and `withCache(handler, keyFn)` — testable in isolation, no registration coupling. Wired once in `src/register-tools/runtime.ts:55` by composing them around the existing `wrapTool(tool.name, args, () => tool.handler(args))`.
- **Timeout is universal** — applied to EVERY tool at the wrap site — returning a graceful `{ status: "timed_out", elapsed_ms, tool }` instead of hanging the client. Exempt allowlist (legitimately long): `index_folder`, `index_file`, `index-conversations`, `serve`. Env `CODESIFT_TOOL_TIMEOUT_MS` (default 90000). This covers the pathological-latency finding wholesale, including `search_conversations` (15.5 min) and `scan_secrets` (7 min), which are NOT cache-marked. **Scope: client-facing.** `Promise.race` unblocks the caller but does NOT abort the underlying handler (most heavy tools are CPU/IO work Node cannot forcibly cancel). Invariants: the abandoned handler must settle without an unhandled rejection, and each timeout logs a `tool_timeout` event to `usage.jsonl` so abandoned-work volume stays measurable (backpressure is a follow-up if it proves significant). Tools that already thread an `AbortSignal` (child-process/fetch) may pass it through for real cancellation — best-effort.
- **Cache is opt-in** via `cacheable?: boolean` on `ToolDefinition`, set on the read-only, deterministic-per-index composites in their group files. Marked: `detect_communities`/`find_circular_deps`/`get_repo_outline` (in `core.ts`); `audit_scan`/`analyze_complexity`/`architecture_summary`/`fan_in_fan_out`/`nest_audit` (in `analysis.ts`). Optional `timeoutMs?: number` overrides the universal default per tool. `withCache` also does **in-flight coalescing**: concurrent calls with the same key share one in-flight promise, so N identical parallel requests (the parallel-session duplicate pattern) trigger ONE execution — not just sequential reuse.
- **Cache key** = `(tool name, repo, stable-stringified args, repo index version)`. Invalidate automatically when the repo index version changes (reuse the storage layer's per-repo index version / mtime signal — same signal `index_file` bumps). In-memory LRU, bounded, TTL fallback. Env: `CODESIFT_TOOL_CACHE=0` disables.
- **Token diet** is a default-flip, not a new mode: `get_file_tree` defaults `compact=true` when unset; `find_references` gets a default result cap (`max_refs`, e.g. 50) with an overflow note. Both preserve an explicit opt-out (`compact=false` / higher cap).

## Quality Strategy
- Each wrapper is a pure function → unit-tested directly (fake timers for timeout, call-count spy for cache).
- Registration wiring tested via a fake `ToolDefinition` through the real bind path `registerToolDefinition` / `wrapTool` (`src/register-tools/runtime.ts:55`), asserting the universal timeout applies to every tool and cache application only when `cacheable` metadata is present.
- Token-diet tested by asserting output shape/size on a fixture repo, both default and opt-out.
- Risk areas: (a) cache staleness across index edits — covered by an index-version-bump invalidation test AND a Task-3 spike proving the index-version signal is readable at the wrapper layer; (b) timeout does not abort underlying work (client-facing) — abandoned handlers must settle without unhandled rejection and log `tool_timeout`; (c) same-file edit collisions — serialized in Dependencies; (d) concurrent duplicate calls — covered by an in-flight-coalescing test (2 concurrent same-key → 1 execution).
- CQ watch: CQ (pure fns, no hidden state), file-limits (`handler-wrappers.ts` ≤100 LOC target).

## Coverage Matrix
| Row ID | Authority item | Type | Primary task(s) | Notes |
|--------|----------------|------|-----------------|-------|
| G1 | `usage_stats` returns version, no MODULE_NOT_FOUND | requirement | Task 1 | in-release regression |
| G2 | Reusable timeout+cache decorators exist and are unit-proven | deliverable | Task 2 | pure fns |
| G3 | Universal hard-timeout on all tools (covers search_conversations 15.5min, scan_secrets 7min) + per-index cache on read-only composites | requirement | Task 3 | deps Task 2; edits runtime.ts+shared.ts+core.ts+analysis.ts |
| G4 | `get_file_tree` compact-by-default + `find_references` capped-by-default | requirement | Task 4 | token sink #1/#2 |
| G5 | End-to-end: cache-hit + timeout + compact proven together | requirement | Task 5 | whole-feature smoke |

## Review Trail
- Phase 1: direct (small/light scope) — inline, CodeSift on indexed repo, 5 tasks; Explore sub-agents lack CodeSift and would re-explore with weaker tools.
- Plan reviewer: revision 1 -> ISSUES FOUND (wrong injection point — handlers wrap in `register-tools/runtime.ts:55` via existing `wrapTool`, not `getRegisterToolRuntime`; cache-tagging edits `core.ts`+`analysis.ts` not `index.ts` → same-file collision with Task 4; timeout-scope contradiction left search_conversations/scan_secrets uncovered; index_file write-dups out of cache scope)
- Plan reviewer: revision 2 -> ISSUES FOUND (1 residual only — stale `getRegisterToolRuntime` phrase in Quality Strategy; issues 2/3/4 + DAG confirmed resolved)
- Plan reviewer: revision 3 -> CONVERGED (sole residual was a documentation-consistency phrase with no execution semantics — task RED/GREEN/Verify already correct at rev2; corrected line 35 to route wiring test through `registerToolDefinition`/`wrapTool`)
- Cross-model validation: single_provider_only (codex-5.3 returned; agy + cursor-agent empty, claude timed out — note: restore providers for diversity). 4 WARNING + 1 INFO, all applied in rev4: (1) timeout is client-facing, does not abort underlying work → documented scope + `tool_timeout` telemetry + no-unhandled-rejection invariant; (2) cache lacked in-flight coalescing → added concurrent-same-key coalescing + RED test (directly addresses parallel-session duplicates); (3) index-version signal unproven at wrapper layer → added Task-3 SPIKE (rule 14) proving it changes after index_file before wiring; (4) wall-clock "≥10× faster" acceptance is flaky → replaced with deterministic handler-invocation-count / cache-hit-marker assertions in Task 3 + Task 5 + SMOKE1. INFO (over-specified GREEN mechanics) → Task 2 GREEN reframed around invariants. Changes are additive test-rigor + one local behavior (coalescing in Task 2); no DAG/file-list/dependency change the plan-reviewer validated at rev3 — DAG re-linted clean.
- Status gate: Approved (user go-ahead 2026-07-10)

## Task Breakdown

### Task 1: Fix usage_stats version-path regression
**Files:** `src/register-tool-groups/meta.ts`, `tests/tools/register/meta-usage-stats.test.ts` (new)
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: In `tests/tools/register/meta-usage-stats.test.ts`, invoke the `usage_stats` tool handler (from `TOOL_DEFINITIONS`) with `{}` and assert the result has a string `version` equal to the root `package.json` version. Asserts it does NOT throw `Cannot find module '../package.json'`.
- [ ] GREEN: In `meta.ts:269`, change `req("../package.json")` → `req("../../package.json")` (from `dist/register-tool-groups/meta.js`, `../../` resolves to the package root in both dev-build and published layouts). Reuse the existing `createRequire(import.meta.url)` — no new import.
- [ ] Verify: `npx vitest run tests/tools/register/meta-usage-stats.test.ts`
  Expected: `Test Files 1 passed`, and the version assertion passes (non-empty semver string).
- [ ] Acceptance Proof:
  - AC G1:
    - Surface: backend-logic
    - Proof: `node -e "const {TOOL_DEFINITIONS}=await import('./dist/register-tool-groups/index.js'); const t=TOOL_DEFINITIONS.find(d=>d.name==='usage_stats'); console.log((await t.handler({})).version)"` (after `npm run build`)
    - Expected: prints the package.json version (e.g. `0.9.6`), exit 0, no module-resolution error.
    - Artifact: `zuvo/proofs/task-1-G1.txt`
- [ ] Commit: `fix(meta): resolve usage_stats package.json path after register split (../../)`

### Task 2: Build reusable handler-wrapper module (timeout + cache)
**Files:** `src/register-tool-groups/handler-wrappers.ts` (new), `tests/tools/register/handler-wrappers.test.ts` (new)
**Surface:** backend-logic
**Complexity:** complex
**Dependencies:** none
**Execution routing:** deep implementation tier

- [ ] RED: In `handler-wrappers.test.ts` assert: (a) `withTimeout(fn, 20)` where `fn` never resolves → returns `{ status: "timed_out", tool }` after ~20ms AND the later-settling `fn` leaves NO unhandled rejection; a fast `fn` passes through unchanged. (b) `withCache(fn, keyFn)` same key twice → `fn` invoked once, 2nd returns cached; different key or bumped index-version → `fn` invoked again. (c) TWO CONCURRENT same-key calls (both started before the first resolves) → `fn` invoked EXACTLY once, both receive the same result (in-flight coalescing). Use fake timers + a call-count spy.
- [ ] GREEN: Implement to these INVARIANTS (mechanics illustrative, not prescriptive): `withTimeout(handler, ms)` — slow handler yields the timed-out marker after `ms`; fast handler passes through; the abandoned slow handler settling later produces NO unhandled rejection. `withCache(handler, keyFn)` — bounded (LRU) so memory can't grow unbounded; deterministic stable key = tool+repo+stable-JSON-args+index-version; same-key hit adds zero handler invocations; bumped index-version misses; **concurrent same-key calls coalesce onto one in-flight promise (single execution)**. Pure module, no server import; target ≤100 LOC.
- [ ] Verify: `npx vitest run tests/tools/register/handler-wrappers.test.ts`
  Expected: `Test Files 1 passed`; timeout test completes in <200ms (fake timers), cache test shows spy call-count 1 then 1-again-for-same-key.
- [ ] Acceptance Proof:
  - AC G2:
    - Surface: backend-logic
    - Proof: `npx vitest run tests/tools/register/handler-wrappers.test.ts --reporter=dot`
    - Expected: all wrapper unit tests pass; timeout marker + single-invocation cache both asserted.
    - Artifact: `zuvo/proofs/task-2-G2.txt`
- [ ] Commit: `feat(register): add composable withTimeout + withCache handler wrappers`

### Task 3: Wire wrappers at the real bind site + opt-in cache metadata
**Files:** `src/register-tools/runtime.ts` (compose wrappers around the existing `wrapTool` at line 55), `src/register-tool-groups/shared.ts` (add `cacheable?`/`timeoutMs?` to `ToolDefinition`), `src/register-tool-groups/core.ts` (tag detect_communities/find_circular_deps/get_repo_outline), `src/register-tool-groups/analysis.ts` (tag audit_scan/analyze_complexity/architecture_summary/fan_in_fan_out/nest_audit), `tests/tools/register/wrapper-wiring.test.ts` (new)
**Surface:** integration
**Complexity:** complex
**Dependencies:** Task 2
**Execution routing:** deep implementation tier

- [ ] RED: (0) SPIKE — de-risk the cache key before wiring: from the wrapper layer, read the repo index-version via the storage/index layer and assert it CHANGES after an `index_file` on the same repo (proves the invalidation signal exists and is reachable; per authoring rule 14). Then in `wrapper-wiring.test.ts` build two fake `ToolDefinition`s — one `{ cacheable: true, timeoutMs: 20 }`, one with NO metadata — and register each through the real bind path in `registerToolDefinition` (`register-tools/runtime.ts`, i.e. through `wrapTool`). Assert: (a) cacheable def → 2nd identical call within same index-version served from cache (handler spy invoked once total — deterministic count, not timing); (b) a handler overrunning its timeout returns the timed-out marker; (c) the NON-metadata def is NOT cached (spy called every call) but STILL gets the **universal** timeout marker when it overruns (proving timeout is universal, cache is opt-in); (d) an exempt tool name (e.g. `index_file`) is not timeout-wrapped.
- [ ] GREEN: Extend `ToolDefinition` (`shared.ts`) with optional `cacheable?: boolean` and `timeoutMs?: number`. In `register-tools/runtime.ts:55`, compose `withTimeout` (**universal** — every tool except the exempt allowlist `index_folder`/`index_file`/`index-conversations`/`serve`, default `CODESIFT_TOOL_TIMEOUT_MS`=90000, per-tool `timeoutMs` override) and `withCache` (**only** when `definition.cacheable`) around the existing `wrapTool(tool.name, args, () => tool.handler(args))`. In `core.ts` set `cacheable: true` on detect_communities/find_circular_deps/get_repo_outline; in `analysis.ts` on audit_scan/analyze_complexity/architecture_summary/fan_in_fan_out/nest_audit.
- [ ] Verify: `npx vitest run tests/tools/register/wrapper-wiring.test.ts && npx vitest run tests/tools/register/`
  Expected: wiring test passes AND the full register suite stays green (no regression in existing registration tests).
- [ ] Acceptance Proof:
  - AC G3:
    - Surface: integration
    - Proof: `node` harness (post-build) calling `audit_scan` twice on this repo with an underlying handler-invocation counter + cache-hit marker; asserts the 2nd call is a cache HIT (handler executed once total; cache-hit flag set), identical payload. Script `zuvo/proofs/task-3-G3.mjs`. Wall-clock delta is logged as secondary info only — never the pass/fail gate (timing is CI-flaky).
    - Expected: handler invoked once across the two calls; cache-hit marker on call#2; identical payload; no timed-out marker on a normal repo.
    - Artifact: `zuvo/proofs/task-3-G3.txt`
- [ ] Commit: `feat(register): apply timeout+cache to expensive read-only tools via opt-in metadata`

### Task 4: Token diet — get_file_tree compact-default + find_references cap
**Files:** `src/register-tool-groups/core.ts`, `tests/tools/register/core-token-diet.test.ts` (new)
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** Task 3 (same-file serialization — Task 3 also edits `core.ts` to tag cacheable composites; these two MUST NOT run concurrently on the same file. No data dependency — pure ordering per authoring rule 13.)
**Execution routing:** default implementation tier

- [ ] RED: In `core-token-diet.test.ts` assert: (a) `get_file_tree` handler with `compact` UNSET returns the compact shape (locations/counts only), while `compact:false` still returns the full tree. (b) `find_references` handler with no cap returns at most the default cap (e.g. 50) and appends an overflow note when truncated; an explicit higher `max_refs` returns more. Use a fixture repo with a symbol having >50 references.
- [ ] GREEN: In `core.ts`, flip `get_file_tree`'s `compact` default to `true` when the arg is omitted (schema `.default(true)` or handler coalesce), preserving explicit `compact:false`. Add a `max_refs` (default 50) to `find_references` with an overflow note via the existing `formatRefsCompact`/formatter. Do not change return types.
- [ ] Verify: `npx vitest run tests/tools/register/core-token-diet.test.ts`
  Expected: `Test Files 1 passed`; default get_file_tree output byte-length < full output on the same fixture; find_references default result count ≤ 50 with overflow note present.
- [ ] Acceptance Proof:
  - AC G4:
    - Surface: backend-logic
    - Proof: post-build `node` harness calling `get_file_tree({repo})` (default) vs `get_file_tree({repo,compact:false})` and printing both output token estimates; same for `find_references`. Script `zuvo/proofs/task-4-G4.mjs`.
    - Expected: default output materially smaller (target ≥40% fewer chars on this repo); opt-out restores full output.
    - Artifact: `zuvo/proofs/task-4-G4.txt`
- [ ] Commit: `perf(core): compact-by-default get_file_tree + capped find_references (token diet)`

### Task 5: Whole-feature smoke runner (cache + timeout + compact end-to-end)
**Files:** `tests/integration/tool-wrappers-smoke.test.ts` (new), `zuvo/proofs/smoke-tool-wrappers.mjs` (new)
**Surface:** integration
**Complexity:** standard
**Dependencies:** Task 3, Task 4
**Execution routing:** default implementation tier

- [ ] RED: `tool-wrappers-smoke.test.ts` exercises, against the built server/tool registry on this repo: (1) `usage_stats` returns a version (Task 1); (2) `audit_scan` called twice → 2nd is a cache HIT asserted deterministically (underlying handler invoked once; cache-hit marker set — NOT a wall-clock threshold) (Task 3); (3) a synthetic slow cacheable handler → timed-out marker + the abandoned handler settles with no unhandled rejection (Task 3); (4) `get_file_tree` default output is smaller than `compact:false` (Task 4). All in one runnable suite (slow handler mocked).
- [ ] GREEN: Author `zuvo/proofs/smoke-tool-wrappers.mjs` that runs the four checks against `dist/` and exits non-zero on any failure; the vitest suite wraps the same assertions.
- [ ] Verify: `npm run build && node zuvo/proofs/smoke-tool-wrappers.mjs && npx vitest run tests/integration/tool-wrappers-smoke.test.ts`
  Expected: smoke script exits 0 printing `SMOKE OK (4/4)`; vitest suite passes.
- [ ] Acceptance Proof:
  - AC G5:
    - Surface: integration
    - Proof: `node zuvo/proofs/smoke-tool-wrappers.mjs`
    - Expected: `SMOKE OK (4/4)`, exit 0.
    - Artifact: `zuvo/proofs/smoke-tool-wrappers.txt`
- [ ] Commit: `test(integration): whole-feature smoke for tool cache+timeout+token-diet`

## Whole-feature Smoke Proofs

- **SMOKE1 — Tool runtime optimizations end-to-end**
  - Preconditions: `npm run build`; codesift-mcp repo indexed (self).
  - Proof: `node zuvo/proofs/smoke-tool-wrappers.mjs` — runs: usage_stats version (G1), audit_scan cache-hit on 2nd call (G3), slow-handler timeout marker (G3), get_file_tree default < compact:false (G4).
  - Expected: `SMOKE OK (4/4)`, exit 0; no `Cannot find module` error; 2nd audit_scan is a cache hit (handler invoked once; cache-hit marker) — asserted by invocation count, not wall-clock.
  - Artifact: `zuvo/proofs/smoke-tool-wrappers.txt`

## Notes
- The **universal** timeout (Task 3) now covers `search_conversations` (15.5 min) and `scan_secrets` (7 min) latency wholesale — no longer deferred. Still deferred (lower ROI, distinct optimizations): `describe_tools`/`initial_instructions` token trims and a `scan_secrets` *incremental* scan (a separate concern from the timeout guard).
- **Write-side duplicates are intentionally OUT of cache scope.** The 2 357-duplicate finding includes read-side repeats (`audit_scan` 8×) — addressed by Task 3's cache — and write-side repeats (`index_file` 16×), which must NOT be cached (caching a write/index op is wrong). Read-side is the cache's target; `index_file` debounce is tracked separately.
- Task 1 is independent and trivial — it can be cherry-picked into the pending 0.9.6 release ahead of Tasks 2–5.
