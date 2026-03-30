# Implementation Plan: review_diff

**Spec:** docs/specs/2026-03-30-review-diff-spec.md
**spec_id:** 2026-03-30-review-diff-1845
**plan_revision:** 2
**status:** Approved
**Created:** 2026-03-30
**Tasks:** 9
**Estimated complexity:** 5 standard + 4 complex

## Architecture Summary

- **1 new file:** `src/tools/review-diff-tools.ts` (~250 lines) — orchestrator + 4 new check functions
- **2 modified files:** `src/register-tools.ts` (1 entry), `src/formatters.ts` (1 function)
- **1 new test file:** `tests/tools/review-diff-tools.test.ts`
- **Pattern:** `Promise.allSettled` fan-out (proven in `report-tools.ts:generateReport`)
- **Dependencies:** None new. Composes 6 existing internal functions + 3 new ones.

## Technical Decisions

1. **Coupling check (D6):** Raw `git log --name-only` → Jaccard matrix. NOT intersection of existing results.
2. **Breaking check (D7):** `git show <since>:<file>` → parse with existing extractors → compare export names. Simplified to name presence/absence (not signature comparison) for v1.
3. **Complexity delta:** Filter `analyzeComplexity()` results to changed files. Flag functions with cyclomatic > 10. True before/after delta deferred to v2.
4. **Test gaps (D8):** Naming convention (`auth.ts` → `auth.test.ts`) + import graph from index.
5. **Per-check `Promise.race` timeout (AC#10, AC#20):** Each check wrapped in `Promise.race([check(), timeoutPromise(check_timeout_ms)])`. Timeout resolves to `{status:"timeout", findings:[]}`. Default 8000ms. This is a spec "Must have" — `execFileSync` timeout only covers individual git calls, not the full check.
6. **Bug patterns:** Run all 7 BUILTIN_PATTERNS in `Promise.all` inside the check, scoped to changed files.
7. **File size contingency:** If `review-diff-tools.ts` exceeds 250 lines by Task 5, extract new check functions to `src/tools/review-diff-checks.ts`.

## Quality Strategy

- **Test framework:** Vitest with `vi.mock` pattern (like `secret-tools.test.ts`)
- **New mock pattern needed:** `vi.mock("node:child_process")` for coupling/breaking git calls
- **Critical CQ gates:** CQ3 (validate `since` ref), CQ6 (cap findings per check), CQ8 (handle sub-check failures gracefully), CQ14 (reuse existing tools, don't duplicate)
- **Branch coverage risk:** 55% threshold. ~30+ branches in new file. Tests must cover: check filtering, all verdict paths, score floor interactions, empty diff, invalid ref, timeout/error status.
- **Risk #1 (HIGH):** New git calls in coupling/breaking must use `validateGitRef` before any `execFileSync`
- **Risk #2 (MEDIUM):** `formatReviewDiff` must truncate at array level, never mid-JSON string

## Task Breakdown

### Task 1: Types, tier assignment, scoring, and verdict functions
**Files:** `src/tools/review-diff-tools.ts`, `tests/tools/review-diff-tools.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: Test `findingTier()` returns correct tiers: `secrets`→1, `breaking`→1, `coupling`→2, `complexity`→2, `dead-code`→2, `blast-radius`→2, `bug-patterns`→2, `test-gaps`→3, `hotspots`→3, unknown→3. Test `calculateScore()` with spec examples: 0 findings=100, 1 T1=80, 2 T1=60, 5 T2+0 T1=75, 1 T1+3 T2=65, 10 T3+0 T1/T2=90, 6 T1=0. Test `determineVerdict()`: any fail→"fail", only warn→"warn", only pass→"pass".
  - File: `tests/tools/review-diff-tools.test.ts`
  - Assertions: exact return values for each case, score floor interactions

- [ ] GREEN: Export interfaces `ReviewDiffOptions`, `ReviewDiffResult`, `CheckResult`, `ReviewFinding` from `src/tools/review-diff-tools.ts`. Implement `findingTier(check: string): 1|2|3`, `calculateScore(findings, checks): number`, `determineVerdict(checks): "pass"|"warn"|"fail"` as exported pure functions matching the spec's exact logic.
- [ ] Verify: `npx vitest run tests/tools/review-diff-tools.test.ts`
  Expected: All tests pass
- [ ] Acceptance: AC#3 (tier assignment), AC#4 (T1→fail verdict), AC#17 (score reflects severity)
- [ ] Commit: `feat(review-diff): add types, tier assignment, scoring, and verdict functions`

---

### Task 2: Orchestrator scaffold — pre-flight, diff parse, assembly
**Files:** `src/tools/review-diff-tools.ts`, `tests/tools/review-diff-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 1
**Execution routing:** deep

- [ ] RED: Test `reviewDiff()` orchestrator with all sub-checks mocked to return empty results:
  1. Happy path: `reviewDiff(repo, "HEAD~1")` → `{verdict:"pass", score:100, findings:[], checks:[9 items with status:"pass"]}`
  2. Empty diff: mock `changedSymbols` returning `{files:[]}` → `{verdict:"pass", score:100, diff_stats:{files_changed:0}}`
  3. Invalid ref: mock `validateGitRef` throwing → structured `{error:"invalid_ref:..."}` (not exception)
  4. Check filtering: `reviewDiff(repo, "HEAD~1", {checks:["secrets","breaking"]})` → only 2 checks in response
  5. Large diff: mock 51 changed files → T3 informational finding in response, `metadata.files_capped:true`
  6. Exclude patterns: pass `exclude_patterns:["*.lock"]`, include `package-lock.json` in mock diff → verify it is absent from all sub-check inputs (AC#14)
  7. Non-git repo: mock `getCodeIndex` returning repo with no git root, `validateGitRef` throws → structured `{error:"not_a_git_repo"}` (AC#19)
  8. Historical diff warning: `since:"abc123"` (not HEAD~1) → `metadata.index_warning` present (AC#21)
  9. WORKING sentinel: `until:"WORKING"` → mock `changedSymbols` called with correct args (AC#15)
  10. Check timeout: one check mock takes 100ms, `check_timeout_ms:50` → that check has `status:"timeout"` (AC#10, AC#20)
  - Mock: `vi.mock("../tools/diff-tools.js")`, `vi.mock("../tools/impact-tools.js")`, `vi.mock("../tools/secret-tools.js")`, `vi.mock("../tools/symbol-tools.js")`, `vi.mock("../tools/pattern-tools.js")`, `vi.mock("../tools/hotspot-tools.js")`, `vi.mock("../tools/complexity-tools.js")`, `vi.mock("../tools/index-tools.js")`, `vi.mock("../utils/git-validation.js")`

- [ ] GREEN: Implement `reviewDiff(index: CodeIndex, opts: ReviewDiffOptions): Promise<ReviewDiffResult>`:
  1. Pre-flight: `validateGitRef(since)`, `validateGitRef(until)`. Catch → return error result.
  2. Call `changedSymbols(index, {since, until})` → extract `changedFiles: string[]`
  3. If empty → return pass result immediately
  4. If >max_files → add T3 finding, set `metadata.files_capped`
  5. Filter `exclude_patterns` via picomatch (already in project)
  6. Build `checkEnabled(name)` filter from `opts.checks`
  7. Wrap each check in `Promise.race([check(), timeoutPromise(opts.check_timeout_ms)])` where timeout resolves to `{status:"timeout"}`
  8. `Promise.allSettled([...wrapped checks...])` — each check returns `CheckResult`
  9. Assembly: collect fulfilled results, mark rejected as `{status:"error"}`, run `findingTier`, `calculateScore`, `determineVerdict`
  10. Set `metadata.index_warning` when `since` is not a recent ref (e.g., not `HEAD~N` for small N)
  11. Handle WORKING/STAGED sentinels: translate to appropriate `changedSymbols` call (no second ref for WORKING, `--cached` for STAGED)
  12. Return `ReviewDiffResult`
  - Scaffold: sub-check functions as stubs returning `{name, status:"pass", tier, summary:"", findings:[], duration_ms:0}`
- [ ] Verify: `npx vitest run tests/tools/review-diff-tools.test.ts`
  Expected: All tests pass (5 new + Task 1 tests)
- [ ] Acceptance: AC#1 (valid JSON), AC#2 (parallel), AC#5 (empty diff), AC#6 (invalid ref), AC#8 (check filter), AC#10 (timeout), AC#14 (exclude), AC#15 (WORKING/STAGED), AC#18 (>50 files), AC#19 (non-git), AC#20 (timeout status), AC#21 (index warning)
- [ ] Commit: `feat(review-diff): add orchestrator with pre-flight, diff parse, and result assembly`

---

### Task 3: Compose existing checks — blast-radius, secrets, dead-code
**Files:** `src/tools/review-diff-tools.ts`, `tests/tools/review-diff-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 2
**Note:** Tasks 3-7 all modify `review-diff-tools.ts` — execute sequentially (3→4→5→6→7)
**Execution routing:** default

- [ ] RED: Test 3 check adapter functions:
  1. `checkBlastRadius`: mock `impactAnalysis` returning 2 affected symbols → CheckResult with 2 T2 findings, status "warn"
  2. `checkSecrets`: mock `scanSecrets` returning 1 finding → CheckResult with 1 T1 finding, status "fail". Verify `file_pattern` passed = changed files pattern.
  3. `checkDeadCode`: mock `findDeadCode` returning 3 candidates → CheckResult with 3 T2 findings
  - Also test: each adapter handles its composed tool throwing → `{status:"error", findings:[]}`

- [ ] GREEN: Implement 3 adapter functions in `review-diff-tools.ts`:
  - `checkBlastRadius(index, since, until)`: call `impactAnalysis(index, since, {until, depth:2})`, map `affected_symbols` to findings with `check:"blast-radius"`, `tier:2`
  - `checkSecrets(index, changedFiles)`: call `scanSecrets(index, {file_pattern: changedFilesPattern})`, map `findings` to ReviewFinding with `check:"secrets"`, `tier:1`
  - `checkDeadCode(index, changedFiles)`: call `findDeadCode(index, {file_pattern: changedFilesPattern})`, map `candidates` to findings with `check:"dead-code"`, `tier:2`
  - Each wrapped in try/catch → error status on failure
- [ ] Verify: `npx vitest run tests/tools/review-diff-tools.test.ts`
  Expected: All tests pass
- [ ] Acceptance: AC#7 (secrets scoped to changed files)
- [ ] Commit: `feat(review-diff): compose blast-radius, secrets, and dead-code checks`

---

### Task 4: Compose existing checks — bug-patterns, hotspots, complexity
**Files:** `src/tools/review-diff-tools.ts`, `tests/tools/review-diff-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 3 (sequential file modification)
**Execution routing:** default

- [ ] RED: Test 3 more adapters:
  1. `checkBugPatterns`: mock `searchPatterns` returning matches for 2 of 7 patterns → merged findings, deduplicated by (file, line, rule_id)
  2. `checkHotspots`: mock `analyzeHotspots` returning 3 hotspots that overlap changed files → 3 T3 findings
  3. `checkComplexityDelta`: mock `analyzeComplexity` returning functions, 2 in changed files with complexity>10 → 2 T2 findings
  - Also test: bug-patterns runs all BUILTIN_PATTERNS (verify searchPatterns called 7 times)
  - Also test: each adapter handles its composed tool throwing → `{status:"error", findings:[]}`

- [ ] GREEN: Implement:
  - `checkBugPatterns(index, changedFiles)`: `Promise.all(BUILTIN_PATTERNS.map(p => searchPatterns(index, p, {file_pattern})))`, merge results, dedup by `(file, line, rule_id)`, map to findings with `check:"bug-patterns"`, `tier:2`
  - `checkHotspots(index, changedFiles)`: call `analyzeHotspots(index, {file_pattern})`, filter to changed files, map to findings with `check:"hotspots"`, `tier:3`
  - `checkComplexityDelta(index, changedFiles)`: call `analyzeComplexity(index, {top_n:50})`, filter to functions in changed files, flag cyclomatic>10, map to findings with `check:"complexity"`, `tier:2`
- [ ] Verify: `npx vitest run tests/tools/review-diff-tools.test.ts`
  Expected: All tests pass
- [ ] Acceptance: AC#2 (parallel)
- [ ] Commit: `feat(review-diff): compose bug-patterns, hotspots, and complexity checks`

---

### Task 5: New check — checkCouplingGaps (Jaccard from git log)
**Files:** `src/tools/review-diff-tools.ts`, `tests/tools/review-diff-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 4 (sequential file modification)
**Execution routing:** deep

- [ ] RED: Test `checkCouplingGaps(repoRoot, changedFiles)`:
  1. Git log shows files A and B changed together 5 times, A alone 6 times, B alone 4 times → Jaccard = 5/(6+4-5) = 1.0. A is in diff but B is not → T2 finding: "B usually changes with A (Jaccard=1.00, 5 co-commits) but is not in this diff"
  2. Pair with Jaccard 0.3 (below 0.5 threshold) → no finding
  3. Pair with only 2 co-commits (below minSupport=3) → no finding
  4. Commit with >50 files → skipped (bulk operation filter)
  5. Empty git log → no findings, status "pass"
  6. `since` ref passed through `validateGitRef` before git call
  - Mock: `vi.mock("node:child_process")` — mock `execFileSync` returning structured git log output

- [ ] GREEN: Implement `checkCouplingGaps(repoRoot: string, changedFiles: string[]): CheckResult`:
  1. `validateGitRef` on any ref used in git commands (defense-in-depth per QA Risk #1)
  2. `execFileSync("git", ["log", "--name-only", "--no-merges", "--diff-filter=AMRC", "--since=180 days ago", "--pretty=format:%H"], {cwd: repoRoot, encoding:"utf-8", timeout:10000})`
  3. Parse commits: split by empty line, extract SHA + file list per commit
  4. Skip commits with >50 files
  5. Build pair matrix: canonical key `min(a,b)\0max(a,b)`, count co-occurrences
  6. Compute Jaccard: `count / (countA + countB - count)`
  7. For each changed file: find partners with Jaccard >= 0.5 and support >= 3 that are NOT in changedFiles → T2 finding
  - Algorithm matches codegraph/optave (verified from source)
- [ ] Verify: `npx vitest run tests/tools/review-diff-tools.test.ts`
  Expected: All tests pass
- [ ] Acceptance: AC#11 (coupling detects missing co-changed files)
- [ ] Commit: `feat(review-diff): add co-change coupling check with Jaccard algorithm`

---

### Task 6: New check — checkBreakingChanges (export diff between refs)
**Files:** `src/tools/review-diff-tools.ts`, `tests/tools/review-diff-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 5 (sequential file modification)
**Execution routing:** deep

- [ ] RED: Test `checkBreakingChanges(index, repoRoot, changedFiles, since, until)`:
  1. File has 3 exports at `since`, 2 at `until` → 1 T1 finding for removed export
  2. File has export renamed (same arity, different name) → T1 finding
  3. New export added → no finding
  4. Non-TS/JS file in diff → skipped
  5. `git show` fails for a file (e.g., file is new) → that file skipped gracefully
  6. Rename detected via `--find-renames` flag → finding suppressed
  - Mock: `vi.mock("node:child_process")` for `git show` and `git diff --find-renames`

- [ ] GREEN: Implement `checkBreakingChanges(index, repoRoot, changedFiles, since, until)`:
  1. `validateGitRef(since)` (defense-in-depth)
  2. Get rename pairs: `execFileSync("git", ["diff", "--find-renames", "--name-status", since + ".." + until], ...)`
  3. For each changed .ts/.js file (skip renames, skip new files):
     a. `execFileSync("git", ["show", since + ":" + file], ...)` → old source
     b. Parse old source for exported symbol names (regex: `export\s+(function|class|const|let|var|type|interface|enum)\s+(\w+)` + `export\s+default`)
     c. Parse current source for exported symbol names (from index: `index.symbols.filter(s => s.file === file && s.exported)`)
     d. Diff: symbols in old but not in current → T1 findings
  4. Wrap each file in try/catch — skip on error
- [ ] Verify: `npx vitest run tests/tools/review-diff-tools.test.ts`
  Expected: All tests pass
- [ ] Acceptance: AC#12 (breaking detects removed exports), AC#16 (rename suppression)
- [ ] Commit: `feat(review-diff): add breaking change detection via export diff between refs`

---

### Task 7: New check — checkTestGaps (naming + import graph)
**Files:** `src/tools/review-diff-tools.ts`, `tests/tools/review-diff-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 6 (sequential file modification)
**Execution routing:** default

- [ ] RED: Test `checkTestGaps(index, changedFiles)`:
  1. `auth.ts` changed, no `auth.test.ts`/`auth.spec.ts`/`__tests__/auth.ts` exists, no test imports `auth.ts` → T3 finding
  2. `auth.ts` changed, `auth.test.ts` exists → no finding
  3. `auth.ts` changed, no naming match but `integration.test.ts` imports `auth.ts` → no finding
  4. Test file itself changed (`auth.test.ts`) → skipped (not a gap)
  5. File in `node_modules` or excluded → skipped
  - Mock: `getCodeIndex` returning symbol data with import edges

- [ ] GREEN: Implement `checkTestGaps(index: CodeIndex, changedFiles: string[])`:
  1. Filter changedFiles to non-test source files via `isTestFile()` from `src/utils/test-file.ts`
  2. For each source file:
     a. Naming check: derive test file candidates (`foo.ts` → `foo.test.ts`, `foo.spec.ts`, `__tests__/foo.ts`) — check if any exist in index
     b. Import check: search index symbols for test files that have an import edge to this source file
     c. If both pathways → 0 matches → T3 finding
  3. Return CheckResult
- [ ] Verify: `npx vitest run tests/tools/review-diff-tools.test.ts`
  Expected: All tests pass
- [ ] Acceptance: AC#13 (test-gaps identifies changed files without tests)
- [ ] Commit: `feat(review-diff): add test gap detection via naming convention and import graph`

---

### Task 8: Formatter and tool registration
**Files:** `src/formatters.ts`, `src/register-tools.ts`, `tests/tools/review-diff-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 1 (types)
**Execution routing:** default

- [ ] RED: Test `formatReviewDiff(result)`:
  1. Full result with findings → compact multi-line text with verdict, score, check summary table, findings grouped by tier
  2. Empty findings → short "PASS (100)" line
  3. `JSON.parse(JSON.stringify(result))` round-trip on all test cases → valid (AC#9)
  4. Token budget truncation: result with 50 T3 findings and `token_budget:500` → T3 truncated, T1 intact, output is valid JSON-parseable
  5. Handler param parsing: `checks:"secrets,breaking"` → internal `opts.checks === ["secrets","breaking"]`; `exclude_patterns:"*.lock, dist/**"` → trimmed array
  - File: add tests to `tests/tools/review-diff-tools.test.ts`

- [ ] GREEN:
  1. In `src/formatters.ts`: add `formatReviewDiff(data: ReviewDiffResult): string` — compact text format:
     ```
     review_diff: VERDICT (score) | N files | Xms
     checks: [name:status ...]
     T1 findings: [...]
     T2 findings: [...]
     T3 findings: [...] (truncated N)
     ```
  2. In `src/register-tools.ts`: add import and one entry to `TOOL_DEFINITIONS` array with schema matching spec. Handler: parse comma-separated `checks`/`exclude_patterns`, call `reviewDiff(index, opts)`, return `formatReviewDiff(result)`.
- [ ] Verify: `npx vitest run tests/tools/review-diff-tools.test.ts`
  Expected: All tests pass
- [ ] Acceptance: AC#9 (valid JSON at all sizes)
- [ ] Commit: `feat(review-diff): add formatter and register MCP tool`

---

### Task 9: Integration smoke test
**Files:** `tests/tools/review-diff-tools.test.ts`
**Complexity:** complex
**Dependencies:** Tasks 1-8
**Execution routing:** deep

- [ ] RED: Integration test using real tmpdir git repo:
  1. Create tmpdir, `git init`, create `src/example.ts` with an exported function, commit
  2. Modify `src/example.ts` (add a `console.log` — triggers bug-pattern), commit
  3. Index the tmpdir repo
  4. Call `reviewDiff(index, {repo, since:"HEAD~1"})` with no mocks
  5. Assert: `verdict` is defined, `diff_stats.files_changed === 1`, `checks.length >= 1`, response is valid JSON
  6. Assert: `bug-patterns` check found the `console-log` pattern finding

- [ ] GREEN: All implementation from Tasks 1-8 should make this pass. If any integration issues surface, fix them.
- [ ] Verify: `npx vitest run tests/tools/review-diff-tools.test.ts`
  Expected: All tests pass including integration
- [ ] Acceptance: AC#1 (valid ReviewDiffResult for any valid ref range), AC#2 (parallel execution verified end-to-end)
- [ ] Commit: `test(review-diff): add integration smoke test with real git repo`
