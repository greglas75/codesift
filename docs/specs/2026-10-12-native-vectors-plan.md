# Plan: embedding vectors in the Rust core (ADR-006 stage 11, ADR-005 stage 2)

## Why (measured 2026-10-12, Mac)

- **Semantic search on the largest repos costs a minute of the daemon's thread.** An rdesigner worktree's
  `.embeddings.ndjson` is **7.6 GB** for 462,980 vectors (768-d). With this Mac's 2,048 MB embedding budget the
  TypeScript loader reads it: **51.8 s** of `JSON.parse` on the main thread, then **691 ms** per query. On a
  machine with a smaller budget (≤ 1 GB, i.e. ≤ 64 GB RAM) the file is above 4× the budget and is never read,
  so semantic search there is BM25 in disguise.
- **Disk.** 83 repos hold **210.8 GB** of vector ndjson (apparent size; worktree seeds are APFS clones until
  rewritten, after which each costs 7.6 GB). As float32 the same vectors are 5.3× smaller (ADR-005).
- **Load cost.** ADR-005 measured 45–97 µs per vector to parse ndjson in V8 (`JSON.parse` + `Float32Array`),
  i.e. ~20–45 s for one rdesigner file, on the daemon's main thread, and the vectors then live in the V8 heap.

## Principles (ADR-006, unchanged)

1. The on-disk format does not change in the same stage as the language.
2. `CODESIFT_NATIVE_VECTORS=auto|0|1`; no binary → the TypeScript path, exactly as today.
3. Parity: identical top-K ids AND scores against the TypeScript ranking on real vector files; a diff is a failure.
4. Measure in the condition (rdesigner, 463k vectors), go/no-go per stage, regression test per real bug.

## Stage E1 — native vector set over the existing ndjson (language only)

- `crates/codesift-core/src/vectors.rs`:
  - parse ndjson in parallel (rayon over newline-aligned byte ranges); `{id, vec, h?}`; `id_rebase` from
    the meta; Map semantics (a repeated id keeps its first position, last value wins);
  - one contiguous `Vec<f32>` plus a per-vector norm computed once (same summation order as the TS loop);
  - vectors whose width differs from the first are excluded (the TS paths skip them too).
- Search, bit-identical to the TS rankings:
  - cosine in f64 over f32 inputs, `dot / (sqrt(na) * sqrt(nb))`, stable sort by score descending over
    load order;
  - a filter: file substring + `isTestFile` (the rule already ported for stage 6), over a per-vector file
    the caller attaches once (`attachFiles(ids, files)`): Rust never opens the index database itself (the
    single-SQLite-owner rule);
  - single query → top K (`searchSemantic`); several queries → RRF with `RRF_K` (`computeRRFScores`),
    including its tie order.
- napi `NativeVectors` handle (`loadVectors(path, rebase)` as an AsyncTask, `searchAsync`, `attachFiles`,
  `footprintBytes`, `release`), off the main thread.
- Daemon wiring: the symbol path of `semantic_search` / `codebase_retrieval` uses the native set; its own
  byte budget, RAM-scaled like the call graph (`CODESIFT_MAX_VECTOR_CACHE_MB`), reported in `/health` caches.
  The TS embedding budget keeps bounding the fallback.
- Fix found while reading (TS, before parity): `searchSemantic` cuts top K BEFORE dropping ids that are no
  longer in the index, so stale vectors take result slots — drop them first.
- Parity script `scripts/native-vectors-parity.ts <vector file>`: queries = stored vectors plus noise,
  with and without filters, single and multi-query; 0 diffs.
- Gate: rdesigner semantic search answers; load ≥ 5× faster than the TS loader; heap does not grow by the
  vector bytes.

## Stage E2 — binary vector file (format only)

- `<hash>.embeddings.vec`: magic + version, header JSON (model, dimensions, count), id table (+ content
  hashes), 64-byte-aligned float32 matrix, checksum over all of it. Written temp + rename.
- Read AND written by both Rust (mmap: file-backed pages, not process heap) and TypeScript (the fallback).
- Writers switch to `.vec` (end of an embedding run, worktree seed clone); the checkpoint stays ndjson
  (small, append-only). Readers prefer `.vec`, else ndjson. A repo with only ndjson is converted on its next
  native load.
- `prune` reclaims an `.embeddings.ndjson` once a valid newer `.vec` sibling holds the same count.
- Gate: ~5× less disk; cold rdesigner load from disk under a second.

## Stage E3 — chunk and conversation vectors (measure first)

Chunk vectors (16 repos) and conversation vectors on the same handle, if the measurement shows a cost
worth moving. Go/no-go recorded in ADR-006.

## Verification (every stage)

`rt rust` (fmt, clippy -D warnings, cargo test); `rt npx vitest run` default and with
`CODESIFT_NATIVE_VECTORS=1`; parity on real files; CI `native` job; daemon rebuilt, restarted and watched.
