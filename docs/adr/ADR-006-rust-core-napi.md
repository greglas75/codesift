# ADR-006: Rust core behind napi-rs — storage, BM25 and parsing move; the MCP layer and tools stay

**Status:** Accepted (stage 0 done; stage 1: single-owner migration done, native store still opt-in pending a live run; stage 2: BM25 native; stage 3: every tree-sitter extractor native; stage 4: no-go for now)
**Date:** 2026-10-08 | **Deciders:** Greg Laski | **Area:** Infra/Language
**Partially supersedes:** ADR-001 (the TypeScript choice stands for the server and the tools; the
"no native bindings" consequence does not)

---

## Context

The faults that cost the most in this repo since ADR-001 all sit in a small core, not in the 150
tools:

| fault | where it lives | recorded in |
|---|---|---|
| OOM crash-loop on V8's default 4,288 MB heap | the daemon's resident indexes | CLAUDE.md, 2026-08-28 |
| 15.2 GB heap from a second, unbounded BM25 cache | `tools/conversation-cache.ts` | CLAUDE.md, 2026-09-27 |
| 349 MB / ~1 s to materialise one 240k-symbol index | `loadIndex`, 161 call sites | ADR-004 |
| `initialize` at 40 s while the disk was saturated | synchronous `node:sqlite` on the only thread | CLAUDE.md, 2026-09-02 |

Each was fixed with a bound, a budget, or a smaller page, and each fix was a workaround for the
same two properties: the data lives on the V8 heap, and the storage API blocks the event loop.
ADR-001's own "revisit when" — WASM inadequate for large repos — is met in substance.

Size, measured 2026-10-08: 112k lines of TypeScript in `src/`, of which `src/tools` is 64k and the
core (parser 9.6k, storage 8.8k, search 2.7k, retrieval 0.9k, import graph) about 28k.

## Decision

Move the **core** into Rust, loaded in-process through **napi-rs**. The MCP server, the tool
handlers, the framework analyzers, the CLI and the hooks stay in TypeScript.

- Two crates: `crates/codesift-core` (plain Rust, `cargo test`, no napi) and
  `crates/codesift-napi` (thin `#[napi]` bindings). Logic that grows in the binding crate is logic
  `cargo test` cannot reach.
- **Optional at runtime.** `src/native/index.ts` loads `native/codesift-core.<tag>.node` (a local
  build) or `@codesift/core-<tag>` (a prebuilt platform package). Every component keeps its
  TypeScript implementation; a missing binary in the default mode is reported once, never an error.
- **Switches** `CODESIFT_NATIVE=auto|0|1` and `CODESIFT_NATIVE_<COMPONENT>` (STORE, BM25, PARSER),
  modelled on `CODESIFT_INDEX_BACKEND`. `1` means required: the parity suites run with it, so a
  binary that fails to load fails the run instead of testing the TypeScript path twice.
- **ABI guard.** `codesift_core::ABI_VERSION` must equal `NATIVE_ABI` in the loader, or the binary is
  refused with "rebuild with `npm run build:native`". A stale `.node` is the daemon-running-replaced-
  files fault one layer down.
- **Distribution** follows `@parcel/watcher`, already a dependency: prebuilt per-platform packages
  as `optionalDependencies`, built in GitHub Actions. No node-gyp — which was ADR-001's actual
  objection to native bindings (fragile local compilation), not native code as such.

## Stages, each shipped and gated on its own

0. Skeleton, loader, distribution, farm toolchain, baseline measurements.
1. **Storage read path** — `rusqlite` behind the existing `findSymbolsSqlite` /
   `streamSymbolsSqlite` / accessor signatures, off the main thread (napi `AsyncTask`), plus native
   scans so only matches cross into V8. Highest leverage: it is ADR-004 stage 2's missing half.
2. **BM25** — the index lives outside the V8 heap behind a handle, one byte-budgeted LRU for code and
   conversations, persisted in the existing v2 format.
3. **Parser + extractors**, per language (TS/TSX/JS first), and the `index_folder` pipeline.
   `web-tree-sitter` stays for the ~28 tools that walk ASTs in TypeScript.
4. *(Optional, decided after 3)* import graph.

Rules that hold across all of them:

- **No format change in the same stage as a language change.** Rust reads and writes the same
  `<hash>.index.db` and `.bm25.ndjson` v2, so rollback is a switch, never a migration.
