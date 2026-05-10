# Implementation Plan: Fix Semantic Search Adoption

**Spec:** inline — no spec
**spec_id:** none
**planning_mode:** inline
**source_of_truth:** inline brief
**plan_revision:** 3
**status:** Reviewed
**Created:** 2026-05-09
**Tasks:** 7
**Estimated complexity:** 6 standard, 1 complex (smoke integration)

## Problem Statement (inline brief)

CodeSift MCP semantic search has near-zero adoption despite being deployed and functional.

Hard data from `/Users/greglas/.codesift/usage.jsonl` (13,338 calls / 1,172 unique sessions):
- `semantic_search` standalone tool: **0 calls**
- `codebase_retrieval(type:"semantic")`: **194 query slots** (24% of codebase_retrieval total of 792)
- 56 / 1172 sessions (**4.8%**) used semantic at all
- `search_text` dominates with 5,644 calls (42% of all)

Prior fix (2026-04-14 plan, deployed): `W_STRUCTURAL=0.4 → 0.1`, `H9 → enableToolByName("semantic_search")` async reveal. Did NOT move adoption.

Root causes (architect + tech lead + QA reports):
- H-A: `semantic_search` NOT in `CORE_TOOL_NAMES` — only auto-revealed via H9 race
- H-B: `semantic_search` duplicates `codebase_retrieval(type:"semantic")` — fragmented telemetry, dual paths
- H-C: plan_turn under-recommends semantic; `W_IDENTITY=2.0` dominates lexical name match
- H-D: H9 emits hint + async `enableToolByName` (fire-and-forget race)
- H-E: No win-loss telemetry to measure semantic result quality

Out of scope: local embeddings (separate workstream, parallel agent).

## Architecture Summary

Eight files modified across five concerns. No new modules. All changes additive or replacing fire-and-forget code.

- `src/register-tools.ts` (line 1275) — semantic_search tool definition; add deprecation status
- `src/tools/search-tools.ts` (line 686–706) — semanticSearch handler; delegate to codebase_retrieval
- `src/server-helpers.ts` (line 287, 342, 344) — H9 hint text; remove async enableToolByName
- `src/search/tool-ranker.ts` (line 70–71) — W_SEMANTIC weight; question-word bonus in rankTools
- `src/storage/usage-tracker.ts` — UsageEntry interface + win_loss tracking in recordToolCall
- `rules/codesift.md`, `rules/codesift.mdc`, `rules/codex.md`, `rules/gemini.md` — agent-facing tool mapping

Dependency direction: `plan-turn-tools.ts → register-tools.ts → tool-ranker.ts`. No circular risk. `usage-tracker.ts` is leaf.

## Technical Decisions

1. **Stable permanent alias for `semantic_search`** — handler delegates to `codebase_retrieval(queries:[{type:"semantic", ...}])` + emits a soft "prefer codebase_retrieval(type:\"semantic\")" notice. **No removal date; alias is permanent.** Wording in user-visible response and tool description must NOT threaten future removal.
2. **W_SEMANTIC 0.8 → 1.2; +0.3 question-word bonus** — when parsed intents include {how, what, why, design, pattern, flow}, boost semantic-capable tools' final score. Target: semantic in plan_turn top-3 ≥ 60% of question queries.
3. **Remove async enableToolByName from H9 path** — replace with routing-advice hint pointing at `codebase_retrieval` (already in CORE_TOOL_NAMES). Eliminates race.
4. **In-session win/loss telemetry** — extend `UsageEntry` with optional `win_loss?: "win" | "loss" | null`. Win = SEARCH_TOOL_SET tool with `result_chunks > 0`. Loss = chunks=0 not error. Reuses existing `SEARCH_TOOL_SET` from session-state.ts.
5. **Selective embedding cost** — `plan_turn` requests queryEmbedding only when question-word intent detected OR `CODESIFT_ALWAYS_EMBED=true` env var set. Graceful BM25-only fallback. Implemented in **Task 6** (planTurn handler + env-flag gating).
6. **Forward-compatible JSONL** — `win_loss` field is optional; old log entries parse unchanged.

## Quality Strategy

