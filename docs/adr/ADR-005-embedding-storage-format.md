# ADR-005: Embedding Storage Format — fixed-width float32 per repo, not references into a shared cache

**Status:** Proposed
**Date:** 2026-08-09 | **Deciders:** Greg Laskowski | **Area:** Storage

---

## Context

ADR-003 moved the per-repo index to SQLite and closed with an explicit deferral:

> Embeddings (`.embeddings.ndjson`, `.chunks.ndjson`) are **out of scope** here. They are
> append-oriented, already streamed, and have their own memory budget. Moving them is a
> separate decision.

This is that decision.

Per-repo vectors live in `<hash>.embeddings.ndjson` (symbol level) and
`<hash>.chunk-embeddings.ndjson` (chunk level), one JSON line per vector,
`{"id": "…", "vec": [768 floats]}`. Alongside them sits a content-keyed shared cache,
`shared-embeddings.v2.bin`, records `[16 B key][2 B dim][4 B crc32 of the vector bytes][dim*4 B
float32]` — 3,094 bytes at 768 dims. (The corruption analysis further down argues from the
**pre-checksum draft**, whose record was 3,090 bytes and had no `crc32` field; that analysis is what
put the checksum there. This line is the shipped layout, and it is the one to build an inspector
from.) Key is
`contentKey(model, dimensions, text)` = sha256 truncated to 128 bits
(`src/storage/shared-embedding-cache.ts`). The shared cache is a **write-side** optimization: a
repo containing text already embedded elsewhere does a lookup instead of a model call. Nothing
reads from it at query time.

The proposal on the table was to invert that — make per-repo files store `{id, key}` and resolve
vectors out of the shared table. That is Option B, and this ADR rejects it.

Five independent measurement passes were run against the live `~/.codesift` on 2026-08-07 …
2026-08-09, read-only. Where they disagree, the disagreement is reported rather than averaged.

### What is on disk

The corpus is a moving target and was measured three times as it grew:

| when | total | symbol | chunk | vectors |
|---|---:|---:|---:|---:|
| 2026-08-07 | 20.61 GB | — | — | 1,362,494 (exact `wc -l`) |
| 2026-08-09 early | 20.72 GB | 12.26 GB | 8.46 GB | 1,362,494 (exact, full census) |
| 2026-08-09 later | 22.32 GB | 13.17 GB | 9.08 GB | 1,366,788 slots |

`+1.71 GB` was written on 2026-08-08, all `embeddinggemma`. Two agents independently produced the
identical exact count **1,362,494** (805,907 symbol + 556,587 chunk); the third scanned later and
found 1,366,788, consistent with growth. Files: 109 `*.embeddings.ndjson` (39 non-empty, 70
zero-byte — 64 of those are `conversations/*` indexes with 0 symbols) and 30
`*.chunk-embeddings.ndjson`, all non-empty.

Mean line width is **16,330 bytes** (near-uniform: every vector is 768 floats). The same vector as
float32 is **3,072 bytes** — a **5.3×** ratio, and the round trip was verified **bit-exact on
1,300 samples** across two files, so the decimal text is a rendering of float32 and a binary form
is lossless by construction.

### Only 25.9% of those bytes can be read at all

This is the largest single finding and it is not a format problem.

| class | GB | share | stems |
|---|---:|---:|---:|
| **Reachable** — live repo, model matches active provider | **5.77** | **25.9%** | 15 |
| **Live repo, wrong model** — rejected before the file is opened | **14.11** | **63.2%** | 18 |
| **Abandoned** — no live repo claims it | **2.44** | **10.9%** | 7 |

Both load paths compare `embeddings.meta.json`'s `model` against
`expectedEmbeddingModel(...)` and return `null` without reading. 14.11 GB was built with
`nomic-ai/nomic-embed-text-v1.5`; the active provider is `ollama/embeddinggemma`. The provenance
split confirms it: 69 metas nomic / 33 embeddinggemma / 2 ollama `nomic-embed-text`. The single
largest file on the machine, `local/tgm-survey-platform` at **7.15 GB**, is in the dead cohort.

