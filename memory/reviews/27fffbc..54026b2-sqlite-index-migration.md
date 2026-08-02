<!-- zuvo-review -->
range: 27fffbc..54026b2
adversarial: zuvo/proofs/adv-27fffbc-54026b2.txt
files: src/storage/sqlite-index-store.ts,src/storage/index-store.ts,src/tools/index-tools/file-indexer.ts,src/register-tools/runtime.ts

# Code review — SQLite index migration (`refactor/sqlite-index-migration`)

**Date:** 2026-08-02 | **Tier:** 3 (DEEP) | **Mode:** FIX-AUTO | **SELF-REVIEW:** yes (`--multi`)
**Range:** `27fffbc..HEAD` | 11 non-noise files, +1755/-115 (20 deleted `zuvo/contracts/*.json` excluded as data noise)
**Intent:** REFACTOR (storage format) | **Deployment risk:** 4/9 → MEDIUM (new production files +1, multi-service blast radius +1, >500 lines +1, rollback-sensitive +1). No auth, money, DB-schema or API-contract signal.

## Verdict

**APPROVE.** 5 adversarial findings confirmed and fixed in-loop, 4 delta findings confirmed and fixed,
3 refuted with evidence, 1 deferred to backlog with a recipe. Full suite green at every gate.

## Scope fence

`src/storage/sqlite-index-store.ts`, `src/storage/index-store.ts`, `src/tools/index-tools/file-indexer.ts`,
`src/register-tools/runtime.ts`, `tests/storage/*`, `tests/integration/index-folder-snapshot.test.ts`,
`docs/adr/ADR-003-index-storage-format.md`, `README.md`, `CLAUDE.md`.

## Findings

### MUST-FIX — all applied

**R-1 [CONFIRMED 3/3 providers] Unbounded materialised-index cache**
`src/storage/index-store.ts:196` — one full `CodeIndex` per repo, retained for process lifetime,
no ceiling. The JSON equivalent is 262 MB on tgm-survey-platform and `codesift serve` is a
long-lived daemon. This would have been the only cache in the codebase without a ceiling, beside
an embedding cache that is explicitly RAM-budgeted (`CODESIFT_MAX_EMBEDDING_MEM_MB`) — the exact
asymmetry behind the OOM reports recorded in CLAUDE.md.
**Fix:** bounded LRU, `CODESIFT_MAX_CACHED_INDEXES` (default 3).

**R-2 [CONFIRMED 2/3] Cross-process migration lost-update**
`src/storage/index-store.ts:82` — the migration guard was an in-process `Map`, but
`codesift postindex-file` is a fresh process per edit. Two of them could both observe an empty
db, both read the legacy JSON, and the slower writer overwrite an incremental update the faster
one had already committed.
**Fix:** `importLegacyIndexIfEmpty` (`src/storage/sqlite-index-store.ts:366`) performs the
emptiness check and the import inside one `BEGIN IMMEDIATE` transaction, so the write lock is
held before the check. The straggler imports nothing.

**R-3 [CONFIRMED 2/3] Cached index handed out by reference**
`src/storage/index-store.ts:245` — the documented "callers only read" invariant was already
false: `tests/integration/index-folder-snapshot.test.ts` reassigns `files` on a `loadIndex`
result. A mutation is invisible to `data_version`, so it would poison every later reader.
**Fix:** `copyIndex` detaches the `files`/`symbols` array containers on every return, on both the
hit and the miss path. (The first attempt copied only on hits — caught by the test written for it.)

**R-4 [CONFIRMED 1/3 + independent self-review] Silent stale index after rollback**
`src/storage/index-store.ts` (`warnIfRollbackIsStale`) — the retained `.json` is frozen at
migration time. Pinning `CODESIFT_INDEX_BACKEND=json` later serves a valid-shaped, version-matching,
weeks-old index with no error and no empty result: confidently wrong.
**Fix:** one-time `console.error` naming the age gap and the two ways out.

### RECOMMENDED — all applied (localized)

**R-5 [CONFIRMED 2/3] Duplicated `.json`→`.db` derivation**
`src/register-tools/runtime.ts:178` re-derived the path inline instead of importing
`sqlitePathFor`. This token exists to track whichever file backs the index; a derivation that
drifts from the storage layer silently pins the cache key.
**Fix:** import the shared helper.

**R-6 [delta, CONFIRMED] Eviction was FIFO, not LRU**
`cacheIndex` ran only on a miss, so a hit never refreshed recency — the hottest repo would be
evicted first once an (N+1)th repo was touched. **Fix:** re-insert on hit.

