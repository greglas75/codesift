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
4. *(Optional, decided after 3)* import graph — done 2026-10-09, see the stage 4 section.

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

## Stage 6 — scan predicates pushed into the store (2026-10-09)

Thirty-four tools scan the whole repo through `streamRepoSymbols`, 27 of them with source, and
discarded most of it in JS. `SymbolQuery` gained four predicates the store applies before anything is
serialised — `kinds`, `sourceContainsAny` (literal, case-sensitive), `minLines`, `fileSuffixAny` — in
SQL (`queries.ts`, `store.rs`) and in one in-memory statement (`symbolMatchesScanPredicates`) shared by
the resident-index filter and the JSON backend. Both parity matrices cover them. Regexes stay in the
callers: the store only gets literal text, because JS and Rust regex semantics differ.

Migrated (each predicate only drops what the callback already discarded unconditionally): fastapi,
celery ×2, hilt, kotlin sealed/suspend, frequency, room, sql schema/query, php n+1/events, pydantic,
python callers, wiring, model graph, yii rbac, complexity, clones, Hono detection.

Measured on a 454,892-symbol rdesigner index, whole stream with source vs. with a predicate:

| | rows | TypeScript store | Rust store |
|---|---:|---:|---:|
| all + source | 454,892 | 1,199 ms | 1,701 ms |
| `kinds` function/method | 66,073 | 456 ms (2.6x) | 572 ms |
| `fileSuffixAny` .py | 2,295 | 102 ms (11.7x) | 129 ms |
| `sourceContainsAny` "Hono" | 38 | 262 ms (4.6x) | 297 ms |

The win is the rows that never reach V8, on either store. Not migrated yet, because their filters are
per-pattern or stateful: `search_patterns` (`patterns/execution.ts`), `perf-tools`, `async-correctness`,
the React and PHP-view scanners — each needs its own literal hints.

## Stage 7, first half — the call graph in Rust (2026-10-09)

`buildAdjacencyIndex` (graph-tools.ts) scanned every symbol's source with three regexes on the main
thread, on every `trace_call_chain`, `classify_roles`, `explore` neighbours, `impact_analysis` and
`trace_route`. `codesift_core::callgraph` is a 1:1 port — JS `\s` spelled out, ASCII `\w`/`\b`, the
same call-site order and dedupe, keyed by id so colliding ids share caller lists exactly as the
TypeScript `Map`s do — built off the main thread from the index database and cached until
`data_version` moves. `adjacencyFor(repo, symbols, …)` serves it through the `.get(id)` shape the
consumers use; node positions map onto `index.symbols` only after an id hash over that array matches
the graph's, so a resident index patched in place falls back to the TypeScript build. Only with the
native store on — the graph reads through the core's SQLite.

Parity (`scripts/native-graph-parity.ts`, 454,892-symbol rdesigner index, every id's callers and
callees compared in order): **0 differences** in all three option sets the tools use.

| option set | edges | TypeScript, main thread | Rust, off it | Rust memory |
|---|---:|---:|---:|---:|
| tests skipped | 4,375,487 | 1,407 ms | 1,594 ms | 77 MB |
| tests included (impact, trace_route) | 28,318,500 | 4,883 ms (+1.17 GB heap) | 3,234 ms | 382 MB |
| React hooks filtered | 4,375,487 | 1,498 ms | 1,034 ms | 77 MB |

The main-thread cost goes to zero, the heap stops carrying the edges, and a repeat call reuses the
graph instead of rebuilding it. Still loading the whole index: these tools need `index.symbols` for
the nodes they print — the second half of stage 7 serves those from the store as well.

## Stage 9 — BM25 persistence in Rust: no-go (2026-10-09)

Measured before building it. `search_all_conversations` over 1,259 conversation repos, fresh process,
three queries compared result by result:

| | first call | second call | results |
|---|---:|---:|---|
| TypeScript engine, loading `.bm25.ndjson` sidecars | 11,824 ms | 3,249 ms | — |
| native engine, building from symbols (no sidecar) | **4,557 ms** | 4,589 ms | identical top-10, scores to 6 decimals |

