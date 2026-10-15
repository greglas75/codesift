<!-- zuvo-review -->
range: 8f7d0bd..94a3ae3
adversarial: zuvo/proofs/46f6f07-reuse-budget.txt
files: src/tools/index-tools/parse.ts,tests/tools/embed-symbols-reuse-budget.test.ts

```
CODE REVIEW | an embedding run reuses stored vectors whatever their size
SCOPE:  46f6f074, 94a3ae3a (comment per review)
AUDIT:  agy + codex-5.3 (proof above)
VERIFY: rt --light npm test at 46f6f074 — 6805 passed, 11 skipped, 0 failed; the regression test
        failed on the pre-fix code first (each pass in fresh modules, shared cache off)
EVIDENCE: tgm-wt-ship-report-delivery: "embeddings skipped (above the 2147 MB budget)", then
        365,488 vectors re-embedded in its checkpoint, ~$1 before it was stopped
```

## Rejected (checked against the code)

- "Infinity removes the memory bound and OOMs the process" (agy CRITICAL, codex WARNING): the
  budget never bounded the run. batchEmbed returns a vector for every symbol in the index, loaded
  or freshly embedded, so with the file refused the result reaches the same size, after paying the
  provider for it. Peak memory is unchanged; only the bill changes.

## Fixed in review

- The comment claimed the run is always in a child process; stdio and CLI run it in-process.
  Rewritten to give the real reason.
