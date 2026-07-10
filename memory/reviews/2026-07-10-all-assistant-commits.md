# Review: all assistant commits

## 1. META

- Date: 2026-07-10
- Range: `d453ab3..209c975`
- Commits: 5 (`583496d`, `384769b`, `d3673b7`, `197f3da`, `209c975`)
- Size: 27 files, +3299/-2603
- Diff type: mixed
- Language/framework: TypeScript / none
- Tier: 3 DEEP, self-review
- Mode: FIX-AUTO

## 2. SCOPE FENCE

Reviewed only committed content in `d453ab3..209c975`. The working tree also contained unrelated staged and unstaged work, so committed snapshots were read with `git show`/`git diff` and verified from an archive of `209c975`. Review fixes are intentionally left unstaged.

## 3. VERDICT

**INCOMPLETE [VALIDITY GATE FAIL].** One introduced regression and two localized pre-existing defects were fixed. Two pre-existing structural risks remain in backlog. The mandatory cross-provider adversarial gate produced no valid review: Claude was unauthenticated, Codex/Cursor returned no result, and Gemini timed out.

## 4. QUESTIONS FOR AUTHOR

None. The only introduced behavior regression had an unambiguous expected contract.

## 5. DEPLOYMENT RISK

**MEDIUM.** The range is a large multi-module refactor, but its public facade exports remain stable. Deploy only after a valid external adversarial pass is available and the unstaged fixes are committed.

## 6. SEVERITY SUMMARY

| State | MUST-FIX | RECOMMENDED | NIT |
|---|---:|---:|---:|
| Introduced by range | 0 | 1 fixed | 0 |
| Pre-existing, moved | 0 | 9 addressed, 2 deferred | 0 |
| Open merge findings | 0 | 2 structural | 0 |

## 7. CHANGE SUMMARY

- Split search tools into focused search, symbol, semantic, ripgrep, and zero-hit modules.
- Split plan-turn routing into parser, formatter, context, recommendation, stale-index, and orchestration modules.
- Split Kotlin tools by capability while preserving the facade.
- Added characterization/regression coverage and bounded several search and plan-turn inputs.

## 8. SKIPPED STEPS

- `review_diff`, `changed_symbols`, `diff_outline`, and `scan_secrets` were absent from the host tool surface. Substitutions were `audit_scan`, `impact_analysis` plus file outlines, and a diff-scoped secret-pattern scan.
- No framework-specific audit applied (`framework=none`).
- The content-keyed success artifact and `reviewed/*` tags were not created because the review did not pass the validity gate.

## 9. VERIFICATION PASSED

- Clean committed snapshot: 108/108 scoped tests passed across search, plan-turn, and Kotlin.
- Current working tree after fixes: 108/108 scoped tests passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- Full suite reached 4532 passing and 196 skipped tests; 42 tests failed for sandbox-only restrictions (`~/.codesift` writes, FSEvents, loopback listeners), not assertions in the reviewed modules.
- Diff secret scan: 14 identifier/fixture matches manually classified; 0 secrets.

## 10. BACKLOG IN SCOPE

- `src/tools/search-tools/text-search.ts|CQ3|sync-regex-fallback-redos` — structural-refactor (multi-file).
- `src/tools/kotlin-tools.ts|CQ6|unbounded-result-arrays` — structural-refactor (multi-file).
- `B-review-incomplete-2026-07-10` — rerun external adversarial coverage and clear this validity failure.

## 11. DROPPED / ADDRESSED ISSUES

- Fixed during this review: unindexed plan-turn truncation metadata at `src/tools/plan-turn/orchestrator.ts:328`; source-size input clamping at `src/tools/search-tools/symbol-search.ts:57`; unreadable Kotlin file reporting at `src/tools/kotlin-sealed-tools.ts:114`.
- Already addressed by unstaged follow-up work present before this review: escaped Kotlin regex names, comment/string-aware brace matching, nested cancellation parsing, overload preservation, uppercase callable discovery, depth validation, and `stateIn` whitespace handling. Evidence is visible at `src/tools/kotlin-sealed-tools.ts:33`, `src/tools/kotlin-suspend-tools.ts:87`, and `src/tools/kotlin-flow-tools.ts:52`.
- No confidence-scored candidate was dropped as a false positive.