The native build — parallel, off the main thread — already beats the TypeScript engine reading its
persisted files. Persisting the native index would also need the per-key token lists the native index
keeps for exact removal, which the v2 file does not carry: rebuilding them means tokenising (the cost
persistence exists to avoid) or a new reconstruction path in the one component where a subtle bug
returns confident wrong results. Not worth it. Conversation persistence keeps the TypeScript engine
for its incremental amend; search uses the native build.

Found while measuring, and guarded: `build:native` and `npm run build` move the addon and the loader
separately, and a daemon restart between them loads an addon the loader's ABI check rejects — with
`CODESIFT_NATIVE_STORE=1` that daemon has no store. `build-native.mjs` now warns when the addon's ABI
differs from `dist/`'s.

## Stage 8 — the indexing pipeline in Rust: no-go for now (2026-10-09)

Profiled a full `index_folder` of ResearchShieldNew (35,357 files, 528,405 symbols), native store and
parser on, embeddings off, host at load 20-40: 29.1 s wall, of which the main thread was **idle 70%**.
What it still does is spread thin — fs callbacks 2.3 s, parser glue 1.5 s, storage 1.6 s, BM25 1.4 s —
and the wall time is the parallel parse plus I/O. In the daemon the whole pass already runs in an index
child process, so none of it blocks a request. Moving walk, hashing and file reads into Rust would buy
a few seconds of a child's time against re-deriving `walkDirectory`'s semantics exactly (ignores,
symlinks, size limits, `max_files`). **Revisit when** indexing time becomes the cost of an incident, or
if in-process indexing (CLI, stdio) turns out to matter.

A profiling trap worth recording: `CODESIFT_EMBEDDING_PROVIDER=none` is not a valid value, so the run
fell through to the local ONNX model and 6-8 s of "indexing" was `onnxruntime-node`. Disable embeddings
with `CODESIFT_DISABLE_LOCAL_EMBEDDINGS=1` and no provider variables when measuring the pipeline.

## Stage 7, second half — graph tools without an index in memory (2026-10-09)

`trace_call_chain`, `classify_roles` and `explore`'s neighbours no longer load the index when the native
graph serves the repo: the graph keeps each node's id and rowid, BFS runs over it with
`buildCallTree`'s exact visit order and limits, and the store returns only the symbols the answer holds
(`symbols_by_rowid_json`, each row checked against the graph's id — a write since the build is a
fallback to the TypeScript path, never a different symbol). `classify_roles` streams the callable
symbols without source and reads degrees off the graph in batches.

Parity (`scripts/native-graph-tools-parity.ts`, ResearchShieldNew, 528,405 symbols — 40 symbols × both
directions × tests on/off at depth 2, neighbours of all 40, roles with and without tests), run in two
processes and diffed: **identical**. Time for that batch: **11.6 s** native against **693.5 s** on the
TypeScript path, which rebuilds the adjacency on every call.

Found and fixed alongside, while reading the daemon's memory for stage 5: `codeIndexes`, the tool-level
cache of loaded indexes, had no bound — entries left only when a repo's files changed or the server went
idle, which a daemon serving ~30 sessions never is (9 indexes, 4.9 GB over a 4 GB budget). It now obeys
the same byte budget as the storage cache (`rememberCodeIndex`, LRU, newest always kept). The third
instance here of a second map of one structure without a bound of its own.

Still materialising the index, and on the ADR-004 list: `impact_analysis`, `trace_route`, `review_diff`,
`plan_turn`, ranked `search_text`, `context L2`, wiki, taint, test-impact and a few helpers. They now get
the Rust graph through `adjacencyFor`, so the expensive part is gone; what remains is the load itself.

## Stage 10 — the remaining candidates, measured (2026-10-09)

Each measured before any code, as the plan required:

- **Cosine search over embeddings: no-go.** Scoring 55k vectors takes 40 ms in TypeScript; the cost
  is loading them (2.3 s for an 856 MB ndjson file), and that is the text format, not the language.
  A binary vector format would pay off in either language and is a format change, which this ADR
  keeps out of a language stage.
- **The conversation extractor: no-go.** 2.5 s for an 861 MB conversation directory, in a
  background pass nothing waits on.
- **The import graph (stage 4): go.** A cold build parses every `.ts`/`.tsx` file one at a time on
  the main thread, and the edge cache is dropped whenever the file set changes (adding one file can
  change where an untouched import resolves) — so in a repo with active worktrees, the cold build is
  the common case, not the rare one.

