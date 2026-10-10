<!-- zuvo-review -->
range: fdf9b37..f047b0f
files: crates/codesift-core/src/lib.rs, crates/codesift-core/src/store.rs, crates/codesift-napi/src/lib.rs, docs/adr/ADR-006-rust-core-napi.md, src/native/index.ts, src/retrieval/semantic-handlers.ts, src/storage/index-store.ts, src/storage/narrow-filters.ts, src/storage/sqlite/narrow-queries.ts, src/storage/sqlite/queries.ts, src/tools/context-levels/l2.ts, src/tools/context-tools.ts, src/tools/index-tools.ts, src/tools/index-tools/narrow-reads.ts, src/tools/plan-turn/stale-index.ts, src/tools/route-tools/express.ts, src/tools/route-tools/python-decorators.ts, src/tools/search-tools/zero-hit.ts, src/tools/taint-tools.ts, src/tools/wiki-module-builder.ts, src/tools/wiki-tools.ts, src/utils/heritage-edges.ts, tests/native/store-parity.test.ts, tests/storage/symbol-queries-backend-parity.test.ts, tests/tools/no-full-index-load.test.ts, tests/tools/wiki-tools.test.ts
adversarial: zuvo/proofs/rust-core-last-tools-adversarial.txt
tier: 3
verdict: APPROVE

# ABI 21: the last tool paths stop loading the whole index

`--multi` pass in two chunks, 10 REVIEW BY lines. Fixed in 7228c701: the getCodeIndex guard (lexer-based,
aliases and references count, every TS extension; it found and removed a dead lazy alias), a memoised
rejected Python read, a raw NUL byte that made zero-hit.ts a binary file in git, parity fixtures for
`extends: []` and hasHeritage+kind, a summary-shaped wiki mock. Rejected after checking: heritage living only
in `extras` (top-level CodeSymbol fields; extras is storage), unordered narrow reads (all ORDER BY rowid),
order-dependent heritage resolution (set size), a partial declaration read (repo-wide by kind), stale narrow
reads (getIndexSummary runs ensureIndexFresh), and the `→`-separator collision (the key uses `|`).
