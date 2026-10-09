<!-- zuvo-review -->
range: d6e7b7a..81e3b7a
files: crates/codesift-napi/src/sqlite_compat.rs, scripts/publish-native-packages.mjs, src/storage/sqlite/queries.ts, tests/storage/symbol-queries.test.ts
adversarial: zuvo/proofs/rust-core-review-fixes-3-adversarial.txt
tier: 3
verdict: APPROVE

# Rust core (ADR-006) — fixes from review 4: whole-stream early stop

Self-review (author == reviewer), so the adversarial pass ran `--multi` across five providers
(4 REVIEW BY lines in the proof). Findings were triaged against the code: real defects were fixed in the
following range and re-reviewed (use-after-free on re-entrant binds, in-place `.node` install killing
processes, stack overflow on too-deep trees, credentials written into the service unit, re-run-unsafe
release, per-chunk stream stop/limit). The rest were rejected as false
positives or as deliberate 1:1 ports of the TypeScript extractors (parity verified at 0 differences on
millions of symbols), where "fixing" the port would make it disagree with the TypeScript path.
