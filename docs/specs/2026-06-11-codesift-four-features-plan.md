# Implementation Plan: CodeSift Four Features (static embeddings, hash-snapshot sync, pg introspection, repo groups)

**Spec:** inline — no spec
**spec_id:** none
**planning_mode:** inline
**source_of_truth:** inline brief (user message, 4 features, priority 3 → 4 → 2 → 1)
**plan_revision:** 4
**status:** Approved
**Created:** 2026-06-11
**Tasks:** 16
**Estimated complexity:** 12 standard / 4 complex

## Architecture Summary

Four independent features, ordered F3 → F4 → F2 → F1 (ascending integration risk):

- **F3 Static embedding tier.** `@huggingface/transformers` 3.8.1 does NOT support Model2Vec (verified by grep of installed dist) → new `StaticEmbeddingProvider` class in **`src/search/static-embedding-provider.ts`** (own file — keeps `semantic.ts` at 407L, under the 450L limit) implementing the existing `EmbeddingProvider` interface (`embed(texts, mode?)`, `dimensions`, `model`), backed by a hand-rolled safetensors parser (`src/utils/safetensors-loader.ts`) and an HF-Hub download/cache util (`src/utils/hf-hub-download.ts`, cache in `~/.codesift/models/`). Dispatch stays on the existing `"local"` provider literal — `createEmbeddingProvider` auto-detects Model2Vec model IDs. No change to `EmbeddingMeta.provider` union (on-disk meta compat preserved).
- **F4 Hash-snapshot cold-start sync.** New `src/storage/hash-snapshot.ts` persists `FileHashSnapshot{version, repo, created_at, files: Record<path, sha1>}` as `{hash}.snapshot.json` co-located with the index. `indexFolder` cold path loads snapshot (validated: repo + version; corruption/mismatch → null → full re-parse) → diffs sha1 per file → parses only changed/new, drops deleted. Snapshot is NOT deleted on entry — it is REPLACED only after successful `saveIndex` (never before the DROP guard), so a mid-run crash or DROP rejection leaves the previous snapshot intact (CQ21). `DROP_THRESHOLD` re-anchored to `Math.min(walkedCount, existing.file_count)` to kill partial-walk false positives. Warm path (watcher → `indexFile`) unchanged.
- **F2 Live Postgres introspection.** New `src/tools/pg-introspect-tools.ts`; `pg` as **optionalDependency** with dynamic-import graceful error (transformers/journal-llm-client pattern). Single-use read-only client per call, `connectionTimeoutMillis`, `SET statement_timeout = 5000`, whole-call 10s race. `information_schema` → existing `TableInfo[]`/`Relationship[]` shapes (sql-tools.ts:26-39) → optional drift vs migration-derived schema. Conn string from `CODESIFT_PG_CONN_STR` env; never a logged tool arg; redacted in every error path.
- **F1 Multi-repo groups + contract matching.** New `src/storage/group-registry.ts` (mirrors registry.ts, `groups.json`, atomicWriteFile) + `src/tools/cross-repo-contract-tools.ts`. Producer side reuses three existing extractors via adapters (hono `extractApiContract` summary, nest `nestRouteInventory`, nextjs handlers — `ApiContractResult` NAME COLLISION between hono/nextjs resolved with import aliases) normalized to a new `RepoEndpoint` type with path-param normalization (`:id`/`{id}`/`[id]` → `{param}`). Consumer side: NEW regex-based outbound fetch/axios/got extractor (template literals → static-prefix `partial` match). Pure matcher function → `ContractMatch[]`.

Tool registration follows the existing `ToolDefinition` + lazy-loader (`memoizeModule`/`lazyExport`) pattern; new tools are hidden/discoverable, not core.

## Technical Decisions

| Decision | Chosen | Rationale |
|----------|--------|-----------|
| F3 dispatch | Reuse `"local"` literal + auto-detect (`startsWith("minishlab/potion") \|\| includes("model2vec")`) | New provider literal breaks `.embeddings.meta.json` compat; bare `includes("potion")` too fragile (QA Risk 3) |
| F3 runtime | No new dep; manual safetensors parse (header = u64 len + JSON) + `node:https`/fetch download | transformers.js 3.8.1 has no Model2Vec support; format trivial to parse |
| F2 client | `pg` in `optionalDependencies` | 12+ yrs production, `@types/pg`; porsager/postgres has exactOptionalPropertyTypes friction; pglite can't reach live servers |
| F1 storage | Separate `groups.json` | registry.json written on every indexFolder — avoid contention; Registry validator untouched |
| F1 consumer extraction | New regex over raw source (do NOT adapt `extractFetchCalls` — AST-based, Next.js-only; see T13) | URL literals inherently heuristic; tree-sitter query adds cost without recall gain |
| F4 hash | sha1 via `node:crypto`; separate `{hash}.snapshot.json` | No new dep; index.json already large; snapshot needed only at cold start |

KNOWN_LOCAL_DIMS gets full-namespace key `"minishlab/potion-code-16M": 256` (QA Risk 3). `StaticEmbeddingProvider` lives in its own file (`src/search/static-embedding-provider.ts`) so `semantic.ts` (407L today) gains only the ~6-line dispatch change and stays under the 450L limit.

## Quality Strategy

