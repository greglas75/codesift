# ADR-006: Rust core behind napi-rs — storage, BM25 and parsing move; the MCP layer and tools stay

**Status:** Accepted (stage 0 in progress)
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