## 12. FINDINGS

### M1 [RECOMMENDED, structural-refactor] Synchronous regex fallback can outlive its wall-clock contract

- File: `src/tools/search-tools/text-search.ts:31`
- Supporting rule set: `src/tools/search-tools/constants.ts:32`
- Confidence: 97/100
- Verified-against: 209c975
- Origin: pre-existing, moved unchanged by the refactor
- Evidence: the denylist is necessarily incomplete, while `RegExp.test()` at `src/tools/search-tools/text-search.ts:62` runs synchronously. Abort/deadline checks cannot interrupt catastrophic backtracking once matching begins.
- Fix recipe: execute fallback regex matching in an isolated worker/child with a hard kill deadline, then make the current wall-clock sentinel cover that process boundary. Add adversarial regex fixtures that evade the current four-pattern denylist.
- Defer reason: **structural-refactor (multi-file)**.

### M2 [RECOMMENDED, structural-refactor] Kotlin analysis result arrays are unbounded

- File: `src/tools/kotlin-extension-tools.ts:27`
- Related: `src/tools/kotlin-kmp-tools.ts:106`, `src/tools/kotlin-sealed-tools.ts:114`
- Confidence: 90/100
- Verified-against: 209c975
- Origin: pre-existing, moved unchanged by the refactor
- Evidence: public analysis functions accumulate results across the whole index without a shared maximum, truncation flag, or input option. Large Kotlin repositories can therefore create oversized responses and avoid the bounded-output contract used by search tools.
- Fix recipe: add a shared Kotlin result-limit helper, thread `max_results` through public option types and registration schemas, return `truncated` metadata, and add large-index tests for all three capabilities.
- Defer reason: **structural-refactor (multi-file)**.

## 13. QUALITY WINS

- Stable facade files preserve existing import paths while capability modules depend one-way on shared types.
- Structure audit found no new dependency cycles and no changed production module over the applicable size threshold.
- Direct test references cover all key exported search, plan-turn, and Kotlin functions.

## 14. TEST ANALYSIS

### Production-file CQ evaluation

| Files | Result |
|---|---|
| Stable facades and most plan/search modules | 23/23 applicable CQ checks pass |
| `src/tools/kotlin-extension-tools.ts` | CQ6 fail (unbounded results) |
| `src/tools/kotlin-flow-tools.ts` | CQ12 issue addressed in unstaged follow-up |
| `src/tools/kotlin-kmp-tools.ts` | CQ1/CQ6 fail (heuristic parsing, unbounded results) |
| `src/tools/kotlin-sealed-tools.ts` | CQ1/CQ3/CQ6/CQ8/CQ17 findings; localized items addressed, CQ6 remains structural |
| `src/tools/kotlin-suspend-tools.ts` | CQ3/CQ12 findings addressed in unstaged follow-up |
| `src/tools/search-tools/symbol-search.ts` | CQ3/CQ6 localized source bound fixed |
| `src/tools/search-tools/text-search.ts` | CQ3/CQ8 structural regex isolation remains |

### Changed-test Q1-Q19 evaluation

| Test file | Score | Critical gap |
|---|---:|---|
| `tests/tools/kotlin-tools.test.ts` | 17/19 | Q11 blind coverage gap in committed snapshot; follow-up cases now present |
| `tests/tools/plan-turn.test.ts` | 18/19 | No critical gap after truncation regression test |
| `tests/tools/search-tools-characterization.test.ts` | 15/19 | Q11 blind boundary coverage improved with `source_chars` cases |

## Validity note

This report is evidence-bearing but does not grant pipeline review coverage. A fresh `--multi` adversarial review of the exact resulting commits is still required.
