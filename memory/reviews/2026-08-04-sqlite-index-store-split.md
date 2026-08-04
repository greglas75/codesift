<!-- zuvo-review -->
range: c3d5a2a..HEAD
files: src/storage/sqlite-index-store.ts,src/storage/sqlite/runtime.ts,src/storage/sqlite/errors.ts,src/storage/sqlite/schema.ts,src/storage/sqlite/rows.ts,src/storage/sqlite/connection.ts,src/storage/sqlite/meta.ts,src/storage/sqlite/index-io.ts,src/storage/sqlite/accessors.ts,tests/storage/sqlite-module-state.test.ts,tests/storage/sqlite-fault-classification.test.ts,tests/storage/index-storage-errors.test.ts,CLAUDE.md
tier: 3
verdict: APPROVE
date: 2026-08-04

# Review — B-2: splitting `sqlite-index-store.ts` (1122L, 22 exports, 8 responsibilities)

**TIER 3** · mixed · 13 files · 4 commits · Deployment risk **MEDIUM (3)** — no auth, money or API
contract; but this is the storage layer every tool reads through, and three of the four commits
change error paths.

Commits: `27a221f` the move · `6df1df4` fault classification · `fbde1f0` in-flight open dedup ·
`3056c5c` faults on first page read.

## The move, and why it is separable from everything else

Splitting a file this size is only reviewable if the split itself is provably nothing but a split.
It is, and that was established mechanically rather than by reading:

- **677 executable lines on each side, 0 lost, 0 gained** — a bidirectional multiset diff between
  `git show HEAD:...` and the union of the nine files, normalising away comments, import plumbing,
  and the `export` keyword added to the 18 units that had been module-private.
- An independent adversarial reviewer compared **all 50 top-level declarations** and found 0
  differences: no renamed identifier, no changed literal, no `const`/`let` flip, no reordered
  statement.
- **Cycles identical before and after**: 5 pre-existing, none in `src/storage/`. Checked, not
  assumed — `find_circular_deps` is revealed but not callable in this build, so an import-graph DFS
  over all of `src/` was run against both trees.

Because that holds, the four correctness fixes could be committed separately, each with its own
red-first test, instead of hiding inside a 1000-line diff.

## The hazard the plan named, and what it took to actually test it

Two module-scope mutable bindings live here: the memoised `node:sqlite` constructor and the
open-connection cache. ESM gives one instance per module, so re-exporting is safe and re-declaring
forks the state — into a `closeIndexDb` that closes a handle somebody else is still handing out.
Type-check, lint and every existing test pass straight over that.

`setSqliteCtorForTesting` had **zero consumers anywhere in the repo**, so the one moved unit with no
coverage was the one guarding the split. The new test was written and proven green against the
PRE-refactor code before any production file was touched.

Two defects in my own first draft of that test, both found by the blind audit:

- **R-1 [MUST-FIX] The memo test passed for the wrong reason.** An implementation with *no memo at
  all* — re-importing `node:sqlite` on every call — satisfied both assertions, because the pinned
  value was only ever checked through the same module's own reader. Now a sentinel constructor pins
  identity across calls.
- **R-2 [MUST-FIX] The docstring claimed more than the tests did.** It said every test observed the
  state cross-module; only one did. The same-module cases are now labelled as the weaker guarantee
  they are, and genuine cross-module cases were added for the read path (`openReadConnection`
  resolves the ctor independently of `openIndexDb`) and for `accessors -> connection`.

## Pre-existing defects the audits surfaced — all carried across verbatim, all fixed

**R-3 [MUST-FIX] `classifyStorageError` was dead for every `node:sqlite` fault.**
`src/storage/sqlite/errors.ts` — the driver sets `code = "ERR_SQLITE_ERROR"` on every fault and puts
the real result code in `errcode`, as a number. The allowlist was written against `code`, so only
the four message regexes ever fired. Reproduced on node v24.18.0: `SQLITE_FULL` (13),
`SQLITE_READONLY` (8) and `SQLITE_PERM` (3) returned `null` — and `null` means "not a storage
fault", which every read path turns into `index = null`. A full disk reported as an empty repo.

