range: 8ebe14b..multi25
files: *

# Review — all Codex refactor commits (2026-07-11)

## Meta

- Scope: 25 commits on 11 `codex/refactor-*` branches, 103 unique changed files
- Diff: mixed, approximately 401 KB
- Tier: 3 / DEEP / SELF-REVIEW
- Deployment risk: MEDIUM
- CodeSift: absent in build; git-diff, symbol/import, secret-pattern and anti-pattern substitutes used

## Verdict

APPROVE WITH STRUCTURAL FOLLOW-UPS. No open MUST-FIX finding remains.

## Applied fixes

- PostgreSQL timeout classification now uses the rejected sentinel identity.
- Yii3 reports fulfilled scans separately from failed reads.
- Kotlin escaped annotation normalization has a direct regression test.
- Tool embedding caches reject null, malformed, and non-finite vectors.

## Findings

### R-1 [RECOMMENDED — structural-refactor]

The SQL extractor branch should use the cycle branch's shared symbol utilities when the branches are integrated.

- Evidence: `/tmp/codesift-refactor-sql/src/parser/extractors/sql-columns.ts:2` and `/tmp/codesift-refactor-sql/src/parser/extractors/sql-symbols.ts:2` import the central extractor, while `/tmp/codesift-refactor-cycles/src/parser/symbol-utils.ts:1` is the inverted dependency target.
- Confidence: 97/100
- Recipe: merge the cycle branch first; update both SQL imports to `../symbol-utils.js`; run SQL extractor and circular-dependency tests.
- Defer reason: [structural-refactor (multi-file/cross-branch)]

### R-2 [RECOMMENDED — structural-refactor]

The extracted PostgreSQL introspection module remains oversized and mixes driver discovery with query lifecycle.

- Evidence: `/tmp/codesift-refactor-pg/src/tools/pg-introspection.ts:36` begins the driver loader; connection/query orchestration continues through `/tmp/codesift-refactor-pg/src/tools/pg-introspection.ts:395`.
- Confidence: 94/100
- Recipe: extract driver discovery/loading; retain connection lifecycle in the orchestrator; characterize loader failure and cleanup paths.
- Defer reason: [structural-refactor (multi-file)]

### R-3 [RECOMMENDED — structural-refactor]

Conversation search remains a 317-line multi-operation module.

- Evidence: `/tmp/codesift-refactor-conversation-tools/src/tools/conversation-search-tools.ts:109`, `:162`, `:198`, and `:266` contain independent search, fusion, all-repo, and symbol-lookup flows.
- Confidence: 90/100
- Recipe: extract result fusion/loading and symbol lookup behind the existing facade; retain current cache identity; rerun conversation search tests.
- Defer reason: [structural-refactor (multi-file)]

### R-4 [RECOMMENDED — structural-refactor]

The server response-hint dispatcher remains a large conditional hotspot.

- Evidence: `/tmp/codesift-refactor-server-helpers/src/server-helpers/response-hints.ts:88` through `:234` is one dispatcher.
- Confidence: 92/100
- Recipe: introduce per-hint detector functions and a rule table; keep ordering explicit; characterize first-match behavior.
- Defer reason: [structural-refactor (multi-file)]

### R-5 [RECOMMENDED — structural-refactor]

Kotlin helper modules remain above the utility-file limit.

- Evidence: `/tmp/codesift-refactor-kotlin-extractor/src/parser/extractors/kotlin-ast-helpers.ts:1` and `/tmp/codesift-refactor-kotlin-extractor/src/parser/extractors/kotlin-test-symbols.ts:1` are approximately 206 and 200 lines.
- Confidence: 92/100
- Recipe: separate annotation/type-name helpers from literal decoding; split Kotest suite detection from test-case traversal; retain facade exports and direct tests.
- Defer reason: [structural-refactor (multi-file)]

## Dropped findings

- Conversation/context/secret cache findings were pre-existing, moved-verbatim behavior rather than regressions in these commits.
- PostgreSQL raw diagnostic restoration was rejected after adversarial review because it could expose an error oracle; generic external errors remain the safe default.
- Yii3 hardlink rejection is an explicit containment policy; the applied `read_failures` telemetry makes skipped coverage visible.
- Tool-ranker non-finite usage handling was already fixed at the reviewed branch tip.

## Verification

- Secret-pattern scan: 0 hits.
- Empty-catch/unsafe-cast scan: 0 introduced actionable hits.
- Focused suites: PG 34/34, Yii3 21/21, Kotlin 52/52, tool ranker 39/39.
- TypeScript checks passed on all four modified branches.
- Four self-review adversarial chunks ran with `--multi`; final fix validation converged with no open critical finding.

## CQ/Q summary

- Critical CQ3/CQ4/CQ5/CQ6/CQ8/CQ14 regressions: 0 open.
- Changed tests use production imports and behavioral assertions; the Kotlin gap was fixed.
- Structural CQ11 findings are R-2 through R-5.
