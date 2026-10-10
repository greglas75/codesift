<!-- zuvo-review -->
range: 384dfce..7bcc67a
adversarial: zuvo/proofs/lock-age-skew-adversarial.txt
files: src/storage/embedding-checkpoint.ts,tests/storage/embedding-checkpoint.test.ts

```
CODE REVIEW | embedding checkpoint lock — follow-ups to 3fdc718..18539a8
SCOPE:  1 production file, 1 test file — commits ba705c1d, 7bcc67ac
        (7ed38d24, f3bae279 in this range belong to the native-store work, reviewed under their own artifact)
AUDIT:  cross-provider adversarial on ba705c1d, author (Claude) excluded
SELF-REVIEW: yes for triage — each finding checked against the code
VERIFY: rt --light npm test at 7bcc67ac — 526 files, 6651 passed, 10 skipped
        rt --repeat 20 on embedding-checkpoint + embedding-resume tests — 20/20
```

## Fixed

| Source | Finding | Commit |
|---|---|---|
| farm full suite (rt --log 1791650331-24160-4426) | a lock read a fraction of a ms "ahead" (sub-ms mtimeMs vs integer Date.now) counted as a far-future mtime → stale → a lock being created was taken over | ba705c1d |
| adversarial on ba705c1d | two concurrent opens in ONE process both passed the in-process check before either linked; the second took over a lock naming its own pid → two owners | 7bcc67ac |

## Rejected (checked against the code)

- "release() drops the lock before discard()": parse.ts calls discard() in the try and release() in the finally.
- Cross-process double takeover: a mover that finds a live foreign pid in the lock it moved hands it back (holdsLock), so only the same-process case was real — fixed above.
- Same pid on another host / network filesystems / O_NOFOLLOW: the checkpoint lives in the local data dir.
- The remaining findings re-read the whole module (header length, batch string size, prepareForAppend ordering) and were triaged under 3fdc718..18539a8.