- **Differential parity.** Each component has a test running both implementations on the same input
  and comparing field by field, in CI and on real indexes (this repo; tgm-survey-platform, 240k
  symbols). A difference is a failure, not a known limitation.
- **Gates are measured in the condition**, on the 240k index and under load — two regressions in
  one session came from numbers taken where they were easy to get (CLAUDE.md, 2026-08-30).
- **Go/no-go per stage.** A stage that does not pay by its gate stops the programme; the earlier
  stages stand on their own.

## Options rejected

- **Full rewrite in Rust (rmcp, all 150 tools).** One binary and no Node, at the price of porting
  64k lines of tool logic whose problems are not language problems, with two implementations
  diverging for months. The measured pain is in 28k lines; that is where the work goes.
- **A Rust sidecar daemon over IPC.** Process isolation is real, but every call pays serialisation
  and the system becomes two processes to deploy and keep alive — on a fleet where keeping ONE
  daemon alive has been its own incident class.
- **More bounds in TypeScript only.** Each bound shipped so far was right and was still a
  workaround; ADR-004 stage 2 (stop materialising) continues in parallel and is what Stage 1 makes
  cheap.

## Consequences

- **Easier:** memory that is not V8 heap cannot OOM the daemon by V8's limit and is priced exactly;
  storage reads stop blocking `/health` and `initialize`; parsing can use every core without
  worker_threads.
- **Harder:** a Rust toolchain for contributors who touch the core (pinned 1.99.0 in
  `rust-toolchain.toml`; on the farm `/home/tf/runtimes/rust-1.99.0`, installed by i9-farma
  `server/tf-rust-install.sh`); a release matrix per platform; two implementations of each ported
  component until the TypeScript one is retired.
- **Retiring a TypeScript implementation** is its own decision, taken only after the native one has
  been the default for at least one release with zero parity failures — not as part of porting it.

## Stage 1, first increment — measured (2026-10-08)

`findSymbolsSqlite` and `getIndexMetaSqlite` dispatch to Rust when the core is loaded
(`CODESIFT_NATIVE_STORE`). The query runs on the libuv pool and returns JSON arrays of at most 4 MB;
the JS side parses one chunk at a time and yields between them. `openIndexDb` still runs first on
the TypeScript driver (cached per path), so schema creation, migration and the newer-schema refusal
are unchanged and Rust only issues SELECTs. Failures carry SQLite's extended code back into the same
`classifyStorageError`.

**Parity on real indexes** (`scripts/native-parity.ts`, query matrix drawn from each index's own
values, compared element by element after `JSON.stringify`): **0 differences** on ResearchShieldNew
(122 queries, 763,052 rows), rdesigner (649,245 rows), codesift (71,694), and two conversation
indexes (265,445 and 3,669,264 rows).

**One defect found before it shipped:** the first version returned ONE JSON string. A conversation
index here holds ~330 MB of raw text, so a full-source query sat at V8's ~512 MB string limit — the
native path would have thrown where TypeScript answers. Results are chunked since.

**Benchmark** (`scripts/bench-store.ts`, 352,694-symbol index, warm page cache, Mac at load ~8, median
of 5). `block` = longest stretch the event loop ran no timer, i.e. what every other client waited:

| op | rows | block TS → Rust | wall TS → Rust |
|---|---:|---:|---:|
| meta | 1 | 8.9 → 2.9 ms | 6.5 → 8.2 ms |
| prefix=get | 10,434 | 119 → 16 ms | 116 → 114 ms |
| kind=function | 34,849 | 113 → 30 ms | 110 → 105 ms |
| kind=function + source | 34,849 | 107 → 45 ms | **104 → 164 ms** |
| kind=variable | 98,420 | 320 → 52 ms | 317 → 225 ms |

What it does and does not buy: the loop is blocked 4–7x less, which is the property the daemon
incidents were about — and on a saturated disk, where a read is a blocking syscall, the TypeScript
block grows with the I/O while the Rust one does not (gate measurement under load still to do).
Wall time for source-heavy queries is WORSE on a warm cache: the text is copied through JSON twice
(escape in Rust, transcode + parse in V8). Retained heap is unchanged (+5–10%) — results are still
JS objects, so memory falls only as callers move from whole-index loads to narrow queries. Remaining
block is mostly napi converting all chunk strings in one `resolve`; returning Buffers decoded per
chunk would cut it further.

### Second increment — `streamSymbolsSqlite`