`prune` reclaims **100% of the abandoned 2.44 GB** (4.78 GB including index artifacts) and
**0 bytes** of the 14.11 GB, by design — its liveness test is "does the repo root exist", which
these pass. It also cannot match `shared-embeddings.*` at all: `artifactPattern()` requires a
`^[0-9a-f]{8,}\.` stem.

**74.1% of the corpus (16.55 GB) is inert for reasons no format change addresses.**

### Embeddings are produced for only some repos, and it is not a size threshold

Five gates, all read in code: (1) no provider configured → silent return; (2) `index_file` **never**
embeds, it only invalidates — so the PostToolUse hook and the watcher never produce vectors;
(3) `index_folder` short-circuits to `status: "skipped"` ~300 lines before the embedder when a
watcher is active; (4) the embedding pass is fire-and-forget and `saveEmbeddings` writes only at
the end, while the stdio server exits on client disconnect; (5) every failure is caught to stderr.

Result: **230 of 333 registered repos have no embeddings at all**, and 155 of those have a
populated index totalling **2,226,275 un-embedded symbols**. Three repos indexed 2026-08-08 carry
an `embeddings.meta.json` with `symbol_count: 0` whose timestamp *predates* the index's own
`created_at` — e.g. `local/TGMQuotas@refactor-due-date-actions`, meta 21:21:18Z, index
`created_at` 22:50:48Z with 52,245 symbols today.

### What the read path cost, and what already changed

Two paths, and they were not alike.

- **Symbols** (`embedding-store.ts:59 loadEmbeddings`): streamed via `readline`, `JSON.parse` per
  line, LRU-cached per repo under `CODESIFT_MAX_EMBEDDING_MEM_MB` (1024 MB on this box).
- **Chunks** (`chunk-store.ts loadChunkEmbeddings`): whole-file `readFile(utf-8)` + `split("\n")`,
  **no cache, no budget**, called by `semantic-handlers.ts` on **every** semantic and hybrid query.

Measured, real production functions, warm page cache:

| file | bytes | vectors | load | per entry | resident |
|---|---:|---:|---:|---:|---:|
| codesift symbols | 499.1 MB | 30,618 | 2,960 ms | 96.7 µs | 94.1 MB |
| codesift chunks | 439.0 MB | 26,975 | 1,225 ms | 45.4 µs | 82.9 MB |
| tgm-survey chunks | 3,223.3 MB | 197,312 | 10,036 ms | 50.9 µs | 606.1 MB |

Raw byte streaming of the 499 MB file is **90 ms** (5.5 GB/s). **I/O is ~3% of the load; the rest
is `JSON.parse` plus `Float32Array` construction.**

A real `semantic_search` on local/codesift, three queries in one process: **2,939 / 1,753 /
1,649 ms**, phased as embed 12–35 ms · `loadChunks` 134–151 ms · **`loadChunkEmbeddings`
1,758–1,945 ms (88–90%)** · cosine + RRF 53–67 ms (3%) · sort 1.6 ms.

The whole-file read also had a hard ceiling that failed silently. `MAX_STRING_LENGTH` on this
runtime is 536,870,888 and `readFile` refuses >2 GiB; both errors were swallowed into `null`,
which every caller reads as "this repo has no embeddings". Three files were confirmed dead by
calling the real loader — 3,223.3 MB → `ERR_FS_FILE_TOO_LARGE` in 2 ms; 765.6 MB → `Invalid string
length` after 1,022 ms; 629.1 MB → same after 761 ms; control 497.4 MB loaded fine.

**Both defects are fixed at HEAD** (`f61dbf5`, committed 2026-08-09 01:36 while this ADR was being
measured). `loadNdjsonMap` streams, and chunk embeddings share the symbol path's LRU under one
budget keyed `<repo>:chunks`. Post-fix, same repo, same process: **1,173 / 0 / 0 ms**, and
**282,906 vectors** (197,312 + 47,020 + 38,574) that the system was reporting as absent now load —
about 6.5 h of model time at the measured 12 emb/s. The two size lists reconcile exactly: the
commit quotes MiB where the measurement quoted MB, a factor of 1.048576 on all three files.

**This matters for the decision.** The two acute, user-visible failures were removed without
touching the format. Everything below is judged against a system that no longer leaks 88% of its
query time to a missing `Map`.

### How much of the corpus is duplicate

