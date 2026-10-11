<!-- zuvo-review -->
range: d7eab1a..3c40060
files: CLAUDE.md, src/tools/index-tools.ts, src/tools/index-tools/folder-indexer.ts, src/tools/index-tools/watcher.ts, tests/tools/explore-tools.test.ts, tests/tools/symbol-source-dedup.test.ts, tests/tools/watcher-token.test.ts
adversarial: zuvo/proofs/watcher-token-adversarial.txt
tier: 3
verdict: APPROVE

# A watcher acts only while it serves its repo name (cause of the explore / shown-source flake)

`--multi` pass over 6cdd08e4..b0f5c105, 5 REVIEW BY lines. Fixed in 3c40060c: retiring stops the other root's
watcher, tokens cleared on eviction and stopAll and rolled back when startWatcher throws, handlers re-check after
their awaits before touching name-keyed caches. Rejected: the fixed 2 s wait as vacuous (the test failed on the
previous code within that window; after the fix the old watcher is stopped, so nothing is delivered), concurrent
indexFolder calls for one name racing tokens (the daemon coalesces same-root calls and queues different ones).
