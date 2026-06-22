# Implementation Plan: Shared HTTP server (B) + embedding memory slimming (C)

**Spec:** inline — no spec
**spec_id:** none
**planning_mode:** inline
**source_of_truth:** inline brief
**plan_revision:** 2
**status:** Completed (11/11 tasks shipped 2026-06-22 — Phase C in 0.8.21, Phase B in 0.9.0)
**Created:** 2026-06-22
**Tasks:** 11
**Estimated complexity:** mostly standard; B1/B2/C3 complex

## Incident context
3–5 Claude Code/Cursor/Codex windows each spawn a **separate stdio `node dist/server.js`**. Each
loads embeddings into its own heap (per-repo `.embeddings.ndjson`, GB-scale — tgm-survey-platform =
4.5GB). On 16–24GB coworker machines this OOMs the box. Root cause: (1) **stdio MCP = one heavy
process per client, no sharing**; (2) embeddings **eagerly loaded into RAM as `number[][]`** and
duplicated per process.

## Architecture Summary
- **Transport seam (B):** `src/server.ts` currently wires `StdioServerTransport`. Add a
  `StreamableHTTPServerTransport` path (MCP SDK supports it) behind a mode flag. ONE long-lived
  daemon process holds the (already module-global) tool handlers + index/embedding caches; every
  client connects over `127.0.0.1` HTTP → caches loaded **once**, shared across all windows.
- **Memory seam (C):** `src/storage/embedding-store.ts` (load/parse `.embeddings.ndjson`) +
  `src/search/semantic.ts` (consumes vectors for cosine). Today the store parses JSON float arrays
  into `number[][]` held in a module cache, loaded eagerly. Make it: lite-mode skippable →
  lazy-per-repo → `Float32Array`-backed → LRU-evicted under a memory budget.
- **CLI seam (B):** `src/cli.ts` + `src/cli/commands.ts` add `serve`; `src/cli/setup.ts` adds an
  `--http` client-config writer.
- **Dependency direction:** server.ts → transport; store/semantic are leaf utilities; CLI → server
  bootstrap. No logic fork — the daemon imports the same `registerTools`/handlers as stdio.

## Technical Decisions
- **Transport:** MCP SDK `StreamableHTTPServerTransport` (HTTP, supersedes raw SSE). Bind
  `127.0.0.1` only. Mode selected by `CODESIFT_TRANSPORT=http|stdio` (default `stdio` — backward
  compatible) or `codesift serve` (forces http).
- **Single instance:** pidfile + port lock at `~/.codesift/daemon.{pid,port}`; refuse 2nd daemon.
- **Memory store:** per-repo vectors as one contiguous `Float32Array` (rows×dims) + parallel id
  array — ~4 bytes/float vs ~8–16 with `number[][]` boxing; cosine reads slices. LRU map keyed by
  repo index-hash, byte-accounted, evict when over `CODESIFT_MAX_EMBEDDING_MEM_MB` (default 1024).
- **Lite mode:** `CODESIFT_DISABLE_LOCAL_EMBEDDINGS=1` (existing flag, extend to gate ALL embedding
  load, not just the local provider) → semantic disabled, store never loads → footprint ~hundreds MB.
- **Backward compatible:** stdio default; existing configs untouched; HTTP + lite are opt-in.

## Quality Strategy
- Memory tasks (C) are unit-testable in-process (load store, assert representation/eviction/skip) —
  no daemon needed → land first for immediate coworker relief.
- Transport tasks (B) need a feasibility spike (B1) before building `serve` on top.
- Risk areas: (1) Float32Array refactor must not change cosine results (golden-vector test);
  (2) LRU eviction must not evict a repo mid-query (pin on access); (3) HTTP daemon concurrency —
  shared cache must be safe for concurrent reads (it is read-mostly; writes via index are serialized).
- CQ watch: CQ6 (unbounded memory — the whole point), CQ8 (daemon error/timeout/shutdown), CQ15
  (concurrent access), CQ10 (lazy-load null guards).