The previously circulated "each unique vector is stored 33×" was withdrawn — it divided all
vectors by shared-cache entries, which measures the cache's age. Three independent replacements
converge:

| method | duplication |
|---|---:|
| exact full census, SHA-1 of the `"vec":[…]` payload, all 69 files | **9.67%** (131,723 of 1,362,494) |
| independent full scan, same technique | **10.4%** (1,366,788 → 1,225,101 distinct) |
| 100-char vector-prefix signature (upper bound) | **≤12.5%** |

So **byte-identical dedup would recover ~2.0 GB**, not 20. But identical *text* does not reliably
produce an identical stored vector: measured on texts that repeat inside a single file (model
necessarily constant), agreement is **51.9% for nomic** and **83.0% for embeddinggemma**, ranging
4.1%–100% per repo. Content-level duplication is therefore **21.5% ≈ 4.26 GB**, roughly double the
byte-level figure. Where it lives:

| | byte-identical | duplicate content |
|---|---:|---:|
| within one repo's own file | 62.9% (1.26 GB) | 49.2% (2.10 GB) |
| across worktrees / nested packages of one project | 36.0% (0.72 GB) | 37.0% (1.58 GB) |
| across unrelated projects | 1.1% (0.02 GB) | 13.8% (0.59 GB) |

"It's the worktrees" is about a third of it; the largest bucket is a repo duplicating itself.
Cross-unrelated-repo sharing is almost entirely trivial symbols — `variable i / let i = 0;` in 13
distinct repos, `const now = Date.now();` in 12 — each costing a full 16,330-byte line.

A bigger lever sits next to it: **49.9% of chunk rows embed source text shorter than 200
characters** — 21.1 MB of text expanded into 4.33 GB of embeddings. Of chunk duplication, 70.4% is
short boilerplate and 8.5% is minified/build output that should never have been indexed
(`marked.min.js` ×411, Next.js `out/_next/static/chunks/*.js` ×378). That is indexing policy, and
it is worth more than dedup.

### Does the shared cache actually hit

Yes — the read path works where content is present. Driven through the real `batchEmbed` from the
installed 0.14.0 against the real cache, with the provider replaced by a counter:

| repo | symbols | hits | model calls |
|---|---:|---:|---:|
| tgm-collect@test-entry-facts-repo (worktree, no embeddings) | 2,551 | **2,522 (98.9%)** | 29 |
| tgmhelp@panel-client | 14,332 | **14,251 (99.4%)** | 81 |
| zuvo (uncovered) | 7,190 | **0 (0.0%)** | 7,190 |

But coverage is **5.7%**: the cache holds 40,218 distinct keys against 701,961 distinct content
keys in the corpus, so of 508,072 redundant symbol instances it can serve **12.8%**. At 12 emb/s
that is ~1.5 h saved out of ~11.8 h.

Two measured causes, both since fixed at HEAD: v1 accumulated one string per append and threw
`RangeError` at exactly **33,042 entries** into a bare `catch` — repos under that ceiling averaged
**35.3%** coverage (n=33), repos at or above it **2.6%** (n=10), with `rs_admin` at 34,237 symbols
sitting at a partial 20.9%. And chunks were never eligible at all: `embedChunks` called
`batchEmbed` with 5 arguments, omitting `sharedModel`, so 9.08 GB across 30 files was recomputed
per repo with no lookup attempted. `5d265a4` chunks the appends and passes model identity.

`contentKey` includes the model, so the corpus is **three non-interchangeable islands** (69 / 33 /
2 repos). `tgm-collect` main is nomic while all of its worktrees are embeddinggemma — the flagship
case for the cache cannot cross that boundary.

### Constraints

- Published to npm, launched via `npx -y codesift-mcp`. No build toolchain at install time.
- `engines: {"node": ">=20.0.0"}`; `node:sqlite` landed in 22.5, so any SQLite option inherits
  ADR-003's dual-backend obligation rather than avoiding it.
- **22.32 GB of live vectors.** Migration must not force re-embedding. Measured throughput is
  **12 emb/s** on the shared Ollama host and **70.4 emb/s** on the M5 GPU, so the whole corpus is
  **27.6–31.5 h** or **4.7–5.4 h** respectively.
