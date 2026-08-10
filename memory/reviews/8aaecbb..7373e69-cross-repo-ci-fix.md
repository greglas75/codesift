<!-- zuvo-review -->
range: 8aaecbb91a5a89e13c5d0e141703a5ace4d1a003..7373e6929a42ecaca92ae73d0a99a0d3543c8fa0
files: *
adversarial: zuvo/proofs/cross-repo-ci-fix-adversarial.txt
verdict: APPROVE
-->

# Cross-repo contract CI repair review

## Outcome

APPROVE. The PR's Node 20 and Node 22 failures were environment-dependent test
infrastructure defects, not regressions in the contract-tools refactor. The fixes
retain meaningful JSON-backend coverage on Node 20 and full native-SQLite coverage
on supported Node 22 runtimes.

## Findings resolved

- The large shared-cache regression test now pins a 256 MB cache-read budget, so
  its approximately 110 MB fixture is independent of runner RAM. Production reads
  this environment value inside `loadSharedCache`, after the test sets it.
- Node runtimes without unflagged `node:sqlite` exclude only the current
  native-SQLite suites. Node 22.5-22.12 is also recognized when launched with
  `--experimental-sqlite`.
- Compatibility-lane exclusions extend `configDefaults.exclude`; they do not
  expose `node_modules`, `dist`, or other default-excluded trees to test discovery.
- The source-invariant test uses a Node 20-compatible directory walk and visits
  files only. The current `src` tree contains no symlinks.

The remaining review suggestions concern future maintenance: a newly added
SQLite-only test must follow the existing `sqlite-*` convention or be added to
the explicit list, and a future symlinked source tree would need a declared scan
policy. Neither condition exists in the reviewed tree and neither is a ship blocker.

## Verification evidence

- Node 20 full suite (`--maxWorkers=2`): 387 files passed, 1 skipped; 5,383 tests
  passed, 8 skipped.
- Node 22 full suite (`--maxWorkers=2`): 396 files passed, 1 skipped; 5,499 tests
  passed, 8 skipped.
- Targeted CI regression tests: 2 files, 15 tests passed.
- Lint and TypeScript type-check: passed; Biome emitted one existing deprecation
  information message.
- Cross-provider review: two independent provider records are preserved in the
  cited proof artifact; availability varied during the final pass.

## Review-light report

No ship-blocking defect remains. The compatibility gate preserves Vitest defaults,
the cache budget is restored after every test, and runtime-specific exclusions are
limited to suites that require native SQLite.

## Coverage-check report

The change is test infrastructure only. Both supported runtime lanes were executed
in full, and the two tests that originally failed on GitHub-hosted runners pass in
their targeted run.
