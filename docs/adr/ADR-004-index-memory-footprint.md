# ADR-004: Index memory footprint — budget the cache in bytes, keep whole-index loads for now

**Status:** Accepted (staged — stage 1 done; stage 2 started, first increment shipped)
**Date:** 2026-08-04 | **Deciders:** Greg Laskowski | **Area:** Storage

---

## Context

ADR-003 moved the index from one JSON blob per repo to SQLite and removed the write-path cost:
`saveIncremental` no longer re-parses the whole repo to update one file, and per-file reads go
through narrow queries. What it did not change is the **read** path — `loadIndex` still
materialises every symbol of a repo as a JS object.

Profiling after ADR-003 landed attributed the remaining stalls to garbage collection
(`Heap::Scavenge`), not to SQLite. That is consistent with the object graph: the index is by a
wide margin the largest thing this process holds, and `codesift serve` is a long-lived daemon.

### Measured, on the real tgm-survey-platform index (240,137 symbols)

| what | value |
|---|---:|
| resident heap for one loaded index | **349 MB** |
| of which `source` text | **185 MB (45%)** |
| of which everything else (objects, ids, paths, signatures) | 164 MB (55%) |
| cold load | ~1.0 s |
| cold load with `source` omitted | ~1.0 s (**2% faster**) |

The split matters because it separates two different problems that were being discussed as one:

1. **Resident bytes → GC pressure.** Dominated by `source`, which is 77% of the stored text.
2. **Load time.** Dominated by constructing 240k objects. Dropping `source` barely moves it —
   the strings are cheap to attach, the objects are not.

So "stop loading source" would halve the memory and do nothing for the time; only "stop
materialising the index at all" fixes both.

### Why the cache made this worse than it had to be

The index cache was bounded by **entry count** (`CODESIFT_MAX_CACHED_INDEXES`, default 3). Index
sizes span two orders of magnitude — 349 MB here against a few MB for a small repo — so "at most
three indexes" is not a memory ceiling in any useful sense; on this machine it permits ~1 GB of
long-lived heap. The neighbouring embedding cache has been byte-budgeted
(`CODESIFT_MAX_EMBEDDING_MEM_MB`) since the OOM reports in CLAUDE.md. The asymmetry was noted in
the code comment and then only half-fixed.

## Decision

**Stage 1 (this ADR, implemented).** Budget the index cache in bytes.

- `CODESIFT_MAX_INDEX_CACHE_MB`, RAM-scaled by the same tiers as the embedding budget
  (≤16 GB → 256 MB, ≤32 GB → 512 MB, else 1024 MB).
- Footprint is **tallied by the loader while it walks the rows** — one addition per row, no extra
  query, no estimate. Indexes that arrive another way (JSON backend, hand-built in a test) fall
  back to a constant calibrated against the measurement above.
- Both constants are rounded **up** from their fitted values. The residual error belongs on the
  evict-sooner side: over-reporting costs a re-read, under-reporting silently breaks the budget.
  Measured overshoot on the calibration index: 9.4%.
- Text is measured with `Buffer.byteLength`, not `String.length`, on the prose-bearing fields
  (`source`, `docstring`, `signature`, `extras`). `.length` counts UTF-16 code units, and V8 stores
  a string at one byte per character only while every character fits Latin1 — so `.length`
  under-reports CJK, Cyrillic and emoji-bearing text by roughly half, in the one direction this
  design rules out. `source` alone is 45% of the footprint, so a repo commented in Chinese would
  have quietly exceeded the cap. Identifiers and paths keep `.length`: they are effectively always
  ASCII, where it is exact, and there are 240k of them per load.
- The entry cap stays as a cheap secondary bound.
- The most recently loaded index is **never** evicted, even if it alone exceeds the budget.
  Evicting it would re-read and re-evict on every call — an unbounded reload loop that costs far
  more than the memory it reclaims. A repo larger than the whole budget is a reason to raise
  `CODESIFT_MAX_INDEX_CACHE_MB`.

**Stage 2 (started).** Stop materialising whole indexes: have each tool query the database for the
rows it actually needs.

First increment shipped — `loadIndexSummarySqlite` / `getIndexSummary`, returning `IndexSummary`:
files and metadata with **no `symbols` field at all**. Not a `CodeIndex` with an empty array, which
would be a lie a caller cannot detect — iterating it reads as "this repo has no symbols". With the
field absent, a consumer that needs symbols fails to compile instead of failing silently.

`index_status` is the first consumer, and the clearest: it reports counts it reads from metadata and
never touched `index.symbols`. Measured on the real 240k-symbol index — full load **15.9 s / 349 MB**
against summary **2.3 s / 3 MB**: **7.0x faster, 345 MB less resident heap**, with `symbol_count` and
`file_count` identical (the SQL `COUNT(*)` agrees with the materialised array length).

The remaining consumers are the bulk of the work; see the call-site count below.

## What stage 2 costs, and why it is not being done quietly

`loadIndex` / `getCodeIndex` has **348 call sites across 150 files**. This is not a mechanical
edit — each site has to be read to establish which slice of the index it genuinely uses, and the
failure mode of getting it wrong is the one this codebase has been repeatedly burned by: a tool
that returns fewer results and reports success, so a partial answer reads as a fact about the
code.

Two rejected shortcuts, recorded so they are not re-proposed:

- **Omit `source` by default.** Halves the memory in one line — and hands `undefined` to the ~60
  files that read `.source`, silently. A missing field is indistinguishable from a symbol that
  genuinely has no source text.
- **Make `source` a lazy getter.** A prototype getter is not serialised by `JSON.stringify`, so
  source would silently vanish from any serialised response; an own-property accessor on 240k
  objects puts them all in dictionary mode, costing more than the strings it defers.

Neither is acceptable, which is why stage 2 is a real refactor rather than a flag.

**This ADR is the queue entry.** The direct lesson of ADR-003 is that a cost documented in
CLAUDE.md but written into no ADR, spec or backlog sat unaddressed for five months with no
blockers — description is not scheduling.

## Consequences

- A daemon touching several large repos now has a stated memory ceiling instead of an implicit
  "three times the largest repo you happen to open".
- Repos evicted under the byte budget are re-read, not lost. On a machine below the tier
  boundaries this trades some cache hits for a bounded heap — the same trade the embedding cache
  already makes.
- Load *time* is unchanged for consumers that still need symbols. It is 7.0x better for the
  first consumer that does not; stage 2 is what carries that to the rest.
- The calibration constants are fitted to one index. If a future repo profiles very differently,
  re-fit them from a `heapUsed` delta rather than adjusting them by feel.
