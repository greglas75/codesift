<!-- zuvo-review -->
range: 8ebe14b97326e1565063041d7b92b58748618eb2..3a322e9e4e3ccfe0184e2ca08ee6a5929ca32535
files: src/search/tool-ranker.ts, src/search/tool-ranker-types.ts, src/search/tool-ranker-bm25.ts, src/search/tool-ranker-reasoning.ts, src/search/tool-ranker-orchestrator.ts, src/search/tool-ranker-signals.ts, src/search/tool-ranker-signal-math.ts, src/search/tool-embedding-cache.ts, src/search/tool-embedding-storage.ts
verdict: PASS
-->

# Review: all tool-ranker refactor commits

## META

- Range: `8ebe14b..3a322e9`
- Type: production TypeScript refactor with a regression-test fix
- Tier: 2 — STANDARD, SELF-REVIEW

## SCOPE FENCE

Nine production modules under `src/search/`, the public facade, and the focused ranker test.

## VERDICT

APPROVE after one automatically applied fix.

## QUESTIONS FOR AUTHOR

None.

## DEPLOYMENT RISK

LOW (1 point for new production modules). Standard CI and direct merge are appropriate.

## SEVERITY SUMMARY

- MUST-FIX: 0
- RECOMMENDED: 1 fixed
- NIT: 0

## CHANGE SUMMARY

The 571-line ranker was split into a stable facade and focused modules for BM25, signals,
scoring orchestration, reasoning/calibration, types, and embedding persistence.

## SKIPPED STEPS

CodeSift was unavailable in this host. Local equivalents covered diff structure, impact,
secret patterns, CQ patterns, symbol references, and hotspot history.

## VERIFICATION PASSED

- 84 focused and integration tests
- TypeScript type-check
- Production build
- Independent behavior audit
- Independent CQ1-CQ29 audit
- Self-review adversarial `--multi`, followed by a clean post-fix pass

## BACKLOG IN SCOPE

N/A — no unresolved findings.

## DROPPED ISSUES

None.

## FINDINGS

R-1 [RECOMMENDED, FIXED] Non-finite usage values could corrupt structural ranking

- File: `src/search/tool-ranker-signal-math.ts:34`
- Confidence: 88/100
- Evidence: the extracted normalization initially allowed `NaN`/`Infinity` to poison the
  maximum or produce a non-finite weighted score.
- Fix: `src/search/tool-ranker-signal-math.ts:36` rejects a non-finite selected value and
  `src/search/tool-ranker-signal-math.ts:39` excludes non-finite candidates.
- Regression coverage: `tests/search/tool-ranker.test.ts:236` and
  `tests/search/tool-ranker.test.ts:257` cover unrelated and directly ranked values.

## QUALITY WINS

- Public imports remain stable through the facade.
- Every production module is at most 70 lines.
- Ranking weights, BM25 behavior, confidence calibration, and cache fallbacks remain equivalent.

## TEST ANALYSIS

The suite now contains 36 focused ranker tests plus 48 plan-turn integration tests. The added
parameterized cases cover `NaN`, positive infinity, and negative infinity in both relevant paths.