## Coverage Matrix
| Row ID | Authority item | Type | Primary task(s) | Notes |
|--------|----------------|------|-----------------|-------|
| C-G1 | Lite mode skips all embedding load (low-RAM relief) | goal | Task 1 | immediate coworker mitigation |
| C-G2 | Embeddings lazy-loaded per repo, not eager | goal | Task 2 | |
| C-G3 | Compact Float32Array store (≪ heap) | goal | Task 3 | cosine parity required |
| C-G4 | LRU eviction under memory budget | constraint | Task 4 | CODESIFT_MAX_EMBEDDING_MEM_MB |
| C-G5 | Document low-RAM guidance | deliverable | Task 5 | README/CLAUDE.md |
| B-G1 | HTTP transport bootstrap (one server, many clients) | goal | Task 6, Task 8 | spike then wire |
| B-G2 | `codesift serve` daemon (lock, health, shutdown) | goal | Task 7 | |
| B-G3 | Caches loaded once, shared across connections | constraint | Task 8 | the core win |
| B-G4 | `codesift setup --http` client config | deliverable | Task 9 | |
| B-G5 | Bind 127.0.0.1 + optional token | constraint | Task 10 | never external |
| B-G6 | One-load-shared verified end-to-end | goal | Task 11 | smoke |

## Review Trail
- Phase 1: **direct (degraded fan-out)** — deep first-hand codebase knowledge from this session;
  3-agent Explore fan-out skipped due to the session's persistent API rate-limiting (Explore also
  lacks CodeSift on this indexed repo). Recorded honestly per skill failure-handling.
- DAG lint: valid DAG (11 tasks, 0 violations).
- Cross-model validation (rev 1): executed → 1 high-confidence dep/ordering finding + scope/recovery WARNINGs. Applied in rev 2: (a) Task 8 now deps Task 4 + reclassified `complex` + RED covers concurrent two-client load-once with pin-on-access (also serves as mid-plan integration gate); (b) Task 7 RED/GREEN add stale-pidfile liveness recovery (CQ8) + clarify loopback bind inherited from Task 6; (c) Task 11 proof artifact renamed `task-11-B-G6.txt`. INFO on artifact naming fixed. Remaining mid-plan-smoke + concurrency-spike WARNINGs resolved by Task 8 doubling as the integration gate.
- Plan reviewer: not dispatched — Phase-1/review agent fan-out degraded due to this session's persistent Anthropic API rate-limiting; cross-model adversarial (external providers) ran in its place and findings were applied.
- Status gate: Reviewed (awaiting user Approval before zuvo:execute).

---

## Task Breakdown

### Task 1: Lite mode — skip ALL embedding load when disabled
**Files:** src/storage/embedding-store.ts, src/search/semantic.ts, tests/storage/embedding-store-lite.test.ts
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: test that with `CODESIFT_DISABLE_LOCAL_EMBEDDINGS=1`, `loadEmbeddings(indexPath)` returns an empty/sentinel store WITHOUT reading the `.embeddings.ndjson` file (spy on `readFileSync`/`createReadStream` → not called), and `semanticSearch` falls back to BM25 (no throw).
- [ ] GREEN: early-return in the embedding-store loader when the flag is set; ensure semantic layer treats empty store as "semantic unavailable" → BM25 path. Flag gates the whole load, not just provider construction.
- [ ] Verify: `npx vitest run tests/storage/embedding-store-lite.test.ts` — Expected: pass; readFile spy call count 0.
- [ ] Acceptance Proof:
  - C-G1: Surface backend-logic. Proof: `CODESIFT_DISABLE_LOCAL_EMBEDDINGS=1 node dist/cli.js search local/codesift "x" --json` returns results with no embedding file read. Expected: exit 0, BM25 results. Artifact: `zuvo/proofs/task-1-C-G1.txt`
- [ ] Commit: `feat(mem): lite mode skips embedding load entirely (low-RAM machines)`