- **37 concurrent codesift processes** were observed. Whatever replaces ndjson must be safe under
  that, not merely tolerable.
- Resident vectors are budgeted at 256–1024 MB (`CODESIFT_MAX_EMBEDDING_MEM_MB`), a bound added
  after a server ballooned past 20 GB. A new format must live inside it, not route around it.
- **`grep -rn "fsync|fdatasync|flock" src/` → 0 real occurrences** (all 30 hits are the word
  "lockfile" in the dependency auditor). The only durability primitive in the codebase is
  tmp-write + `rename`, which `saveEmbeddings` uses and `appendSharedCache` does not.

---

## Decision

**Reject Option B.** Per-repo files must not become references into the shared cache. The
durability evidence against it is not a judgement call, and a second, independent argument
(model-keying) arrived with it.

**Adopt Option C** — fixed-width float32 records, per repo, self-contained — **with a file-level
checksum**, and **sequenced behind the reclamation work**, because migrating 22.32 GB of which
16.55 GB is inert is four times the work for none of the benefit.

**Keep the shared cache exactly as it is:** derived, write-side, optional, `rm`-safe.

**Keep Option D open** with a stated condition that reverses this ADR.

Order of work, and each stage is independently valuable:

1. **Stage 0 — done, `f61dbf5`.** Stream the chunk loader; cache chunk embeddings under the
   existing budget. Removed 88–90% of semantic-query wall clock and recovered 282,906 vectors.
   No format change.
2. **Stage 1 — reclamation.** Teach the disk side the model identity the load side already
   enforces, so the 14.11 GB dead cohort is either re-embedded or reclaimed, and let `prune` see
   `shared-embeddings.*`. Stop embedding chunks whose source text is under ~200 characters and
   skip minified/build output. Measured ceiling on these two: **16.55 GB + up to 4.33 GB**.
3. **Stage 2 — the format.** Option C, on whatever remains.

---

## Options Considered

### Option A: Leave as is

Genuinely defensible after Stage 0, and closer than the raw 22 GB suggests.

What A still costs, measured: 5.3× on disk for every live byte; 45.4–96.7 µs per vector on the
first load in each process (2,960 ms for codesift symbols, 10,036 ms for the largest chunk file);
no dedup at rest for a measured 9.67% byte-identical / 21.5% content-identical corpus.

What A does **not** cost, contrary to the framing this ADR started from: the silent read ceiling
(fixed, and it was one loader's whole-file read, not a property of ndjson — the symbol loader has
streamed all along), the per-query re-parse (fixed), and resident memory. That last one deserves
emphasis: **94.1 MB for 30,618 vectors is 3,075 bytes per vector, which is already float32-optimal.
A binary format changes disk and parse time; it does not free a byte of the RAM budget.**

Rejected, but only just, and for one reason: the parse cost is paid **once per process per repo**,
and the stdio server exits on client disconnect and is respawned per agent session. A 3–10 s stall
on the first semantic question of every session, forever, on a corpus that is 12% built out, is
not a cost that amortises.

### Option B: Reference format keyed into the shared cache — **REJECTED**

**Architecture:** per-repo files hold `{id, key}`; vectors resolve out of the shared table loaded
once per process.

The read-time case is strong and was measured honestly, with real reference files built from real
ids and real keys so every resolution hits:

| repo | vectors | today | as references | speedup | size |
|---|---:|---:|---:|---:|---:|
| codesift symbols | 30,618 | 2,960 ms / 499.1 MB | **79 ms / 3.00 MB** | 37× | 166× |
| tgmhelp | 14,343 | 1,213 ms / 234.0 MB | **14 ms / 1.58 MB** | 87× | 148× |
| mobilapp | 7,701 | 501 ms / 126.1 MB | **7 ms / 1.17 MB** | 72× | 108× |

The extra lookup is free: **90–329 ns** on a 67k map, **160–607 ns** on a full 1.22M map — 5–16 ms
for a 26,975-symbol repo, i.e. **0.3–0.9% of the 1,758 ms parse it replaces**. Nobody should reject
B because of the lookup.

**It is rejected on durability, and the evidence is measured, not argued.**

**1. The reader is engineered to discard silently, and that was verified by injection.** A
synthetic 1,000-record v2 cache was built against the compiled production loader and corrupted:

| injected fault | recovered | signal |
|---|---:|---|
| tail truncated mid-record | 700/1000 (30% lost) | none |
| 1 byte → implausible dim at record 100 | 100/1000 (**90% lost**) | none |
| 1 byte → implausible dim at record 10 | 10/1000 (**99% lost**) | none |
| 2 bytes flipped inside a vector | 1000/1000 — **wrong vector served as valid** | none |
| 1 byte flipped in a key | 1000/1000 — that text is a permanent miss | none |
| empty / unreadable file | 0 entries | none |

Every path is a bare `catch {}`, and the source states the intent: *"A cache that cannot be read
must degrade into 'compute it again', never into an error."* Correct for a derived cache.
Catastrophic for a system of record.

**2. The detection that exists barely fires.** Of the 16 single-bit flips possible in the 2-byte
`dim` field, **13 still yield a plausible dim (1..8192)**, so the reader does not stop — it
misaligns, and admits a record with the wrong vector length. That vector reaches
`cosineSimilarity` (`src/search/semantic.ts:60`), which returns 0 on a length mismatch, so the
symbol becomes permanently unretrievable with no error anywhere. Per 3,090-byte record, **99.417%
of bytes are vector payload where corruption is undetectable**, 0.518% key, 0.0647% dim — and for
the fraction that *is* detected, expected loss from a uniformly-placed corrupt byte is **50% of
the whole corpus**.

**3. No verification is possible even in principle.** The non-determinism measured above (51.9% /
83.0% agreement for identical text) means a stored vector cannot be checked by recomputing it.
Without a checksum there is no way to distinguish a corrupt vector from a valid one.

**4. Direction of derivation is the safety property, and B reverses it.** Today the per-repo files
are primary and the cache is derived: deleting `shared-embeddings.v2.bin` costs zero vectors, and
this already happened — `CACHE_VERSION` was bumped 1→2 in `5d265a4`, instantly orphaning
**745,247,727 bytes / 40,218 unique vectors**, with **no migration on purpose**. Nothing broke.
Under B that one-character change is total loss across every repo. The measured blast radius today
is one file, 437,226 vectors, **32.1% of the corpus**; under B it is **100% of all repo hashes**,
27.6–31.5 h at 12 emb/s, paid lazily inside whichever agent session next indexes each repo.

**5. There is no recovery path and no backup.** No rebuild, repair, verify or checksum code exists
for the shared cache. It cannot be reconstructed from per-repo files even in principle — the key is
`sha256(model\0dims\0text)` and the per-repo lines carry no text — so recovery means re-deriving
every symbol's text from the `.index.db` files, newly coupling embedding recovery to index
integrity. And for the **6 orphaned files (1.34 GB, 10 files / 2.20 GB by a later count)** there is
no working tree left at all: those vectors would be **unrecoverable, not merely expensive**.
Meanwhile `tmutil latestbackup` fails with *"Failed to mount destination"*; the last off-disk
snapshot is **2026-07-05, 35 days stale**; the only live copies are 15 same-disk APFS snapshots
covering ~25 h.

**6. It routes around the memory bound.** `loadSharedCache` builds an unbounded module-level `Map`
with no budget, no LRU, no eviction. At true corpus scale — a real 3.79 GB file with 1,225,101
records, built and read, not extrapolated — it is **9,029 ms and 4.06 GB resident (RSS 5.0 GB)**,
against a 1024 MB budget, **per process, with 37 processes observed**. That is the exact failure
mode the budget was added to prevent.

The non-resident alternative (key→offset index + `pread`) measures **1,269 ms build, 125 MB
resident, 5.1–8.2 µs/vector** → 220 ms for a codesift-sized set, 1,733 ms for the largest repo. It
solves the memory objection and none of items 1–5.

**7. Model-keying makes it worse than today, not better.** The model is inside `contentKey`. The
corpus is already three islands, and 63.2% of current bytes are dead from one provider switch.
Today that switch invalidates per repo, recoverable per repo. Under B it invalidates the single
store that every repo depends on.

**The size win and the durability risk are separable, and only B forces the trade.** A binary
per-repo format gets the 5.3× with none of the above.