## Stage 4 — import extraction in Rust (2026-10-09)

`extract/imports.rs` is a 1:1 port of `extractTypeScriptImports`: the same pre-order walk (iterative,
so a deep tree cannot overflow), the same `type`-keyword rules, `typeof import()` as type-only, mocks,
non-literal specifiers skipped. Only extraction moved. Resolution against tsconfig paths, workspace
aliases and the indexed file set stays in TypeScript, unchanged.

`collectImportEdges` reads files in chunks of 1,024 and sends each chunk's uncached `.ts`/`.tsx` files
to the core in one call. The core parses them in parallel on the extract pool, and processing then
continues in file order, as before. A file whose parse the core gives up on (budget, depth) is left
out of the result, and its edges come from the web-tree-sitter path that decided them before.

Parity (`scripts/native-imports-parity.ts`, each file's edges compared, then the whole edge list with
the native parser off and on):

| index | `.ts`/`.tsx` files compared | per-file diffs | graph | TypeScript | native |
|---|---:|---:|---|---:|---:|
| ResearchShieldNew (29,433 files) | 3,763 | 0 | 12,118 edges, identical | 3,944 ms | **641 ms** |
| tgm-survey-platform (89,142 files) | 69,499 | 0 | 219,404 edges, identical | 83,682 ms | **12,333 ms** |

Both measured on the Mac under its usual load. Python's import extraction stays in TypeScript; its
cost has not been measured as a separate item.


## Stage 7 — the full loads left on hot paths (2026-10-10)

Ranked `search_text` (the most used tool) and `plan_turn` (~4,800 calls in the usage log) both loaded
the whole index to read a handful of symbols. Ranking needs only the symbols of the files the hits are
in, without source (`findRepoSymbolsInFiles`). `plan_turn` needs only the first symbol for each name
the query mentions, which is the new `names` predicate (`name IN (...)`, served by `idx_symbols_name`,
on all four implementations plus the parity matrices; ABI 19). Both keep index order, so the answers
do not change: checked on codesift and ResearchShieldNew, 7 ranked queries and 5 plan queries each,
old and new compared as JSON. All were identical.

On tgm-survey-platform (rdesigner), each read in a fresh process:

| read | time | heap |
|---|---:|---:|
| `getCodeIndex` (what both did before) | 12,905 ms | +2,422 MB |
| symbols of 300 files, no source (ranking) | 421 ms | +85 MB |
| `names` for 5 identifiers (`plan_turn`) | 32 ms | +12 MB |

### `impact_analysis` without the index (ABI 20)

`impact_analysis` now runs its walks in Rust (`CallGraph::impact_walk`), off the main thread, in one
call: the changed symbols, the breadth-first walk over callers, the file dependency graph, the test
files reached and per-symbol counts for risk. They keep the TypeScript order rules exactly: a Map
keyed by id where a repeated changed id keeps its slot, first-seen callers, files in order of their
first symbol. The store is read only for the 20 symbols shown and for the callee names the test
reasons quote. The first version made several napi calls per node and took **66 s** on a 1.4M-node
graph, against 3-5 s for the TypeScript walk. Moving the walk into Rust is what fixed it.

The walk also stops once the 20 entries it shows exist. It only ever appends, so the answer is the
same. The TypeScript path keeps walking to the end and then slices.

Parity (`scripts/native-impact-parity.ts`, 2 git ranges × depths 1-3 × with/without source, old and
new compared as JSON): codesift 12/12 identical, tgm-survey-platform 12/12 identical (1,426,824
nodes, ranges of 5 and 556 changed files, up to 25,345 affected test files).

| tgm-survey-platform | TypeScript path | native |
|---|---:|---:|
| setup per cold call | 45 s (index load + adjacency) | 25 s graph build, cached per `data_version` |
| walk, 5 changed files | 3.0-3.8 s | 0.84-0.98 s |
| walk, 556 changed files, depth 3 | 5.0-5.4 s | 0.84-0.87 s |

The TypeScript path also ran out of a 14 GB heap partway through the 556-file range. That path
remains the fallback when there is no native store.

