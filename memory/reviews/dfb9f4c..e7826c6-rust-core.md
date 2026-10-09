<!-- zuvo-review -->
range: dfb9f4c..e7826c6
files: src/tools/review-diff/checks/breaking.ts
adversarial: zuvo/proofs/rust-core-breaking-catch-adversarial.txt
tier: 3
verdict: APPROVE

# breaking check: only git show inside the catch

`--multi` pass (5 REVIEW BY lines). The remaining points concern the existing git-show catch, which treats every failure as a new file, and are not changed here. A real limit worth a separate change: no `maxBuffer` on `git show`, so an old revision over 1 MiB throws ENOBUFS and is skipped as if it were new. A store fault now aborts the check, which the outer try reports as status "error"; that is the intended behaviour.
