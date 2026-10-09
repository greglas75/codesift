<!-- zuvo-review -->
range: c84cdcd..384df94
files: .cargo/config.toml, .github/workflows/release.yml, .github/workflows/test.yml, .gitignore, CLAUDE.md, Cargo.lock, crates/codesift-core/Cargo.toml, crates/codesift-core/src/lib.rs, crates/codesift-core/src/store.rs, crates/codesift-napi/Cargo.toml, crates/codesift-napi/src/lib.rs, crates/codesift-napi/src/sqlite_compat.rs, docs/adr/ADR-006-rust-core-napi.md, docs/release-native.md, npm/darwin-arm64/README.md, npm/darwin-arm64/package.json, npm/darwin-x64/README.md, npm/darwin-x64/package.json, npm/linux-arm64-gnu/README.md, npm/linux-arm64-gnu/package.json, npm/linux-x64-gnu/README.md, npm/linux-x64-gnu/package.json, npm/win32-x64-msvc/README.md, npm/win32-x64-msvc/package.json, scripts/bootstrap-native-packages.mjs, scripts/build-native.mjs, scripts/publish-native-packages.mjs, src/cli/commands-maintenance.ts, src/native/index.ts, src/storage/sqlite/native-sqlite.ts, src/storage/sqlite/runtime.ts, src/tools/index-tools/worktree-seed.ts, tests/native/sqlite-compat-parity.test.ts, tests/native/sqlite-compat-scenarios.ts, tests/storage/sqlite-fault-classification.test.ts
adversarial: zuvo/proofs/rust-core-sqlite-compat-adversarial.txt
tier: 3
verdict: APPROVE

# Rust core (ADR-006) — native platform packages + node:sqlite DatabaseSync port (single SQLite owner)

Self-review (author == reviewer), so the adversarial pass ran `--multi` across five providers
(25 REVIEW BY lines in the proof). Findings were triaged against the code: real defects were fixed in the
following range and re-reviewed (use-after-free on re-entrant binds, in-place `.node` install killing
processes, stack overflow on too-deep trees, credentials written into the service unit, re-run-unsafe
release, per-chunk stream stop/limit). The rest were rejected as false
positives or as deliberate 1:1 ports of the TypeScript extractors (parity verified at 0 differences on
millions of symbols), where "fixing" the port would make it disagree with the TypeScript path.