The paging LOOP stays in TypeScript (time-budget page sizing, stop on an empty page, the limit, the
yields); only each page's fetch moves to Rust, from one read transaction held for the whole stream
(`Snapshot` / `SymbolSnapshot`). Copying the loop instead of re-deriving it is what keeps the two
paths from disagreeing about which symbols a stream delivers. Parity including streams: 0
differences on the same five indexes with a new seed (5.8M rows).

| op | rows | block TS → Rust | wall TS → Rust |
|---|---:|---:|---:|
| stream all + source | 352,694 | 62 → 41 ms | **938 → 1,443 ms** |

The same trade as source-heavy finds, larger: less blocking, more wall time, because every source
string crosses JSON twice. If the gate measurement under load does not show the block reduction
paying for that, the source column is the thing to move off JSON (e.g. a parallel array of strings
created in `resolve`), not the approach.

Still TypeScript: the whole-index `loadIndexSqlite` — materialising every symbol into V8 is the cost
itself, so a native fetch would not change what it holds; the fix there is callers moving to the
narrow reads (ADR-004 stage 2). Gate still open: the measurement under disk saturation.

### Third increment — `extras` copied as raw JSON

Timed on the Rust side alone (`crates/codesift-core/examples/time_find.rs`): a 34,849-row read with
source took 79 ms, of which SQLite stepping the rows is 21 ms. The biggest single cost was the
`extras` column — parsing every row's tokens/meta into a tree and serialising it again. They are now
copied as raw JSON text (`RawValue`): 79 → 61 ms, and the stored text reaches the JS parser
unchanged, so numbers and key order cannot drift. A hand-written string escaper was tried and
measured slower than serde's (60 → 80 ms), so it was not kept.

Re-measured after it (same index, Mac at load 7–17, median of 5):

| op | rows | block TS → Rust | wall TS → Rust |
|---|---:|---:|---:|
| meta | 1 | 11.1 → 2.0 ms | 8.2 → 6.9 ms |
| prefix=get | 10,434 | 120 → 15 ms | 117 → 104 ms |
| kind=function | 34,849 | 127 → 26 ms | 122 → 99 ms |
| kind=function + source | 34,849 | 121 → 43 ms | 118 → 143 ms |
| kind=variable | 98,420 | 312 → 50 ms | 309 → 203 ms |
| stream all + source | 352,694 | 72 → 43 ms | 1,048 → 1,400 ms |

Parity re-verified: 0 differences on the five indexes, fresh seed, 5.6M rows. The remaining wall-time
cost is confined to source-heavy reads (+22% find, +34% stream).

## Stage 2 — BM25 in Rust (2026-10-09)

`buildBM25IndexYielding` builds a `NativeBM25Index` when the core is loaded (`CODESIFT_NATIVE_BM25`):
the postings, field lengths, vocabulary and centrality live in Rust memory behind a handle; JS keeps
only the `symbols` Map, whose values are the code index's own objects. `searchBM25`,
`updateBM25ForFile`, `bm25FootprintBytes` and `centrality` dispatch on the index type. Input is the
same JS symbol array the TypeScript build reads, in the same batches with the same yields — so every
caller (repo index, `index_folder`, conversations, the JSON backend) feeds both engines identically.

What "the same ranking" took, each with a test:

- `Map` semantics on non-unique ids: `set` on an existing id overwrites in place, delete-then-add
  moves to the end, and ties sort in that insertion order. Each key also remembers the token list of
  its LAST symbol, because removal re-derives from it — so a collided id leaves stale postings exactly
  where the TypeScript maps leave them.
- `source.slice(0, 500)` counts UTF-16 code units; JS `\s` (incl. U+FEFF) is spelled out in the
  centrality regex; the camelCase split is hand-written and checked against the original regexes on
  20,000 random strings.
- `Math.log` vs `ln` may differ in the last bit — the only tolerance (1e-12 relative); order, symbol
  identity and matched tokens compare exactly.

Measured (`scripts/native-bm25-parity.ts`: 300 queries drawn from each index, run after the build and
again after 25 file updates; 0 differences on all five):

| index | symbols | build TS → Rust | V8 heap retained TS → Rust | Rust-side memory |
|---|---:|---:|---:|---:|
| codesift | 32,421 | 448 → 229 ms | 42 → 1 MB | 32 MB |
| zuvo conversations | 17,302 | 918 → 399 ms | 85 → 1 MB | 47 MB |
| ResearchShieldNew | 352,694 | 6.5 → 3.2 s | **400 → 14 MB** | 328 MB |
| rdesigner | 295,322 | 6.8 → 2.7 s | **451 → 14 MB** | 345 MB |
| tgm-survey-platform conversations | 168,984 | 9.5 → 3.4 s | **870 → 7 MB** | 432 MB |