**R-7 [delta, CONFIRMED] `CODESIFT_MAX_CACHED_INDEXES=0` silently became 3**
`Number("0") || 3` treats a deliberate 0 as unset. **Fix:** explicit `Number.isNaN` guard.

**R-8 [delta, CONFIRMED] Stale-rollback warning could be permanently suppressed**
The path was marked "warned" before the comparison, so a JSON-pinned daemon that read the repo
before any `.db` existed would never warn once one appeared. **Fix:** mark only after a real
comparison.

### REFUTED — with evidence

**R-9 `ensureSqliteMigrated` check-then-act race** (cursor-agent, WARNING) — there is no
suspension point between `migrations.get` and `migrations.set`: the async IIFE runs synchronously
to its first internal `await` and returns control to complete the `set`. No interleaving possible.

**R-10 "partial write looks migrated"** (claude, WARNING) — `writeIndexRows` runs inside
`BEGIN`/`COMMIT` and writes the `repo` meta key in the same transaction; `loadIndexSqlite`
returns null without that key. A killed write rolls back and reads as empty, never as complete.

**R-11 `saveIndex` bypasses `ensureSqliteMigrated`** (cursor-agent, CRITICAL) — the proposed fix
does not address its own scenario: importing the JSON and then immediately overwriting it with a
full `saveIndex` yields the same end state as not importing. `saveIndex` replaces the whole index
by contract.

### Deferred to backlog

**B-sqlite-operational-errors** — `loadIndexOrStale` / `readIndex` convert SQLite operational
failures (locked, corrupt, permission) into `null`, i.e. "no index", so callers cannot distinguish
transient storage failure from an absent index.
**Defer-reason:** structural-refactor (multi-file) — changing the error contract touches all 9
production importers of `index-store`.
**Recipe:** (1) introduce `IndexReadError` distinguishing not-found/invalid from operational;
(2) propagate operational errors from `readIndex`; (3) update the 9 importers to surface rather
than rebuild.

## CQ evaluation

- `src/storage/sqlite-index-store.ts` (546 NL) | 40/40 clean
- `src/storage/index-store.ts` (585 NL) | 40/40 clean
- `src/register-tools/runtime.ts` (delta only) | 40/40 clean
- `src/tools/index-tools/file-indexer.ts` (delta only) | 40/40 clean

CQ8 verified by `search_patterns(empty-catch)` — 0 matches across 143 scanned symbols; every added
`catch` either assigns, returns, or carries an explanatory comment.

## Verification

- `npx tsc --noEmit` — clean at every gate
- Full suite: **368 files, 5266 passed, 3 skipped, 0 failed**
- Storage subset after each fix round: 350/350
- Benchmark (4k files / 32k symbols): `saveIncremental` 10.8× faster, per-file mtime read ~2500×,
  warm `loadIndex` ~17800×; cold `loadIndex` 3.1× and full `saveIndex` 2.1× **slower** (documented
  trade — rare paths pay).

## Pre-existing, out of scope

`tests/storage/hono-cache-benchmark.test.ts` failed intermittently under machine load during this
session (timing-based benchmark, `model.routes.length === 0`). Verified pre-existing by stashing
the entire change set and reproducing the identical failure. Green in the final runs.

## Skipped steps

- `changed_symbols`: absent-in-build (git-native `diff | grep '^+export'`: 23 new exports)
- `impact_analysis`: called, but answered for the MAIN checkout (H19 — returned `src/cli/commands.ts`,
  `package.json` from another session's uncommitted work). Substituted with a git-native importer
  scan: 9 production importers of `index-store`.
- `diff_outline`: absent-in-build (`get_file_outline` + bounded `Read`)
- `scan_secrets`: absent-in-build (grep secret-scan: 0 hits)
- CodeSift generally: `partial` — the index spans both the main checkout and this worktree, so
  results were path-filtered; several calls exceeded the 120 s tool timeout.

## Quality wins

1. The measured regressions (cold load, full save) are published in the ADR and the README rather
   than omitted — a table of only-wins would have misled anyone sizing this.
2. The cross-process cache-invalidation bug (`getRepoIndexVersion` keying on a frozen `.json`) was
   caught by the full suite, not by the 82 new unit tests — recorded in the commit message so the
   next storage change does not trust unit tests alone.
3. `-wal` inclusion in the index-version token: a WAL commit need not touch the main db file until
   checkpoint, so statting `.db` alone would have missed exactly the recent writes the token exists
   to catch.
