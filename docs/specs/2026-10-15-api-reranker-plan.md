# Implementation Plan: API reranker for CodeSift (no local models)

**Spec:** inline — no spec (brief from the zuvo-plugin reranker campaign, 2026-10-15)
**spec_id:** none
**planning_mode:** inline
**source_of_truth:** inline brief
**plan_revision:** 5
**status:** Reviewed
**Created:** 2026-10-15
**Tasks:** 10
**Estimated complexity:** 3 standard, 7 complex

> **Execution note.** Run from a worktree off `origin/main` (`zuvo:worktree`); the shared checkout
> carries other agents' uncommitted files. Tests run on the farm: `rt --light <cmd>`.
> **Out of scope (owner's decision):** `~/Library/LaunchAgents/com.codesift.daemon.plist` and
> `com.greglas.codesift-ollama.plist` (`CODESIFT_EMBEDDING_PROVIDER=ollama`). Turning `rerank` on by
> default for `search_symbols` / `assemble_context` is also the owner's call — it stays opt-in.
> `tsconfig.json` excludes `tests/` and `scripts/`: `tsc --noEmit` proves nothing about test fixtures
> or the bench script — vitest is the check there.

## Architecture Summary

Measured on 2026-10-15 (30 plain-English tasks × 180 tool descriptions, gold
`tests/fixtures/tool-routing/gold.json` after Task 5): `discover_tools` MRR 0.53, `rankTools`
keyword scoring 0.75, API rerank (`voyageai/rerank-2.5-lite`) 0.90. The owner forbids local models,
yet `src/search/reranker.ts` runs a local transformers.js cross-encoder, and the Mac's semantic
search is dead (Ollama removed, `semantic_search` averages 74 s, cause not yet located — Ollama
refuses the connection in 0.3 ms).

Components:
- **`src/search/rerank-api.ts` (new, leaf):** provider/key resolution, OpenRouter `/api/v1/rerank`
  POST, shape guard, circuit breaker per error class, LRU cache, sliding-window budget. Returns
  `number[] | null`; `null` always means "keep the input order".
- **`src/search/reranker.ts`:** public signatures unchanged; private `scoreCandidates` dispatches to
  `off | openrouter | local`.
- **Tool ranking:** `discoverTools` → `rankDiscoverCandidates` (sync: `rankTools` with a `limit`, a
  recall guard, pool fill to 40) → `rerankToolCandidates` (async API stage). `plan_turn` reranks once,
  after merging intents.
- **Semantic path:** `loadSemanticContext` checks for vectors and provider reachability BEFORE
  embedding; with no usable vectors it takes `semantic-lexical.ts` (BM25 top-50 → rerank).

Dependency direction: tools → reranker / tool-rerank / semantic-lexical → rerank-api (leaf, only
`node:*` + global `fetch`). No cycles.

## Technical Decisions

- **The endpoint contract is already proven live** (2026-10-15 campaign: ~1 200 real calls through
  OpenRouter `POST /api/v1/rerank` for `voyageai/rerank-2.5`, `-2.5-lite`, `rerank-3`, `-3-lite`,
  `cohere/rerank-4-pro|4-fast|v3.5`, `qwen/qwen3-reranker-8b`,
  `nvidia/llama-nemotron-rerank-vl-1b-v2:free`). Response:
  `{"model":…, "results":[{"index":0,"relevance_score":0.55,"document":{…}}], "usage":{"total_tokens":161,"cost":3.2e-05}}`
  — Cohere returns `usage.search_units` + `cost`; `results` come sorted by score. No pre-implementation
  spike is needed; SMOKE2 re-checks it after build.
- **Vector-free baseline is BM25 order.** "Fail-open keeps the input order" means the order of the
  stage before the reranker. For vector-free semantic/hybrid queries that stage is BM25 (labelled
  `ranking: "bm25"`), not today's failing vector path.

- **Provider default:** `CODESIFT_RERANK_PROVIDER` explicit wins; else `openrouter` when a key is
  found (`OPENROUTER_API_KEY`, then `~/.zuvo/openrouter.key`, trimmed); else `off`. `local`
  (transformers.js) only when set explicitly. Model `CODESIFT_RERANK_MODEL`, default
  `voyageai/rerank-2.5-lite`.
- **Remove the dead semantic tool signal.** `queryEmbedding` is hard-coded `null`
  (`src/tools/plan-turn/orchestrator.ts:214`), so the 0.8 × 0 term is always zero; yet
  `getToolEmbeddings` runs on every `plan_turn`. Delete it (score-neutral, proven by a before/after
  dump), replace `metadata.embedding_available` with `rerank: "applied" | "skipped"` +
  `rerank_reason?`.
- **`rankTools` gets `limit?: number`** (default 10). `discoverTools` asks for 40, then fills the pool
  to 40 from the legacy keyword scorer and the remaining tools (the 0.90 was measured over all
  tools; `rankTools` top-10 misses the gold tool on 4/30 tasks), reranks, returns 15.
- **Tool doc text is byte-identical to the measurement:**
  `` `${name} (${category ?? ""}): ${description} ${searchHint ?? ""}`.slice(0, 600) ``.
- **`plan_turn`:** one rerank call per `plan_turn` (never per intent), 2.5 s timeout, skipped when
  the query is an exact tool identity. `confidence` stays the lexical confidence (documented and
  pinned by a test); only the order changes.
- **Fail-open everywhere:** off / no key / `local` without the package / timeout / open circuit /
  budget → input order, plus a `rerank_reason`.
- **Circuit per error class:** timeout, network, 5xx, 429 → 60 s (429 honours `Retry-After`, ≤10 min);
  401/402/403 → 30 min, one stderr line naming the class; 400 or bad shape → that call only.
- **Cost guards (the daemon is shared and long-lived):** LRU 256 keyed by sha1(model, query, docs);
  daily USD budget `CODESIFT_RERANK_DAILY_USD` (default 1.00) from `usage.cost`; fallback
  `CODESIFT_RERANK_MAX_CALLS_PER_HOUR` (600); budget slot reserved before the `await`; ≤8 reranks per
  `codebase_retrieval` batch (`src/retrieval/codebase-retrieval.ts`); the `zero-hit.ts:91` embeddings-exist gate stays and is pinned by a test.
- **Timeouts:** tool rerank 2 500 ms; chunk/symbol rerank 5 000 ms; Ollama probe `GET /api/version`
  1 500 ms with a 60 s negative cache; `semantic_search` wall clock 20 s via `raceWallClock` (which
  discards, not cancels, in-flight work — the inner fetch is bounded by its own 5 s timeout). All
  injectable for tests (fake timers do not drive `AbortSignal.timeout`): `CODESIFT_RERANK_TIMEOUT_MS`
  overrides both rerank timeouts.
- **Telemetry path:** `rerank-api.ts` records `{provider, ms, cached, cost, outcome}` on the
  per-request context (`src/server-helpers/request-context.ts`, AsyncLocalStorage); the tool-call
  tracker (`src/server-helpers.ts:329/383/388` → `trackToolCall` in `src/storage/usage-tracker.ts:541`)
  copies it into `UsageEntry` via `extra`.
- **Secrets / egress:** the key never reaches stderr, MCP output, usage.jsonl or error text; error
  bodies to stderr only (SEC-004 pattern from `fetchEmbeddings`). README states that queries and code
  snippets go to OpenRouter when a key is present.
- **Reuse:** `fetchEmbeddings`/`isEmbeddingResponse` (`semantic.ts:184-233`) as the HTTP template;
  `buildCandidateText` (`reranker.ts:144`); `getBM25Index` + `searchBM25Async` as in
  `context-tools.ts:57-68`; `formatSemanticResults` (`semantic-handlers.ts:15`); `raceWallClock`;
  `parseIntEnv`; `localEmbeddingRemedy` (extend, don't duplicate); `calibrationCap`/`toRecommendation`.

File structure (300-line convention; `discovery.ts` 430, `semantic-handlers.ts` 417 and
`plan-turn/orchestrator.ts` 392 are already over it — new logic goes into new files, those three
only shrink or gain a branch):

| Path | New/Mod | Est. LOC |
|---|---|---|
| `src/search/rerank-api.ts` | new | ~200 |
| `src/search/rerank-budget.ts` | new (split out if rerank-api > 220) | ~80 |
| `src/search/tool-rerank.ts` | new | ~70 |
| `src/register-tools/discovery-ranking.ts` | new | ~90 |
| `src/retrieval/semantic-lexical.ts` | new | ~100 |
| `src/search/provider-reachability.ts` | new | ~50 |
| `scripts/bench-tool-routing.ts` | new (not in CI) | ~120 |
| `src/search/tool-embedding-cache.ts`, `tool-embedding-storage.ts` | delete | — |

## Quality Strategy

- **Tests never call the paid API.** The owner's Mac holds `~/.zuvo/openrouter.key`; with the new
  default every suite reaching `discoverTools`/`plan_turn`/`semantic_search` would spend money and
  diverge from the farm (no key). `vitest.config.ts` `env` gets `CODESIFT_RERANK_PROVIDER: "off"`;
  key lookup takes injectable `{env, homeDir}`; fetch is mocked once per file with a URL router.
- **Module state resets:** `_resetRerankApi()` (circuit, LRU, budget windows, warn-once) and the probe
  cache reset run in every new file's `beforeEach`; budget windows take an injectable `now()`.
- **CQ gates:** CQ3 (response shape + env values), CQ5 (key never logged; egress documented), CQ6
  (≤50 docs, 600-char tool docs, LRU 256, batch cap 8), CQ8 (fail-open, timeouts, circuit),
  CQ14 (no second HTTP client, no second remedy string, `rankTools` not reimplemented), CQ16 (USD
  budget, reserve before await), CQ19 (`plan_turn` metadata, `discover_tools` async, `semantic_search`
  `ranking` field), CQ21 (shared daemon state: budget race test), CQ22 (timers cleared/unref'd).
- **Existing tests that change:** `reranker.test.ts` (pin `local`), `discover-tools.test.ts`
  (`await`, assertions kept as regression checks), `tool-ranker.test.ts` (delete ~:195-212 and
  :402-503 with the code), `plan-turn.test.ts` (mock + metadata), `register-tools-lazy-loading.test.ts:85`
  (fixture shape), `semantic-chunk-coverage.test.ts` (route fetch by URL, reset probe cache),
  `zero-hit-fallback.test.ts` (gate pin), `install-check.test.ts:46-62` (wording).
  `search-tools-characterization.test.ts:11` must stay unchanged (export names fixed).
- **Not tested (test-scope.md):** schema description text, one test per env var, output snapshots,
  assertions that only echo the mocked fetch.

## Coverage Matrix

| Row ID | Authority item | Type | Primary task(s) | Notes |
|---|---|---|---|---|
| G1 | Reranker API backend with `CODESIFT_RERANK_PROVIDER=openrouter\|local\|off`, default openrouter-if-key-else-off | requirement | Task 2, Task 3 | |
| G2 | `discover_tools` ranked through `rankTools` (free step, MRR ≥0.75) | requirement | Task 5 | |
| G3 | API rerank of the tool pool in `discover_tools` and `plan_turn` (MRR ≈0.90) | requirement | Task 6 | bench confirms |
| G4 | Decide the dead `queryEmbedding` path | requirement | Task 4 | removed |
| G5 | Fail fast instead of 74 s when the embedding provider is unreachable | requirement | Task 1, Task 7, Task 8 | Task 1 locates the cause; Task 8 adds the wall-clock cap |
| G6 | Vector-free semantic/hybrid path: BM25 top-50 → API rerank | requirement | Task 8 | |
| C1 | No local models by default; transformers.js only on explicit `local` | constraint | Task 3 | |
| C2 | Fail-open: any failure keeps today's order | constraint | Task 2, Task 3, Task 6, Task 8 | |
| C3 | Tests never touch the network or the owner's key | constraint | Task 2 | vitest env default |
| C4 | Cost bounded in the shared daemon | constraint | Task 2, Task 6, Task 8 | budget, LRU, per-call/batch caps, zero-hit pin |
| C5 | API key never logged; data egress documented | constraint | Task 2, Task 9, Task 10 | |
| C6 | Daemon plist untouched (owner's decision) | constraint | Task 10 | documented only |
| C7 | `rerank` stays opt-in per call for `search_symbols` / `assemble_context` | constraint | Task 3 | owner decides any default change |
| C8 | Rerank spend visible per call | requirement | Task 9 | usage.jsonl `rerank` object |

## Review Trail
- Phase 1: Architect → Tech Lead → QA Engineer (full fan-out, sequential)
- Plan reviewer: revision 2 -> ISSUES FOUND (2: Task 4 dump script outside the worktree could diff
  unchanged code — moved to `zuvo/proofs/`; Task 9 test bypassed the wrapTool wiring — now driven
  through `wrapTool`) → applied in revision 3
- Plan reviewer: revision 1 -> ISSUES FOUND (6 HIGH, 6 MEDIUM, 3 LOW: wrong codebase-retrieval path;
  unnamed usage logger + oversized Task 9 → split into 9/10; bench output format unpinned; identity
  skip had no input; rerank env vars never parsed; missing deps 5→2, 6→4, 9→2/5, 7↛3; Task 4 dump not
  runnable + orphan tool-embedding-storage.ts; Task 7 test/GREEN contradiction + abort claim; Task 1
  verdict format; SMOKE2 unallocated; API bench needs key; vitest default unproven; C7 missing) →
  all applied in revision 2
- Cross-model validation (rev 3): partial (3/5 providers: agy, codex-5.3, claude; openrouter-3 and qwen
  timed out), 17 findings; after triage 0 CRITICAL open:
  - fixed: gold fixture from /tmp (now committed beside the plan); Task 1 verdict brittleness and no
    re-plan branch (no-dominant-stage verdict, REPLAN decision, sum check); `usage.cost` absent (call-cap
    test); vector-free fail-open baseline undefined (BM25 stated); embed-gate constraint before the spike
    (allowed on verdict b); Task 9 complexity (complex); G3 never verified by an agent (conditional live
    bench, UNVERIFIED blocks ready); Task 4 commit message.
  - rejected: "live API never validated" ×3 (the campaign made ~1 200 real calls; contract recorded in
    Technical Decisions); Task 9 must depend on Task 6 (its test drives `wrapTool` with a direct
    `rerankViaApi` call — no tool wiring needed).
  - plan reviewer on revision 4: 2 fixes (Task 1 sum-check scoped to the single stage table with pinned
    number format; RED names the REPLAN outcome) → applied as revision 5; stop rule reached, no further
    loop.
  - accepted as notes (stop rule, no re-split): Task 4 and Task 8 bundling — both carry boundary
    justifications the plan reviewer approved; Task 10 verify chain (INFO).
- Status gate: Reviewed

## Task Breakdown

### Task 1: Locate the cause of the 74 s semantic_search (measuring spike)
**Files:** `docs/specs/2026-10-15-semantic-search-latency-spike.md` (new, findings only)
**Surface:** docs
**Complexity:** standard
**Dependencies:** none
**Failure:** halt
**Execution routing:** default implementation tier

- [ ] RED: docs-only gate task — no production code, no test. It must print
  `[DECISION: 74s-cause=<a|b|c|d|other>] → COMPLETE` (verdict a, b or d) or `→ REPLAN` (any other
  cause, or no dominant stage; see Branch).
- [ ] GREEN: from `~/.codesift/usage.jsonl` (+ `usage-remote/`) split `semantic_search` and
  `codebase_retrieval` durations by host, transport (daemon vs stdio) and error. Time the stages of one
  call on the Mac daemon and one in a stdio process: lazy imports, `loadConfig` provider, embed incl.
  machine-slot wait (`embed-gate.ts`), `loadChunks`, vector cache. Confirm or kill: (a) stdio sessions
  lack the daemon env → provider resolves to `local` → model load; (b) machine-slot wait behind
  indexing; (c) daemon event-loop lag; (d) chunk loading before the embed error surfaces. Write exactly ONE table with the header `| stage | ms |` (a second
  timed call goes in further columns after `ms`), ending with a `| total | <ms> |` row; ms as plain
  integers without separators; other breakdowns as prose or tables with other headers. Then a literal line
  `**Verdict:** <stage> — <ms> of <total ms> (<pct>%)` (integer pct), or `**Verdict:** no dominant stage` when no
  stage reaches 50%. **Branch:** if the verdict is not (a), (b) or (d), or there is no dominant stage,
  print `[DECISION: 74s-cause=<x>] → REPLAN` and stop before Task 7: Tasks 7-8 are re-planned against
  the measured cause.
- [ ] Verify: `f=docs/specs/2026-10-15-semantic-search-latency-spike.md; grep -q '^| stage | ms |' $f && grep -Eq '^\*\*Verdict:\*\* (.+\(([5-9][0-9]|100)%\)|no dominant stage)' $f && awk -F'|' '/^\| stage \| ms \|/{n++;f=1;next} f&&/^\|[ :-]+\|/{next} f&&/^\| total \|/{t=$3+0;f=0;next} f&&/^\|/{s+=$3+0;next} {f=0} END{exit !(n==1 && t>0 && s>=0.9*t && s<=1.1*t)}' $f`
  Expected: exit 0 — a verdict line, and the stage rows sum to the total within 10%
- [ ] Acceptance Proof:
  - G5 (cause):
    - Surface: docs
    - Proof: the verify command
    - Expected: exit 0
    - Artifact: `zuvo/proofs/task-1-report.md`
- [ ] Commit: `docs: locate where semantic_search spends 74 s on the Mac`

### Task 2: OpenRouter rerank client with fail-open, circuit, cache and budget
**Files:** `src/search/rerank-api.ts` (new), `src/search/rerank-budget.ts` (new, if split),
`tests/search/rerank-api.test.ts` (new), `vitest.config.ts`
**Surface:** backend-logic
**Complexity:** complex
**Dependencies:** none
**Failure:** halt
**Execution routing:** deep implementation tier

- [ ] RED: `tests/search/rerank-api.test.ts` (fetch mocked once with a URL router; injected env,
  homeDir, clock; `_resetRerankApi()` in `beforeEach`):
  - `resolveRerankProvider` table (`it.each`): explicit off + key → off; explicit local → local; env key
    → openrouter; key file only → openrouter; empty/whitespace key file → off; no key → off; invalid
    value → off with one warning. Catches a default that silently spends or silently disables.
  - env parsing table: bad `CODESIFT_RERANK_TIMEOUT_MS` / `_DAILY_USD` / `_MAX_CALLS_PER_HOUR` values
    fall back to defaults; `_MODEL` overrides the model sent in the body.
  - `maps results back to input index order` (API returns them sorted by relevance).
  - malformed response table: index out of range / duplicate index / NaN score / missing `results` →
    null; partial results → unscored items keep their order after the scored ones.
  - failure-class table: 500, 429 + `Retry-After`, 401, 402, 400, network reject, timeout (50 ms via
    `CODESIFT_RERANK_TIMEOUT_MS`, fetch honouring the abort signal) → null, and whether/how long the
    next call is skipped.
  - `never writes the key to stderr on any failure class` (spy stderr + console.error).
  - `serves a repeated (model, query, docs) from cache without fetch`.
  - `stops after the daily USD budget, resumes after the window slides` (injected clock).
  - `concurrent calls cannot overshoot the call budget` (budget+3 parallel calls → fetch count ≤ budget).
  - `a response without usage.cost still counts against the hourly call cap` (catches an unbounded
    budget when the vendor omits cost).
  - `provider off ignores a present key file and makes no fetch`.
- [ ] GREEN: `resolveRerankProvider(env)`, `resolveOpenRouterKey({env, homeDir})`,
  `rerankViaApi(query, docs, {model?, timeoutMs?}) → Promise<number[] | null>`, `_resetRerankApi()`.
  Parse `CODESIFT_RERANK_MODEL` (default `voyageai/rerank-2.5-lite`), `CODESIFT_RERANK_TIMEOUT_MS`
  (overrides the 2 500 / 5 000 ms defaults), `CODESIFT_RERANK_DAILY_USD` (1.00),
  `CODESIFT_RERANK_MAX_CALLS_PER_HOUR` (600) via `parseIntEnv` or a float twin, falling back on bad
  values. Template: `fetchEmbeddings` (`semantic.ts:198`). Reserve the budget slot synchronously before
  `fetch`; write the LRU only after a validated response; ≤50 docs per call. Add
  `CODESIFT_RERANK_PROVIDER: "off"` to `vitest.config.ts` `env`.
- [ ] Verify: `grep -q 'CODESIFT_RERANK_PROVIDER: "off"' vitest.config.ts && rt --light npx vitest run tests/search/rerank-api.test.ts && rt --light npx tsc --noEmit`
  Expected: exit 0
- [ ] Acceptance Proof:
  - G1 / C2 / C3 / C4 / C5:
    - Surface: backend-logic
    - Proof: the verify command
    - Expected: exit 0; the key-leak, budget-race and provider-off-no-fetch tests are among the passes
    - Artifact: `zuvo/proofs/task-2-report.md`
- [ ] Commit: `add an OpenRouter rerank client that fails open and caps its own spend`

### Task 3: Reranker dispatches to off, OpenRouter or the explicit local model
**Files:** `src/search/reranker.ts`, `tests/search/reranker.test.ts`,
`src/register-tool-groups/core/search.ts` (lines ~72, ~123 wording),
`src/search/optional-transformers.ts` (`localEmbeddingRemedy` wording),
`tests/search/install-check.test.ts`
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** Task 2
**Failure:** halt
**Execution routing:** default implementation tier

- [ ] RED: in `reranker.test.ts`, pin `CODESIFT_RERANK_PROVIDER=local` in `beforeEach` for the existing
  cases; add `off returns input order and never loads transformers` (catches the local model loading
  by default), `openrouter reorders rerankResults and rerankChunkIds by API scores` (catches dispatch
  wired into only one of the two), `openrouter failure keeps input order`, `local without the package
  keeps input order`. Update the remedy-wording assertion in `install-check.test.ts`.
- [ ] GREEN: private `scoreCandidates(query, texts)` → `number[] | null` dispatching on
  `resolveRerankProvider`; `rerankResults`, `rerankChunkIds`, `_resetReranker` keep their signatures
  and call it; text via `buildCandidateText`. Warn-once stderr line when `rerank=true` resolves to
  `off`. Wording: "uses the OpenRouter rerank API when a key is set (`CODESIFT_RERANK_PROVIDER`)".
  The per-call `rerank` default stays `false` (C7).
- [ ] Verify: `rt --light npx vitest run tests/search/reranker.test.ts tests/search/install-check.test.ts tests/tools/search-tools-characterization.test.ts`
  Expected: all pass
- [ ] Acceptance Proof:
  - G1 / C1 / C2 / C7:
    - Surface: backend-logic
    - Proof: the verify command, plus `grep -n "rerank" src/register-tool-groups/core/search.ts` showing the default unchanged
    - Expected: exit 0; the `off … never loads transformers` test passes
    - Artifact: `zuvo/proofs/task-3-report.md`
- [ ] Commit: `rerank through OpenRouter or not at all; the local model only on request`

### Task 4: Remove the never-used semantic tool signal and add a rankTools limit
**Files:** `src/search/tool-ranker-types.ts`, `src/search/tool-ranker-signals.ts`,
`src/search/tool-ranker-orchestrator.ts`, `src/search/tool-ranker.ts`,
`src/search/tool-embedding-cache.ts` (delete), `src/search/tool-embedding-storage.ts` (delete),
`src/tools/plan-turn/orchestrator.ts`, `src/tools/plan-turn/types.ts`,
`src/tools/plan-turn/recommendations.ts`, `tests/search/tool-ranker.test.ts`,
`tests/tools/plan-turn.test.ts`, `tests/tools/register-tools-lazy-loading.test.ts`,
`tests/fixtures/tool-routing/gold.json` (new fixture)
**Surface:** backend-logic
**Complexity:** complex
**Dependencies:** none
**Failure:** halt
**Execution routing:** deep implementation tier

> Boundary justification: 9 production files + 3 tests. Removing a field from `ToolRankerContext` must
> reach every consumer in one commit or `tsc` fails; `tool-embedding-storage.ts` becomes dead (only
> `tool-embedding-cache.ts:10-14` and a test import use it). `limit` and the `rerank` metadata
> placeholder ride along so Tasks 5-6 do not re-touch the same types.

- [ ] RED: copy `docs/specs/2026-10-15-api-reranker-gold.json` (committed with this plan, 30 tasks)
  to `tests/fixtures/tool-routing/gold.json`; gate: `python3 -c "import json,sys;sys.exit(len(json.load(open('tests/fixtures/tool-routing/gold.json')))!=30)"`. Write the one-off
  dump script `zuvo/proofs/task-4-dump-rank.ts` inside the worktree (`zuvo/` is gitignored, so it is
  not committed; relative imports such as `../../src/search/tool-ranker.js`; both runs execute from the
  same worktree root): for the 30 gold queries plus the fixed
  intent list `["find dead code", "who calls parseConfig", "rename a symbol across files",
  "N+1 queries in services", "what changed since main"]` it builds a `ToolRankerContext` using only the
  fields that survive this task, calls `rankTools`, and prints `{query, names, confidences}` as JSON.
  Run it before any edit: `npx tsx zuvo/proofs/task-4-dump-rank.ts > zuvo/proofs/task-4-before.json`.
  New test `rankTools with limit 40 sliced to 10 deep-equals the default call`. Delete the
  semantic-vector test (~:195-212), the `getToolEmbeddings` block (:402-503) and the
  `readToolEmbeddingCache` import (:23-24) together with the code; remove the `getToolEmbeddings` mock
  from `plan-turn.test.ts`.
- [ ] GREEN: remove `embeddings`/`queryEmbedding` from `ToolRankerContext`, `computeSemanticSignals`
  and its import, `tool-embedding-cache.ts`, `tool-embedding-storage.ts`, the re-export at
  `tool-ranker.ts:11`, the `getToolEmbeddings` entry in `loadRankerContext`'s `Promise.all`
  (`orchestrator.ts:183`); delete `cosine` in `tool-ranker-signal-math.ts` if it has no other importer.
  Add `limit?: number` (default `MAX_RECOMMENDATIONS`) and an optional `identity_match?: boolean` on
  `ToolRecommendation` (true when the identity signal is at its maximum; read by Task 6). Replace
  `metadata.embedding_available` with `rerank: "skipped"` + `rerank_reason: "not_wired"` (Task 6 fills
  it); update the lazy-loading fixture. Remove "5-signal"/"semantic W=0.8" wording from code comments.
- [ ] Verify: `rt --light npx vitest run tests/search/tool-ranker.test.ts tests/tools/plan-turn.test.ts tests/tools/register-tools-lazy-loading.test.ts && rt --light npx tsc --noEmit && npx tsx zuvo/proofs/task-4-dump-rank.ts > zuvo/proofs/task-4-after.json && diff -u zuvo/proofs/task-4-before.json zuvo/proofs/task-4-after.json`
  Expected: exit 0 — tests pass, tsc clean, empty diff
- [ ] Acceptance Proof:
  - G4:
    - Surface: backend-logic
    - Proof: the verify command including the before/after diff
    - Expected: zero diff in names and confidences for all 35 queries
    - Artifact: `zuvo/proofs/task-4-report.md`
- [ ] Commit: `drop the always-zero tool-embedding signal; add rankTools limit and identity_match for the rerank stage`

### Task 5: discover_tools ranks through rankTools with a full candidate pool
**Files:** `src/register-tools/discovery-ranking.ts` (new), `src/register-tools/discovery.ts`,
`src/register-tools.ts`, `tests/tools/discover-tools.test.ts`, `scripts/bench-tool-routing.ts` (new,
not in CI)
**Surface:** backend-logic
**Complexity:** complex
**Dependencies:** Task 2, Task 4
**Failure:** halt
**Execution routing:** deep implementation tier

- [ ] RED: in `discover-tools.test.ts` (provider off): add `await` to existing tests and keep every
  assertion; table for `rankDiscoverCandidates`: "complex" → contains `analyze_complexity` (recall-guard
  substring hit), "functions that are never used anywhere" → `find_dead_code` in the 40-pool,
  category + query → only that category, empty query + category → unchanged category list;
  `returns at most 15 with params and is_core`; gold floor over `tests/fixtures/tool-routing/gold.json`:
  provider-off MRR of `rankDiscoverCandidates` ≥ 0.70 and the gold tool inside the 40-pool for 30/30
  (catches routing regressions and a pool that drops the right tool before rerank).
- [ ] GREEN: `rankDiscoverCandidates(query, category)` (sync): category filter on definitions first,
  `rankTools({limit: 40, usageFrequency: new Map(), frameworkTools: []})`, union with legacy keyword
  hits when fewer than 40, then fill to 40 with the remaining tools; empty query keeps the legacy
  category path. `discoverTools` becomes `async` and delegates; `register-tools.ts:159` does
  `return await`. Output shape (`params`, `is_core`, `total_tools`) unchanged.
  `scripts/bench-tool-routing.ts` forces `CODESIFT_RERANK_PROVIDER=off` unless `--api` is passed, uses
  live `getToolDefinitions()`, reads a key only via `resolveOpenRouterKey`, and prints exactly one line
  per variant:
  `<label> hit@1=<n>/30 hit@5=<n>/30 MRR=<d.dd> p50=<n>ms recall@40=<n>/30` with labels `legacy`,
  `rankDiscoverCandidates` and (only with `--api`) `discoverTools+api`.
- [ ] Verify: `rt --light npx vitest run tests/tools/discover-tools.test.ts && npx tsx scripts/bench-tool-routing.ts | tee zuvo/proofs/task-5-bench.txt | awk '/^rankDiscoverCandidates /{for(i=2;i<=NF;i++){split($i,a,"=");v[a[1]]=a[2]}; ok=(v["MRR"]+0>=0.70 && v["recall@40"]=="30/30")} END{exit !ok}'`
  Expected: exit 0
- [ ] Acceptance Proof:
  - G2:
    - Surface: backend-logic
    - Proof: the verify command
    - Expected: provider-off MRR ≥ 0.70 (measured 0.75), recall@40 30/30
    - Artifact: `zuvo/proofs/task-5-report.md`
- [ ] Commit: `rank discover_tools with the plan_turn scorer and keep every gold tool in the pool`

### Task 6: API rerank of tool candidates in discover_tools and plan_turn
**Files:** `src/search/tool-rerank.ts` (new), `src/register-tools/discovery-ranking.ts`,
`src/tools/plan-turn/orchestrator.ts`, `tests/search/tool-rerank.test.ts` (new),
`tests/tools/plan-turn.test.ts`
**Surface:** integration
**Complexity:** complex
**Dependencies:** Task 2, Task 4, Task 5
**Failure:** halt
**Execution routing:** deep implementation tier

- [ ] RED: `tool-rerank.test.ts`: `toolRerankDoc builds the measured string` (exact string for one
  known tool incl. the 600-char cut and empty category/searchHint — catches format drift that voids
  the 0.90); `reorders the top-40 pool by API scores, tail kept`; `fail-open keeps the input order`.
  `plan-turn.test.ts` (`CODESIFT_RERANK_PROVIDER=openrouter`, fake key, URL-routed fetch,
  `CODESIFT_RERANK_TIMEOUT_MS=50`): `3 intents make exactly 1 rerank fetch`; `exact tool-identity query
  makes 0 rerank fetches`; `rerank timeout yields merged order with rerank_reason=timeout`;
  `metadata reports rerank applied/skipped with reason`; `confidence stays lexical after rerank`
  (pins the decision).
- [ ] GREEN: `toolRerankDoc(def)`, `rerankToolCandidates(query, defs, {topN: 40})` (timeout from
  `rerank-api`, default 2 500 ms). `discoverTools`: pool → rerank → first 15. `plan_turn`: per-intent
  `rankTools({limit: 20})` stays sync; after `mergeToolRecommendations` cut to 40, one awaited rerank,
  then `partitionSessionRecommendations`. Skip the rerank when the top recommendation has
  `identity_match` and its confidence is ≥ 2× the second's. Fill `rerank`/`rerank_reason`.
- [ ] Verify: `rt --light npx vitest run tests/search/tool-rerank.test.ts tests/tools/plan-turn.test.ts tests/tools/discover-tools.test.ts && if [ -n "$OPENROUTER_API_KEY" ] || [ -s ~/.zuvo/openrouter.key ]; then npx tsx scripts/bench-tool-routing.ts --api | tee zuvo/proofs/task-6-bench.txt | awk '/^discoverTools\+api /{for(i=2;i<=NF;i++){split($i,a,"=");v[a[1]]=a[2]}; ok=(v["MRR"]+0>=0.85 && v["recall@40"]=="30/30")} END{exit !ok}'; else echo 'G3 UNVERIFIED: no key on this host — SMOKE2 must pass before the PR is marked ready' | tee zuvo/proofs/task-6-bench.txt; fi`
  Expected: exit 0; with a key, MRR ≥ 0.85 (measured 0.90, ~$0.003); without one, the UNVERIFIED line,
  which blocks marking the PR ready until SMOKE2 passes
- [ ] Acceptance Proof:
  - G3 / C2 / C4:
    - Surface: integration
    - Proof: the verify command
    - Expected: exit 0; exactly one rerank POST per `plan_turn`; identity query makes none
    - Artifact: `zuvo/proofs/task-6-report.md`
- [ ] Commit: `rerank tool candidates once per call through the API, falling back to lexical order`

### Task 7: semantic_search stops embedding when there is nothing to compare against
**Files:** `src/search/provider-reachability.ts` (new), `src/search/semantic.ts`,
`src/retrieval/semantic-handlers.ts`, `tests/search/provider-reachability.test.ts` (new),
`tests/retrieval/semantic-fail-fast.test.ts` (new), `tests/retrieval/semantic-chunk-coverage.test.ts`
**Surface:** backend-logic
**Complexity:** complex
**Dependencies:** Task 1
**Failure:** halt
**Execution routing:** deep implementation tier

> Boundary justification: 3 production files + 3 tests. The probe, its single call site in the Ollama
> provider and the reordered context loader form one behaviour (no embed without usable vectors);
> the coverage test must change in the same commit because the probe adds a GET its mock cannot parse.

- [ ] RED: `provider-reachability.test.ts`: `probe failure is cached for 60 s` (second call makes no
  request; injected clock). `semantic-fail-fast.test.ts`: `no vectors on disk → provider.embed is never
  called` (catches the embed-first path); `unreachable Ollama with vectors on disk → returns the lexical
  marker in under 2 s, no embed call, no throw` (Task 8 flips this test to "returns results").
  Fix `semantic-chunk-coverage.test.ts`'s fetch mock to route by URL (`/api/version` → 200) and reset
  the probe cache in `beforeEach`. Add one negative test matching Task 1's verdict if it names a cause
  not covered above.
- [ ] GREEN: `isProviderReachable(provider, {timeoutMs: 1500})` with a 60 s negative cache and a
  `_reset`. Reorder `loadSemanticContext`: resolve `repoMeta` and whether chunk/symbol vectors exist
  BEFORE embedding; no provider / local disabled / unreachable / no vectors → return a `lexical`
  marker instead of embedding; the handlers turn the marker into today's error text, fast (Task 8
  replaces that with results). Probe before `withEmbedSlot` in `OllamaProvider.embed`. Leave `embed-gate.ts` alone unless Task 1's verdict is (b)
  (slot wait) — then add a deadline to its machine-slot loop, with a test.
- [ ] Verify: `rt --light npx vitest run tests/search/provider-reachability.test.ts tests/retrieval/semantic-fail-fast.test.ts tests/retrieval/semantic-chunk-coverage.test.ts tests/tools/search-tools-characterization.test.ts tests/search/semantic.test.ts`
  Expected: all pass
- [ ] Acceptance Proof:
  - G5:
    - Surface: backend-logic
    - Proof: the verify command
    - Expected: exit 0; the no-vectors test proves `embed` is never called
    - Artifact: `zuvo/proofs/task-7-report.md`
- [ ] Commit: `check for vectors and a reachable provider before embedding a semantic query`

### Task 8: Vector-free semantic and hybrid search through BM25 and the API reranker
**Files:** `src/retrieval/semantic-lexical.ts` (new), `src/retrieval/semantic-handlers.ts`,
`src/retrieval/codebase-retrieval.ts`, `src/tools/search-tools/semantic-search.ts`,
`tests/retrieval/semantic-lexical.test.ts` (new), `tests/retrieval/semantic-fail-fast.test.ts`,
`tests/search/zero-hit-fallback.test.ts`
**Surface:** integration
**Complexity:** complex
**Dependencies:** Task 2, Task 3, Task 7
**Failure:** halt
**Execution routing:** deep implementation tier

> Boundary justification: 4 production files + 3 tests. The lexical path, its branch in the handler,
> the batch cap that bounds its cost in `codebase_retrieval`, and the wall-clock cap on the tool that
> exposes it ship together: shipping the path without the cap opens the cost fan-out.

- [ ] RED: on a tmp fixture repo (pattern: `zero-hit-fallback.test.ts`): `provider off returns BM25
  order labelled ranking=bm25`; `mocked API reorders the BM25 top-50`; `hybrid with no chunk index
  returns results instead of throwing "No chunk index"`; `codebase_retrieval batch of 10 semantic
  sub-queries makes at most 8 rerank fetches` (catches cost fan-out); `semantic_search wall-clock cap
  returns a hint naming the stage` (cap injected at 50 ms). Flip Task 7's `unreachable Ollama…` test to
  "returns results". Zero-hit gate pin in `zero-hit-fallback.test.ts`: provider openrouter + fake key +
  repo without embeddings → `zeroHitFallback` makes 0 rerank fetches (catches every zero-hit
  `search_text` becoming paid).
- [ ] GREEN: `semantic-lexical.ts`: `getBM25Index(repo)` + `searchBM25Async(index, query, 50,
  config.bm25FieldWeights)` (+ `searchText` hits for hybrid) → `rerankResults` → `formatSemanticResults`,
  with a `ranking: "bm25" | "rerank"` field. The handler branches to it at the top on the Task 7
  `lexical` marker (never interleaved with the vector paths); hybrid :360 uses the same branch.
  `codebase_retrieval` passes a per-batch rerank counter (cap 8) and stops reranking once its wall-clock
  caps fire. Wrap the `semantic_search` tool in `raceWallClock(…, 20_000, hint)` (in-flight work is
  discarded, bounded by the 5 s fetch timeout). Exported names of `semantic-handlers.ts` unchanged.
- [ ] Verify: `rt --light npx vitest run tests/retrieval tests/search/zero-hit-fallback.test.ts tests/tools/search-tools-characterization.test.ts && rt --light npx tsc --noEmit`
  Expected: all pass, tsc exit 0
- [ ] Acceptance Proof:
  - G6 / G5 / C2 / C4:
    - Surface: integration
    - Proof: the verify command
    - Expected: exit 0; batch-cap, wall-clock and zero-hit-pin tests pass
    - Artifact: `zuvo/proofs/task-8-report.md`
- [ ] Commit: `answer semantic and hybrid queries without vectors: BM25 candidates, API rerank`

### Task 9: Rerank cost and outcome in the usage log
**Files:** `src/search/rerank-api.ts`, `src/server-helpers/request-context.ts`,
`src/storage/usage-tracker.ts`, `src/server-helpers.ts`, `tests/storage/usage-tracker.test.ts`
**Surface:** backend-logic
**Complexity:** complex
**Dependencies:** Task 2
**Failure:** halt
**Execution routing:** deep implementation tier

- [ ] RED: in `usage-tracker.test.ts`: `a tool call that reranks twice writes a usage entry with summed
  rerank ms/cost and the outcome` — driven through `wrapTool("semantic_search", args, fn)` inside
  `runWithRequestContext({cwd})`, where `fn` calls the mocked `rerankViaApi` twice (catches the context
  slot never reaching `trackToolCall`); `usage entry never contains the API key`.
- [ ] GREEN: `rerank-api.ts` records the outcome on the current request context
  (`request-context.ts`, AsyncLocalStorage; add a `rerank` slot); the tracking calls at
  `server-helpers.ts:329/383/388` pass it through `trackToolCall`'s `extra` into `UsageEntry`
  (`usage-tracker.ts:194`). Several reranks in one request sum `ms` and `cost`.
- [ ] Verify: `rt --light npx vitest run tests/storage/usage-tracker.test.ts tests/search/rerank-api.test.ts && rt --light npx tsc --noEmit`
  Expected: exit 0
- [ ] Acceptance Proof:
  - C8 / C5:
    - Surface: backend-logic
    - Proof: the verify command
    - Expected: exit 0
    - Artifact: `zuvo/proofs/task-9-report.md`
- [ ] Commit: `log what each tool call spent on reranking`

### Task 10: End-to-end smoke test and docs
**Files:** `tests/integration/rerank-smoke.test.ts` (new), `README.md`, `CLAUDE.md`
**Surface:** integration
**Complexity:** standard
**Dependencies:** Task 5, Task 6, Task 8, Task 9
**Failure:** halt
**Execution routing:** default implementation tier

- [ ] RED: `tests/integration/rerank-smoke.test.ts` runs SMOKE1 below through the registered MCP
  handlers (catches a stage not wired into the real tool path while unit tests pass).
- [ ] GREEN: README: `CODESIFT_RERANK_PROVIDER`, `_MODEL`, `_TIMEOUT_MS`, `_DAILY_USD`,
  `_MAX_CALLS_PER_HOUR`, key locations, the sentence "queries and code snippets are sent to OpenRouter
  when a key is present", and how to keep the old local model (`local`). CLAUDE.md: "4 signals +
  optional API rerank"; a line "daemon plist still sets CODESIFT_EMBEDDING_PROVIDER=ollama — owner's
  decision". Write `zuvo/proofs/smoke-rerank-live.md` as a checklist for the owner (SMOKE2).
- [ ] Verify: `rt --light npx vitest run tests/integration/rerank-smoke.test.ts && grep -q "sent to OpenRouter" README.md && grep -q "CODESIFT_EMBEDDING_PROVIDER=ollama" CLAUDE.md && test -s zuvo/proofs/smoke-rerank-live.md && rt --light npm run lint && rt npx vitest run`
  Expected: exit 0 — smoke passes, docs carry the egress and plist notes, lint and the full suite green
- [ ] Acceptance Proof:
  - SMOKE1 / C5 / C6:
    - Surface: integration
    - Proof: the verify command
    - Expected: exit 0
    - Artifact: `zuvo/proofs/task-10-report.md`, `zuvo/proofs/smoke-rerank.md`
  - SMOKE2 (manual, owner, after `npm run build`): not executed by the agent; the checklist file is the
    artifact, the owner fills it in.
- [ ] Commit: `prove the reranker end to end and document it and its data egress`

## Whole-feature Smoke Proofs

- **SMOKE1 — tool routing and semantic search without vectors, three provider states**
  - Preconditions: tmp fixture repo indexed with every embedding provider disabled; fetch mocked by
    URL; injected fake key.
  - Proof: `rt --light npx vitest run tests/integration/rerank-smoke.test.ts` — calls the registered
    `discover_tools`, `plan_turn` and `semantic_search` handlers in three passes: (a) openrouter +
    reversed mock scores; (b) off; (c) openrouter with fetch rejecting.
  - Expected: (a) output order follows the mock scores, exactly one rerank POST per call, no
    Ollama/embedding request; (b) zero fetches, `discover_tools` equals the `rankDiscoverCandidates`
    order, `semantic_search` returns `ranking: "bm25"` in under 2 s; (c) identical to (b) plus a
    `rerank_reason`.
  - Artifact: `zuvo/proofs/smoke-rerank.md`
  - RED copy: Task 10.
- **SMOKE2 — live check on the Mac (manual, owner's key, after `npm run build`; not run by the agent)**
  - Proof: `semantic_search` on codesift-mcp; `discover_tools("functions that are never used
    anywhere")`; `npx tsx scripts/bench-tool-routing.ts --api`; then the same with
    `CODESIFT_RERANK_PROVIDER=off`.
  - Expected: `semantic_search` under 5 s (was 74 s); `find_dead_code` in the top 3; the
    `discoverTools+api` line shows MRR ≥ 0.85 and recall@40 30/30; `usage.jsonl` shows `rerank.outcome`
    and `cost`; with off, no OpenRouter calls.
  - Artifact: `zuvo/proofs/smoke-rerank-live.md` (checklist written by Task 10, filled in by the owner)