### Option C: Fixed-width float32 records, per repo, no shared dependency ← **CHOSEN**

**Architecture:** `<hash>.embeddings.f32` — header (magic, version, model, dimensions, count,
checksum), an id table, then `count × dimensions × 4` bytes of contiguous float32 at a fixed
stride. Written tmp + `rename`, the path `saveEmbeddings` already uses.

| dimension | assessment |
|---|---|
| Size | 3,072 B/vector vs 16,330 B measured — **5.3×**, round trip verified bit-exact on 1,300 samples |
| Read | **Proxy-measured 7.4 µs/vector** vs 45.4–96.7 µs today — see caveat below |
| Durability | Blast radius unchanged: self-contained, tmp + `rename`, worst single loss stays one repo |
| Memory | **No change.** Resident is already 3,075 B/vector; the budget is unaffected |
| Migration | Read old ndjson, write new file. **No re-embedding** — the 27.6 h stays hypothetical |
| Lock-in | LOW — a header plus a matrix; dumping back to ndjson is a loop |

**The read figure is a proxy and must be labelled as one.** Nobody measured a per-repo float32
reader. The closest real measurement is `loadSharedCache` on a genuine 3.79 GB binary file in the
same record shape: **9,029 ms for 1,225,101 records = 7.4 µs/vector**, with a per-record
`Float32Array` constructed exactly as C would need. Against today's measured 45.4–96.7 µs/entry
that is 6–13×, and it is conservative: C can use strided views over one `ArrayBuffer` and skip
per-record construction entirely, which ADR-004 measured as the dominant cost in the analogous
index case (omitting the largest string field, 45% of resident bytes, made the load 2% faster —
object construction, not bytes, was the cost).

**C passes ADR-003's own test.** ADR-003 accepted a format change because "every frequent operation
gets dramatically cheaper, and the two that regress are the rare ones." Here the frequent
operation — first load per process — gets 6–13× cheaper; the cached query path is unchanged;
nothing frequent regresses.

**What C costs, honestly.** One regression is measured rather than speculative: in a fixed-width
binary file a corrupt payload byte yields a **silently wrong vector** (demonstrated above:
`float[33] 0.7379313707351685 → 2.951777696609497`, map size unchanged, served as valid), whereas
a corrupt byte in ndjson usually breaks `JSON.parse` and costs one line. Fixed stride taken from
the header means corruption cannot cascade the way the v2 per-record `dim` field does — the loss is
bounded to one vector — but "bounded and undetectable" is why the header carries a checksum. Beyond
that: a bespoke on-disk format to version, validate and debug, in a codebase with zero durability
primitives; and no cross-repo dedup at rest, conceding a measured 9.67% byte / 21.5% content.

**Forward argument, on measured numbers:** 230 registered repos have no embeddings and 155 of them
hold **2,226,275 indexed symbols**. At the measured 16,330 B/vector that is **36.4 GB**; at 3,072 B
it is **6.8 GB** (arithmetic on two measured figures). The corpus is 12% built out, so the encoding
decision is mostly about bytes not yet written.

### Option D: Embeddings as BLOBs in the per-repo SQLite database

On durability this is the best option on the list, and that should be said plainly. It reuses
machinery that exists and is tested: WAL, transactions, real atomic commit, `PRAGMA data_version`,
and ADR-003's `CODESIFT_INDEX_BACKEND` rollback switch. It answers every one of items 1–5 against
Option B and most of C's checksum problem. The durability pass reached the same conclusion
independently: *"SQLite already provides most of that, and this repo already depends on
`node:sqlite`."*

Deferred, not rejected, on three grounds:

1. **Its advantage is selectivity, which the current algorithm does not use.** The measured query
   is a full scan — cosine over all 26,975 vectors, 53–67 ms including RRF. Against a full scan,
   per-row `Buffer` allocation (197,312 of them on the largest chunk file) is pure overhead, and
   ADR-004 measured per-row construction as precisely where the time goes.
2. **ADR-003 measured SQLite's cold path 2–3× slower than JSON** (cold `loadIndex` 167.8 → 517.8 ms;
   full `saveIndex` 639 → 1,329 ms) and accepted it because the *frequent* operations got faster.
   For embeddings the frequent operation **is** the whole-corpus load. The trade that made ADR-003
   right points the other way here.