Moved off the full load in the same pass, each checked against the old code on tgm-survey-platform:
`test_impact_analysis` and `find_unused_imports` (the summary is all they read), `get_context_bundle`
(80 bundles, 0 differences), `analyze_project` (React conventions, gotchas and importer counts
identical). One known limit is in `analyze_project`: the importer count falls back to symbol sources
for files it cannot read from disk, and that includes every non-JS/TS file. In a Python repo this
still reads most of the index, as it did before. Narrowing it needs a file-list predicate combined
with the `import`/`export`/`require` literals.

`find_dead_code` (also used by `review_diff`, `audit_scan` and the PHP/Python audits) loaded the whole
index, but the reference scan itself takes under a second. It now reads the exported symbols without
source in one query. Source changes the answer only by turning a symbol into a framework entry
point, so it is read just for the symbols that are still candidates, in order, until 100 are
confirmed. Old vs new compared on three repos with four option sets each: 12/12 identical. Cold on
tgm-survey-platform with the native store: 3.6 s and +1.07 GB peak heap, against 4.8 s and +2.68 GB.
Streaming the same rows in pages took 5.5 s against 2.4 s for one query, so it is one query.

`review_diff` runs its ten checks on a `ReviewIndex` (summary plus two narrow reads: a file's
symbols, and whether any test source mentions a name). On tgm-survey-platform the old path loaded
4.3-5.7 GB, two checks timed out at 30 s and complexity overflowed the stack. The new path finishes
every check in ~30 s at 0.6-1 GB. Small repos are the exception: the checks run at once, and their
narrow reads queue on the same four libuv threads as the file reads, so codesift went from 1.5 s to
9.2 s. Up to 150k symbols, `review_diff` therefore loads the index once and every read is served from
it: 1.36 s against 1.40 s, identical findings.

`trace_route` hands its thirteen framework finders a `RouteIndex`: the summary plus `find(SymbolQuery)`
and `inFiles`, both in index order. Each lookup the finders made over `index.symbols` became one
query: by file and name, by name and kind, parent, `fileSuffixAny`, and for Express and Hono a
`sourceContainsAny` literal that their regexes require. The callee trees come from the native graph
(`nativeCallTreeFrom` with source, for the DB-call scan), falling back to the old path when there is
no graph. Old vs new on tgm-survey-platform, 7 routes (up to 21 handlers and 3,565 call-chain nodes),
and on ResearchShieldNew, 6 routes (NestJS, Express and Yii2; up to 113 handlers and 29,146 nodes):
13/13 identical. The total for each batch was 145.6 s / 2.4 GB → 68.9 s / 0.9 GB and 14.5 s / 637 MB →
8.7 s / 326 MB.

The last ones, each compared against the previous code on real repos:

- `search_text`'s zero-hit vocabulary: the distinct symbol names in order of first appearance, from
  one grouped query (`findSymbolNames`, `GROUP BY name ORDER BY MIN(rowid)`): 0.2 s for 258k names out
  of 1.4M symbols. A repeated name never changes the suggestions, so the result is the same: 15/15
  cases identical, first call on tgm-survey-platform 7.5 s → 1.3 s. Its freshness check reads the
  summary.
- `get_knowledge_map`: heritage edges come from two reads, the declarations and the symbols with
  `extends`/`implements` (a new exact predicate, `hasHeritage` → `json_extract` on `extras`, ABI 21).
  Identical on codesift and tgm-survey-platform with and without focus, 25.8 s → 2.7 s.
- `taint_trace`: Python symbols only (`fileSuffixAny: [".py"]`). Every callee lookup resolves to a
  `.py` file, so nothing outside is ever read. Identical on three repos, 5.1 s → 0.5 s.
- `assemble_context` L2, wiki generation, and the semantic symbol fallback read the summary,
  community files' symbols, and ids without source plus source for the top results, respectively.

`tests/tools/no-full-index-load.test.ts` now fails on any new `getCodeIndex` call in `src/`. What
remains is on its allowlist: the TypeScript fallbacks for when there is no native call graph
(`graph-tools`, `impact-tools`, `trace-route`), `review_diff`'s single load for small repos, and
`php8_migration_candidates`. That last one has no recorded calls, and its rules depend on whole-index
order across predicates that no single query expresses.