**R-4 [MUST-FIX] Four write paths destroyed their own diagnosis.** SQLite auto-rolls back on FULL,
IOERR, NOMEM and INTERRUPT, so the explicit `ROLLBACK` in the catch threw `cannot rollback - no
transaction is active` and *that* propagated. Reproduced. Now one `rollbackQuietly` helper.

**R-5 [MUST-FIX] Concurrent opens orphaned a handle.** `openIndexDb` was a check-then-act across two
awaits; `Promise.all([openIndexDb(p), openIndexDb(p)])` returned two distinct handles, and the
overwritten one is in no map, so nothing can ever close it — a leaked descriptor arriving on exactly
the EMFILE/BUSY conditions the file works to avoid.

**R-6 [MUST-FIX, found by neither audit] A corrupt-page fault escaped unclassified.** The guard in
`openIndexDb` carries a comment saying a corrupt file "fails here, before any row is read". True of a
corrupt header, false of corrupt data pages: `CREATE TABLE IF NOT EXISTS` only consults
sqlite_schema and succeeds. The first statement touching a real page is the `schema_version` meta
read — outside the guard. This fell out of a test aimed at something else, which failed for a reason
that was not the reason it was written. Recording it because the instinct in that moment is to
adjust the assertion until it agrees.

**R-7 [RECOMMENDED] Write paths and narrow accessors never classified at all** (closes the standing
backlog item `rethrowOperational-coverage`). **R-8 [RECOMMENDED] A newer-schema index threw a plain
Error**, which every caller doing `if (isIndexStorageError(err)) throw err;` swallowed into
`index = null` — so the "Upgrade codesift-mcp" instruction reached nobody. **R-9 [NIT]** `instanceof`
used where this same file documents it as unsafe. **R-10 [NIT]** the file-row footprint counted
`path.length` and ignored `language`, under-reporting on the two axes the symbol-row helper's
comment rules out.

## Rejected, with reasons

- **"The split leaked 18 previously-private names."** True, and it is the adversarial pass's only
  surviving refutation of "no consumer can observe any difference". But it is inherent to splitting
  a file whose units call each other; none reaches the facade, and the facade re-exports an
  **explicit list** rather than `export *`, so the public surface did not move. Accepted, recorded.
- **"Fix the check-then-act in `saveIncrementalSqlite` too."** Real (**B-14**), and deliberately not
  folded in: moving the `meta.repo` read inside the transaction changes locking on the hottest write
  path — the postindex hook, one process per edited file — and deserves its own measurement rather
  than a ride on a refactor.
- **"Delete `setSqliteCtorForTesting`, it has no consumers."** It has one now. Deleting an export
  mid-move would have turned a provable move into an API change.

## What this run bought

No single lens found more than half of it. The adversarial pass cleared all six behaviour attacks
and would have signed off; the blind CQ auditor found six real defects it never looked for; and the
one defect neither found (**R-6**) came from a test failing unexpectedly. The recurring shape across
all of them is unchanged from earlier this session: **the defect was a comment that overclaimed
relative to its code** — "node:sqlite surfaces extended result codes" (it does not), "fails here,
before any row is read" (only for headers), and my own test docstring.

## Verification

`tsc --noEmit` clean · `biome lint` clean (941 files) · **383 files / 5402 tests green, 3 skipped**
(from 381/5386 at c3d5a2a: +2 files, +16 tests). Every remediation test proven RED against the
pre-fix modules and green after — 5/6, 1/1, 1/1 respectively.

## Backlog

- **B-14** check-then-act outside the transaction in the two incremental write paths (NIT).
- B-6, B-7, B-8 from earlier reviews remain open; ADR-004 stage 2 continues (~346 `loadIndex` call
  sites across ~149 files).