This is the heap the OOM crash-loops were made of (two BM25 caches, 15.2 GB at the worst). The memory
still exists — in Rust, counted exactly by `footprintBytes()` and so enforced by the same budget — but
it no longer counts against V8's ceiling, and it is ~35–50% smaller.

Deliberately unchanged in this increment: the tool ranker (150 entries, sync `buildBM25Index`), and
conversation PERSISTENCE, which still builds a TypeScript index because the incremental pass amends
the sidecar it writes. Search paths skip restoring that sidecar when native BM25 is on — loading it
would rebuild the heap maps this stage removes, and the native build is the cheaper of the two.

## Stage 3 — go/no-go measurement (2026-10-09)

CPU profile of a full `index_folder` of ResearchShieldNew (352,694 symbols, parser inline so one
thread holds every sample, native store and BM25 on): **36.2 s** sampled.

| where | time | share |
|---|---:|---:|
| tree-sitter WASM — parsing, and the extractors' node accessors | 16.9 s | **47%** |
| SQLite writes (`writeIndexRows`) | 7.3 s | 20% |
| BM25 build (native, incl. napi conversion) | 5.0 s | 14% |
| extractor logic itself (TypeScript, self time) | 0.7 s | 2% |

**Go.** Nearly half of indexing is the WASM boundary, and the extractors' own logic is 2% of it — the
rest of their time is calls into WASM nodes. Native tree-sitter, with files parsed in parallel instead
of on the pool's two workers (`DEFAULT_POOL_SIZE = 2`), is the largest remaining lever on indexing.

Grammar identity, verified by hash: the shipped `.wasm` files are byte-identical to npm
`tree-sitter-typescript@0.23.2` and `tree-sitter-javascript@0.23.1`; the Rust crates of the same
versions are what stage 3 builds on. `download-wasm.ts` now pins `tree-sitter-typescript` (it was
the one TS/JS grammar left floating), so the two sides cannot drift apart on a new release.

### Stage 3, first language — TypeScript / TSX / JavaScript (2026-10-09)

`runTreeSitterParse` sends TS, TSX and JS to the Rust extractor when the core is loaded
(`CODESIFT_NATIVE_PARSER`): native tree-sitter 0.26.11 with the 0.23.2 / 0.23.1 grammars, a 1:1 port
of the nine `typescript*.ts` modules, parsed on the libuv pool instead of the two WASM workers.

Parity on real code (`scripts/native-extract-parity.ts`, byte-for-byte JSON per file):

| code | files | symbols | differences |
|---|---:|---:|---:|
| codesift `src` + `tests` | 1,292 | 29,256 | 0 |
| codesift-dashboard (React) | 57 | 599 | 0 |
| ResearchShieldNew (TS, JS, bundles) | 22,022 | 461,113 | 0 |
| tgm-survey-platform (TSX-heavy, incl. worktrees) | 184,970 | 3,393,366 | 0 |

**The one defect parity found:** the UTF-16 input callback halved an offset the binding had ALREADY
halved, so every read past the first returned text from the wrong place — 18 of 660 files diverged,
always late in the file. A unit test on short snippets could not have seen it.

Details the port had to carry, each from reading the TypeScript rather than guessing: positions are
UTF-16 code units (`start_byte` included); a class is pushed after its members; `isExported` flows into
the children of continue-after nodes; `getTestName` keeps an empty suite name; the export post-pass
appends `is_exported` as the LAST key; JS `trim`/`\s` include U+FEFF; a class without a body keeps its
whole untruncated text.

One intended difference: on a tree deeper than V8's stack the TypeScript extractor catches the
RangeError and returns a partial list; the Rust walk runs on 64 MB stacks and returns every symbol.

Measured: a full `index_folder` of ResearchShieldNew (33,227 files, 494,840 symbols — the same count
both ways) **34.7 s → 19.5 s**. The TypeScript baseline parsed in-thread (a dev run has no built
worker); production's two workers make the real gap smaller. Parallelism here is bounded by the libuv
pool (4 threads) — spawning on the extractor's own pool is the next step if parsing still dominates.

