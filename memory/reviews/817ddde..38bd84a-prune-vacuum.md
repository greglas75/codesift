<!-- zuvo-review -->
range: 817ddde..38bd84a
files: src/cli/commands-maintenance.ts, tests/cli/prune.test.ts
adversarial: zuvo/proofs/rust-core-prune-vacuum-adversarial.txt
tier: 3
verdict: APPROVE

# prune VACUUMs index databases a reindex left mostly empty

`--multi` pass over d950f126, 5 REVIEW BY lines. Follow-up commit: VACUUM outside the registry lock, counted even
when the checkpoint after it is refused, reclaimed size includes the WAL, non-busy errors reported, empty env
value means the default. Rejected: "VACUUM under an open reader" as a bug (it is the tested guarantee — WAL
leaves an open snapshot's view unchanged, which is what paged readers rely on), Infinity/huge threshold (an
explicit override that disables vacuuming is the operator's choice).