- 3 new/modified test files (~180 lines new test code)
- 100% line coverage on new logic paths (deprecation, question-word bonus, win_loss tracker)
- Branch coverage on null-safe embedding path + SEARCH_TOOL_SET membership
- Integration smoke test proves end-to-end: question-word query → plan_turn → top-3 includes codebase_retrieval → invocation records win_loss

CQ pre-check: PASS for all proposed changes (rankTools stays under 150 lines, file size limits OK, public API additive, no PII risk in win_loss enum).

## Coverage Matrix

| Row ID | Authority item | Type | Primary task(s) | Notes |
|--------|----------------|------|-----------------|-------|
| AC1 | Deprecation warning on `semantic_search` invocation | requirement | Task 4 | Soft deprecation via response hint |
| AC2 | H9 hint text mentions `codebase_retrieval(type:semantic)` | requirement | Task 1 | Routing advice, not tool reveal |
| AC3 | `enableToolByName("semantic_search")` removed from server-helpers H9 path | requirement | Task 1 | Eliminates async race |
| AC4 | W_SEMANTIC = 1.2 (was 0.8) | requirement | Task 2 | Constant in tool-ranker.ts |
| AC5 | Question-word query bonus +0.3 in rankTools | requirement | Task 2 | Triggers on {how, what, why, design, pattern, flow} |
| AC6 | `win_loss?: "win" \| "loss" \| null` field on UsageEntry | requirement | Task 3 | Optional, backwards-compatible |
| AC7 | Win-loss recording: chunks>0→win, chunks=0 (no error)→loss | requirement | Task 3 | Reuses SEARCH_TOOL_SET |
| AC8 | End-to-end smoke: question query → codebase_retrieval in top-3 → win_loss recorded | requirement | Task 7 | Whole-feature proof |
| AC9 | `plan_turn` skips queryEmbedding for non-question, non-flag queries; uses BM25-only fallback | requirement | Task 6 | Implements TD5 |
| AC10 | `CODESIFT_ALWAYS_EMBED=true` forces embedding even for non-question queries | requirement | Task 6 | Env-flag override |
| G1 | Out-of-scope: local embeddings | constraint | (all) | No tasks may add Xenova/Nomic ONNX |
| G2 | Backwards compatibility: existing `semantic_search` callers must not break | constraint | Task 4 | Permanent alias, no removal threat |
| G3 | Forward-compat JSONL: old entries without `win_loss` must parse | constraint | Task 3 | Optional field |

## Review Trail (final)

- Plan reviewer: revision 1 → APPROVED (10/10 checklist pass)
- Cross-model validation: revision 1 → ISSUES FOUND (2 CRITICAL, 4 WARNING, 1 INFO).
  - CRITICAL-A: TD5 (selective embedding) had no implementing task — **fixed** by adding Task 6 (plan_turn embedding gating); smoke renumbered to Task 7
  - CRITICAL-B: TD1 ("forever alias") contradicted Task 4 sample warning ("will be removed") — **fixed** by removing removal language; alias is permanent
  - WARNING-A (risk concentration): smoke deferred to last task — **mitigated** by adding minimal sub-spike step in Task 7 (run plan_turn → recommendations check before full smoke)
  - WARNING-B (hidden ordering): Task 5 modifies `src/instructions.ts` while Task 1 changes H9 strings — **fixed** by adding `Task 1` dependency on Task 5
  - WARNING-C (Task 5 scope): docs-only label but modifies production `src/instructions.ts` — **fixed** by extending RED test to assert canonical phrasing inside `src/instructions.ts`
  - WARNING-D (Task 7 spike): no feasibility prototype — **mitigated** by Task 7 sub-spike step
  - INFO (Task 5 breadth across 5 paths): noted; left as-is — paths are tightly coupled and a single sync checkpoint is preferable to splitting