### Stage 3, second language — Python

Port of `python.ts` (`extract/python.rs`) on `tree-sitter-python =0.23.6` (the pinned npm version;
`.wasm` identical by hash). Carried over because they show in the output: the depth counter restarts in
a plain class body but not a decorated one; a decorated function's body is walked with the OUTER parent
id; computed `__all__` members come out in stack order; decorator meta keys keep first-assignment
order. `MAX_WALK_DEPTH` warnings come back to JS and are printed as before.

Parity on the first run: **0 differences** on sentry, data-lab, tgm-statbox and Helper — 15,939 files,
220,464 symbols. Native extraction 1.7x faster single-threaded (7.2 s → 4.1 s on sentry).

Shared now in `extract/mod.rs`: `Sym`, `Opts`, `make_symbol` (= `_shared.ts`), `meta_set` (JS object
assignment semantics), the serialiser, and `Extracted` with a `warnings` list.

### Stage 3 — Go and Rust

Ports of `go.ts` and `rust.ts` on `tree-sitter-go =0.25.0` and `tree-sitter-rust =0.24.0` — the
versions whose `.wasm` matches the shipped one by hash (both were unpinned npm deps; rust 0.23.3 and
0.24.0 ship byte-identical wasm). Parity, first run, 0 differences: the Go 1.23.4 standard library
(6,683 files, 367,969 symbols) and 74 crates from the cargo registry (2,335 files, 102,745 symbols).

**A performance defect parity timing exposed:** Go names every spec of a `const (...)` block after the
WHOLE block, and `make_symbol` copied the node's full text before truncating it — O(block) per spec,
quadratic per block. The Go stdlib took 23.4 s native against 10.5 s in TypeScript, where V8's `slice`
is O(1). `node_source` now slices only the 5,000 units it keeps: 23.4 s → 7.1 s, output unchanged
(TypeScript and Python parity re-run, still 0 differences).

### Stage 3 — PHP

Port of the five `php-*.ts` modules (`extract/php.rs`). The grammar is tree-sitter-php **0.23.12**,
the version whose `.wasm` ships (by hash) — never published to crates.io, so it is a git dependency on
the `v0.23.12` tag; 0.23.11, the newest crate of that line, has a different grammar. Carried over: a
bodiless top-level `namespace X;` parents every later top-level node; docblock members are synthesised
after the class body, `@property` before `@method`, and skipped when a real member of that kind
exists; JS's ASCII `\w` and its `\s` set are spelled out in the docblock patterns. Attributes add a
`meta` value kind — an array of `{name, args?}` objects.

Parity on the first run: **0 differences** on Mobi4, tgm-panel (Yii2), tgm-collect (Laravel) and
tgm-flux — 83,279 files, 909,405 symbols, vendor code included. Native 1.7x faster single-threaded.

### Stage 3 — Kotlin and Gradle KTS: every tree-sitter extractor is now native

Ports of `kotlin.ts` (+ its AST-helper and Kotest modules) and `gradle-kts.ts`, both on
`tree-sitter-kotlin-ng =1.1.0` — the crate of the `@tree-sitter-grammars/tree-sitter-kotlin` 1.1.0
grammar whose `.wasm` ships (by hash). Parity on the first run: **0 differences** on tgm-app and three
public projects chosen for coverage (nowinandroid for Compose + Gradle KTS, ktor, kotest for the DSL) —
6,100 files, 83,519 symbols.

With the generic fallback ported next (Java, Ruby, CSS on `tree-sitter-java =0.23.5`,
`tree-sitter-ruby =0.23.1`, `tree-sitter-css =0.25.0`, each the shipped `.wasm` by hash; 0 differences on
commons-lang's 11,669 symbols — Ruby and CSS yield no symbols through it on either side, its node map
names none of their node types), every extractor that runs on a tree-sitter grammar has a native
counterpart: ~4.6M symbols compared in total, 0 differences. What stays in TypeScript has no grammar to
share — the regex extractors (Markdown, Prisma, SQL, Astro, Hono, conversations) — plus the ~28 tools
that walk ASTs in TypeScript through web-tree-sitter.

## Two copies of SQLite in one process — why the native store is opt-in only (2026-10-09)

Adding the native whole-index WRITE turned up a fault in stage 1 as built: after a Rust connection
wrote and closed, the next `node:sqlite` read of the same database failed with `SQLITE_IOERR`.