- Framework: Vitest; storage tests mirror `tests/storage/registry.test.ts` (mkdtemp-injected paths); index tests use `CODESIFT_DATA_DIR` + `resetConfigCache()` + `watch:false` + `stopAllWatchersForTesting`.
- **CQ5 (critical, F2):** conn string never accepted as logged arg; NOT added to `TOOL_ARG_FIELDS`; every catch redacts `connStr` → `[REDACTED]`; dedicated negative test asserts no conn-str substring in any error/result.
- **CQ8 (critical, F2/F3):** pg `connectionTimeoutMillis: 5000` + `SET statement_timeout = 5000` + 10s `Promise.race`; HF download `AbortSignal.timeout(30_000)` + partial-file unlink on failure + 500MB cap.
- **CQ21 (F4):** snapshot NOT deleted on entry; REPLACED only after successful `saveIndex`; corruption or version/repo mismatch on load → null (full re-parse); DROP-guard rejection leaves the previous snapshot intact (dedicated test).
- **CQ6 (F1/F3):** group fan-out capped `max_repos=20` with truncation warning; download size cap.
- **CQ14 (F1):** matcher operates ONLY on normalized `RepoEndpoint` — never on the two divergent `ApiContractResult` shapes.
- Coverage gaps to close (none exist today): second-call `indexFolder` skip behavior; DROP_THRESHOLD under `max_files`; snapshot corruption fallback.

## Coverage Matrix

| Row ID | Authority item | Type | Primary task(s) | Notes |
|--------|----------------|------|-----------------|-------|
| G1 | F3: potion-code-16M usable as local embedding provider (256d, CPU, no API key) | goal | T1, T2, T3, T4 | |
| G2 | F3: existing nomic `"local"` path and on-disk meta format unchanged | constraint | T4 | compat regression test |
| G3 | F4: persistent per-file hash snapshot; cold start parses only changed files | goal | T5, T6 | |
| G4 | F4: DROP_THRESHOLD no longer false-positives on partial walks (1139-vs-9512 bug class) | goal | T7 | |
| G5 | F2: live information_schema → TableInfo/Relationship | goal | T8, T9 | |
| G6 | F2: optional drift check live-vs-migrations; tool registered | goal | T10 | |
| G6b | F2: "feeds zuvo:db-audit --live" | deferred | — | Out of scope: zuvo:db-audit is a skill-layer consumer; this plan delivers the `introspect_pg` MCP tool that the skill can call. No zuvo skill changes in this plan. |
| G7 | F1: repo group CRUD persisted in ~/.codesift | goal | T11 | |
| G8 | F1: producer↔consumer contract matching; "who calls this endpoint" | goal | T12, T13, T14, T15 | |
| C1 | No new hard dependencies (pg optional; F1/F3/F4 zero new deps) | constraint | T8, T2 | |
| C2 | F2: conn string never in logs/telemetry/errors (CQ5) | constraint | T9, T10 | negative tests |
| C3 | Whole-feature smoke runner exists and passes | deliverable | T16 | |

## Review Trail
- Plan reviewer: revision 1 -> ISSUES FOUND (5: semantic.ts >450L → StaticEmbeddingProvider moved to own file; CQ21 delete-on-entry contradiction → unified on replace-after-save; T13 extractFetchCalls misdirection → new regex, do-not-adapt note; T10/T15 register-tool-loaders.ts removed → TOOL_DEFINITIONS inline imports; G6b deferral row added for zuvo:db-audit --live)
- Plan reviewer: revision 2 -> ISSUES FOUND (2 minor: Technical Decisions table still said "adapt extractFetchCalls" contradicting T13; Task Authoring Notes referenced removed register-tool-loaders.ts)
- Plan reviewer: revision 3 -> APPROVED
- Cross-model validation: executed (partial — gemini + cursor-agent returned, 0 timeouts) -> 4 WARNING / 0 CRITICAL. Dispositions:
  - T16 vague GREEN -> FIXED rev 4 (enumerated 4-item wiring checklist tied to SMOKE1-4)
  - T13 missing real-repo recall gate -> FIXED rev 4 (tests/fixtures/outbound-corpus/ from real consumer files + recall ≥ 80% assertion)
  - T8 bloat / T8-T9 ownership gap -> FIXED rev 4 (Verify tightened: single command proves env→config→tool error chain; task kept whole — 4 files but one logical unit)
  - T15 risk concentration -> NOTE, no structural change: T15 RED already runs the suggested end-to-end fixture-group exercise BEFORE registration assertions, and SMOKE4 re-runs it at Phase Final; splitting registration out would add a task without new coverage