### Task 2: Lazy-load embeddings per repo on first semantic query
**Files:** src/storage/embedding-store.ts, src/search/semantic.ts, tests/storage/embedding-store-lazy.test.ts
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** Task 1
- [ ] RED: indexing/opening a repo (getCodeIndex) does NOT load its embeddings; the store loads only on the first `semanticSearch`/embedding read for that repo (assert via load-spy: 0 after index open, 1 after first semantic call, still 1 on second = memoized).
- [ ] GREEN: move embedding load out of the eager path into a lazy memoized getter keyed by index-hash; first consumer triggers load.
- [ ] Verify: `npx vitest run tests/storage/embedding-store-lazy.test.ts` — Expected: pass.
- [ ] Acceptance Proof:
  - C-G2: Surface backend-logic. Proof: unit spy shows load-count 0 after open, 1 after first semantic query. Expected: asserted in test. Artifact: `zuvo/proofs/task-2-C-G2.txt`
- [ ] Commit: `perf(mem): lazy-load repo embeddings on first semantic query`

### Task 3: Compact Float32Array vector store (cosine parity)
**Files:** src/storage/embedding-store.ts, src/search/semantic.ts, tests/storage/embedding-store-f32.test.ts
**Surface:** backend-logic
**Complexity:** complex
**Dependencies:** Task 2
- [ ] RED: golden test — load a fixture embeddings file, assert vectors stored as one `Float32Array` (rows×dims) + id array, and that cosine similarity for known pairs matches the pre-refactor `number[][]` result within 1e-5.
- [ ] GREEN: parse ndjson into a contiguous `Float32Array`; cosine reads `subarray(i*d,(i+1)*d)`. Keep public search API unchanged.
- [ ] Verify: `npx vitest run tests/storage/embedding-store-f32.test.ts` — Expected: pass; cosine delta < 1e-5.
- [ ] Acceptance Proof:
  - C-G3: Surface backend-logic. Proof: test asserts Float32Array backing + cosine parity vs golden. Expected: pass. Artifact: `zuvo/proofs/task-3-C-G3.txt`
- [ ] Commit: `perf(mem): store embeddings as Float32Array (halves heap vs number[][])`

### Task 4: LRU eviction under memory budget
**Files:** src/storage/embedding-store.ts, tests/storage/embedding-store-lru.test.ts
**Surface:** backend-logic
**Complexity:** complex
**Dependencies:** Task 3
- [ ] RED: with `CODESIFT_MAX_EMBEDDING_MEM_MB` set low, loading 3 repos whose total exceeds the budget evicts the least-recently-used repo's Float32Array (assert it's dropped + reloads on next access); the repo being queried is never evicted mid-call (pin-on-access).
- [ ] GREEN: byte-accounted LRU map keyed by index-hash; on insert over budget, evict LRU (excluding the in-use entry); reload lazily on re-access.
- [ ] Verify: `npx vitest run tests/storage/embedding-store-lru.test.ts` — Expected: pass; resident bytes ≤ budget.
- [ ] Acceptance Proof:
  - C-G4: Surface backend-logic. Proof: test asserts resident set bounded + LRU victim correct. Expected: pass. Artifact: `zuvo/proofs/task-4-C-G4.txt`
- [ ] Commit: `perf(mem): LRU-evict repo embeddings over CODESIFT_MAX_EMBEDDING_MEM_MB`

### Task 5: Document low-RAM guidance
**Files:** README.md, CLAUDE.md
**Surface:** docs
**Complexity:** standard
**Dependencies:** Task 1, Task 4
- [ ] RED: docs-only — no test. Add a "Low-memory / multi-session" section: lite mode env, the budget env, and (forward ref) the shared HTTP daemon.
- [ ] Verify: `grep -q CODESIFT_MAX_EMBEDDING_MEM_MB README.md && grep -q CODESIFT_DISABLE_LOCAL_EMBEDDINGS README.md` — Expected: exit 0.
- [ ] Acceptance Proof:
  - C-G5: Surface docs. Proof: grep finds both env vars + low-memory section. Expected: exit 0. Artifact: `zuvo/proofs/task-5-C-G5.txt`