The cause is documented by SQLite as a way to corrupt a database — "multiple copies of SQLite linked
into the same application". `node:sqlite` and rusqlite's bundled SQLite are two copies. SQLite's unix
locking uses POSIX `fcntl` locks, which never conflict within one process, and each copy keeps its own
table of open files, so neither can see the other's connections. When the Rust connection closed, its
SQLite believed it was the last one: it took the "exclusive" lock (granted — same process), checkpointed,
and deleted `-wal`/`-shm` that node's connection still had open. In a daemon that is not an IOERR but
writes landing in an unlinked WAL — lost data. Reads are exposed too: stage 1 opened and closed a Rust
connection per query next to node's cached one.

The parity suites did not catch it because they never interleaved a live node connection with a
closing Rust one in a way that triggers the checkpoint. The full-suite storage tests did, once a
native write sat between two TypeScript operations on the same file.

**Decision, in force now:** `store` is the one component that `auto` and `CODESIFT_NATIVE` never turn
on (`OPT_IN_ONLY` in `src/native/index.ts`); only `CODESIFT_NATIVE_STORE=1` does, and only the parity
suites set it. BM25 and parsing never open a database and stay on in `auto`. The live daemon was not
exposed — its `dist/` predates the native loader — but the next build would have been.

**What a safe stage 1 requires:** every access to an index database within a process going through
ONE copy of SQLite — `src/storage/sqlite/*` (connection cache, migrations, meta, incremental writes,
paged loads, narrow reads) plus the four modules outside it that open index databases
(`cli/commands-daemon.ts`, `cli/commands-maintenance.ts` — prune checkpoints WALs —
`storage/registry.ts`, `tools/index-tools/worktree-seed.ts`). Partial ownership is not a smaller
version of the safe design; it is the unsafe one. Until that migration happens, the measured stage 1
gains (3–8x less event-loop block on reads, 6 s of main-thread writes per large index) are not taken.

## Indexing after stage 3 — where the time went next (2026-10-09)

Full `index_folder` of ResearchShieldNew (35,355 files, 528,394 symbols), native core on, one process:

| | wall | main-thread BM25 | main-thread waiting on parses |
|---|---:|---:|---:|
| after stage 3 | 23.2 s | 5.1 s | 6.3 s |
| + BM25 tokenised in parallel off the main thread (`ingestAsync`) | | **1.1 s** | |
| + parses on tokio's blocking pool, 32 files in flight | **18.4–19.1 s** | | |

Extraction used to hold one of libuv's four threads per parse — the same threads every `readFile` and
`stat` of the indexer needs. It now runs as an `async fn` on tokio's blocking pool, and the indexer
keeps 32 files in flight when the native parser is on (8 for WASM, which has two workers).

The largest remaining main-thread cost is the SQLite write of the index (`writeIndexRows`, ~6 s) —
exactly the work the opt-in native writer moves off it, once a single SQLite copy owns the files.

**Stage 4 (import graph): no-go for now.** `collectImportEdges` does not appear on the indexing path at
all in this profile; there is no measured cost to remove.

## Stage 1 — go/no-go after the SQLite finding: no-go for now (2026-10-09)

Rule 5 of this ADR applied to what a SAFE stage 1 now costs.

**Cost.** Every access to an index database within a process must go through one SQLite copy, so the
Rust core would have to own all of it: `src/storage/sqlite/*` (~1,800 lines — the connection cache,
the v1→v2 migration and newer-schema refusal, meta, `saveIncremental`/`removeFile`, the paged whole
loads with their footprint accounting, legacy-JSON import, `data_version` invalidation, error
classification) plus the four modules outside it that open index databases. Each needs the same
exact-parity treatment the read path got, and a partial move is the unsafe design, not a smaller safe
one.

**Gain, re-measured against what the TypeScript path already does.** Whole loads and whole writes
already yield to the event loop every page (50+ rows, ~65 ms blocks) and every 500 rows (~22 ms) —
the daemon stays responsive during them. What the native store would still buy: large `find`s block
50 ms instead of 320 ms, and ~6 s of main-thread CPU per full index of a 500k-symbol repo moves off it.
The motivating incident (`initialize` at 40 s on a saturated disk) was addressed by the 50-row page
floor; the disk-saturation measurement this stage was gated on was never taken.

**Decision.** Not now. The native store, writer and their parity suites stay in the tree, opt-in only,
so the work is not lost and remains tested. **Revisit when** a measurement on a saturated disk shows
`/health` or `initialize` blocked by index reads despite the page floor, or when index writes become
the dominant cost of an incident — then do the whole single-owner migration, not part of it.