3. **Nothing at all has been measured for vectors in SQLite.** Every figure above is borrowed from
   ADR-003/ADR-004 on symbol rows. D is deferred on an analogy — a well-grounded one that names its
   mechanism, but a reader is entitled to demand the direct measurement, and it is an afternoon's
   work.

Secondary, neither decisive: D adds roughly **737 MB of BLOBs** to the largest repo's `.index.db`
(240,005 × 3,072), which is disk rather than heap but interacts with ADR-004's byte-budgeted index
cache; and it inherits the Node 20 dual-backend obligation, so the ndjson reader survives anyway.

**What reverses this ADR:** if semantic search moves to an ANN/IVF index where a query touches a
candidate subset instead of every vector, D's selectivity becomes the whole point and C's
contiguous-scan advantage becomes dead weight. Anyone planning that should argue for D **now**
rather than migrate the corpus twice.

---

## Measured outcome of Stage 0 (already shipped)

The only part of this ADR that has been implemented and measured after the fact, `f61dbf5`:

| | before | after |
|---|---:|---:|
| `loadChunkEmbeddings`, three queries, one process | 1,564 / 1,345 / 1,219 ms | **1,173 / 0 / 0 ms** |
| chunk vectors readable | 3 files reported empty | **+282,906 vectors** (~6.5 h of model time) |
| RSS spike per query | +686 MB | none after the first |

Stage 0 removed the largest measured cost in the system without changing the format. That is the
strongest single argument for taking Stages 1 and 2 in the stated order rather than starting with
the format.

---

## What is not measured

Stated as plainly as the findings, because several of these could change the answer.

**Load-bearing:**

1. **No one measured a per-repo binary reader or writer.** C's central performance claim is a
   proxy (7.4 µs/vector on a real 3.79 GB binary file of the same record shape), not a direct
   measurement. Measure it before Stage 2 ships. The write path of every option is entirely
   unmeasured, as is migration cost for 22.32 GB.
2. **Nothing is measured for embeddings in SQLite.** D is deferred on an analogy from symbol rows.
3. **Two agents disagree by 1.8× on cross-repo symbol redundancy**: 23.71% (over 748,546 resolved
   embedding lines) vs 42.0% (over 1,210,033 index symbols in 43 repos). Different populations —
   stored vectors vs current index contents — and the discrepancy was not resolved. That number is
   exactly what decides how much a shared table is worth, so **anyone quoting a single figure for
   what cross-repo sharing would save is quoting an unreconciled measurement.**
4. **Content duplication is a slight underestimate.** 7.6% of symbol lines (61,655 of 810,201) have
   ids no longer in the index and could not be resolved; those are disproportionately
   abandoned-worktree leftovers and therefore likely *more* duplicated than average.
5. **The cause of embedding non-determinism is unknown.** The effect was measured precisely (51.9%
   / 83.0%); the mechanism was not. Per-repo bimodality (4.1% vs 100%) favours temporal
   provider/model drift over per-call randomness, but no re-embedding test was run.

**Conditions that flatter the measurements:**

6. **Every read number is warm page cache.** `sudo purge` needs sudo, and the box has 128 GB RAM
   against a ~34 GB data dir — 499 MB streamed at 5.5 GB/s proves it. Today's format reads 5.3×
   more bytes than C would, so the speedups are lower bounds; but the `pread` option in B was also
   measured warm and would degrade most. **On a 16 GB laptop — the machine where the 4.06 GB
   resident option is also unaffordable — nobody knows which option wins.**
7. **The machine was under 24–37 concurrent codesift processes** throughout. Ratios should hold;
   absolutes are not clean-room figures. Full spreads are quoted rather than means.
8. **The corpus moved during measurement** — 20.61 → 22.32 GB over two days, and one file grew by
   4,294 lines / 70 MB between two passes of the same scan. No figure here is reproducible to the
   byte.
9. **The full-scale shared-cache measurement used synthetic keys and vectors.** Record count and
   dimension drive the cost, but real sha256 key distribution at 1.22M entries was not verified
   against V8 `Map` bucketing. The 67k-entry run on real keys (90–329 ns) brackets the synthetic
   figure (160–607 ns), which is reassuring, not proof.

