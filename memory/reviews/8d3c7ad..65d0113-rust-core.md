<!-- zuvo-review -->
range: 8d3c7ad..65d0113
files: crates/codesift-core/src/lib.rs, crates/codesift-core/src/store.rs, crates/codesift-napi/src/lib.rs, docs/adr/ADR-006-rust-core-napi.md, src/native/index.ts, src/storage/narrow-filters.ts, src/storage/sqlite/queries.ts, src/tools/plan-turn/orchestrator.ts, src/tools/plan-turn/query-parser.ts, src/tools/search-ranker.ts, src/tools/search-tools/text-search.ts, tests/native/store-parity.test.ts, tests/storage/symbol-queries-backend-parity.test.ts, tests/tools/plan-turn.test.ts
adversarial: zuvo/proofs/rust-core-narrow-reads-adversarial.txt
tier: 3
verdict: APPROVE

# Ranked search_text and plan_turn on narrow reads (ABI 19, names predicate)

Self-review, so the adversarial pass ran `--multi` (5 REVIEW BY lines). Fixed in 4c2a8f1: no store read for zero hits, and the plan_turn mock now fails closed. Rejected after checking the code: case/length/Unicode mismatch (queryIdentifiers uses parseQuery's exact IDENT_RE on the same capQuery, and old vs new matched on two real indexes), ordering (ORDER BY rowid on both stores, covered by the parity matrix), "napi drops names" (the mapping is present), swallowed storage errors (the catch rethrows IndexStorageError).