- Plan reviewer: revision 4 (post-adversarial verification pass) -> APPROVED
- DAG lint: revisions 1, 3, 4 -> valid (16 tasks, 0 violations)
- Status gate: Approved [AUTO-APPROVED per user's durable feedback-auto-execute preference — no plan-approval friction question]
- Phase 1: full fan-out (Architect → Tech Lead → QA Engineer, sequential)
- DAG lint: revision 1 -> valid (16 tasks, 0 violations)

## Task Breakdown

### Task 1: safetensors header/tensor parser
**Files:** `src/utils/safetensors-loader.ts`, `tests/utils/safetensors-loader.test.ts`
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier
*De-risking spike (rule 14): proves the F3 core mechanism (manual safetensors parse) before anything builds on it.*

- [ ] RED: `tests/utils/safetensors-loader.test.ts` — `parseSafetensors(buf)` on a synthetic minimal fixture (u64-LE header length + JSON header `{"embeddings":{"dtype":"F32","shape":[2,4],"data_offsets":[0,32]}}` + 32 bytes payload) returns a `Float32Array`-backed 2×4 matrix with exact values; malformed JSON header → throws descriptive error; header length > file size → throws; non-F32 dtype → throws; zero-row tensor shape `[0,4]` → returns empty matrix without throwing.
- [ ] GREEN: implement `parseSafetensors(buffer: Uint8Array): { name: string; shape: [number, number]; data: Float32Array }[]` + `getTensor(parsed, name)` in `src/utils/safetensors-loader.ts` (~60L; DataView for u64 length, JSON.parse header, subarray views for data). No filesystem I/O in this module.
- [ ] Verify: `npx vitest run tests/utils/safetensors-loader.test.ts`
  Expected: all tests pass, exit 0
- [ ] Acceptance Proof:
  - AC: G1 (parser slice)
    - Surface: backend-logic
    - Proof: `npx vitest run tests/utils/safetensors-loader.test.ts`
    - Expected: exit 0; assertions include exact float values round-tripped from fixture
    - Artifact: `zuvo/proofs/task-1-G1.txt`
- [ ] Commit: `add safetensors parser that extracts F32 tensors and rejects malformed headers`

### Task 2: HF Hub model download + cache util
**Files:** `src/utils/hf-hub-download.ts`, `tests/utils/hf-hub-download.test.ts`
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: `tests/utils/hf-hub-download.test.ts` — with `globalThis.fetch` mocked: `ensureModelFile(modelId, filename, cacheDir)` downloads to `<cacheDir>/<modelId-slug>/<filename>` and returns the path; second call returns cached path WITHOUT calling fetch (assert `fetchMock.mock.calls.length` unchanged); fetch rejection mid-stream → partial file is unlinked and error rethrown (assert file absent after failure); response with `content-length` > 500MB cap → aborts with descriptive error; download uses `AbortSignal` (assert signal passed to fetch).
- [ ] GREEN: implement `ensureModelFile(modelId, filename, cacheDir?, opts?)` (~80L) — URL `https://huggingface.co/<modelId>/resolve/main/<filename>`, `AbortSignal.timeout(30_000)`, stream to `<file>.tmp` then rename (atomic), unlink tmp in catch, `MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024`. Default cacheDir `join(config.dataDir, "models")`.
- [ ] Verify: `npx vitest run tests/utils/hf-hub-download.test.ts`
  Expected: all tests pass, exit 0 (no network touched — fetch fully mocked)
- [ ] Acceptance Proof:
  - AC: G1 (download slice) + C1
    - Surface: backend-logic
    - Proof: `npx vitest run tests/utils/hf-hub-download.test.ts && node -e "const p=require('./package.json'); if(Object.keys(p.dependencies||{}).some(d=>/safetensor|model2vec|hub/.test(d))) process.exit(1)"`
    - Expected: vitest exit 0 AND node exit 0 (no new hard dep added)
    - Artifact: `zuvo/proofs/task-2-G1-C1.txt`
- [ ] Commit: `add HF Hub model downloader with cache, 30s timeout, size cap, and partial-file cleanup`

### Task 3: StaticEmbeddingProvider (Model2Vec)
**Files:** `src/search/static-embedding-provider.ts` (NEW — own file keeps semantic.ts under the 450L limit), `tests/search/static-embedding-provider.test.ts`, `tests/fixtures/model2vec-mini/` (fixture safetensors + tokenizer.json — excluded from 5-file boundary)
**Surface:** backend-logic
**Complexity:** complex (new pattern: manual static-embedding inference, no codebase precedent)
**Dependencies:** Task 1, Task 2
**Execution routing:** deep implementation tier

- [ ] RED: `tests/search/static-embedding-provider.test.ts` — using a 4-token fixture vocab (known vectors): `new StaticEmbeddingProvider("minishlab/potion-code-16M")` has `dimensions === 256` (from KNOWN_LOCAL_DIMS) and `model` set; `embed(["hello world"])` with mocked `ensureModelFile` pointing at fixture returns mean-pooled L2-normalized vector matching hand-computed expected values (toBeCloseTo, 5 places); `embed([""])` returns a zero-safe vector (no NaN); unicode input does not throw; missing tokenizer file → descriptive error; `_resetStaticProviderForTesting()` clears the model cache (second construction re-reads).
- [ ] GREEN: create `src/search/static-embedding-provider.ts` (~110L) exporting `StaticEmbeddingProvider implements EmbeddingProvider` (import the interface from semantic.ts): lazy-load via Task 2 `ensureModelFile` (model.safetensors + tokenizer.json), parse via Task 1, simple WordPiece/unigram lookup from tokenizer.json vocab (fallback: whitespace+lowercase tokens mapped through vocab, OOV skipped), mean-pool token rows, L2-normalize, return `number[][]`. Module-level cache + `failedStaticModels` guard mirroring `LocalProvider` pattern; export `_resetStaticProviderForTesting`. Add `"minishlab/potion-code-16M": 256` to `KNOWN_LOCAL_DIMS` in semantic.ts (1-line change — acceptable same-file overlap with T4, serialized). `mode` parameter accepted and ignored (no task prefixes for Model2Vec — document in code).
- [ ] Verify: `npx vitest run tests/search/static-embedding-provider.test.ts tests/search/semantic.test.ts`
  Expected: new suite passes AND all existing semantic.test.ts tests still pass, exit 0
- [ ] Acceptance Proof:
  - AC: G1 (provider slice)
    - Surface: backend-logic
    - Proof: `npx vitest run tests/search/static-embedding-provider.test.ts`
    - Expected: exit 0; includes exact-value mean-pool assertion and dimensions===256 assertion
    - Artifact: `zuvo/proofs/task-3-G1.txt`
- [ ] Commit: `add StaticEmbeddingProvider running Model2Vec potion models without ONNX inference`

### Task 4: provider auto-detection + meta compat
**Files:** `src/search/semantic.ts`, `tests/search/semantic.test.ts`
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** Task 3 (same file — serialized per rule 13)
**Execution routing:** default implementation tier

- [ ] RED: extend `tests/search/semantic.test.ts` — `createEmbeddingProvider("local", { localModel: "minishlab/potion-code-16M" })` returns instance with `dimensions === 256` (StaticEmbeddingProvider); `createEmbeddingProvider("local", { localModel: "nomic-ai/nomic-embed-text-v1.5" })` still returns LocalProvider-shaped provider (768d) — existing 3 local-branch tests untouched and green; model id `"my-org/notapotion-v2"` does NOT route to static provider (prefix-match regression guard); a `"local-static"` literal does NOT exist anywhere (grep-style assertion via type test: EmbeddingMeta.provider accepts only the 4 existing literals).
- [ ] GREEN: in `createEmbeddingProvider` `case "local"`: `const m = config.localModel ?? DEFAULT_LOCAL_MODEL; if (m.startsWith("minishlab/potion") || m.includes("model2vec")) return new StaticEmbeddingProvider(m); return new LocalProvider(m);` — `StaticEmbeddingProvider` imported from `./static-embedding-provider.js`. No change to `EmbeddingMeta`, `Config.EmbeddingProvider` union, or meta serialization.
- [ ] Verify: `npx vitest run tests/search/ && npx tsc --noEmit`
  Expected: full search suite green, typecheck clean, exit 0
- [ ] Acceptance Proof:
  - AC: G1 (dispatch) + G2 (compat)
    - Surface: backend-logic
    - Proof: `npx vitest run tests/search/semantic.test.ts && git diff --exit-code src/types.ts src/config.ts`
    - Expected: vitest exit 0 AND git diff exit 0 (types.ts/config.ts untouched by F3 — meta union preserved)
    - Artifact: `zuvo/proofs/task-4-G1-G2.txt`
- [ ] Commit: `route potion/model2vec local models to StaticEmbeddingProvider, preserving nomic path and meta compat`

### Task 5: hash-snapshot storage module
**Files:** `src/storage/hash-snapshot.ts`, `tests/storage/hash-snapshot.test.ts`
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: `tests/storage/hash-snapshot.test.ts` (mirror registry.test.ts pattern, mkdtemp-injected path) — `saveHashSnapshot(path, snap)` + `loadHashSnapshot(path)` round-trip preserves `files` map exactly; load missing file → null; load corrupted JSON → null (never throws); load wrong `version` → null; load snapshot whose `repo` mismatches expected repo arg → null; `getSnapshotPath(indexPath)` maps `{hash}.index.json` → `{hash}.snapshot.json`; `deleteHashSnapshot(path)` idempotent on missing file.
- [ ] GREEN: implement `FileHashSnapshot { version: 1; repo: string; created_at: number; files: Record<string, string> }`, `saveHashSnapshot` (atomicWriteFile), `loadHashSnapshot(path, expectedRepo?)`, `getSnapshotPath`, `deleteHashSnapshot` (~90L).
- [ ] Verify: `npx vitest run tests/storage/hash-snapshot.test.ts`
  Expected: all tests pass, exit 0
- [ ] Acceptance Proof:
  - AC: G3 (storage slice)
    - Surface: backend-logic
    - Proof: `npx vitest run tests/storage/hash-snapshot.test.ts`
    - Expected: exit 0; includes corrupted-JSON→null and version-mismatch→null assertions
    - Artifact: `zuvo/proofs/task-5-G3.txt`
- [ ] Commit: `add persistent file-hash snapshot storage with corruption-safe null fallbacks`

### Task 6: indexFolder cold-start snapshot diff
**Files:** `src/tools/index-tools.ts`, `tests/integration/index-folder-snapshot.test.ts`
**Surface:** integration
**Complexity:** complex (1475-line hottest-path file; three logic regions touched)
**Dependencies:** Task 5
**Execution routing:** deep implementation tier

- [ ] RED: `tests/integration/index-folder-snapshot.test.ts` (CODESIFT_DATA_DIR + resetConfigCache + watch:false pattern) — (a) first `indexFolder` creates `{hash}.snapshot.json` with sha1 per indexed file; (b) second `indexFolder` with NO file changes parses zero files (assert via symbol identity / parse-counter test hook or by asserting `updated_at` of unchanged FileEntries preserved) and still returns correct file_count; (c) modify ONE file → only that file re-parsed (its symbols updated, others identical); (d) delete a file → second index drops it; (e) corrupt the snapshot file → full re-parse, no throw, snapshot rewritten valid; (f) DROP-guard rejection path leaves the PREVIOUS snapshot intact (seed: large existing index, force a tiny partial walk via include_paths, assert old snapshot survives).
- [ ] GREEN: in `indexFolder`: at start, capture `snapshotPath = getSnapshotPath(indexPath)` and load prior snapshot — snapshot is only REPLACED on success and VALIDATED on load (repo + version), so mid-run crash leaves the old snapshot which is then invalidated by hash mismatch naturally; replace the mtime-map cold-start block (:469-511) with: for each walked file compute sha1 (stream read), compare to snapshot — unchanged files reuse kept symbols/entries from `existing`, changed/new go to parse list; after successful `saveIndex` (post-:577), build and `saveHashSnapshot` for ALL files in the new index. The watcher/`indexFile` warm path untouched.
- [ ] Verify: `npx vitest run tests/integration/index-folder-snapshot.test.ts tests/integration/index-folder.test.ts tests/tools/index-folder-redundant.test.ts tests/integration/index-file-short-circuit.test.ts`
  Expected: new suite + all 3 existing index suites green, exit 0
- [ ] Acceptance Proof:
  - AC: G3
    - Surface: integration
    - Proof: `npx vitest run tests/integration/index-folder-snapshot.test.ts`
    - Expected: exit 0; includes assertions (b) zero-parse second run and (f) DROP-rejection preserves old snapshot
    - Artifact: `zuvo/proofs/task-6-G3.txt`
- [ ] Commit: `make indexFolder cold start diff a persistent sha1 snapshot and parse only changed files`

### Task 7: DROP_THRESHOLD partial-walk fix
**Files:** `src/tools/index-tools.ts`, `tests/integration/index-folder-snapshot.test.ts`
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** Task 6 (same file region — serialized per rule 13)
**Execution routing:** default implementation tier

- [ ] RED: add to `tests/integration/index-folder-snapshot.test.ts` — seed a 4-file repo, full index (file_count=4); re-run `indexFolder` with `max_files: 1`: must NOT be rejected by the sanity guard (no "SANITY CHECK FAILED" in result/warnings) and must return a usable index; re-run with a genuinely shrunken walk on an unrestricted full walk where 90% of files vanished → guard STILL fires (regression: legitimate drop detection preserved).
- [ ] GREEN: change the guard denominator at :533-547 from `existing.file_count` to `Math.min(walkedFileCount, existing.file_count)` where `walkedFileCount` reflects the actual walk result (post-max_files cap); when the walk was explicitly capped (`max_files` hit) or scoped (`include_paths`), skip the guard with a logged note instead of failing.
- [ ] Verify: `npx vitest run tests/integration/index-folder-snapshot.test.ts`
  Expected: both new guard tests pass alongside Task 6 suite, exit 0
- [ ] Acceptance Proof:
  - AC: G4
    - Surface: backend-logic
    - Proof: `npx vitest run tests/integration/index-folder-snapshot.test.ts -t "DROP"`
    - Expected: exit 0; capped-walk acceptance AND legit-drop rejection both asserted
    - Artifact: `zuvo/proofs/task-7-G4.txt`
- [ ] Commit: `anchor index sanity guard on actual walk size so capped or scoped walks stop false-positive drops`

### Task 8: pg optional dependency + config + import guard
**Files:** `package.json`, `src/config.ts`, `src/tools/pg-introspect-tools.ts` (skeleton), `tests/tools/pg-introspect-tools.test.ts`
**Surface:** config
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: `tests/tools/pg-introspect-tools.test.ts` — `loadPgClient()` when `import("pg")` rejects (vi.mock factory throwing) returns a structured error result `{ error: "pg not installed. Run: npm install pg" }` and never throws; `loadConfig().pgConnStr` reads `CODESIFT_PG_CONN_STR` env (set/unset cases, resetConfigCache between).
- [ ] GREEN: add `"pg": "^8.12.0"` to `optionalDependencies` (+ `@types/pg` to devDependencies); add `pgConnStr: string | null` to Config from `CODESIFT_PG_CONN_STR`; create `src/tools/pg-introspect-tools.ts` with `loadPgClient()` dynamic-import guard (journal-llm-client pattern) only — no queries yet.
- [ ] Verify: `npx vitest run tests/tools/pg-introspect-tools.test.ts -t "env" && npx vitest run tests/tools/pg-introspect-tools.test.ts && npx tsc --noEmit`
  Expected: exit 0 — the `-t "env"` invocation proves the full env→config→tool error chain in one command (CODESIFT_PG_CONN_STR unset → loadConfig().pgConnStr null → tool returns descriptive error, not throw), closing the T8/T9 ownership gap flagged by cross-model review
- [ ] Acceptance Proof:
  - AC: G5 (dep slice) + C1
    - Surface: config
    - Proof: `node -e "const p=require('./package.json'); if(p.dependencies&&p.dependencies.pg) process.exit(1); if(!p.optionalDependencies||!p.optionalDependencies.pg) process.exit(1)"`
    - Expected: exit 0 — pg present in optionalDependencies, absent from dependencies
    - Artifact: `zuvo/proofs/task-8-G5-C1.txt`
- [ ] Commit: `add pg as optional dependency with graceful import guard and CODESIFT_PG_CONN_STR config`

### Task 9: pg introspection core (information_schema → TableInfo/Relationship)
**Files:** `src/tools/pg-introspect-tools.ts`, `tests/tools/pg-introspect-tools.test.ts`
**Surface:** backend-logic
**Complexity:** complex (credential handling — CQ5 critical; external I/O — CQ8)
**Dependencies:** Task 8
**Execution routing:** deep implementation tier

- [ ] RED: extend `tests/tools/pg-introspect-tools.test.ts` with fully mocked `pg` module — `introspectPgSchema(connStr)`: 3 tables + 2 FKs fixture rows → correct `TableInfo[]` (names, columns with type/nullability, indexes) and `Relationship[]`; empty schema → empty arrays, no throw; client.connect rejection → error result whose message contains `[REDACTED]` and **does NOT contain any substring of connStr** (assert on full serialized result); `client.end()` called exactly once in success AND failure paths (finally semantics); `SET statement_timeout = 5000` issued before introspection queries; whole call races a 10s timeout (vi.useFakeTimers advance → timeout error, end() still called).
- [ ] GREEN: implement `introspectPgSchema(connStr, opts?: { schema?: string })` (~150L): new Client per call with `connectionTimeoutMillis: 5000`, try/finally end(), queries over `information_schema.columns/table_constraints/key_column_usage/referential_constraints` + `pg_catalog.pg_indexes`, map to `TableInfo`/`Relationship` (import types from sql-tools), `redact(msg, connStr)` helper applied in every catch.
- [ ] Verify: `npx vitest run tests/tools/pg-introspect-tools.test.ts`
  Expected: exit 0; redaction negative-assertion present
- [ ] Acceptance Proof:
  - AC: G5 + C2
    - Surface: backend-logic
    - Proof: `npx vitest run tests/tools/pg-introspect-tools.test.ts -t "redact"`
    - Expected: exit 0 — error path test asserts conn-str substrings absent from result JSON
    - Artifact: `zuvo/proofs/task-9-G5-C2.txt`
- [ ] Commit: `add read-only pg schema introspection with timeouts and credential redaction on every error path`

### Task 10: drift integration + introspect_pg MCP tool registration
**Files:** `src/tools/pg-introspect-tools.ts`, `src/register-tools.ts`, `tests/tools/pg-introspect-tools.test.ts`
**Surface:** api
**Complexity:** standard
**Dependencies:** Task 9
**Execution routing:** default implementation tier

- [ ] RED: extend tests — `pgDriftCheck(liveSchema, repo)` synthesizes comparison against migration-derived schema (mock getCodeIndex with SQL symbols fixture): added table live-only, missing column, type mismatch all reported; repo with no SQL symbols → clear "no migration schema" result. Registration test (mirror existing register-tools tests if present, else handler-level): tool `introspect_pg` callable, takes NO conn_str argument in its zod schema (env-only — assert schema keys), absent from `TOOL_ARG_FIELDS` in usage-tracker (read the map, assert no `introspect_pg` key).
- [ ] GREEN: implement `pgDriftCheck` reusing/adapting drift comparison against index-derived schema (shim CodeIndex path if `analyzeSchemaDrift` signature doesn't fit — do NOT change `analyzeSchemaDrift`'s signature); register `introspect_pg` as a ToolDefinition in the `TOOL_DEFINITIONS` array in `src/register-tools.ts` using an inline `await import("./tools/pg-introspect-tools.js")` in the handler (the established pattern for analysis tools — no `register-tool-loaders.ts` entry). Hidden/discoverable, category "analysis", schema: `{ schema?, drift_check?, repo? }`, conn from `loadConfig().pgConnStr`, error if unset.
- [ ] Verify: `npx vitest run tests/tools/pg-introspect-tools.test.ts tests/tools/sql-drift.test.ts && npx tsc --noEmit`
  Expected: exit 0; sql-drift existing suite untouched and green
- [ ] Acceptance Proof:
  - AC: G6 + C2
    - Surface: api
    - Proof: `npx vitest run tests/tools/pg-introspect-tools.test.ts -t "drift" && grep -c "introspect_pg" src/storage/usage-tracker.ts; test $? -eq 1`
    - Expected: vitest exit 0 AND grep finds zero occurrences (exit 1 from grep -c = 0 matches → test asserts that)
    - Artifact: `zuvo/proofs/task-10-G6-C2.txt`
- [ ] Commit: `register env-only introspect_pg tool with live-vs-migration drift check`

### Task 11: group registry storage + types
**Files:** `src/types.ts`, `src/storage/group-registry.ts`, `tests/storage/group-registry.test.ts`
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: `tests/storage/group-registry.test.ts` (registry.test.ts template) — registerGroup/getGroup/listGroups/removeGroup round-trips on mkdtemp path; overwrite same name updates `updated_at`; load missing file → empty registry; corrupted JSON → empty (no throw); group with 0 repos accepted; duplicate repo names within a group deduplicated on save.
- [ ] GREEN: add `RepoGroup { name; repos: string[]; description?; created_at; updated_at }` + `GroupRegistry { groups: Record<string, RepoGroup>; updated_at }` + `RepoEndpoint { repo; method; path; normalized_path; file }` + `ContractMatch { producer_repo; consumer_repo; method; path; consumer_file; consumer_line; confidence: "exact" | "partial" }` to `src/types.ts`; implement `src/storage/group-registry.ts` (~120L) on `groups.json` via atomicWriteFile with `isValidGroupRegistry` guard.
- [ ] Verify: `npx vitest run tests/storage/group-registry.test.ts && npx tsc --noEmit`
  Expected: exit 0 both
- [ ] Acceptance Proof:
  - AC: G7
    - Surface: backend-logic
    - Proof: `npx vitest run tests/storage/group-registry.test.ts`
    - Expected: exit 0; corruption→empty and dedup assertions present
    - Artifact: `zuvo/proofs/task-11-G7.txt`
- [ ] Commit: `add persistent repo-group registry with corruption-safe load and normalized contract types`

### Task 12: endpoint adapters (hono/nest/nextjs → RepoEndpoint)
**Files:** `src/tools/cross-repo-contract-tools.ts`, `tests/tools/cross-repo-contract-tools.test.ts`
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** Task 11
**Execution routing:** default implementation tier

- [ ] RED: `tests/tools/cross-repo-contract-tools.test.ts` — three adapter functions tested independently with synthetic inputs: hono `{summary:[{path:"/users/:id",method:"get",file}]}` → `RepoEndpoint` with `normalized_path:"/users/{param}"`; nest `{routes:[{path:"/users/{id}",method:"GET",...}]}` → same normalized form; nextjs handlers for `app/users/[id]/route.ts` → same; undefined/empty `summary` → empty array (no throw — QA Risk 5); method case normalized to upper.
- [ ] GREEN: create `src/tools/cross-repo-contract-tools.ts` with `normalizePathParams(path)` (`:id`/`{id}`/`[id]`/`[...slug]` → `{param}`) + `adaptHonoContract`, `adaptNestInventory`, `adaptNextjsContract` (import the two colliding `ApiContractResult` types with aliases `HonoContractResult`/`NextjsContractResult`), each → `RepoEndpoint[]`.
- [ ] Verify: `npx vitest run tests/tools/cross-repo-contract-tools.test.ts`
  Expected: exit 0
- [ ] Acceptance Proof:
  - AC: G8 (producer slice)
    - Surface: backend-logic
    - Proof: `npx vitest run tests/tools/cross-repo-contract-tools.test.ts -t "adapter"`
    - Expected: exit 0; all three param styles normalize to identical `{param}` form
    - Artifact: `zuvo/proofs/task-12-G8.txt`
- [ ] Commit: `normalize hono, nest, and nextjs endpoint shapes into one RepoEndpoint contract form`

### Task 13: outbound HTTP call extractor (consumer side)
**Files:** `src/tools/cross-repo-contract-tools.ts`, `tests/tools/cross-repo-contract-tools.test.ts`
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** Task 12 (same file — serialized per rule 13)
**Execution routing:** default implementation tier

- [ ] RED: extend tests — `extractOutboundCalls(source, file)`: `fetch("/api/users/1")` → static call entry; `` fetch(`${BASE}/users/${id}`) `` → entry with static prefix `"/users/"` semantics flagged `partial: true` (prefix after stripping leading `${...}` segment); `axios.get('/orders')`, `got.post("/x")` captured; method inference (fetch default GET, `{method:"POST"}` second-arg literal detected); plain string concat `'/users/' + id` → prefix partial; no matches in unrelated source → empty; unicode/comment noise ignored (reuse strip approach if trivial). **Real-corpus recall gate (cross-model fix):** add `tests/fixtures/outbound-corpus/` containing 2-3 REAL consumer source files copied from the user's repos (e.g. an api-client file from tgm-survey-platform designer, a QuotasMobi fetch wrapper) with a hand-labeled expected-calls manifest (`expected.json`); assert recall ≥ 80% of labeled calls detected (exact or partial) — this is the gate that catches "perfect on synthetic strings, zero matches on real code".
- [ ] GREEN: write a NEW regex-based `extractOutboundCalls` returning `{ url_prefix, method, partial, file, line }[]`. Do NOT attempt to adapt `extractFetchCalls` from `src/utils/nextjs-metadata-readers.ts` — it is AST-based (takes a `Parser.Tree`) and Next.js-specific (fetch/cookies/headers only, no axios/got); a regex over raw source is the decided approach (Tech Lead trade-off table). Patterns: `fetch(`, `axios.(get|post|put|patch|delete)(`, `got.(get|post|put|patch|delete)(` with first-arg string/template-literal capture.
- [ ] Verify: `npx vitest run tests/tools/cross-repo-contract-tools.test.ts`
  Expected: exit 0
- [ ] Acceptance Proof:
  - AC: G8 (consumer slice)
    - Surface: backend-logic
    - Proof: `npx vitest run tests/tools/cross-repo-contract-tools.test.ts -t "outbound"`
    - Expected: exit 0; template-literal partial-prefix case asserted (the case that otherwise yields zero matches in real repos)
    - Artifact: `zuvo/proofs/task-13-G8.txt`
- [ ] Commit: `extract outbound fetch, axios, and got calls with template-literal partial prefixes`

### Task 14: pure contract matcher
**Files:** `src/tools/cross-repo-contract-tools.ts`, `tests/tools/cross-repo-contract-tools.test.ts`
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** Task 12, Task 13 (same file — serialized)
**Execution routing:** default implementation tier

- [ ] RED: extend tests — `matchContracts(producers: RepoEndpoint[], consumers)`: exact path+method match → `confidence:"exact"`; consumer partial prefix `/users/` matches producer `/users/{param}` → `confidence:"partial"`; method mismatch → no match; same-repo producer/consumer pairs excluded; multiple consumers of one endpoint all reported; empty inputs → empty output; "who calls GET /users/{param}" answerable by filtering result (assert shape).
- [ ] GREEN: implement `matchContracts` as a pure function (no I/O), normalized-path prefix matching for partial consumers, dedupe per (producer, consumer_file, line).
- [ ] Verify: `npx vitest run tests/tools/cross-repo-contract-tools.test.ts`
  Expected: exit 0
- [ ] Acceptance Proof:
  - AC: G8 (matcher slice)
    - Surface: backend-logic
    - Proof: `npx vitest run tests/tools/cross-repo-contract-tools.test.ts -t "match"`
    - Expected: exit 0; exact + partial + negative (method-mismatch) all asserted
    - Artifact: `zuvo/proofs/task-14-G8.txt`
- [ ] Commit: `match producer endpoints to cross-repo consumers with exact and partial confidence`

### Task 15: group tools orchestration + MCP registration
**Files:** `src/tools/cross-repo-contract-tools.ts`, `src/register-tools.ts`, `tests/tools/cross-repo-contract-tools.test.ts`
**Surface:** api
**Complexity:** complex (cross-repo fan-out, 2 registration files, framework detection per repo)
**Dependencies:** Task 11, Task 14, Task 10 (register-tools.ts/loaders same-file serialization with F2 — rule 13)
**Execution routing:** deep implementation tier

- [ ] RED: extend tests with mocked `getCodeIndex` + fixture group — `matchGroupContracts("tgm")` over 2 synthetic repos (one hono producer, one consumer source) returns ContractMatch[] end-to-end; repo in group but not indexed → collected warning, others still processed; group missing → error result; >20 repos → capped with truncation warning (CQ6); `findEndpointConsumers(group, "GET", "/users/{param}")` filters matches. Registration: tools `repo_group` (create/list/remove via action param) + `match_group_contracts` + `find_endpoint_consumers` present in TOOL_DEFINITIONS as hidden tools.
- [ ] GREEN: implement orchestration: load group → per repo detect framework (reuse existing detection signals from index/framework detect util) → run matching adapter → collect producers; scan consumer repos' indexed source files for outbound calls (bounded: indexed files only) → `matchContracts`; register 3 ToolDefinitions in the `TOOL_DEFINITIONS` array in `src/register-tools.ts` with inline dynamic imports (no `register-tool-loaders.ts` entries); `MAX_GROUP_REPOS = 20`.
- [ ] Verify: `npx vitest run tests/tools/cross-repo-contract-tools.test.ts && npx tsc --noEmit && npm run build`
  Expected: exit 0 all three
- [ ] Acceptance Proof:
  - AC: G8 + G7
    - Surface: api
    - Proof: `npx vitest run tests/tools/cross-repo-contract-tools.test.ts -t "group"`
    - Expected: exit 0; end-to-end fixture-group match + unindexed-repo warning + cap behavior asserted
    - Artifact: `zuvo/proofs/task-15-G8-G7.txt`
- [ ] Commit: `add repo group tools answering who-calls-this-endpoint across indexed services`

### Task 16: whole-feature smoke runner
**Files:** `tests/integration/smoke-four-features.test.ts`
**Surface:** integration
**Complexity:** standard
**Dependencies:** Task 4, Task 7, Task 10, Task 15
**Execution routing:** default implementation tier

- [ ] RED: author `tests/integration/smoke-four-features.test.ts` containing the four smoke proofs below as executable tests (mocked network/pg, real filesystem + real fixture indexes). Initially red only if any feature slice regressed — this task's RED step is authoring + first full run.
- [ ] GREEN: fix any cross-feature integration issues surfaced. Enumerated checklist (cross-model fix — each item must be individually verified, not assumed):
  1. SMOKE1: `createEmbeddingProvider` import resolves `StaticEmbeddingProvider` from `./static-embedding-provider.js` (wiring, not just unit pass);
  2. SMOKE2: snapshot path derives from the SAME `getIndexPath` the index used (no path divergence between save and load);
  3. SMOKE3: `introspect_pg` reads `CODESIFT_PG_CONN_STR` via `loadConfig()` (env set in-test) and the serialized result is grepped for conn-str substrings (zero expected);
  4. SMOKE4: `repo_group`/`match_group_contracts`/`find_endpoint_consumers` are present in TOOL_DEFINITIONS (registration wiring) AND `matchGroupContracts` returns the partial-confidence match on the fixture pair.
- [ ] Verify: `npx vitest run tests/integration/smoke-four-features.test.ts && npx vitest run`
  Expected: smoke suite green AND full repo suite green (no regressions), exit 0
- [ ] Acceptance Proof:
  - AC: C3 (+ SMOKE1-4 below)
    - Surface: integration
    - Proof: `npx vitest run tests/integration/smoke-four-features.test.ts`
    - Expected: exit 0, 4 smoke tests passed
    - Artifact: `zuvo/proofs/smoke-four-features.txt`
- [ ] Commit: `add whole-feature smoke suite covering embeddings, snapshot sync, pg introspection, and contract matching`

## Whole-feature Smoke Proofs

- **SMOKE1 — static embedding round-trip (F3)**
  - Preconditions: fixture model2vec vocab (Task 3 fixture), `ensureModelFile` mocked to fixture paths
  - Proof: `createEmbeddingProvider("local", { localModel: "minishlab/potion-code-16M" }).embed(["function foo() {}"])` inside the smoke test
  - Expected: 256-dim L2-normalized vector; provider instanceof StaticEmbeddingProvider; nomic model id still routes to LocalProvider in same test
  - Artifact: `zuvo/proofs/smoke-four-features.txt` (shared runner output)
- **SMOKE2 — snapshot cold-start (F4)**
  - Preconditions: tmp fixture repo (3 TS files), CODESIFT_DATA_DIR tmpdir
  - Proof: indexFolder → modify 1 file → indexFolder again
  - Expected: second run parses exactly 1 file (others reused), file_count stable, snapshot file valid JSON v1
  - Artifact: shared runner output
- **SMOKE3 — pg introspect + drift (F2)**
  - Preconditions: pg module mocked with 2-table fixture; migration-schema fixture index
  - Proof: `introspectPgSchema(connStr)` then `pgDriftCheck(live, repo)`
  - Expected: TableInfo[2], Relationship[1], drift reports the seeded missing-column; serialized result contains zero conn-str substrings
  - Artifact: shared runner output
- **SMOKE4 — group contract match (F1)**
  - Preconditions: 2 synthetic CodeIndexes (hono producer with GET /users/:id; consumer with `` fetch(`${B}/users/${id}`) `` source), group registered in tmp groups.json
  - Proof: `matchGroupContracts(group)` then `findEndpointConsumers(group, "GET", "/users/{param}")`
  - Expected: ≥1 ContractMatch with confidence "partial", consumer file+line correct
  - Artifact: shared runner output

## Task Authoring Notes

- Same-file serialization (rule 13): semantic.ts → T3→T4; index-tools.ts → T6→T7; cross-repo-contract-tools.ts → T12→T13→T14→T15; register-tools.ts → T10→T15.
- Feature independence: F3 (T1-T4), F4 (T5-T7), F2 (T8-T10), F1 (T11-T15) have no cross-feature dependencies except T15→T10 (registration-file serialization) and T16→all.
- Fixtures (`tests/fixtures/model2vec-mini/`, synthetic safetensors buffers) excluded from 5-file boundaries per rule 2.