- Plan reviewer: revision 2 → APPROVED (all 7 revision-2 fixes verified; 10/10 checklist pass)
- Cross-model validation: revision 2 → ISSUES FOUND (0 CRITICAL, 3 WARNING, 2 INFO).
  - WARNING-E (Task 1 verify grep semantics): grep with no matches returns exit 1; under `set -e` chains this would fail. **Fixed in rev 3** — Task 1 Verify and AC3 Proof now use `! grep` form so exit-code semantics are explicit and `set -e`-safe.
  - WARNING-F (Task 5 multi-boundary scope): 5 paths spanning rules + production `instructions.ts` is wider than other "standard" tasks. **Acknowledged, not split.** Reason: the canonical-phrase invariant is shared across all 5 files and a single sync checkpoint (with the rules-content vitest as the binding contract) is preferable to splitting and risking partial completion. Task 5 scope is intentional. Note recorded.
  - WARNING-G (Task 7 risk concentration): integration smoke still runs after upstream merges; spike sub-test runs after Tasks 1–6 land. **Acknowledged, partially mitigated.** Mitigation in rev 2: fail-fast spike inside Task 7. Full elimination would require a stack/merge-train restructuring (e.g. integration branch enforced before merge to main) which is an execution-policy concern outside plan-document scope. Note recorded; `zuvo:execute` should treat Task 7 as a gating step.
  - INFO-A (Task 6 dep on Task 2 rationale): ranker already null-safe per Architect report (line 42-43); dep is light-coupling for ordering predictability. Ignored per fix policy.
  - INFO-B (no operational validation task for win_loss telemetry): out of plan scope; covered by separate observability workstream. Ignored per fix policy.
- Plan reviewer: revision 3 → APPROVED ("Plan converged — ready for status: Reviewed")
- Status gate: Draft → **Reviewed** (awaiting user approval to move to Approved)

## Task Breakdown

### Task 1: Replace H9 async tool-reveal with routing-advice hint
**Files:** `src/server-helpers.ts`, `tests/tools/response-hints.test.ts`
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: In `tests/tools/response-hints.test.ts`, add test `"H9 emits routing hint for codebase_retrieval(type:semantic) and does NOT call enableToolByName"`. Use a question-word query through `buildResponseHint`. Assert hint string includes `"codebase_retrieval(type:semantic)"` and a spy on `enableToolByName` is NOT called.
- [ ] GREEN: In `src/server-helpers.ts` around lines 287/342/344:
  - Update H9 description comment to reflect routing advice
  - Replace `hints.push(\`⚡H9\`)` with `hints.push(\`H9: question-word query — codebase_retrieval(type:semantic)\`)`
  - Delete the dynamic `import("./register-tools.js").then(m => m.enableToolByName("semantic_search"))` line entirely
  - Maintain QUESTION_PATTERN match logic unchanged
