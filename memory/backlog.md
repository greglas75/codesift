# Review backlog (zuvo:review)

<!-- fingerprint: file|rule|signature -->

<!-- session 2026-09-23..25 — read this install's usage.jsonl (12,763 calls / 14 d) + daemon.err.log.
     Everything here was OBSERVED and MEASURED in that session and deliberately left unfixed; the
     four defects that were fixed shipped in v0.18.1. Numbers are from that window, not estimates. -->
- [ ] [HIGH] `src/cli/commands-daemon.ts|memory|daemon-oom-root-cause-unknown` — **12 `FatalProcessOutOfMemory` crash reports between 09-23 18:33 and 09-25**, against a 16 GB `--max-old-space-size`; one cycle crashed three times in 20 minutes. What is NOT the cause (each measured, do not re-litigate): host RAM alone (41 GB free during one failure), the tailnet ollama (HTTP 200 in 0.78 s), and v0.18.0's `shown-source` ledger (capped at 5,000 entries and disabled in the daemon). A 91-process / 34.6 GB `sentry-mcp` swarm starved the box during part of the window and is NOT this repo's bug, but it also does not explain the crashes that predate it. Recipe: capture a heap snapshot at high RSS (needs `--heapsnapshot-signal=SIGUSR2` on the LaunchAgent, or an in-process trigger) and name the retainer before changing anything — this is the ADR-004 stage-2 question, not another heap bump. Defer reason: needs the loop reproduced while the host is otherwise idle.
- [ ] [MED] `src/cli/commands-daemon.ts|startup|server-import-dominates-boot` — the new boot trace shows `server module imported` is 3.9-4.3 s of a 4.4-5.4 s start on an idle box, and the same stage took **9+ minutes at load 155** (no listening socket the whole time; located only with `sample <pid>`, which is why the trace exists). The trace names the stage but nothing reduces it. Recipe: measure what that import pulls (150 tool modules, every parser, the storage layer) and defer what the first request does not need; `CODESIFT_TOOL_SURFACE=single` already proves most of it is optional for some sessions. Defer reason: needs a measurement pass, not a guess.
- [ ] [MED] `src/cli/service.ts|verification|process-type-standard-unbooted` — `bba4172` switched the macOS LaunchAgent from `ProcessType: Background` to `Standard` on the hypothesis that priority throttling caused the 9-minute boot. The plist on disk carries it, but **no boot under load has gone through it**: at the time of writing the box was at load ~250 and the daemon had not restarted since. A drop-in no boot has passed is a hypothesis (see rules/service-liveness-and-boot-order). Recipe: restart the daemon while load is high and read the `boot +…` trace; if the stages are still minutes long, priority was not the cause.
- [ ] [MED] `src/cli/service.ts|ops|daemon-log-never-rotates` — `~/.codesift/logs/daemon.err.log` is **141 MB** and nothing in the repo rotates or truncates it; the LaunchAgent only names the path. It grows fastest exactly when things are wrong (12,992 `embed batch … stalled` lines in the current file), so the log is least usable in the incident it was kept for — `tail -c` plus `tr -d '\000'` was needed to read it at all. Recipe: size-capped rotation at write time, or a `StandardErrorPath` that points at a rotated file, plus a truncate in `codesift prune`.
- [ ] [MED] `src/search/*|efficiency|embed-stall-storm` — **12,992 `embed batch of N stalled (aborted due to timeout) — retrying as N/2+N/2`** lines in one daemon log, ending in per-repo `Embedding failed for local/tgm-panel@…`. The split-retry is bounded and works as designed, so this is not a retry loop — but a repo whose batches all end in `Embedding failed` keeps NO vectors for those chunks, and nothing reports which repos are left unembedded. Recipe: count stalls per repo and surface them in `index_status` (an install with silent embedding failure currently looks identical to one with semantic search working).
- [ ] [MED] `src/parser/*|correctness|parser-pool-60s-on-tiny-php` — **25 × `parser-pool terminating worker due to timeout … 60000ms`**, all on small Yii2 validator files (`AsciiValidator.php`, `EmailValidator.php`, …), each followed by `worker exited with code 1 — respawning`. A 60-second parse of a file of that size is not a slow parse, it is a hang; the surrounding failures are attributed to the file rather than to the pool. Recipe: reproduce on one of those files in isolation (`index_file` on a copy) and check for a pathological tree-sitter pattern vs a pool-level deadlock under contention.
- [ ] [MED] `src/storage/usage-tracker.ts|telemetry|error-class-other-35pct` — `classifyError` resolves **89 of 251 errors (35%) to `other`**, concentrated in the tools with the most errors: `index_folder` 14, `index_file` 14, `search_patterns` 12, `get_file_outline` 12. Since `error: true` discards the message by design, an `other` row is unrecoverable — the class exists precisely so a past error can be diagnosed without it. Recipe: reproduce one failure per tool, then add the missing classes; the taxonomy is a closed set on purpose, so this is an additive change plus the sanitizer allowlist.
- [ ] [MED] `src/tools/plan-turn-tools.ts|adoption|recommendation-follow-through` — over 14 days `plan_turn` ran **40 times, every call carrying recommendations, and a recommended tool appeared in the next three calls only 5 times (12.5%)**. n is too small to call it a defect and the funnel field was added for exactly this question, so the task is measurement: does the agent ignore the recommendations, or does the surface it names not match what the task needs? Recipe: slice by the recommended tool and by whether the tool was reachable in that session (`isToolHiddenForHost`) before concluding anything.
- [ ] [MED] `release|process|tag-without-publish` — **v0.18.0 was tagged and pushed but never published to npm**; `npm view codesift-mcp version` still answered `0.17.0` two days later, so every `npm install -g codesift-mcp` kept getting 0.17.0 while the repo, the changelog and the tag all said otherwise. Publishing is a manual OTP step at the end of a checklist and nothing checks it happened. Recipe: a release step (or CI job on a `v*` tag) that compares `npm view <pkg> version` with `package.json` and fails loudly; note that `postinstall` runs `setup all`, so the publish itself must stay `--ignore-scripts`.
- [ ] [LOW] `src/server-helpers/response-hints.ts|design|h19-memory-cap-repeats` — the once-per-session H19 mute is bounded at 200 repo names (`H19_REPO_MEMORY_CAP`) because the daemon outlives every session; past the cap the hint starts repeating again. Deliberate — repeating is the safe direction versus an unbounded Set keyed by caller-supplied strings — but a session touching more than 200 repos gets the old behaviour back. Recipe: if that turns out to happen, key the mute by session id with an LRU rather than raising the number.
- [ ] [LOW] `release|friction|npm-version-needs-clean-tree` — `npm version patch` refuses on a shared checkout whenever another agent session has uncommitted files (`memory/backlog.md`, `memory/last-ship.json` at the time), which is the normal state of this tree. The release then has to go through `--no-git-tag-version` plus a hand-made commit and tag, which is easy to get subtly wrong (it also must not sweep the other session's files into the release commit). Recipe: make the release path use `--no-git-tag-version` + explicit path staging by default, and document it in the Release section of CLAUDE.md.

<!-- zuvo:ship 2026-09-23 3608aba..HEAD (v0.18.0) — release review deferrals -->
- [ ] [MED] `src/server.ts|test-coverage|stdio-dual-era-integration` — createStdioClientHooks/startStdioTransport (serveStdio factory, envelope identification, front-load on a 2026-07-28 opening, usedModuleServer fallback) have no automated test; verified only by a hand-rolled protocol probe (60→181 tools for a modern Codex opening). Recipe: an integration test that spawns the built server and speaks both eras (the probe script is in the release session). Defer reason: [structural-refactor (multi-file)] — needs a built-dist test harness.
- [ ] [LOW] `src/cli/hooks/{pre-compact,session}.ts|test-coverage|marker-touch-call-sites` — touchCompactionMarker is unit-tested, its two hook call sites are not (both handlers read stdin and exit the process). Defer reason: [NIT].
- [ ] [MED] `src/tools/symbol-lookup-tools.ts|consistency|export-keyword-in-source` — get_symbol/find_and_show render a declaration WITHOUT its `export` keyword, get_symbols/explore WITH it, for the same symbol. Pre-existing; surfaced by the shown-source ledger, which (correctly) treats the two bodies as different and resends. Recipe: pick one source slice in both lookup paths. Defer reason: [structural-refactor (multi-file)].
- [ ] [LOW] `src/tools/symbol-context-tools.ts|dead-code|formatSymbolsCompact-chain` — no tool handler calls formatSymbolsCompact any more (get_symbols renders per symbol for the ledger); only benchmarks/ import it, yet it is still re-exported through register-tool-loaders.ts and deps.ts. Defer reason: [NIT].
- [ ] [LOW] `src/server-helpers.ts|efficiency|cache-bypasses-dedup` — an exact repeat served from the response cache returns the full body again instead of a pointer (lost saving, not a correctness issue). Defer reason: [NIT].

<!-- zuvo:review 2026-08-03 v0.12.0..HEAD — release review deferrals -->
- [ ] [MED] `src/storage/index-store.ts|CQ11|god-module-split` — 731L / 21 exports carrying six concerns (backend selection, JSON→SQLite migration, materialised-index LRU, stale/extractor-version detection, legacy JSON path + mutation batching, path helpers); the largest file in src/storage/ and the only multi-concern one (siblings own one job each). Recipe: (1) extract the LRU + data_version cache into `src/storage/index-cache.ts` — it only needs a dbPath key, so it lifts cleanly; (2) extract `sqlitePathFor` + `ensureSqliteMigrated` + the migration guard map into `src/storage/index-migration.ts`, re-exporting `sqlitePathFor` so register-tools/runtime.ts keeps its import path; (3) leave index-store.ts as the JSON backend + dispatcher, mirroring sqlite-index-store.ts so the two are symmetric. Defer reason: [structural-refactor (multi-file)].
- [ ] [MED] `src/storage/*|convention|two-forTesting-styles` — src/storage/ now has both `resetXForTesting` (index-store.ts, sqlite-index-store.ts) and `_resetXForTests` (shared-embedding-cache.ts, telemetry/anon-id.ts) live at once with no rule distinguishing them. Pick one for the directory and align. Defer reason: [structural-refactor (multi-file)].
- [ ] [LOW] `src/tools/workspace-scope-helper.ts|duplication|storage-fault-guard` — the `catch (err) { if (isIndexStorageError(err)) throw err; return null; }` idiom is implemented twice (also workspace-tools.ts getIndexOrEmpty); the comments already cross-reference each other. Promote getIndexOrEmpty to a shared location and have resolveWorkspaceScope call it. Defer reason: [structural-refactor (multi-file)].
- [ ] [LOW] `src/storage/embedding-store.ts|duplication|index-path-derivation` — two copies of `indexPath.replace(/\.index\.json$/, ...)`, the same shape `sqlitePathFor` was created to remove for the .db case. Pre-existing (predates v0.12.0). Recipe: `embeddingPathsFor(indexPath)` returning both. Defer reason: [structural-refactor (multi-file)].
- [ ] [MED] `src/storage/embedding-store.ts|correctness|hash-before-vector` — content hashes are committed for every symbol BEFORE embedFn returns, so a provider returning a short array leaves the OLD vector persisted under the NEW content hash; needsEmbed then sees a match and the symbol is permanently skipped from re-embedding. Confirmed by the behaviour audit; introduced by 748fdf4 which is an ANCESTOR of v0.12.0, so out of this range. Recipe: require vectors.length === batch.length before committing hashes, or commit each hash only after its vector is stored; also assert data.length === texts.length in isEmbeddingResponse. Defer reason: [structural-refactor (multi-file)] + out-of-range.
- [ ] [LOW] `src/storage/shared-embedding-cache.ts|concurrency|append-interleave` — appendFileSync of a multi-KB batch is not atomic beyond the OS write size, so concurrent codesift processes can interleave into a malformed line. Mitigated: the reader drops malformed lines, so the effect is a lost cache entry, not corruption. Defer reason: [NIT].
- [ ] [MED] `src/tools/index-tools/parse.ts|efficiency|embedChunks-always-rechunks` — `embedChunks` always calls `readAndChunkFiles`, re-reading and re-chunking the whole tree even when `<hash>.chunks.ndjson` already holds the finished chunks (197,913 of them / 154 MB for designer). Measured on a loaded Mac that pre-pass ran 20+ minutes without issuing a single embed request — and it is also what pushes the wall-clock abort deadline over. The `embed-child` docstring already claims "Everything it needs is read back from the on-disk index, so no parsing is repeated", which is true for symbols and false for chunks. Recipe: reuse the existing chunk file when the index's file SHAs are unchanged, fall back to re-chunking otherwise. Needs a staleness rule, hence not done inline.
- [ ] [MED] `farm|rt-watchdog|silence-timeout-never-fires` — a job wedged in a 100%-CPU loop held a farm core for **54 minutes**; `tf-watchdog.sh` was invoked with a 600 s silence threshold and never fired against 3211 s of silence. Only the 14400 s absolute ceiling works. `rt --cancel <runid>` is the manual remedy. Farm-side (`~/DEV/i9-farma`), tracked here because this repo is where it was measured.
- [ ] [MED] `farm|mirror|no-git-dir` — the farm mirrors the working tree without `.git`, so any test shelling out to git fails on an environment gap. Worked around in this repo by skipping (see `docs/runbook/farm-and-ci.md` 2.4); the real fix is mirroring `.git`, which also restores coverage instead of dropping it.

<!-- zuvo:ship 2026-08-03 v0.13.0 — carried pre-existing flake -->

<!-- zuvo:ship 2026-08-03 v0.13.0 — daemon adversarial residuals -->

<!-- zuvo:review 2026-08-02 27fffbc..HEAD — SQLite index migration -->

<!-- zuvo:review 2026-07-11 — 25 commits across 11 refactor branches -->
- [ ] [MED] `src/parser/extractors/sql-symbols.ts|integration|symbol-utils-dependency` — when integrating SQL extractor + cycle branches, import shared helpers from `../symbol-utils.js` in both SQL leaf modules and run SQL/cycle tests. Defer reason: [structural-refactor (multi-file/cross-branch)].
- [ ] [MED] `src/tools/pg-introspection.ts|CQ11|driver-lifecycle-split` — extract driver discovery/loading from connection and catalog-query lifecycle; characterize loader failure and cleanup. Defer reason: [structural-refactor (multi-file)].
- [ ] [MED] `src/tools/conversation-search-tools.ts|CQ11|search-fusion-symbol-split` — extract result fusion/loading and symbol lookup behind the existing facade while preserving cache identity. Defer reason: [structural-refactor (multi-file)].
- [ ] [MED] `src/server-helpers/response-hints.ts|CQ11|hint-rule-table` — split `buildResponseHint` into ordered per-hint detectors plus a rule table with first-match tests. Defer reason: [structural-refactor (multi-file)].
- [ ] [MED] `src/parser/extractors/kotlin-test-symbols.ts|CQ11|kotlin-helper-split` — split annotation/type-name helpers and Kotest suite/test traversal into bounded modules with facade compatibility. Defer reason: [structural-refactor (multi-file)].

<!-- zuvo:review 2026-07-10 d453ab3..209c975 — all assistant commits -->
- [ ] [MED] `src/tools/search-tools/text-search.ts|CQ3|sync-regex-fallback-redos` — isolate Node regex fallback in a worker/child with a hard kill deadline; the current denylist plus synchronous `RegExp.test()` cannot enforce the wall-clock contract. Defer reason: [structural-refactor (multi-file)].
- [ ] [MED] `src/tools/kotlin-tools.ts|CQ6|unbounded-result-arrays` — add shared `max_results`/`truncated` handling across extension, KMP, and sealed-hierarchy capabilities plus registration schemas and large-index tests. Defer reason: [structural-refactor (multi-file)].
- [ ] **B-review-incomplete-2026-07-10** — rerun `zuvo:review d453ab3..209c975` after external providers are authenticated/reachable; three `--multi` attempts returned zero valid adversarial reviews, so no content-keyed artifact or `reviewed/*` tags were created.

<!-- zuvo:review 2026-05-05 ae96065^..ae96065 — consolidated fixes (Hono mounts, extractors, tools, CLI) -->
- [ ] **R-2** `heritage-edges.ts|telemetry|ambiguous-skip-counter` — persist counter for resolution misses (silently drops edges when 2+ files declare same name)
- [ ] **R-5** `pattern-tools.ts|test|postFilter-fail-open-untested` — add unit test asserting throwing postFilter keeps match + emits warning; document in CHANGELOG
- [ ] **R-7** `constant-file-pattern.ts|precision|4char-substring-fp` — raise threshold or word-boundary substring fallback [nit]
- [ ] **R-8** `symbol-tools.ts|coverage|reexport-regex-anchored-misses` — drop `^` anchor or use tree-sitter walk over export_statement [nit]
- [ ] **R-9** `commands.ts|UX|git-hooks-flag-precedence` — document `--no-git-hooks` always-wins precedence [nit, cross-provider]
- [ ] **R-10** `hono.ts|observability|replay-error-context-lost` — capture `String(err)` once into skip_reasons [nit, cross-provider INFO]

<!-- Pre-existing items (now [x]) shipped in this commit per review evidence: -->

<!-- zuvo:review 2026-05-05 713a4a8..05805db astro-helpers + astro-middleware -->
- [ ] `git|hygiene|05805db-message` — amend commit message vs actual files (review-queue vs middleware) (R-5) [nit]

<!-- zuvo:review 2026-05-05 b0ae5ff^..61d7d28 — fixed 2026-05-05 -->

<!-- zuvo:review 2026-05-05 5cdb537..83ea333 task 9a-9c — patched 2026-05-05 -->
- [ ] `typescript.ts|contract|enum-symbol-cardinality` — document 1+N symbols per enum for index consumers (R-4)
- [ ] `typescript.ts|control-flow|enum-case-return` — `return` vs `break` in `enum_declaration` vs future post-switch hooks [below-threshold]

<!-- zuvo:review 2026-05-05 fc4866b..803f259 — addressed in follow-up fix -->

<!-- zuvo:review 2026-05-05 ff64858^..0be6cd6 tasks 11–12 -->

- [ ] **R-7** `src/tools/*.ts` | loadIndex-vs-stale | centralize Task 16 — silent stale on non-migrated callers

<!-- zuvo:review 2026-05-05 83ea333..b247d02 task10a/b — addressed in extractor follow-up -->
<!-- zuvo:review 2026-05-04 3d4e52e^..c087544 -->
- [ ] `index-store.ts|CQ14|tolerance-dedup` — delegate `isExtractorVersionCurrent` to `findExtractorVersionMismatch`
- [ ] `typescript-constants-tools.ts|perf|pathmap` — memoize `buildNormalizedPathMap` per resolution
- [ ] `status-tools.ts|resilience|detectStale` — shared repo meta + try/catch around `loadIndexOrStale`
- [ ] `typescript-constants-tools.ts|robustness|readFile-catch` — narrow ENOENT vs other I/O errors
- [ ] `typescript-constants-tools.ts|numeric|Number-precision` — large literals / Infinity → unresolved
- [ ] `constant-resolution-tools.ts|API|file_pattern` — document or strict path matching for `file_pattern`
- [ ] `index-store.ts|edge|empty-extractor` — `{}` + empty `files` should not count as version-current
- [ ] `typescript-constants-tools.ts|coverage|path-alias` — resolve or document tsconfig path imports
- [ ] `constant-resolution-tools.ts|UX|infer-lang-fallback` — avoid silent default to python-only

<!-- zuvo:review 2026-05-05 f570c4c^..fc4866b TS extractor implements Tasks 1–2 -->

<!-- zuvo:review 2026-05-05 e8a23a4^..5cdb537 tasks 6–8 -->
- [ ] `typescript.ts|heuristic|react-component-suffix` — tighten ECS-style false positives on `*.Component` vs preserve permissive DX (R-2)
- [ ] `typescript.ts|coverage|signature-heritage-edge` — asserts/predicate returns; arrow param shape; mixin extends call_expression (R-3) [below-threshold cross-review]
- [ ] `_helpers.ts|hardening|stale-message-sanitize` — cap length strip control chars if metadata untrusted (R-5) [nit cross-review]

<!-- zuvo:review 2026-05-05 9e3be29^..9e3be29 react Tier 6 — 9 patterns + severity migration -->
- [ ] `pattern-tools.ts|accuracy|error-boundary-incomplete-description` — claim "React requires both" lifecycles is inaccurate; `cDC + setState` is valid (R-2) [superseded][cross-review]
- [ ] `pattern-tools.ts|precision|rsc-deep-pascalcase-critical` — open-ended `[A-Z]\w*` constructor at severity=critical flags `new Error()`/`new URL()`; denylist + downgrade unknowns (R-3) [superseded][cross-review]
- [ ] `pattern-tools.test.ts|coverage|severity-migration-hardcoded` — derive React-pattern list at runtime so Tier 5 + future tiers can't skip severity gate (R-4) [superseded][cross-review]
- [ ] `pattern-tools.ts|nit|stale-closure-toggle-handler-scope` — `setOpen(!open)` flagged universally; scope to async/effect closures (R-5) [superseded][nit cross-review]
- [ ] `pattern-tools.ts|nit|context-provider-via-variable-ASI` — requires `;` between literal and JSX; loosen to `[;\n]` (R-6) [superseded][nit cross-review]
- [ ] `pattern-tools.ts|nit|react-lazy-prefix-tempered` — `^((?!Suspense)[\s\S])*` fragile on minified files; two-pass indexOf alternative (R-7) [superseded][nit cross-review]
<!-- NOTE: All 7 entries in this block reference Tier 6 code that ae96065 reverted at HEAD — superseded, not actionable until Tier 6 is re-introduced on another branch. -->

- [ ] [LOW] safetensors-loader: adversarial WARNINGs deferred (iter-3, 0 critical): big-endian byte-swap support (currently hard-throw), isValidMeta name implies boolean (rename parseTensorMeta), 100MB header cap as explicit DoS doc. Source: zuvo/context/adversarial-task-1.txt 2026-06-12.
- [ ] [LOW] hf-hub-download: adversarial WARNINGs deferred (final iter, post-cap): no checksum/ETag verification of downloaded model files; hardcoded HF base URL not overridable for mirrors; inflight dedup shares stale rejection within one microtask. Source: zuvo/context/adversarial-task-2.txt 2026-06-12.
- [ ] [MED] static-embedding/tokenize: deferred adversarial findings — custom tokenizer approximates (not replicates) HF unigram pipeline the potion matrix was trained with (validate retrieval quality vs real model before flipping default); model2vec-tokenize.ts ~117 exec lines (>100 util cap); event-loop yield for very large texts batches. Source: zuvo/context/adversarial-task-3.txt 2026-06-12. [POST-CAP: DEFERRED]
- [ ] [MED] indexFolder: 364-line function (CQ11 advisory) — extract resolveSnapshotReuse helper; serial stat+sha in mtime loop could batch (CQ17); snapshot slightly stale if watcher saveIncremental lands between saveIndex and saveHashSnapshot (next cold run rebuilds — accepted). Source: T6 quality review + adversarial 2026-06-12. [POST-CAP noted]
- [ ] [MED] walk/include_paths: startsWith lacks path-segment boundary ("src/api" matches "src/api-v2") — walkDirectory and indexFolder merge-scope intentionally share the rule (consistent), fix BOTH together with a boundary-aware matcher. Source: adversarial-task-7 iter3. [POST-CAP: DEFERRED]
- [ ] [LOW] group-registry: adversarial iter-2 disposition — read-only getGroup/listGroups mask IO failures by design (warn + empty; mutations throw); revisit if groups become multi-writer. Source: adversarial-task-11. [POST-CAP: DEFERRED]
- [ ] [LOW] cross-repo-outbound-lexer: adversarial WARNINGs deferred (single-agent fallback, 0 critical) — non-/path absolute URLs, exotic call forms (got.extend, ky), and lexer perf on huge minified files. Source: zuvo/context/adversarial-task-12-13.txt 2026-06-12. [POST-CAP: DEFERRED]
- [ ] [LOW] cross-repo group orchestration: adversarial WARNINGs deferred (T15 iter3, 0 crit) — defaultRepoResolver path lacks unit tests (real getCodeIndex; covered only by T16 smoke); consumers_of_path scans all group repos each call (no cache); framework detect samples first 200 symbols (may miss endpoints in large repos). Source: adversarial-task-15. [POST-CAP: DEFERRED]

<!-- zuvo:review 2026-06-13 2a6e4f0..ab615b2 — aggregate cross-task review of the 16-commit 4-feature plan (fixes committed 78843ec) -->
- [ ] [LOW] `hf-hub-download.ts|structure|over-100-exec-lines` — ~127 exec lines vs 100 util cap (STRUCT-1); extract downloadToCache + inflight map into hf-hub-download-inner.ts or fold into hf-download-stream.ts. Source: Structure auditor.
- [ ] [LOW] `hash-snapshot.ts|deadcode|deleteHashSnapshot-unused` — exported but only test-used; invalidateCache does a bare unlink(snapshotPath) inline — route it through deleteHashSnapshot to dedup + get ENOENT-swallow (STRUCT-6). Source: Structure auditor.
- [ ] [NIT] util over-exports — `HOST_IS_LE`/`destroyAndWait` (safetensors-loader/hf-download-stream) + `READ_INACTIVITY_MS`/`MAX_ZERO_READS`: underscore-prefix or @internal per project convention; destroyAndWait can be fully unexported (STRUCT-7). Source: Structure auditor.
- [ ] [NIT] `cross-repo-outbound-lexer.ts|encapsulation|export-OutboundCallee-UrlLiteral` — un-export the two internal types (STRUCT-9). DEFERRED: both are referenced by the exported LexerOutboundCall, so un-exporting risks a TS4023 declaration-emit break under the package's `--declaration` — verify build before applying. Source: Structure auditor + post-fix judgment.
- [ ] [NIT] `register-tools.ts|consistency|inline-import-type` — introspectOpts uses an inline `import("./tools/...").IntrospectPgOptions` annotation, inconsistent with sibling handlers; drop the annotation (inferred from introspectPgSchema) (STRUCT-10). Source: Structure auditor.
- [ ] [MED] `cross-repo-contract-tools.ts|CQ6|consumer-scan-no-file-cap` — scanFiles has no per-repo file-count cap; a 50k-file monorepo reads every .ts in batches of 16 (concurrency bounds latency, not memory). Add MAX_SCAN_FILES_PER_REPO (~2000) + truncation warning (CQ-2). Source: CQ auditor.
- [ ] [LOW] `cross-repo-contract-tools.ts|CQ17|sequential-repo-resolve` — collectGroupData awaits resolver(repo) one at a time across up to 20 repos; parallelize with bounded concurrency (p-limit 4) — resolvers are independent (CQ-3). Source: CQ auditor.
- [ ] [NIT] `cross-repo-outbound-lexer.ts|CQ3|nested-backtick-in-interp` — readTemplateContent tracks "/' inside `${}` but not a nested template literal's backtick; `` `/api/${`${id}`}` `` corrupts raw → false-negative dropped fetch (CQ-4). Source: CQ auditor.
- [ ] [LOW] `index-tools.ts|behavior|snapshot-watcher-cold-start-tax` — saveIncremental (watcher edits) bumps updated_at but not the snapshot; next cold start's staleness guard discards it → full re-parse (BEHAV-4). Correct-and-safe by design; revisit only if cold-start cost matters. Source: Behavior auditor.
- [ ] [NIT] `pg-introspection.ts:294,318|deadcode|redactError-return-discarded` — redactError() is pure; its return value is discarded at both catch sites. Leftover from 8320176, which replaced substring classification (`message.includes("timed out")`) with identity comparison (`err === timeoutError`). Two-line delete. Source: Behavior auditor + CQ auditor (independent). (B-1)
- [ ] [NIT] `sql-parens.ts:57|cleanup|orphaned-section-header` — file ends on `// ── Byte-precise end finding ─` whose code moved to sql-end-scanner.ts in the same commit (be9973b). One-line delete. Source: Structure auditor. (B-2)
- [ ] [LOW] `pg-introspection.ts:330|observability|cleanup-deadline-silent` — on timeout, settleCleanup races closeClient() against a 100ms deadline; if client.end() hangs longer the call returns while the socket may still be open. Deliberate tradeoff (the alternative is the unbounded hang the timeout exists to prevent), not a defect — but the deadline winning should surface a cleanup-failure metric rather than passing silently. Adversarial confirmed no double-end (WeakMap dedupe) and no unhandled rejection from the losing Promise.race branch. Source: adversarial pass 4 (codex-5.3). (B-3)
- [ ] [MED] `sql-end-scanner.ts:2-57 + sql-parens.ts:1-55|duplication|four-quote-aware-scanners` — both files independently implement the same "walk chars, track inString/stringQuote with doubled-quote escaping" state machine (4 near-identical loops); the end-scanner pair also tracks `--` comments, the parens pair does not. Recipe: extract one `scanQuoted(source, start, onChar)`; keep the comment-aware variant as the superset and have non-comment-aware paths opt out explicitly. DEFER-REASON: [structural-refactor (multi-file)] — zuvo:refactor territory. Source: Structure auditor (STRUCT-1, conf 60). (B-4)
- [ ] [LOW] `tests/tools/journal/llm-client.test.ts|flake|10s-realtime-timeout` — "AnthropicJournalProvider timeout > rejects with timeout error after LLM_TIMEOUT_MS" waits on a real 10s timeout; fails under CPU contention (reproduced: red while 4 adversarial passes ran, green on an idle box, and red identically WITHOUT any local changes → pre-existing, not a regression). Fix: fake timers, as the pg introspection timeout test already does. Source: lead, isolated via stash-and-rerun. (B-6)
- [ ] [LOW] `tests/tools/yii3-migration-audit.test.ts|Q17|snapshot-is-implementation-echo` — the new "characterizes the complete category catalog" test asserts toMatchSnapshot() against a .snap generated from the current implementation's own output, so it proves "still equals what the code emitted the day it was written", not "still correct". Hard-code by_severity/decision_signal/php_version_required instead. Source: CQ auditor. (B-7)
- [ ] [LOW] `tests/integration/tools.test.ts|Q15|loose-predicates-on-L1-L2-L3` — new assembleContext assertions use toBeGreaterThan(0)/.some()/.every() and would pass on a wrong symbol/file set. Backstopped by context-levels.test.ts (exact toEqual), so not blocking; tighten if it ever becomes sole coverage. Source: CQ auditor. (B-8)


## Aggregate review 4cad382..b39c0e7 (tool-runtime-opt) — deferred findings
- [ ] B-1 [structural-refactor (multi-file)] Extract `src/register-tools/repo-version.ts` — runtime.ts:56 is ~460 LOC owning registry parse + fs stat + cache keying + registration. Collapse the twin registry loaders (CC 13 / 11) into one mtime-keyed loader returning both maps. Target: runtime.ts ~220 LOC, no node:fs import.
- [ ] B-2 [structural-refactor (multi-file)] Move `src/register-tool-groups/handler-wrappers.ts` → `src/utils/` — zero-import pure utility in a tool-definition-group dir; 7th `withTimeout` in the tree. Ties into existing R-9 (memory/reviews/2026-04-11-25dd3e6-six-new-tools.md:96).
- [ ] B-3 [structural-refactor (multi-file)] Config sprawl: runtime.ts:72 reads process.env directly; add `toolTimeoutMs` to Config (src/config.ts:6) so the boundary owns the clamp. Also route server-helpers.ts:14 REGISTRY_PATH through loadConfig().registryPath (it ignores CODESIFT_DATA_DIR while runtime.ts honors it). Dangerous consequence already neutralised by the R-4 fix; remaining issue is DRY/testability.
- [ ] B-4 [structural-refactor (multi-file)] Outer-cache invalidation API: server-helpers.ts:604 flushes the inner cache on index-mutating tools, but each per-tool withCache map is closed over in runtime.ts:351 with no handle. Register them; export `_resetToolResponseCaches()`.
- [ ] B-5 [structural-refactor (multi-file)] `timeoutMs` is set on ZERO production tools, yet run_pyright/run_mypy/generate_wiki/analyze_project/search_all_conversations/cold semantic_search can exceed the 90s default and now hard-fail. Set per-tool budgets. (runtime.ts:56)
- [ ] B-6 [structural-refactor (multi-file)] Outer cache: LRU cap but no TTL sweep — 8 tools x 128 entries x ~105KB = ~107MB worst-case retention in a long-lived daemon. (runtime.ts:68)
- [ ] B-7 [NIT] `withCache` maxEntries LRU eviction has no test (hit/miss/coalesce/reject covered). (handler-wrappers.ts:98)
- [ ] B-8 [structural-refactor (multi-file)] Abandoned-work backpressure: withTimeout is client-facing and does not cancel the handler (deliberate, plan-accepted), but nothing bounds the pile-up. (handler-wrappers.ts:20)
- [ ] B-9 [pre-existing] buildResponseHint (server-helpers.ts:323) cyclomatic complexity 55; server-helpers.ts has no dedicated test file and is a churn hotspot (309000).

## From review 080ae7c..28ba048 (2026-08-04) — index memory + SQLite honesty

  `resolveSearchHit` (`src/tools/symbol-tools.ts:234`) falls back to the BM25 hit for a colliding id,
  the response says nothing — the same silence `lossy_migration` was added to remove one layer down.
  Recipe: (1) return the collision group from `resolveSearchHit`, (2) thread `ambiguous_id: true` +
  candidate summaries through both tool registrations for `find_and_show` and `get_context_bundle`,
  (3) make the field unconditional, never conditional-on-ambiguity (a conditional shape was the
  earlier BEHAV-class bug in this same file).
- [ ] **B-19 [MED]** `stdio-servers|observability|transport_closed-is-undiagnosable`. Two runs today reported `transport_closed` on `refactor-result-export-migrate-v2` (09:48, 09:52) — the MCP server started and then died mid-session, a different failure from B-17's "never started". **Cause unknown and not retroactively knowable**: no crash report exists in that window (so not the documented web-tree-sitter WASM segfault risk in `server.ts:49`), and a stdio server's stderr goes to its client and is retained nowhere. Two events, same repo, four minutes apart. Recipe: give stdio servers a rotating stderr file under `~/.codesift/logs/` keyed by pid, so the NEXT occurrence is diagnosable instead of being reconstructed from a one-word retro field. Do not guess a cause before that exists.
- [ ] **B-14 [NIT]** `src/storage/sqlite/accessors.ts:136,163` — `saveIncrementalSqlite` and `removeFileFromIndexSqlite` read `meta.repo` to decide "does an index exist" BEFORE `BEGIN`, so the decision is made outside the transaction it guards — the same check-then-act shape `importLegacyIndexIfEmpty` uses `BEGIN IMMEDIATE` to avoid. Benign TODAY because nothing clears `meta.repo` concurrently, which is why it was left rather than folded into a remediation commit: moving it inside the transaction changes locking on the hottest write path (the postindex hook, one process per edited file) and deserves its own measurement. Source: blind CQ auditor on the B-2 split.
- [ ] **B-15 [MED]** `src/cli/setup/mcp.ts|correctness|http-setup-bakes-one-cwd` — `codesift setup <platform> --http` writes a GLOBAL client config whose URL hardcodes `?cwd=<the repo setup ran in>`. The daemon itself is correct: `cwdFromUrl` (src/server.ts:148) reads cwd per REQUEST and is stateless, so one daemon serves any number of repos. The client is the constraint — one static URL means one static cwd, so every OTHER repo silently resolves to the setup repo's index. That is hint H19 as a permanent configuration, and it is very likely WHY the shared daemon had zero adoption: anyone who tried it once got wrong answers everywhere and went back to stdio. Measured 2026-08-04: daemon up 25h, 0 established TCP connections, 65 stdio processes / 3.49 GB instead. Workaround applied by hand to ~/.claude.json — a per-project entry for each of 78 existing project dirs, each with its own URL-encoded cwd, global stdio left as the fallback for unknown dirs (own process, correct cwd). Encoding is not optional: four project paths contain a space and one contains `&`, which truncates the query and silently substitutes the wrong directory. Recipe: (1) `setup --http` should refuse to write a global entry, or emit per-project entries for clients that support them (Claude Code `projects{}`, per-repo `.cursor/mcp.json`); (2) for clients with only a global config (Codex TOML, Gemini), either keep stdio or teach the daemon to take cwd from the tool call rather than the URL; (3) note that `setup all --http` reported success for Codex while leaving it on stdio — the flag is ignored on the TOML path.
  (>2x the 450L ceiling; 587 non-comment). Extract the read-connection / paging / footprint block,
  mirroring the `index-footprint.ts` extraction already done.
- [ ] **B-3 [NIT]** `indexCacheMemBudgetBytes` (`src/config.ts:76`) duplicates
  `embeddingMemBudgetBytes` (`:53`) — same env-parse + RAM-tier shape. Extract
  `ramTieredBudgetBytes(envVar, tiers)` when a third budget function appears.
  no eslint/biome/oxlint config. Fails CQ40 on every TS file independent of any diff.
  `BEGIN IMMEDIATE` and never re-checks under the lock, so two processes can both run the v1->v2
  migration. Harmless (v2 has no PRIMARY KEY, so the second pass is a redundant copy) but wasteful.

## From review f8979e5..d9e424f (2026-08-04) — IndexSummary / ADR-004 stage 2

- [ ] **B-7 [NIT, pre-existing]** `EXTRACTOR_VERSIONS` (`src/tools/index-shared.ts`) has no entries
  for go, rust, markdown, sql, prisma, swift, dart despite extractors existing for several. This is
  what made R-1's trigger condition reachable.
- [ ] **B-8 [NIT]** `loadIndexSummarySqlite` reads the whole `files` table in one `.all()` with no
  `setImmediate` yield, unlike `readTablePaged`. Harmless while `files` stays orders of magnitude
  smaller than `symbols`; revisit if that stops holding.
  `files`, and the cache-hit call site is outside `getIndexSummary`'s try/catch. Unreachable via the
  typed path, undefended nonetheless.

## From the CQ audit of f8979e5..d9e424f (returned late; 2026-08-04)

  same ~10-line meta-extras block (extractor_version / workspaces / lossy_migration: JSON-parse,
  null-check, assign). Recipe: extract
  `parseIndexMetaExtras(meta: (k: string) => string | undefined): Pick<IndexSummary,
  "extractor_version" | "workspaces" | "lossy_migration">` in `sqlite-index-store.ts` and call it
  from both readers. Deferred rather than done inline: it edits the hot full-load path for a
  maintainability win, which is not a trade to make in the same commit as a correctness fix.
  cache, so a repo whose only traffic is `index_status` re-opens a connection every call while its
  `getCodeIndex` sibling is cached. Either add a lightweight summary cache keyed the same way, or
  state the asymmetry in the doc comment — currently it is neither.
  ("731L") are stale after this diff: `sqlite-index-store.ts` is ~1100L and `index-store.ts` ~806L.

  the string `"laravel", "symfony", "yii2"` and calls it Yii2 detection. Biome caught it: the test
  imported `detectStack` and never called it. Renamed to what it actually checks; a real test needs
  a temp dir with a `composer.json` requiring `yiisoft/yii2`, run through `detectStack`.

## From cross-repo contract refactor (2026-08-10)

- [ ] **B-20 [MEDIUM, correctness]** `cross-repo-outbound-calls.ts|ADV|fetch-method-window` —
  fetch method inference scans a raw 300-character window and can consume a neighboring call's
  `method`. A correct fix needs call-span offsets from `cross-repo-outbound-lexer.ts`, outside the
  refactor fence. Source: `zuvo:refactor` adversarial review.

## From import graph refactor (2026-08-10)

- [ ] **B-22 [MEDIUM, correctness]** `path-map.ts|ADV|above-root-relative-import` —
  `resolveImportPath` permits excess `..` segments to pop beyond the indexed source root, after
  which the remaining path can match an unrelated indexed file. Define whether above-root imports
  must be rejected or resolved against a workspace boundary, then add a regression matrix before
  changing this pre-existing behavior. Source: `zuvo:refactor` adversarial review.
- [ ] **B-23 [MEDIUM, correctness]** `language-imports.ts|ADV|php-leading-backslash-use` —
  PHP import extraction does not recognize fully-qualified declarations such as
  `use \\App\\Foo;`. Extend the parser and resolver together, with grouped/aliased and comment/string
  negatives, because accepting the syntax changes the graph rather than merely moving code.
  Source: `zuvo:refactor` adversarial review.

## From test audit 2026-08-10 — TypeScript constant resolution

- [ ] **B-21 [MEDIUM, Test]** `constant-resolution-tools.test.ts|Q11|defensive-branches` — the suite now passes 23/23 with 92.1% line and 75.55% branch coverage across the split TypeScript resolver, but defensive AST/import-context branches remain uncovered, so critical gate Q11 stays at 0 after the two-iteration test-quality cap. Residual anchors: `src/tools/typescript-constants/file-context.ts:47-50,75-86,126-155`, `src/tools/typescript-constants/symbol-resolver.ts:29-31,156-161`, and `src/tools/typescript-constants/value-evaluator.ts:173-203,273-315,397-417`. Continue with malformed import/export AST fixtures and non-ENOENT read failures; do not weaken exact result/reason assertions. File: `tests/tools/constant-resolution-tools.test.ts:1`. Source: `zuvo:test-audit`. Seen: 1. Added: 2026-08-10.

## From route tools refactor and test audit (2026-08-10)

- [ ] **B-24 [MEDIUM, Test]** `route-tools.test.ts|Q8-Q11|framework-edge-inventory` — the 39-test suite has exact positive assertions but no exhaustive negative/error inventory for every framework scanner; targeted branch coverage remains 73.30%. Source: `zuvo:test-audit`. Seen: 1. Added: 2026-08-10.
- [ ] **B-25 [MEDIUM, Test]** `route-tools-python.test.ts|Q8-Q11|decorator-edge-inventory` — Python decorator parsing lacks a complete branch-to-test inventory for malformed, stacked, and ambiguous decorators. Source: `zuvo:test-audit`. Seen: 1. Added: 2026-08-10.
- [ ] **B-26 [MEDIUM, Test]** `route-formatter.test.ts|Q8-Q11|malformed-render-inputs` — formatter coverage lacks exhaustive empty and malformed route/call-chain inputs. Source: `zuvo:test-audit`. Seen: 1. Added: 2026-08-10.
- [ ] **B-27 [MEDIUM, Test]** `tools.test.ts|Q8-Q11|route-integration-errors` — the route integration section covers the happy path but not a complete set of index, filesystem, and parser failures. Source: `zuvo:test-audit`. Seen: 1. Added: 2026-08-10.
- [ ] **B-28 [MEDIUM, correctness]** `next.ts|ADV|pages-exact-match` — Pages Router exact matching is inconsistent with other Next.js route forms. Source: `zuvo:refactor` adversarial review. Seen: 1. Added: 2026-08-10.
- [ ] **B-29 [MEDIUM, correctness]** `django.ts|ADV|include-prefix-resolution` — Django `include()` prefixes are not resolved into child URL patterns. Source: `zuvo:refactor` adversarial review. Seen: 1. Added: 2026-08-10.
- [ ] **B-30 [MEDIUM, correctness]** `django.ts|ADV|symbol-name-collision` — Django handler resolution can select the wrong same-named symbol. Source: `zuvo:refactor` adversarial review. Seen: 1. Added: 2026-08-10.
- [ ] **B-37 [MEDIUM, contract]** `trace-route.ts|ADV|mermaid-return-shape` — the optional Mermaid branch has a return-shape compatibility risk that needs an explicit public-contract decision. Source: `zuvo:refactor` adversarial review. Seen: 1. Added: 2026-08-10.
- [ ] **B-38 [LOW, efficiency]** `trace-route.ts|ADV|enrichment-without-handlers` — Next.js enrichment work is skipped or inconsistently applied when discovery returns no handlers. Source: `zuvo:refactor` adversarial review. Seen: 1. Added: 2026-08-10.
- [ ] **B-39 [MEDIUM, correctness]** `handler-discovery.ts|ADV|cross-framework-merge` — running all scanners and merging results can misclassify files containing overlapping framework syntax. Source: `zuvo:refactor` adversarial review. Seen: 1. Added: 2026-08-10.
- [ ] **B-42 [MEDIUM, correctness]** `nest.ts|ADV|ambiguous-symbol-selection` — NestJS discovery can bind a decorator to the wrong same-named method symbol. Source: `zuvo:refactor` adversarial review. Seen: 1. Added: 2026-08-10.
- [ ] **B-48 [MEDIUM, correctness]** `spring-kotlin.ts|ADV|annotation-adjacency` — Spring Kotlin discovery requires a mapping annotation to immediately precede `fun`, missing valid intervening syntax. Source: `zuvo:refactor` adversarial review. Seen: 1. Added: 2026-08-10.
- [ ] **B-49 [MEDIUM, correctness]** `django.ts|ADV|re-path-confusion` — the Django `path()` matcher can also consume `re_path()` constructs. Source: `zuvo:refactor` adversarial review. Seen: 1. Added: 2026-08-10.
- [ ] **B-50 [MEDIUM, correctness]** `ktor.ts|ADV|string-brace-depth` — braces inside Kotlin strings can corrupt Ktor nesting-depth tracking. Source: `zuvo:refactor` adversarial review. Seen: 1. Added: 2026-08-10.

## From test audit 2026-08-10 — Nest extension analyzers

The split suite passes 46/46 and the two audit iterations raised focused coverage from 96.19% to 99.77% lines and from 74.12% to 81.97% branches. Q11 remains 0 because the listed parser alternatives are still unexecuted; preserve exact outputs while adding table-driven `.js`, malformed-decorator/class, and zero-limit fixtures.

- [ ] **B-53 [MEDIUM, Test]** `nest-ext-graphql.test.ts|Q11|parser-fallback-branches` — cover `.js` resolver selection, the per-file pre-limit exit, and operation decorators outside a resolver class. File: `tests/tools/nest-ext-graphql.test.ts:1`. Source: `zuvo:test-audit`. Seen: 1. Added: 2026-08-10.
- [ ] **B-54 [MEDIUM, Test]** `nest-ext-websocket.test.ts|Q11|parser-fallback-branches` — cover `.js` gateway selection, a gateway decorator without a following class, and ignored commented handlers. File: `tests/tools/nest-ext-websocket.test.ts:1`. Source: `zuvo:test-audit`. Seen: 1. Added: 2026-08-10.
- [ ] **B-55 [MEDIUM, Test]** `nest-ext-schedule.test.ts|Q11|parser-fallback-branches` — cover `.js` candidates, quick-filter exits, ownerless decorators, and fallback dedup alternatives. File: `tests/tools/nest-ext-schedule.test.ts:1`. Source: `zuvo:test-audit`. Seen: 1. Added: 2026-08-10.
- [ ] **B-56 [MEDIUM, Test]** `nest-ext-typeorm.test.ts|Q11|parser-fallback-branches` — cover `.js` entity selection and an entity decorator without a following class. File: `tests/tools/nest-ext-typeorm.test.ts:1`. Source: `zuvo:test-audit`. Seen: 1. Added: 2026-08-10.
- [ ] **B-57 [MEDIUM, Test]** `nest-ext-microservice.test.ts|Q11|parser-fallback-branches` — cover `.js` controllers, the no-pattern fast path, missing handlers, and the ownerless-controller fallback. File: `tests/tools/nest-ext-microservice.test.ts:1`. Source: `zuvo:test-audit`. Seen: 1. Added: 2026-08-10.
- [ ] **B-58 [MEDIUM, Test]** `nest-ext-queue.test.ts|Q11|parser-fallback-branches` — cover `.js`/fast-path filters, ownerless decorators, and default queue/job-name fallbacks. File: `tests/tools/nest-ext-queue.test.ts:1`. Source: `zuvo:test-audit`. Seen: 1. Added: 2026-08-10.
- [ ] **B-59 [MEDIUM, Test]** `nest-ext-scope.test.ts|Q11|parser-fallback-branches` — cover `.js` candidates, no-`Injectable` and no-owner fast paths, and reverse-graph set reuse. File: `tests/tools/nest-ext-scope.test.ts:1`. Source: `zuvo:test-audit`. Seen: 1. Added: 2026-08-10.
- [ ] **B-60 [MEDIUM, Test]** `nest-ext-openapi.test.ts|Q11|parser-fallback-branches` — cover `.js`/spec filters, empty schema classes, optional decorator metadata, and route/security/parameter fallbacks. File: `tests/tools/nest-ext-openapi.test.ts:1`. Source: `zuvo:test-audit`. Seen: 1. Added: 2026-08-10.

## From telemetry error triage 2026-08-12 (measurements in CLAUDE.md → "Reading the error telemetry")

Triage rule established: slice `error_rate` by `codesift_ver` AND `day` before believing a tool is
broken. The all-time sum said `find_and_show` was failing at 14.1% (one cut read 69.7%); it has been
at 0/100 since `974f92c` (2026-07-16). These four are what survived that slicing.

  **The first diagnosis filed here was wrong** and is kept as the correction: it blamed npm omitting `optionalDependencies`, then npm 11 vs npm 10. Isolating one variable at a time killed both — same lockfile, same host: `npm ci --ignore-scripts` → 238 packages, transformers present; `npm ci` → 207, absent; identical on npm 10.9.8 and 11.16.0, and `--include=optional` changed nothing. The cause is an install SCRIPT: `onnxruntime-node`'s postinstall finds no `nvcc`, **assumes CUDA 12**, downloads a multi-hundred-MB GPU tarball from GitHub releases, dies on `Error: socket hang up` via an unhandled error event — and npm drops the failed optional package together with `@huggingface/transformers`, which depends on it, then **exits 0**.


<!-- refactor-radar session 2026-09-25 (tgm-access) -->
- [ ] [MED] `src/cli/hooks/pre-tool-use.ts (precheck-bash)|false-positive|blocks-find-grep-outside-indexed-scope` — `codesift precheck-bash` rejected Bash commands that were NOT code discovery in the indexed repo. (1) `find ~/DEV … ~/.zuvo /private/tmp/claude-501 … -name 'refactor-radar-*'`, a search for report directories outside any repo, run from cwd tgm-access, was blocked with "Current repo is indexed by CodeSift. Use get_file_tree". CodeSift cannot answer that. (2) `grep` over PHP files in a LINKED WORKTREE (`tgmdev-tgm-panel-worktrees/radar-4971266`, detached at a frozen SHA) was blocked, although the index describes the parent checkout on another branch; the tool's own worktree trap (H19) says that answer would be wrong. Workaround each time: rewrite as `python3 -c` (3 turns lost). Fix: block only when every path argument resolves inside the indexed root of the CURRENT worktree; allow a path outside it, or a linked worktree that is not indexed. Seen: 1. Added: 2026-09-25.
- [ ] [MED] `src/cli/hooks/pre-tool-use.ts (precheck-bash)|fail-open|blocks-grep-while-server-unreachable` — 2026-09-25 the MCP server was unreachable for the whole session (`CONNECT_TIMEOUT` dialing `http://127.0.0.1:7077`, so no `mcp__codesift__*` tools at all), yet precheck-bash kept rejecting `grep -r` with "Use CodeSift MCP tools instead" — the agent was left with no search tool and fell back to `git grep`/`git ls-files` workarounds. The hook should fail open (or say so explicitly) when the daemon does not answer a cheap health probe. Source: tgm-panel PANEL-1515 session.

<!-- zuvo build/test-audit session 2026-09-25 (zuvo-plugin worktree radar-coverage) -->
- [ ] [MED] `src/tools/index-folder + audit-scan|timeout|no-progress-on-worktree` — On a linked worktree of zuvo-plugin (1,029 files) `index_folder` ran past the host's 300 s MCP idle timeout twice without a progress event (also with `include_paths` scoped to 2 directories), and `audit_scan` scoped to 4 test files (`checks=CQ8,CQ13,CQ14`) timed out twice the same way; per-file `index_file` worked (28–42 s each). Long operations need progress notifications or a background job id, otherwise the host aborts them and skills lose their mandatory tools. Source: zuvo:test-audit Validity Gate. Seen: 1. Added: 2026-09-25.
- [ ] [LOW] `src/tools/find-references|partial|30s-scan-cap-on-bare-names` — `find_references(symbol_names=[parse, load, family, …], file_pattern="tests/gates/*.py")` returned `scan_coverage: partial` after the 30 s cap, matching unrelated tokens (`rev-parse`, `"family"` dict keys). For bare common names the result cannot establish test references; either qualify by module or say so in the response. Seen: 1. Added: 2026-09-25.


<!-- zuvo:refactor-radar session 2026-09-27 (tgm-survey-platform, linked worktree radar-cov-0927 @ eff5f2c9c2, 19,379 files) -->
- [ ] [MED] `src/tools/index-folder|correctness|include-paths-glob-indexes-zero` — `index_folder(path=<worktree>, include_paths=["apps/runner/**","apps/api/src/modules/runner/**","packages/survey-engine/src/**"], watch=false)` returned `file_count: 0` in 538 ms; the same call without `include_paths` indexed 19,379 files. The tool schema documents `include_paths` as "Glob patterns", but the matcher appears to be a prefix `startsWith` (see the walk/include_paths entry above), so a `**` glob matches nothing and the call reports success with an empty index. Fix: glob-match (or reject glob characters with an error), and fail loudly on a 0-file result when include_paths was given.
- [ ] [MED] `src/tools/search-text|timeout|8s-cap-even-with-narrow-file-pattern` — on that fresh 19k-file index, `search_text("VITE_RUNNER_LOCAL_FIRST_RUNTIME_ENABLED")` hit the 8000 ms cap both unscoped and with `file_pattern="apps/runner/src/config/*.ts"` (one directory, ~5 files). A narrow pattern should not scan the tree; it looks like filtering happens after the scan. Same session: `find_references(symbol_names=[4 names])` scanned 284/19,379 files before the 30 s cap and returned `[]` with `scan_coverage: partial` (seen again — see the find-references 30s entry above); a regex `search_text` with `file_pattern` over 1,692 files succeeded earlier. Fix: apply `file_pattern` before reading file contents.

<!-- zuvo:refactor-radar session 2026-09-27 (tgm-survey-platform, detached linked worktree radar-cov-eff5f2c @ eff5f2c9c2) -->
- [ ] [MED] `src/tools/index-folder|timeout|worktree-index-times-out` — `index_folder(path=<linked worktree>, include_paths=["apps/api/**"], watch=false)` returned only the MCP client error "The operation timed out" — no partial index, no progress, no hint whether the daemon kept working. Together with the include_paths entry above this leaves the documented H19 remedy ("index_folder the worktree once") unusable on tgm-sized trees. Recipe: return immediately with a job id / progress handle for large folders, or report the file count it is about to index and refuse above the client timeout budget with a message naming the narrowing option that actually works.
- [ ] [MED] `src/cli/hooks/pre-tool-use.ts (precheck-bash)|false-positive|unindexed-linked-worktree` — inside an UNINDEXED linked worktree the hook blocked `grep` with "Current repo is indexed by CodeSift" — true only of the PARENT checkout, so the suggested `search_text` would answer from another branch (310 commits apart here), i.e. exactly the H19 trap the rules warn about; with `index_folder` timing out (entry above) the session had no valid discovery path at all. Also seen again: `find` on a `$TMPDIR` artifact directory outside the repo was blocked (same class as the 2026-09-25 "outside indexed scope" entry). Recipe: when CWD is a linked worktree that is not itself indexed, allow grep/find (or allow after one failed/timed-out `index_folder`), and say so in the block message.
- [ ] [LOW] `src/server.ts|availability|partial-tool-surface-drop` — mid-session the client reported 28 `mcp__codesift__*` tools as "no longer available (their MCP server disconnected)" while the rest of the surface (search_text, index_folder, find_references…) stayed callable. A partial drop looks like neither a crash nor a healthy server. Unverified whether this was a daemon restart racing a lazy tool surface or a client-side artifact. Recipe: correlate with the daemon boot trace / OOM entries for 2026-09-27 ~11:40Z before acting.

## Findings carried from the v0.19.0 ship review (2026-09-28)

Six providers (cursor-agent, codex-5.3, byteplus-3, claude, kimi, muse) produced 16 CRITICAL records
over `v0.18.1..3cf4330`. Four were real and fixed in-run; these are the ones deliberately NOT fixed,
with the reason.

- **Conversation change detection is mtime-only.** A file rewritten with a preserved or
  same-granularity mtime is missed. A proper fix compares SIZE as well, which needs a stored size on
  `FileEntry` — a schema decision, not a patch. Low likelihood for append-only JSONL logs written by
  the editor, which move the mtime on every append. (`src/tools/conversation-index-tools.ts`)
- **`prune` may checkpoint a WAL whose database another process has open.** `PRAGMA
  wal_checkpoint(TRUNCATE)` on a busy database is refused rather than destructive, and the call is
  wrapped, so the log is left exactly as it was — but it can briefly contend for the write lock.
  Bounded and non-destructive; worth revisiting if prune ever runs while indexing does.
  (`src/cli/commands-maintenance.ts`)
- **The code index and its BM25 file are linked by a mutable `updated_at`, non-atomically.** If a
  write lands between reading the value back and stamping the header, the header is stale and the next
  search rejects the file and rebuilds. Costs a rebuild, never a wrong answer — the staleness check is
  what protects correctness. (`src/tools/conversation-index-tools.ts`)
- **`DEAD_PID` in two test files is captured once at module load.** If the OS recycled that pid mid-run
  the liveness assertions would invert. Test-only flake risk, vanishingly unlikely within one run on a
  monotonic pid allocator. (`tests/storage/orphan-temp-of-live-repo.test.ts`, `tests/cli/prune.test.ts`)

Recorded as false positives, with the reason, so they are not re-litigated:
`cleanupOrphanTempFiles(path)` takes the TARGET path and derives the directory itself (that is its
signature at every call site); the "unbounded peak during `Promise.all`" finding quotes the comment's
description of the PRE-fix behaviour, which the bounded worker pool replaced (measured peak
1,191 MB); a partially-failed incremental pass self-heals, because the unwritten file keeps its old
recorded mtime and is reprocessed next run; `appendSharedCache` is synchronous, so the seed helper has
nothing to await; and the conversation tests use a unique repo name per tmpdir, so module state cannot
leak between them.

### Separate: a hole in the push gate itself, not in this repo

`pg_uncovered_files` reported **0 uncovered files** for this release. Removing the twelve
`files: *` artifacts from `memory/reviews/` and re-running it reported all 12. Those artifacts are
from July and August, months before this code existed, so the gate's "already reviewed" verdict was
blanket coverage rather than evidence — and it satisfies `pre-push-gate.sh` the same way. Belongs to
`zuvo`'s `hooks/lib/pipeline-gate-lib.sh`, not to codesift. This release was reviewed at full depth
anyway, on the grounds that no honest per-file evidence line could be written.

## Deferred from the v0.19.0 ship review — structural, with recipes (2026-09-28)

Both are real, both are `zuvo:refactor` work, and neither is a correctness problem. Deferred per
`zuvo:review` Phase 2: a structural refactor surfaced on an unrelated diff is scope creep and must
not block a merge.

- **B-STRUCT-1 `handlePruneLocked` is 423 lines doing four unrelated reclaim jobs**
  (`src/cli/commands-maintenance.ts:19`). The 293-line baseline already broke the 50-line function
  limit; this release added ~130 more as three further inline sweeps. Recipe: extract
  `reclaimOrphanTempTails`, `reclaimSupersededBm25Files` and `checkpointOrphanWals`, leaving
  `handlePruneLocked` an orchestrator. They are already comment-delimited and share nothing but
  `dataDir`, `dryRun` and the `files`/`bytes` counters, so each extracts cleanly. The pre-existing
  shared-cache-version sweep just below them is already its own block — match that shape.
- **B-STRUCT-2 `incrementalConversationUpdate` is 149 lines and its file went 200L to 528L**
  (`src/tools/conversation-index-tools.ts:238`). The file-size violation was created entirely by this
  release. Recipe: move `conversationsUnchanged`, `incrementalConversationUpdate` and
  `CONVERSATION_AMEND_MAX_SHARE` into a new `src/tools/conversation-incremental.ts` imported by
  `indexConversations` — the same split `storage/index-json-mutations.ts` already is from
  `index-store.ts`. That alone brings the file back under 300L.

Coverage gaps the CQ audit named. The first is CLOSED in this release
(`tests/server/health-cache-report.test.ts` covers `cache-report.ts`, the `/health` caches block and
the opt-out); the rest are open:

- **B-COV-2** no test asserts `CONVERSATION_SEARCH_CONCURRENCY` actually bounds in-flight searches —
  the fan-out's correctness is covered, its boundedness is not. Instrument `searchOne` and assert
  peak concurrency at or below the configured value.
- **B-COV-3** `MAX_EMBEDDING_ENTRIES = 64` in `conversation-cache.ts` has no eviction test (seed 65+).
- **B-COV-4** `saveEdgeCache`'s new `cleanupOrphanTempFiles` call is untested at the integration
  point; only the primitive is tested standalone.
- **B-CQ14-1** `evictBM25OverBudget` (`index-tools/state.ts`) and `evictOverBudget`
  (`conversation-cache.ts`) are near-identical LRU policy, just under the duplication threshold. A
  shared `evictLRUOverBudget(map, budget, pinned, onEvict?)` would close it. The two already share
  their *pricing* functions after this release; this is the second-order duplication of the *policy*.
- **B-CI-1** (pre-existing) the CI workflow runs the build but never the linter, so it enforces the
  typecheck half of the lint script and not the Biome half.

## B-FLAKE-1 `tests/tools/explore-tools.test.ts` fails 1 run in 2–3, measured (2026-09-28)

Found while shipping v0.19.0, in a file that release does not touch. It reddens full-suite runs at a
rate high enough to make every red ambiguous, which is worse than the test being absent.

**Measured, isolated (`rt --repeat`):** 1/12, then 2/6, then 4/8 — so somewhere around a third,
possibly rising with host load. Plus three separate full-suite reds in one session, in two different
cases of the same file (`shows the head of a single line longer than the budget` and `does not record a
clipped body as shown`).

**Symptom:** `explore` answers `No symbols match "<fixture symbol>"` for a repo the `beforeEach`
just indexed with an awaited `indexFolder(root)`.

**A hypothesis that was tried and does NOT fix it:** the test reuses one repo NAME
(`local/explore-project`) across tests while giving each a fresh `CODESIFT_DATA_DIR`, and the
module-level caches (`codeIndexes`, `bm25Indexes`, the registry cache) are keyed by name — so a
previous test's index, or a registry row pointing at a since-removed tmpdir, could survive into the
next test. Clearing both (`releaseCachedIndexes()` + `_resetRegistryCacheForTests()` in `beforeEach`)
measured 4/8, i.e. no improvement. Reverted; recorded here so the next attempt does not start there.

**What to try next, in order:** (1) give each test a UNIQUE repo name by making the fixture directory
basename unique, which removes name-keyed collision as a possibility rather than trying to clear it;
(2) assert `index_status` inside `beforeEach` so the failure is attributed at setup rather than at the
first `explore` call; (3) check whether `indexFolder`'s watcher or its detached wiki-regen child
mutates the index after the await returns.