## Stage 1 — the single-owner migration, done (2026-10-09, owner decision)

The owner overrode the no-go above: do the whole migration. It turned out not to need the ~1,800-line
rewrite the cost estimate assumed.

**Approach: port `node:sqlite` itself, not the callers.** Every index-database caller already reached
SQLite through one seam — `loadSqliteCtor()` — or through `import("node:sqlite")` in two places
(`commands-maintenance.ts` prune, `worktree-seed.ts`), now routed through the seam too. So the core got
a `DatabaseSync`/`StatementSync` of its own (`crates/codesift-napi/src/sqlite_compat.rs`, a line-by-line
port of `node_sqlite.cc` on the raw C API of the SAME bundled SQLite rusqlite uses, re-exported as
`codesift_core::sqlite_ffi`), and `loadSqliteCtor()` returns it whenever the store is on. The choice is
memoised per process, so a process is all-node or all-Rust for every file it opens through the seam —
the condition the IOERR finding requires. All of `src/storage/sqlite/*` runs unchanged on top of it,
and the existing native fast paths (find, stream, whole-index writer) share the same copy.

Outside the seam, deliberately: `commands-daemon.ts` opens `daemon-lock.db`, which nothing else opens,
so one copy owns it regardless. On Linux the `.node` neither exports nor imports any `sqlite3_*` symbol
(`nm -D`), and node exports none, so the two copies cannot be cross-bound by the dynamic linker.

**Parity is a transcript.** `tests/native/sqlite-compat-scenarios.ts` drives ~150 steps through both
classes — every bind type, arity and named-parameter rule, every storage class read back, row
prototype, duplicate/`__proto__`/index-like column names, statement reuse and reset, `run()` on
SELECT/RETURNING/constraint failures, transactions, a second connection (WAL, `data_version`, BUSY),
every constructor option, URIs, and the lifecycle after `close()` — recording values with their types
and errors with class, `code`, `errcode` and `errstr`. The transcripts are identical except where
node:sqlite itself differs between Node releases, found by running the same test on the Mac (24.18)
and the farm (24.21): 24.21 binds a boolean as INTEGER and refuses SQL that compiles to nothing, 24.18
throws on the first and returns a dead statement for the second. The port pins the newer behaviour
(`PINNED` in the test); nothing in `src/` does either.

Two build differences were found by diffing `PRAGMA compile_options` and are closed in
`.cargo/config.toml`: libsqlite3-sys's bundle lacked math functions, percentile and geopoly, and had a
32,766 variable limit against Homebrew node's 250,000 (the official Linux build has 32,766 — so the
test compares SQL-visible options and requires our limit to be at least node's).

**Full suite with `CODESIFT_NATIVE_STORE=1`** (every SQLite call in the process through the core):
6,493 passed, 0 failed. One TypeScript test is skipped there — it stages a full disk with a
per-connection `max_page_count` on the cached connection, which the native writer's own connection
never sees; the property it guards is pinned in Rust instead
(`a_full_database_reports_sqlite_full_and_the_index_survives`).

**Cost of the port** (731 MB real index, 454,892 symbols, Mac, best of rounds):

| | node:sqlite | port |
|---|---:|---:|
| whole table, paged as `loadIndexSqlite` reads it | 590–640 ms | 730–780 ms |
| 2,000 `file = ?` lookups | 62 ms | 74 ms |
| 20,000 meta reads | 27 ms | 33 ms |
| 50,000 inserts × 20 params | 70 ms | 113–131 ms |

Rows were 1.8x node's when each column crossed napi on its own (`napi_set_property`); the fix that
held was building each row with ONE call into a factory the facade compiles per column list,
`(v0, v1, …) => ({ __proto__: null, "id": v0, … })` — the null-prototype literal node's
`Object::New` produces. What remains is napi's own call cost, ~90 ns per call and ~30 ns per bound
parameter (measured against the raw binding; the JS facade adds nothing measurable). The heavy
operations do not take this path when the store is on: whole-index writes go through the native
writer (off the main thread), and `find`/`stream` through their native paths.

**Still open: default-on.** `store` stays in `OPT_IN_ONLY` until a daemon has run on it under the
monitoring the owner asked for (RSS and `/health` every 15 minutes for 24 h). Rollback is the switch.
