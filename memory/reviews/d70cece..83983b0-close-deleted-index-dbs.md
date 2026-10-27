<!-- zuvo-review -->
range: d70cece..83983b0
files: src/storage/sqlite/connection.ts,tests/storage/sqlite-deleted-index-handles.test.ts
adversarial: zuvo/proofs/close-deleted-index-dbs.txt
verdict: PASS after fixes

Fixed: missing file counts as stale (never-recorded identity / open-stat TOCTOU); no close while db.isTransaction (saveIndexSqlite awaits inside BEGIN) — new test, red on the prior commit.
Rejected: sweep never re-fires (lastSweep only moves when a sweep runs); inode reuse (a held deleted inode stays allocated, its number cannot be reused); refcounts for handles held across awaits (only await under a handle is writeIndexRows inside BEGIN, now covered; other readers are synchronous).
Tests: tsc, biome, vitest tests/storage 71 files / 727 green via rt; the 3 new tests red on origin/main.
