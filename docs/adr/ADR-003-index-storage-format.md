# ADR-003: Index Storage Format — SQLite instead of one JSON blob per repo

**Status:** Accepted
**Date:** 2026-08-02 | **Deciders:** Greg Laskowski | **Area:** Storage

---

## Context

The per-repo index has been a single JSON document since the original rewrite. It was never
an explicit decision: `docs/IMPLEMENTATION_PLAN.md` v1.0 (2026-03-13) contains the line
`index-store.ts # Atomic JSON save/load, lock-free reads`, and that line is the entire
provenance. There is no prior ADR for storage — ADR-001 covers TypeScript + web-tree-sitter,
ADR-002 covers semantic search. The format was therefore never revisited, only worked around.

At 21 symbols and a handful of tools the choice was correct. It no longer is.

### Measured cost (2026-07-30, live indexes)

| repo | index size | read + parse + stringify | observed `index_file` median |
|---|---:|---:|---:|
| tgm-survey-platform | 262 MB | 1854 ms | 3711 ms |
| translation-qa | 130 MB | 849 ms | 1218 ms |
| codesift | 26 MB | 169 ms | 131 ms |

Telemetry over 10,613 `index_file` calls: **235 ms median, p90 6.2 s, p99 29 s, 7.5 h of
cumulative wall clock**. The frequently-quoted "9 ms" figure is the unchanged-file
short-circuit, not the write path.

Two structural costs drive this, and neither is patchable within the format:

1. `saveIncremental` performs a full `loadIndex` + `saveIndex` per changed file. Re-indexing
   one 40-line file rewrites all 262 MB.
2. `file-indexer.ts` parses the whole blob purely to read one file's `mtime_ms`, then
   `saveIncremental` parses it again — two full parses per first-touch edit.

### Why the existing mitigations are not enough

`enqueueIndexMutation` folds a burst of concurrent mutations into one load+save. It helps
exactly one access pattern. An agent that awaits each `index_file` before issuing the next
still pays the full cycle per file, and the PostToolUse hook (`codesift postindex-file`) is a
**fresh process per edit** and therefore cannot batch at all — which is the single most
frequent write path in production.

The obvious remaining lever, an in-memory index cache, is unsafe today for a reason recorded
in `CLAUDE.md`: the hook writes the same index from a separate process, so a cached copy in
the MCP server would silently clobber the hook's writes. There is no cross-process
invalidation signal in a plain JSON file.

### Constraints

- The package is published to npm and launched via `npx -y codesift-mcp` on arbitrary user
  machines. A storage change must not require a build toolchain at install time.
- `package.json` declares `engines: {"node": ">=20.0.0"}`. Any built-in-module dependency
  must be weighed against dropping Node 20 users.
- Existing users have live indexes on disk (21.9 GB of embeddings alone). Migration must be
  automatic and must not force a full reindex of every repo.
- The MCP server and the CLI hook are **separate processes writing the same index
  concurrently**. Whatever replaces JSON must make that safe rather than merely tolerable.
- 8 production files call into `index-store.ts`. The public shape of that module is the
  migration's blast radius and should stay stable.

---

## Decision

Replace the per-repo JSON blob with a **per-repo SQLite database** (`<hash>.db`) holding
normalized `files` and `symbols` tables, accessed through the **built-in `node:sqlite`
module**, in **WAL mode**.

`index-store.ts` keeps its current exported functions so call sites do not churn. Alongside
them it gains narrow, single-purpose accessors (`getFileMtime`, `upsertFileSymbols`,
`getSymbolsForFile`) that let the hot paths touch one row instead of the whole index.

JSON remains readable indefinitely: on first access of a repo that has only `<hash>.json`,
the store migrates it into `<hash>.db` and leaves the JSON in place as a rollback artifact.

---

## Options Considered

### Option A: SQLite via `node:sqlite` ← **CHOSEN**

**Architecture:** normalized schema, `PRAGMA journal_mode=WAL`, per-file upserts inside a
transaction, `PRAGMA data_version` as the cross-process cache-invalidation signal.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium — real schema + migration path, but the call-site surface is only 8 files |
| Install cost | **Zero** — built into Node, no native build, no prebuild matrix, no postinstall |
| Incremental write | O(changed rows) instead of O(index size) |
| Multi-process | Solved by design — WAL supports concurrent readers with one writer |
| In-memory cache | Becomes *safe*: `PRAGMA data_version` changes when another process writes |
| Lock-in | LOW — SQL over a normalized schema; the data can be dumped back to JSON |