- [ ] Commit: `docs(mem): low-RAM + multi-session guidance for teams`

### Task 6: SPIKE — Streamable HTTP MCP transport bootstrap
**Files:** src/server.ts, tests/server/http-transport.test.ts
**Surface:** integration
**Complexity:** complex
**Dependencies:** none
- [ ] RED: a test boots the server in HTTP mode on an ephemeral 127.0.0.1 port and performs an MCP `initialize` + `tools/list` over HTTP, asserting the codesift tool set comes back (proves the transport + handler reuse works before building `serve` on it).
- [ ] GREEN: factor transport selection in server.ts: `CODESIFT_TRANSPORT=http` → `StreamableHTTPServerTransport` bound to 127.0.0.1; same `registerTools(server)` as stdio.
- [ ] Verify: `npx vitest run tests/server/http-transport.test.ts` — Expected: pass; tools/list non-empty.
- [ ] Acceptance Proof:
  - B-G1: Surface integration. Proof: HTTP initialize+tools/list returns ≥50 tools. Expected: pass. Artifact: `zuvo/proofs/task-6-B-G1.txt`
- [ ] Commit: `feat(server): optional Streamable HTTP transport (127.0.0.1)`

### Task 7: `codesift serve` daemon (lock, health, shutdown)
**Files:** src/cli/commands.ts, src/cli/help.ts, src/cli.ts, tests/cli/serve.test.ts
**Surface:** integration
**Complexity:** complex
**Dependencies:** Task 6
- [ ] RED: `serve` writes `~/.codesift/daemon.{pid,port}`, a 2nd `serve` refuses (single-instance), `GET /health` returns ok, SIGTERM removes the pidfile (graceful). **Recovery:** a STALE pidfile (pid not alive — simulating `kill -9`/OOM) is detected and reclaimed so `serve` starts cleanly (else coworkers can never restart → revert to per-window stdio = the original incident). Use a temp data dir. (Loopback-only bind is inherited from Task 6; token auth is Task 10.)
- [ ] GREEN: `handleServe` boots the HTTP server (Task 6, already 127.0.0.1), pidfile+port lock with **liveness check** (`process.kill(pid,0)` → if dead, reclaim), `/health`, SIGTERM/SIGINT cleanup; `keepProcessAlive=true` for `serve` in cli.ts.
- [ ] Verify: `npx vitest run tests/cli/serve.test.ts` — Expected: pass.
- [ ] Acceptance Proof:
  - B-G2: Surface integration. Proof: start serve → /health ok → 2nd serve exits non-zero → SIGTERM cleans pidfile. Expected: asserted. Artifact: `zuvo/proofs/task-7-B-G2.txt`
- [ ] Commit: `feat(cli): codesift serve — shared local daemon`

### Task 8: Shared caches across connections (load once)
**Files:** src/storage/embedding-store.ts (cache scope), src/storage/index-store.ts, tests/server/shared-cache.test.ts
**Surface:** backend-logic
**Complexity:** complex
**Dependencies:** Task 3, Task 4, Task 6
- [ ] RED: (a) two sequential AND (b) two **concurrent (parallel)** MCP clients against one HTTP server querying the SAME repo trigger the embedding load **exactly once** (load-spy count 1, not 2) — proving both the shared-process cache and in-flight dedup. Also assert a query never observes an LRU-evicted store (pin-on-access from Task 4). This task is the **mid-plan integration gate** before Tasks 9–10.
- [ ] GREEN: confirm/repair the index+embedding caches are process-module-global (not per-connection); add a guard so concurrent first-access dedupes to a single in-flight load (promise memoization) that respects Task 4's pin-on-access (never evict an entry with an outstanding load/query).
- [ ] Verify: `npx vitest run tests/server/shared-cache.test.ts` — Expected: pass; load-count 1.
- [ ] Acceptance Proof:
  - B-G3: Surface backend-logic. Proof: 2 clients, same repo → 1 embedding load. Expected: pass. Artifact: `zuvo/proofs/task-8-B-G3.txt`