**Durability gaps:**

10. **Power loss and kernel panic are untested,** and all corruption results are macOS/APFS. CI runs
    on Linux/ext4, where POSIX permits partial writes. Node's `appendFileSync` routes a `Buffer`
    through a `while` loop of separate `write(2)` calls with `flush: false`, so the source comment's
    claim that a concurrent writer "can interleave BETWEEN records but never inside one" is not
    guaranteed — it was never observed failing, but it was never excluded either.
11. **No torn v2 append has been scanned,** because no `shared-embeddings.v2.bin` exists yet. The
    clean v1 scan (46,253 lines, 0 unparseable, 0 bad keys, 0 wrong dims) covers only small appends,
    since v1's own `RangeError` capped every batch.
12. **Whether the APFS local snapshots contain a readable copy** of anything was not verified.
13. **The direction of the 63/26 model split is inferred from `launchctl getenv`,** not from the
    running server's environment. A GUI app launched before `launchctl setenv` would reject the
    other cohort instead. Either way one cohort is dead; the evidence supports 14.11 GB over 5.77 GB.
14. **Two scans of the v1 cache disagree on line count** (45,825 vs 46,253) while agreeing exactly on
    40,218 unique keys. Unexplained; it does not affect any conclusion here.

**Out of scope entirely:** GC pressure in a long-lived daemon holding a multi-GB pinned map; MCP
wire overhead (`semanticSearch()` was called in-process); whether the 14,593 duplicate-id rows in
`chunks.ndjson` with no matching embedding line indicate a write-path bug; and whether the 2,226,275
un-embedded symbols would fit the budget if embedded.

---

## Consequences

**Positive**

- Disk drops 5.3× on every live byte, round trip verified bit-exact — no quality change, by
  construction. On the 5.77 GB that is currently reachable that is ~4.7 GB; on the 2,226,275
  symbols not yet embedded it is the difference between 36.4 GB and 6.8 GB.
- First load per process drops from 45.4–96.7 µs/vector to a proxy-measured 7.4 µs — 3–10 s off the
  first semantic question of each agent session on the larger repos.
- Blast radius is unchanged and stays partitioned per repo: 437,226 vectors worst case, not the
  whole corpus.
- Migration re-reads; it does not re-embed. The 27.6 h figure stays hypothetical.
- Stage 1 reclaims a measured 16.55 GB before a single byte is migrated.

**Negative**

- A hand-rolled binary format is ours to version, validate and debug. **Rejecting D is where this
  ADR is most exposed**, and it is rejected without a direct measurement.
- Fixed-width binary turns a corrupt byte from "one skipped line" into "one silently wrong vector".
  The header checksum is a mitigation, not a cure — it detects the file, not the record.
- Two on-disk formats coexist through the migration, and the ndjson reader stays for rollback.
- No cross-repo dedup at rest; a measured 9.67% byte / 21.5% content is conceded.
- C's headline read number is a proxy until someone measures the real reader.

**Neutral**

- The shared cache keeps its role: derived, write-side, `rm`-safe, and demonstrably cheap to
  re-version. Its coverage will climb from 5.7% as v2 repopulates; that is worth ~10.3 h of the
  ~11.8 h of redundant symbol compute, and it is independent of this decision.
- The 70 zero-byte embedding files, the 6–10 orphaned files (1.34–2.20 GB) and the 9 zero-byte
  `.tmp.*` orphans are hygiene, and `prune` already handles the part that is genuinely abandoned.

---

## Rollback

`CODESIFT_EMBEDDING_FORMAT=ndjson|f32`, mirroring `CODESIFT_INDEX_BACKEND` from ADR-003. Unset
auto-detects by file extension; `=ndjson` forces the legacy reader; `=f32` forces the new one and
**fails loudly** rather than silently falling back, so CI cannot test the wrong path — the same
rule ADR-003 adopted, and the direct lesson of a format whose every failure mode to date has been
a silent `null`.

Migration **never deletes** the source `.ndjson`, exactly as ADR-003 retains `<hash>.json`.
Reverting is: set the env var, restart. It costs disk during the transition, which is the correct
price for a rollback that cannot cost 27.6 h of model time.