- [ ] Verify: `npx vitest run tests/tools/response-hints.test.ts && ! grep -n "enableToolByName" src/server-helpers.ts`
  Expected: vitest green AND grep finds zero matches (the `!` inverts grep's exit so the compound exits 0 under `set -e`).
- [ ] Acceptance Proof:
  - AC2:
    - Surface: api
    - Proof: `grep -n "codebase_retrieval(type:semantic)" src/server-helpers.ts && grep -n "H9: question-word" src/server-helpers.ts`
    - Expected: both grep commands return at least one match each (exit 0)
    - Artifact: `.zuvo/proofs/task-1-AC2.txt`
  - AC3:
    - Surface: backend-logic
    - Proof: `! grep -n "enableToolByName" src/server-helpers.ts`
    - Expected: command exits 0 (i.e. grep found zero matches; `!` inverts) — no remaining async tool-reveal. Compatible with `set -e`.
    - Artifact: `.zuvo/proofs/task-1-AC3.txt`
- [ ] Commit: `fix(hints): H9 emits routing advice for codebase_retrieval(type:semantic), drop async tool-reveal race`

### Task 2: Boost W_SEMANTIC + add question-word bonus in rankTools
**Files:** `src/search/tool-ranker.ts`, `tests/search/tool-ranker.test.ts`
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: In `tests/search/tool-ranker.test.ts`, add suite `"H-C question-word bonus"`:
  - Test 1: query `"how does authentication work"` → semantic-capable tool (e.g. `codebase_retrieval`) score includes +0.3 bonus
  - Test 2: query `"getUserById"` (non-question-word) → no bonus applied
  - Test 3: with embeddings `null`, ranker still returns deterministic ordering (graceful degrade)
  - Use synthetic embeddings (Float32Array fixtures) to make scoring deterministic
- [ ] GREEN: In `src/search/tool-ranker.ts`:
  - Line 70: change `const W_SEMANTIC = 0.8;` → `const W_SEMANTIC = 1.2;`
  - In `rankTools()` function: after computing base score, detect question-word intents (regex: `/\b(how|what|why|design|pattern|flow)\b/i`) and add `+0.3` to tools whose `category === "search"` AND `searchHint` contains `"semantic"` or whose name is `codebase_retrieval`. Keep existing null-safe embedding handling.
  - Add inline comment explaining the bonus rationale (one line)
- [ ] Verify: `npx vitest run tests/search/tool-ranker.test.ts`
  Expected: all suites green; new "H-C question-word bonus" tests pass.
- [ ] Acceptance Proof:
  - AC4:
    - Surface: backend-logic
    - Proof: `grep -n "const W_SEMANTIC" src/search/tool-ranker.ts`
    - Expected: returns line containing `1.2`
    - Artifact: `.zuvo/proofs/task-2-AC4.txt`
  - AC5:
    - Surface: backend-logic
    - Proof: `npx vitest run tests/search/tool-ranker.test.ts -t "question-word bonus"`
    - Expected: test passes; assertion that question-word query produces score-delta of approximately +0.3 vs non-question-word baseline
    - Artifact: `.zuvo/proofs/task-2-AC5.txt`
- [ ] Commit: `feat(ranker): boost W_SEMANTIC to 1.2 and apply +0.3 bonus for question-word queries`

### Task 3: Add win_loss field to UsageEntry + recordToolCall logic
**Files:** `src/storage/usage-tracker.ts`, `tests/storage/usage-tracker.test.ts`
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: In `tests/storage/usage-tracker.test.ts`, add suite `"win-loss tracking"`:
  - Test 1: call recorder with `tool="codebase_retrieval"`, `result_chunks=5`, no error → JSONL line includes `"win_loss":"win"`
  - Test 2: call with `tool="search_text"`, `result_chunks=0`, no error → `"win_loss":"loss"`
  - Test 3: call with `tool="get_file_outline"` (not in SEARCH_TOOL_SET), chunks=0 → `win_loss` is `null` or absent
  - Test 4: existing log line without `win_loss` field still parses (forward-compat)
- [ ] GREEN: In `src/storage/usage-tracker.ts`:
  - Extend `UsageEntry` interface with `win_loss?: "win" | "loss" | null;`
  - Import `SEARCH_TOOL_SET` from `src/storage/session-state.ts` (or reuse existing import)
  - In `recordToolCall()`: compute `win_loss` value before JSONL write — `"win"` if SEARCH_TOOL_SET has tool AND result_chunks > 0 AND no error; `"loss"` if SEARCH_TOOL_SET has tool AND result_chunks === 0 AND no error; otherwise `null`
  - Set field on entry only when SEARCH_TOOL_SET membership applies (avoid bloating non-search entries)
- [ ] Verify: `npx vitest run tests/storage/usage-tracker.test.ts -t "win-loss"`
  Expected: green; all 4 cases pass.
- [ ] Acceptance Proof:
  - AC6:
    - Surface: backend-logic
    - Proof: `grep -A 12 "interface UsageEntry" src/storage/usage-tracker.ts`
    - Expected: output includes `win_loss?: "win" | "loss" | null;`
    - Artifact: `.zuvo/proofs/task-3-AC6.txt`
  - AC7:
    - Surface: integration
    - Proof: `npx vitest run tests/storage/usage-tracker.test.ts -t "win-loss tracking"`
    - Expected: 4 cases pass; JSONL output asserted to contain `"win_loss":"win"` and `"win_loss":"loss"` for the respective fixtures
    - Artifact: `.zuvo/proofs/task-3-AC7.txt`
- [ ] Commit: `feat(telemetry): record win_loss on search-tool calls in usage.jsonl`

### Task 4: Deprecate semantic_search as alias to codebase_retrieval(type:"semantic")
**Files:** `src/tools/search-tools.ts`, `src/register-tools.ts`, `tests/tools/semantic-search-deprecation.test.ts` (new)
**Surface:** api
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: Create `tests/tools/semantic-search-deprecation.test.ts` (file name retained for clarity, test asserts permanent-alias semantics):
  - Test 1: invoking `semanticSearch(repo, "find auth")` returns response whose first non-data field includes a `prefer codebase_retrieval` substring (case-insensitive) AND does NOT contain `will be removed` or `deprecat` removal-language
  - Test 2: invoking `semanticSearch` with same query as `codebase_retrieval(queries:[{type:"semantic", query:"find auth"}])` produces equivalent semantic results (mock `handleSemanticQuery` and assert it is called once with the right args from EITHER entry point)
  - Test 3: tool description in `register-tools.ts` for semantic_search starts with the literal `"ALIAS: prefer codebase_retrieval"`
- [ ] GREEN:
  - In `src/tools/search-tools.ts` lines 686–706: change `semanticSearch()` to delegate by calling `codebaseRetrieval(repo, [{type:"semantic", query, ...options}], token_budget)` and prepend a permanent-alias notice to the returned message (e.g. `"NOTICE: semantic_search is a stable alias — prefer codebase_retrieval(queries=[{type:'semantic', ...}]).\n\n" + delegated`). Do NOT include "will be removed" or any removal-date language.
  - In `src/register-tools.ts` line 1275: update tool description prefix to `"ALIAS: prefer codebase_retrieval(queries=[{type:\"semantic\", query:\"...\"}]). This tool is a permanent stable alias and delegates internally."`
  - Do NOT add semantic_search to CORE_TOOL_NAMES (stays hidden; alias path)
- [ ] Verify: `npx vitest run tests/tools/semantic-search-deprecation.test.ts`
  Expected: green; all 3 cases pass.
- [ ] Acceptance Proof:
  - AC1:
    - Surface: api
    - Proof: `npx vitest run tests/tools/semantic-search-deprecation.test.ts -t "alias notice"`
    - Expected: passes; semantic_search response includes "prefer codebase_retrieval" substring AND does NOT contain "will be removed"
    - Artifact: `.zuvo/proofs/task-4-AC1.txt`
  - G2:
    - Surface: api
    - Proof: same test file Test 2 — assert `handleSemanticQuery` invoked from the codebase_retrieval delegation path with same args
    - Expected: assertion on shared semantic invocation passes — alias is backwards-compatible permanent delegation
    - Artifact: `.zuvo/proofs/task-4-G2.txt`
- [ ] Commit: `refactor(tools): semantic_search becomes permanent alias delegating to codebase_retrieval(type:"semantic")`

### Task 5: Sync rules files + instructions to canonical codebase_retrieval(type:"semantic")
**Files:** `rules/codesift.md`, `rules/codesift.mdc`, `rules/codex.md`, `rules/gemini.md`, `src/instructions.ts`, `tests/rules-content.test.ts` (new or extended)
**Surface:** docs (rules) + config (src/instructions.ts)
**Complexity:** standard
**Dependencies:** Task 1 (H9 hint text in server-helpers.ts must land first so instructions.ts H9 wording can mirror it canonically)
**Execution routing:** default implementation tier

- [ ] RED: Add a static-grep assertion vitest in `tests/rules-content.test.ts` (extend if exists, create if not):
  - Test 1: for each file in `["rules/codesift.md","rules/codesift.mdc","rules/codex.md","rules/gemini.md","src/instructions.ts"]`, assert content does NOT include the literal phrase `"semantic_search **or** codebase_retrieval"` (the dual-path wording) and does NOT include the standalone phrase `"call semantic_search"` outside of explicit alias-context strings
  - Test 2: each file in the same list mentions `codebase_retrieval(type:"semantic")` at least once
  - Test 3: `src/instructions.ts` H9 description string matches the canonical phrase emitted from `src/server-helpers.ts` (exact substring `"H9: question-word query — codebase_retrieval(type:semantic)"`) — couples instructions to runtime hint
- [ ] GREEN: In each rules file, replace any `"semantic_search **or** codebase_retrieval(type:\"semantic\")"` (and minor variants) with `"codebase_retrieval(type:\"semantic\")"`. Replace the table row "concept question | `semantic_search`" with "concept question | `codebase_retrieval(queries:[{type:\"semantic\",...}])`". In `src/instructions.ts`, ensure CODESIFT_INSTRUCTIONS references only `codebase_retrieval(type:"semantic")` and that H9 description string is byte-equal to the runtime hint set by Task 1.
- [ ] Verify: `npx vitest run tests/rules-content.test.ts && ! grep -l "semantic_search \\*\\*or\\*\\*" rules/*.md* src/instructions.ts`
  Expected: vitest green; grep returns no matching files.
- [ ] Acceptance Proof:
  - G1 (covered here since rules + instructions govern adoption messaging):
    - Surface: docs
    - Proof: `for f in rules/codesift.md rules/codesift.mdc rules/codex.md rules/gemini.md src/instructions.ts; do grep -q 'codebase_retrieval(type:"semantic")' "$f" || { echo "MISSING in $f"; exit 1; }; done; ! grep -lE "semantic_search \\*\\*or\\*\\*" rules/*.md* src/instructions.ts`
    - Expected: every file (rules + instructions.ts) contains the canonical phrase; no file contains the dual "or" phrasing (exit 0)
    - Artifact: `.zuvo/proofs/task-5-rules-sync.txt`
  - WARNING-B-fix (instructions ↔ runtime sync proof):
    - Surface: config
    - Proof: `npx vitest run tests/rules-content.test.ts -t "instructions H9 matches runtime hint"`
    - Expected: passes — `src/instructions.ts` H9 string is byte-equal to the hint emitted from `src/server-helpers.ts`
    - Artifact: `.zuvo/proofs/task-5-instructions-sync.txt`
- [ ] Commit: `docs(rules): canonical codebase_retrieval(type:"semantic") path; sync instructions.ts to server-helpers H9 hint`

### Task 6: Selective queryEmbedding in planTurn handler + env-flag gating
**Files:** `src/tools/plan-turn-tools.ts`, `tests/tools/plan-turn-tools.test.ts`
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** Task 2 (ranker accepts queryEmbedding nullable; we only change the caller side)
**Execution routing:** default implementation tier

- [ ] RED: In `tests/tools/plan-turn-tools.test.ts`, add suite `"H-D selective embedding"`:
  - Test 1: `planTurn(repo, "getUserById usage")` (non-question-word, no env flag) — spy on the embedding-provider call; assert it is NOT invoked. Recommendations still returned via BM25-only ranking.
  - Test 2: `planTurn(repo, "how does authentication work")` (question-word) — spy on embedding-provider; assert it IS invoked exactly once.
  - Test 3: with `process.env.CODESIFT_ALWAYS_EMBED = "true"`, `planTurn(repo, "getUserById usage")` — spy asserts embedding IS invoked even for non-question query.
  - Test 4: when embedding provider throws / returns null, planTurn still returns recommendations (BM25 fallback) — no thrown error.
- [ ] GREEN: In `src/tools/plan-turn-tools.ts`, in the planTurn handler before invoking ranker:
  - Compute `shouldEmbed` = (parsed intents include any of {how, what, why, design, pattern, flow}) OR `process.env.CODESIFT_ALWAYS_EMBED === "true"`
  - If `shouldEmbed`, request `queryEmbedding` from the configured provider; otherwise pass `null` to `rankTools`
  - On embedding-provider error or null result, log at DEBUG level and pass `null` (graceful BM25 fallback). Do NOT throw.
  - Add inline comment naming the env-var override and the question-word predicate.
- [ ] Verify: `npx vitest run tests/tools/plan-turn-tools.test.ts -t "selective embedding"`
  Expected: all 4 cases green; spy assertions confirm the gating logic.
- [ ] Acceptance Proof:
  - AC9:
    - Surface: backend-logic
    - Proof: `npx vitest run tests/tools/plan-turn-tools.test.ts -t "selective embedding"`
    - Expected: Test 1 + Test 4 green — non-question query skips embedding; provider failure does not break planTurn
    - Artifact: `.zuvo/proofs/task-6-AC9.txt`
  - AC10:
    - Surface: config
    - Proof: same suite — Test 3 asserts `CODESIFT_ALWAYS_EMBED=true` forces embedding
    - Expected: passes — env override path covered
    - Artifact: `.zuvo/proofs/task-6-AC10.txt`
- [ ] Commit: `feat(plan_turn): selective queryEmbedding via question-word intent + CODESIFT_ALWAYS_EMBED env override`

### Task 7: Whole-feature smoke integration test
**Files:** `tests/integration/semantic-adoption-smoke.test.ts` (new)
**Surface:** integration
**Complexity:** complex
**Dependencies:** Task 1, Task 2, Task 3, Task 4, Task 5, Task 6
**Execution routing:** deep implementation tier

- [ ] RED: Create `tests/integration/semantic-adoption-smoke.test.ts`:
  - Suite `"semantic adoption smoke"`
  - Setup: index a small fixture repo (under `tests/fixtures/semantic-smoke/`), inject deterministic embedding stub, point usage-tracker at temp jsonl
  - **Spike (run first; fail-fast):** Sub-test `"feasibility — planTurn returns recommendations"` invokes `planTurn(fixtureRepo, "how does semantic search work")` and asserts the response shape has a non-empty `recommendations` (or equivalent) list. This spike MUST pass before downstream sub-tests run; if it fails the smoke aborts early so Tasks 1–6 can be re-checked without burning the full suite.
  - Test 1: same `planTurn` call — assert top-3 recommended tools include `codebase_retrieval`
  - Test 2: invoke `codebaseRetrieval(fixtureRepo, [{type:"semantic", query:"semantic similarity"}])`; read temp usage.jsonl and assert most recent entry for that tool has `win_loss` set to `"win"` or `"loss"` (not absent)
  - Test 3: invoke alias `semanticSearch` directly; assert response contains the canonical alias notice (`"prefer codebase_retrieval"`) AND that internal `handleSemanticQuery` is invoked (mocked or spied)
  - Test 4: with `CODESIFT_ALWAYS_EMBED` unset and a non-question query (`"foo helper usage"`), assert no embedding-provider call (guards Task 6 wiring through the integration layer)
- [ ] GREEN: No new production code — this task asserts composition of Tasks 1–6. If a smoke test fails (e.g. ranker bonus not surfacing in `recommendations`, or selective embedding bypass not honored end-to-end), fix in the upstream task and re-run.
- [ ] Verify: `npx vitest run tests/integration/semantic-adoption-smoke.test.ts`
  Expected: spike + 4 cases green.
- [ ] Acceptance Proof:
  - AC8:
    - Surface: integration
    - Proof: `npx vitest run tests/integration/semantic-adoption-smoke.test.ts`
    - Expected: spike + Test 1–4 green — recommendations include codebase_retrieval, win_loss recorded, alias path delegates, embedding gating respected
    - Artifact: `.zuvo/proofs/task-7-AC8.txt`
- [ ] Commit: `test(integration): semantic adoption smoke — plan_turn + ranker + tracker + alias end-to-end`

## Whole-feature Smoke Proofs

- **SMOKE1 — Question-word query → semantic recommendation → invocation telemetry → alias delegation → embedding gating**
  - Preconditions: fixture repo indexed under `tests/fixtures/semantic-smoke/`; deterministic embedding stub registered; usage-tracker pointed at temp jsonl; `CODESIFT_ALWAYS_EMBED` unset
  - Proof: run Task 7 vitest suite (`tests/integration/semantic-adoption-smoke.test.ts`)
  - Expected: (spike) planTurn returns non-empty recommendations; (a) top-3 includes `codebase_retrieval` for question-word query; (b) codebase_retrieval `type:"semantic"` invocation writes a usage.jsonl entry with `win_loss` ∈ {"win","loss"}; (c) alias `semanticSearch` returns `"prefer codebase_retrieval"` notice AND invokes the same semantic handler; (d) non-question-word query through planTurn does NOT invoke embedding provider (Task 6 gating verified end-to-end)
  - Artifact: `.zuvo/proofs/smoke-semantic-adoption.txt`

<!-- duplicate Review Trail removed; canonical entries live under the section above near the Coverage Matrix -->