- [ ] Commit: `perf(server): single shared embedding/index cache across HTTP clients`

### Task 9: `codesift setup --http` client config
**Files:** src/cli/setup.ts, tests/cli/setup.test.ts
**Surface:** config
**Complexity:** standard
**Dependencies:** Task 7
- [ ] RED: `setup("claude",{http:true})` writes an HTTP client entry (type/url pointing at the daemon port) instead of the stdio `command` block; stdio remains default without the flag. Idempotent.
- [ ] GREEN: add `--http` path in setupClaude/Cursor/Codex writers emitting the http client config + a note to run `codesift serve`.
- [ ] Verify: `npx vitest run tests/cli/setup.test.ts` — Expected: pass.
- [ ] Acceptance Proof:
  - B-G4: Surface config. Proof: with --http, config has url+no stdio command; without, unchanged. Expected: pass. Artifact: `zuvo/proofs/task-9-B-G4.txt`
- [ ] Commit: `feat(setup): --http writes shared-daemon client config`

### Task 10: Security — local-only bind + optional token
**Files:** src/server.ts, tests/server/http-security.test.ts
**Surface:** integration
**Complexity:** standard
**Dependencies:** Task 6
- [ ] RED: server binds 127.0.0.1 only (a non-loopback bind attempt is refused/not used); when `CODESIFT_HTTP_TOKEN` is set, requests without the matching header get 401; with it, 200.
- [ ] GREEN: hard-bind loopback; optional bearer-token middleware gating MCP requests.
- [ ] Verify: `npx vitest run tests/server/http-security.test.ts` — Expected: pass.
- [ ] Acceptance Proof:
  - B-G5: Surface integration. Proof: loopback-only + token 401/200. Expected: pass. Artifact: `zuvo/proofs/task-10-B-G5.txt`
- [ ] Commit: `feat(server): HTTP daemon binds loopback + optional token`

### Task 11: Smoke runner — one-load-shared end to end
**Files:** tests/integration/smoke-shared-server.test.ts, zuvo/proofs/smoke-shared-server.test.ts
**Surface:** integration
**Complexity:** standard
**Dependencies:** Task 7, Task 8, Task 10
- [ ] RED: boot `serve`; two MCP clients each run a semantic query on the same large fixture repo; assert embeddings loaded once + memory stays under the budget + both clients get results; lite-mode boot loads zero embeddings.
- [ ] GREEN: author the smoke runner exercising SMOKE1/SMOKE2.
- [ ] Verify: `npx vitest run tests/integration/smoke-shared-server.test.ts` — Expected: pass.
- [ ] Acceptance Proof:
  - B-G6: Surface integration. Proof: SMOKE1 + SMOKE2 below. Expected: pass. Artifact: `zuvo/proofs/task-11-B-G6.txt`
- [ ] Commit: `test(server): whole-feature smoke — shared daemon loads once, bounded memory`

## Whole-feature Smoke Proofs
- **SMOKE1 — shared daemon loads embeddings once**
  - Preconditions: one `codesift serve` daemon; a fixture repo with embeddings; embedding load-spy.
  - Proof: two MCP clients each issue `semantic_search` on the same repo.
  - Expected: load-spy count == 1 (shared cache); both clients return results.
  - Artifact: `zuvo/proofs/smoke-shared-server.test.ts`
- **SMOKE2 — bounded memory + lite mode**
  - Preconditions: `CODESIFT_MAX_EMBEDDING_MEM_MB` low; then a separate boot with `CODESIFT_DISABLE_LOCAL_EMBEDDINGS=1`.
  - Proof: query several repos over budget; separately boot lite mode and query.
  - Expected: resident embedding bytes ≤ budget (LRU evicts); lite boot loads 0 embeddings, BM25 still answers.
  - Artifact: `zuvo/proofs/smoke-shared-server.test.ts`
