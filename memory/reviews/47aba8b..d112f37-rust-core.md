<!-- zuvo-review -->
range: 47aba8b..d112f37
files: src/tools/project-profile-extractors.ts, src/tools/project-profile-imports.ts, src/tools/project-tools.ts, tests/tools/project-profile-boundaries.test.ts, tests/tools/project-tools.test.ts
adversarial: zuvo/proofs/rust-core-analyze-project-adversarial.txt
tier: 3
verdict: APPROVE

# analyze_project on the summary plus three narrow reads

`--multi` pass (5 REVIEW BY lines). Fixed in a459385: summary-only indexes could reach the source-built counts (overloads restore the compile-time guard). The fallback for unread files, which reads most of the index in non-JS/TS repos as it did before, is recorded in ADR-006 as a known limit. Rejected: the profile not coming from one snapshot (the existing narrow-read pattern), and mocks returning [] (wiring was checked against the full-index path on two real repos instead).