**Cost:** `node:sqlite` landed in Node 22.5 (stable in 24) and does not exist on the declared
`>=20.0.0` floor.

**Resolution — degrade, do not break.** The engines floor stays at `>=20.0.0`. The store
detects `node:sqlite` at load time; when it is absent the JSON backend is used unchanged and
a single startup line records why. This costs nothing extra: the dual-format path is already
required for migration (existing users have JSON on disk) and for rollback, so supporting an
old runtime reuses machinery that must exist regardless.

Node 20 went end-of-life in April 2026, so the population still on it is small and shrinking;
they keep today's behaviour rather than losing the package. The JSON backend can be deleted
in a later major once telemetry shows the Node 20 share is negligible — that deletion is a
separate decision, deliberately not bundled here.

### Option B: `better-sqlite3`

Same schema and semantics, works on Node 20.

Rejected: it is a native module. Every user install would need either a matching prebuilt
binary or a local toolchain, and `npx -y codesift-mcp` is our primary distribution path — a
failed node-gyp build there is an install-blocking error for a user who only wanted code
search. `onnxruntime-node` is already a native dependency, but it is *optional in effect*
(lite mode disables local embeddings on <24 GB machines and everything still works). Storage
is not optional. Adding a hard native dependency to the one component that cannot degrade is
a worse failure mode than raising the Node floor.

### Option C: Sharded JSON (one file per source file, or per directory)

Rejected. It fixes the write amplification and nothing else. Whole-index reads become N file
reads, cross-file queries (`find_references`, `detect_communities`) need a hand-written join
layer, and the multi-process invalidation problem is untouched — we would be writing a
worse database by hand.

### Option D: Keep JSON, add an in-memory cache in the MCP server

Rejected as unsafe, for the reason already documented: the CLI hook writes the same file from
another process and would be silently overwritten. Making it safe requires a change signal,
which requires a format that has one, which is Option A.

---

## Measured outcome

Synthetic index, 4,000 files / 32,000 symbols (~18 MB in both formats), same machine, both
backends driven through the public `index-store` API. Absolute values are noisy (a
concurrent test suite was running); the ratios are the point.

| operation | how often | JSON | SQLite | |
|---|---|---:|---:|---|
| `saveIncremental` (one edited file) | every Write/Edit | 534 ms | **49.6 ms** | **10.8× faster** |
| `getFileEntry` (one file's mtime) | first touch of every file | 205.8 ms | **0.08 ms** | **~2500× faster** |
| `loadIndex`, warm | every tool call after the first | 149.7 ms | **0.008 ms** | **~17800× faster** |
| `loadIndex`, cold | once per process | 167.8 ms | 517.8 ms | 3.1× slower |
| `saveIndex` (full) | once per repo, on reindex | 639 ms | 1329 ms | 2.1× slower |

The trade is deliberate and it is the right way round: **every frequent operation gets
dramatically cheaper, and the two that regress are the rare ones.** A cold load happens once
per process; a full save happens when a repo is (re)indexed.

The cold-load regression has a real cause worth recording: rebuilding 32k symbol objects
from rows is slower than one large `JSON.parse`, because V8's parser is heavily optimised and
we now pay per-row object construction. That is exactly why the materialised-index cache is
part of *this* change rather than a follow-up — without it the migration would have traded a
faster write path for a slower read path.

## Consequences

**Positive**
- Incremental writes stop scaling with repo size. The p99 = 29 s tail is removed at the source.
- `file-indexer`'s mtime lookup becomes a single indexed row read instead of a 262 MB parse.
- The in-memory cache that was previously unsafe is now correct, via `PRAGMA data_version`.
- The hook process and the server can write concurrently without a corruption window.

**Negative**
- Two on-disk formats coexist indefinitely, and both need to stay tested. This is the price
  of not breaking Node 20 and of having a real rollback.
- Node 20 users get none of the benefit — they keep the current performance profile.
- Tests that construct index fixtures by writing JSON need a shared helper instead.

**Neutral**
- Embeddings (`.embeddings.ndjson`, `.chunks.ndjson`) are **out of scope** here. They are
  append-oriented, already streamed, and have their own memory budget. Moving them is a
  separate decision.

---

## Rollback

`CODESIFT_INDEX_BACKEND=json` forces the legacy path; `=sqlite` forces the new one and fails
loudly if `node:sqlite` is missing (so CI cannot silently test the wrong backend). Unset means
auto-detect.

The migration never deletes the source `<hash>.json`, so reverting is: set the env var,
restart. A repo indexed only under SQLite and then rolled back reindexes from scratch —
acceptable, and precisely why the JSON file is retained rather than removed on successful
migration.
