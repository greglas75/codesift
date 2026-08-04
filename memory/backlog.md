# Review backlog (zuvo:review)

<!-- fingerprint: file|rule|signature -->

<!-- zuvo:review 2026-08-03 v0.12.0..HEAD — release review deferrals -->
- [ ] [MED] `src/storage/index-store.ts|CQ11|god-module-split` — 731L / 21 exports carrying six concerns (backend selection, JSON→SQLite migration, materialised-index LRU, stale/extractor-version detection, legacy JSON path + mutation batching, path helpers); the largest file in src/storage/ and the only multi-concern one (siblings own one job each). Recipe: (1) extract the LRU + data_version cache into `src/storage/index-cache.ts` — it only needs a dbPath key, so it lifts cleanly; (2) extract `sqlitePathFor` + `ensureSqliteMigrated` + the migration guard map into `src/storage/index-migration.ts`, re-exporting `sqlitePathFor` so register-tools/runtime.ts keeps its import path; (3) leave index-store.ts as the JSON backend + dispatcher, mirroring sqlite-index-store.ts so the two are symmetric. Defer reason: [structural-refactor (multi-file)].
- [ ] [MED] `src/storage/*|convention|two-forTesting-styles` — src/storage/ now has both `resetXForTesting` (index-store.ts, sqlite-index-store.ts) and `_resetXForTests` (shared-embedding-cache.ts, telemetry/anon-id.ts) live at once with no rule distinguishing them. Pick one for the directory and align. Defer reason: [structural-refactor (multi-file)].
- [ ] [LOW] `src/tools/workspace-scope-helper.ts|duplication|storage-fault-guard` — the `catch (err) { if (isIndexStorageError(err)) throw err; return null; }` idiom is implemented twice (also workspace-tools.ts getIndexOrEmpty); the comments already cross-reference each other. Promote getIndexOrEmpty to a shared location and have resolveWorkspaceScope call it. Defer reason: [structural-refactor (multi-file)].
- [ ] [LOW] `src/storage/embedding-store.ts|duplication|index-path-derivation` — two copies of `indexPath.replace(/\.index\.json$/, ...)`, the same shape `sqlitePathFor` was created to remove for the .db case. Pre-existing (predates v0.12.0). Recipe: `embeddingPathsFor(indexPath)` returning both. Defer reason: [structural-refactor (multi-file)].
- [ ] [MED] `src/storage/embedding-store.ts|correctness|hash-before-vector` — content hashes are committed for every symbol BEFORE embedFn returns, so a provider returning a short array leaves the OLD vector persisted under the NEW content hash; needsEmbed then sees a match and the symbol is permanently skipped from re-embedding. Confirmed by the behaviour audit; introduced by 748fdf4 which is an ANCESTOR of v0.12.0, so out of this range. Recipe: require vectors.length === batch.length before committing hashes, or commit each hash only after its vector is stored; also assert data.length === texts.length in isEmbeddingResponse. Defer reason: [structural-refactor (multi-file)] + out-of-range.
- [x] [LOW] `src/storage/sqlite-index-store.ts|consistency|rethrowOperational-coverage` — DONE 2026-08-04 (6df1df4 write paths, 3056c5c narrow accessors + the `schema_version` meta read in openIndexDb, which was outside the guard because `CREATE TABLE IF NOT EXISTS` succeeds on a database with corrupt DATA pages). — only openIndexDb and loadIndexSqlite wrapped raw sqlite errors as IndexStorageError; the narrow accessors and write paths let them propagate raw, so a caller using isIndexStorageError (rather than classifyStorageError) will not recognise them.
- [ ] [LOW] `src/storage/shared-embedding-cache.ts|concurrency|append-interleave` — appendFileSync of a multi-KB batch is not atomic beyond the OS write size, so concurrent codesift processes can interleave into a malformed line. Mitigated: the reader drops malformed lines, so the effect is a lost cache entry, not corruption. Defer reason: [NIT].

<!-- zuvo:ship 2026-08-03 v0.13.0 — carried pre-existing flake -->
- [ ] [MED] `tests/server/http-session-cwd.test.ts|flake|econnreset-on-server-replace` — "keeps serving the same client after the server instance is replaced" fails intermittently with ECONNRESET. Measured, not assumed: 3 failures / 12 runs at v0.12.0 vs 1 / 9 at HEAD, so it is PRE-EXISTING and slightly LESS frequent after this release — carried, not introduced. A first 5/5 green baseline nearly misclassified it as a regression; the rate only resolves with ~12 runs. Recipe: the race is in the test's own restart sequence — await a readiness probe on the replacement server before the next fetch instead of assuming the listener is up. Defer reason: [structural-refactor (multi-file)] — needs a shared readiness helper for the daemon test harness.

<!-- zuvo:ship 2026-08-03 v0.13.0 — daemon adversarial residuals -->
- [ ] [MED] `src/cli/service.ts|injection|systemd-token-escaping` — the daemon token is interpolated into systemd unit syntax without escaping; a token containing whitespace, quotes or a newline can malform the environment assignment or inject further unit directives, so the service may fail or silently run with a different token. Recipe: reject control characters at parse time, then serialize the Environment= assignment with a systemd-compatible escaper. Found by adversarial on 8f6671f during ship v0.13.0. Defer reason: [structural-refactor (multi-file)] — touches the service plan builder and both platform unit writers.
- [ ] [MED] `src/cli/commands.ts|correctness|remote-cwd-from-client` — shared-daemon setup sends the CLIENT machine's process.cwd() as the path for the REMOTE host, so on machines with different checkout paths the generated config points the daemon at a nonexistent directory (or an unrelated one that happens to share the name) — while the help correctly states paths must exist on the daemon host. Recipe: require an explicit daemon-side path when --host is supplied instead of defaulting to the client CWD. Found by adversarial on 8f6671f during ship v0.13.0. Defer reason: [structural-refactor (multi-file)] — changes the --http contract across all four setup platforms.

<!-- zuvo:review 2026-08-02 27fffbc..HEAD — SQLite index migration -->
- [x] [MED] `src/storage/index-store.ts|error-contract|sqlite-operational-errors` — DONE 2026-08-02 (IndexStorageError + loadIndexOrStale "unreadable" + getCodeIndex throws + index_status reports). — `readIndex`/`loadIndexOrStale` collapse SQLite operational failures (locked, corrupt, permission) into `null`, i.e. "no index", so callers cannot tell transient storage failure from an absent index and may trigger needless rebuilds. Recipe: (1) introduce an `IndexReadError` distinguishing not-found/invalid from operational; (2) propagate operational errors out of `readIndex`; (3) update the 9 production importers of index-store to surface rather than rebuild. Defer reason: [structural-refactor (multi-file)].

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
- [ ] **R-0** `hono.ts|correctness|inflight-leak-on-throw` — MUST-FIX: `inFlight.delete(file)` outside `finally` in BOTH cache-hit (line ~150) and main-path (line ~239) branches; throw poisons cycle detection set [cross-provider CRITICAL]
- [ ] **R-1** `tsconfig-paths.ts|perf|ancestor-cache-lost` — populate ancestor dirs in `dirToConfigCache` with new compound key (sibling lookups regressed from O(1) to O(N))
- [ ] **R-2** `heritage-edges.ts|telemetry|ambiguous-skip-counter` — persist counter for resolution misses (silently drops edges when 2+ files declare same name)
- [ ] **R-3** `git-hooks-installer.ts|robustness|hookspath-normalize` — `realpathSync` both sides before equality check on `core.hooksPath` [cross-provider WARNING]
- [ ] **R-4** `index-store.ts|UX|empty-index-language-arbitrary` — degenerate empty branch picks `Object.keys(currentVersions)[0]`; either distinct `reason: "empty_index"` or explicit sentinel in `mismatch_detail` [cross-provider WARNING]
- [ ] **R-5** `pattern-tools.ts|test|postFilter-fail-open-untested` — add unit test asserting throwing postFilter keeps match + emits warning; document in CHANGELOG
- [ ] **R-6** `react-tools.ts|hygiene|sym-id-fallback-masks-bug` — drop `sym.id ?? sym.name` fallback at line 804 (sym.name not in reverseAdj keyset)
- [ ] **R-7** `constant-file-pattern.ts|precision|4char-substring-fp` — raise threshold or word-boundary substring fallback [nit]
- [ ] **R-8** `symbol-tools.ts|coverage|reexport-regex-anchored-misses` — drop `^` anchor or use tree-sitter walk over export_statement [nit]
- [ ] **R-9** `commands.ts|UX|git-hooks-flag-precedence` — document `--no-git-hooks` always-wins precedence [nit, cross-provider]
- [ ] **R-10** `hono.ts|observability|replay-error-context-lost` — capture `String(err)` once into skip_reasons [nit, cross-provider INFO]

<!-- Pre-existing items (now [x]) shipped in this commit per review evidence: -->
- [x] `typescript-constants-tools.ts|perf|pathmap` — memoized in `state.normalizedPathMap` (this commit)
- [x] `typescript-constants-tools.ts|robustness|readFile-catch` — narrowed ENOENT vs other I/O (this commit)
- [x] `typescript-constants-tools.ts|numeric|Number-precision` — `!Number.isFinite(n)` + `!Number.isSafeInteger(n)` guards (this commit)
- [x] `constant-resolution-tools.ts|UX|infer-lang-fallback` — returns `[]` instead of `["python"]` (this commit)
- [x] `index-store.ts|tolerance-dedup` — `isExtractorVersionCurrent` delegates to `collectExtractorVersionMismatches` (this commit)
- [x] `index-store.ts|edge|empty-extractor` — degenerate-empty-index branch returns mismatch (this commit; see R-4 above for residual)
- [x] `status-tools.ts|resilience|detectStale` — try/catch + shared `resolveRegisteredRepoMeta` (this commit)

<!-- zuvo:review 2026-05-05 713a4a8..05805db astro-helpers + astro-middleware -->
- [x] `astro-middleware.ts|heuristic|rewrite-return` — fixed: bare `context.rewrite` no longer satisfies EFFECT_RE; require `return` + redirect|rewrite
- [x] `astro-middleware.ts|parser|js-extension` — fixed: `typescript` for `.ts`, `javascript` for `.js`/`.mjs`
- [x] `astro-middleware.ts|UX|mw03-dedupe-lines` — fixed: one MW03 per if with `ifStmt.startPosition.row + 1`
- [x] `astro-middleware.ts|coverage|export-shapes` — narrowed scope documented in file header (re-exports/default still future)
- [ ] `git|hygiene|05805db-message` — amend commit message vs actual files (review-queue vs middleware) (R-5) [nit]

<!-- zuvo:review 2026-05-05 b0ae5ff^..61d7d28 — fixed 2026-05-05 -->
- [x] `hono.ts|correctness|parseFile-cache-mounts` — cache hit re-runs walkRouteMounts after replay
- [x] `hono.ts|model|mount-parent-var` — parent_var from route ownerVar
- [x] `hono.ts|cache|mounts-stale` — parsedCache.set after walkRouteMounts
- [x] `python.ts|types|partial-meta` — partial_extraction on all symbols
- [x] `hono.ts|observability|cycle-skip-reason` — parse_cycle_skipped skip_reason

<!-- zuvo:review 2026-05-05 5cdb537..83ea333 task 9a-9c — patched 2026-05-05 -->
- [x] `typescript.ts|parity|abstract-method-signature` — **patched:** `is_async`, `accessor_kind`, shared meta with `method_definition`
- [x] `typescript.ts|metadata|accessor-in-modifiers` — **patched:** `accessor` in `MODIFIER_KEYWORD_TOKENS`
- [x] `typescript.ts|ordering|abstract-modifier` — **patched:** `ensureAbstractRecorded` (unshift when no other modifiers, else push)
- [ ] `typescript.ts|contract|enum-symbol-cardinality` — document 1+N symbols per enum for index consumers (R-4)
- [ ] `typescript.ts|control-flow|enum-case-return` — `return` vs `break` in `enum_declaration` vs future post-switch hooks [below-threshold]

<!-- zuvo:review 2026-05-05 fc4866b..803f259 — addressed in follow-up fix -->
- [x] `tsconfig-paths.ts|security|absolute-specifier` — reject absolute importPath + clamp resolved path under repoRoot (R-1)
- [x] `tsconfig-paths.ts|cache|repoRoot-key` — include repoRoot in dirToConfigCache key (R-2)
- [x] `tsconfig-paths.ts|coverage|extensions` — add .mts/.cts/.mjs/.cjs (+ index variants) (R-3)
- [x] `ts-imports.ts|coverage|legacy-module-syntax` — import=/export= forms (R-4)
- [x] `ts-imports.ts|accuracy|export-type-specifiers` — per-specifier type on re-exports (R-5)
- [x] `ts-imports.ts|accuracy|verbatim-module-syntax` — document or detect runtime retained imports (R-6)

<!-- zuvo:review 2026-05-05 ff64858^..0be6cd6 tasks 11–12 -->
- [x] `import-graph.ts|paths|alias-prefix-strip` — at `0be6cd6` used `startsWith(index.root)`; **[patched]** later on `HEAD` with `relative` + inside-repo guard (`memory/reviews/2026-05-05-ff64858-0be6cd6.md`)

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
- [ ] `typescript-constants-tools.ts|CQ11|split-module` — reduce file size / split helpers
- [ ] `typescript-constants-tools.ts|coverage|path-alias` — resolve or document tsconfig path imports
- [ ] `constant-resolution-tools.ts|UX|infer-lang-fallback` — avoid silent default to python-only

<!-- zuvo:review 2026-05-05 f570c4c^..fc4866b TS extractor implements Tasks 1–2 -->
- [x] `_shared.ts|parity|heritage-array-copy` — `[...opts.extends]` / `[...opts.implements]` in `makeSymbol` + mutation test (`2026-05-05`)
- [x] `context-tools|graph|heritage-edges` — `collectHeritageFileEdges` + persist `extends`/`implements` on knowledge graph (`2026-05-05`)

<!-- zuvo:review 2026-05-05 e8a23a4^..5cdb537 tasks 6–8 -->
- [ ] `typescript.ts|perf|dup-getClassHeritage` — compute heritage once per class; align CQ14 comment (R-1)
- [ ] `typescript.ts|heuristic|react-component-suffix` — tighten ECS-style false positives on `*.Component` vs preserve permissive DX (R-2)
- [ ] `typescript.ts|coverage|signature-heritage-edge` — asserts/predicate returns; arrow param shape; mixin extends call_expression (R-3) [below-threshold cross-review]
- [ ] `_helpers.ts|hardening|stale-message-sanitize` — cap length strip control chars if metadata untrusted (R-5) [nit cross-review]

<!-- zuvo:review 2026-05-05 9e3be29^..9e3be29 react Tier 6 — 9 patterns + severity migration -->
- [ ] `pattern-tools.ts|precision|derived-state-reducer-sync-substring` — `[a-zA-Z_-]*sync` with `i` flag overmatches `async`/`asynchronous`; word-boundary or allowlist (R-1) [superseded][cross-review]
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
- [ ] [MED] `index-tools.ts|structure|indexFolder-monolith` — indexFolder body ~358 exec lines, 9 responsibilities (STRUCT-3); extract resolveIncrementalFiles + buildNewSnapshot + finalizeLegacyHashes. zuvo:refactor territory — overlaps the existing 364-line entry above. Source: aggregate Structure auditor.
- [ ] [LOW] `hf-hub-download.ts|structure|over-100-exec-lines` — ~127 exec lines vs 100 util cap (STRUCT-1); extract downloadToCache + inflight map into hf-hub-download-inner.ts or fold into hf-download-stream.ts. Source: Structure auditor.
- [ ] [LOW] `cross-repo-contract-tools.ts|structure|386-exec-lines` — under the 450 tool cap but 4 concerns woven (STRUCT-4); split adapters+matchContracts into cross-repo-match.ts (pure logic, no I/O). Source: Structure auditor.
- [ ] [LOW] `registry.ts|robustness|enoent-vs-parse` — loadRegistry silently returns empty on ALL errors incl. EACCES/EMFILE; align with group-registry's ENOENT-vs-parse distinction so transient FS errors throw not vanish (STRUCT-8). NOTE: parallel-session file, out of primary diff scope. Source: Structure auditor.
- [ ] [LOW] `hash-snapshot.ts|deadcode|deleteHashSnapshot-unused` — exported but only test-used; invalidateCache does a bare unlink(snapshotPath) inline — route it through deleteHashSnapshot to dedup + get ENOENT-swallow (STRUCT-6). Source: Structure auditor.
- [ ] [NIT] util over-exports — `HOST_IS_LE`/`destroyAndWait` (safetensors-loader/hf-download-stream) + `READ_INACTIVITY_MS`/`MAX_ZERO_READS`: underscore-prefix or @internal per project convention; destroyAndWait can be fully unexported (STRUCT-7). Source: Structure auditor.
- [ ] [NIT] `cross-repo-outbound-lexer.ts|encapsulation|export-OutboundCallee-UrlLiteral` — un-export the two internal types (STRUCT-9). DEFERRED: both are referenced by the exported LexerOutboundCall, so un-exporting risks a TS4023 declaration-emit break under the package's `--declaration` — verify build before applying. Source: Structure auditor + post-fix judgment.
- [ ] [NIT] `register-tools.ts|consistency|inline-import-type` — introspectOpts uses an inline `import("./tools/...").IntrospectPgOptions` annotation, inconsistent with sibling handlers; drop the annotation (inferred from introspectPgSchema) (STRUCT-10). Source: Structure auditor.
- [ ] [MED] `cross-repo-contract-tools.ts|CQ6|consumer-scan-no-file-cap` — scanFiles has no per-repo file-count cap; a 50k-file monorepo reads every .ts in batches of 16 (concurrency bounds latency, not memory). Add MAX_SCAN_FILES_PER_REPO (~2000) + truncation warning (CQ-2). Source: CQ auditor.
- [ ] [LOW] `cross-repo-contract-tools.ts|CQ17|sequential-repo-resolve` — collectGroupData awaits resolver(repo) one at a time across up to 20 repos; parallelize with bounded concurrency (p-limit 4) — resolvers are independent (CQ-3). Source: CQ auditor.
- [ ] [NIT] `cross-repo-outbound-lexer.ts|CQ3|nested-backtick-in-interp` — readTemplateContent tracks "/' inside `${}` but not a nested template literal's backtick; `` `/api/${`${id}`}` `` corrupts raw → false-negative dropped fetch (CQ-4). Source: CQ auditor.
- [ ] [LOW] `index-tools.ts|behavior|snapshot-watcher-cold-start-tax` — saveIncremental (watcher edits) bumps updated_at but not the snapshot; next cold start's staleness guard discards it → full re-parse (BEHAV-4). Correct-and-safe by design; revisit only if cold-start cost matters. Source: Behavior auditor.
- [ ] [MED] `secret-scan-shared.ts|CQ5-FP|scanner-flags-its-own-rule-file` — scan_secrets returns 200 findings on the scanner's OWN source: rule `azuredevopspersonalaccesstoken-2` matches ordinary words (`function`, `endsWith`, `includes`, `basename`) because the file has maximum secret-keyword density and there is no self-exclusion. Makes `review_diff` score 0/fail on any diff touching it, drowning real findings. Fix: exclude the rule-definition files from their own scan, or require higher entropy/length for that rule. Pre-existing on main (NOT from the integration range). Source: lead, verified by executing the masked output (`func***tion`=`function`). (B-5)
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

- [x] **B-1 [structural-refactor (multi-file)]** DONE 2026-08-04. Surface ambiguity on the search path. When
  `resolveSearchHit` (`src/tools/symbol-tools.ts:234`) falls back to the BM25 hit for a colliding id,
  the response says nothing — the same silence `lossy_migration` was added to remove one layer down.
  Recipe: (1) return the collision group from `resolveSearchHit`, (2) thread `ambiguous_id: true` +
  candidate summaries through both tool registrations for `find_and_show` and `get_context_bundle`,
  (3) make the field unconditional, never conditional-on-ambiguity (a conditional shape was the
  earlier BEHAV-class bug in this same file).
- [x] **B-2 [structural-refactor (multi-file)]** DONE 2026-08-04 (27a221f move, 6df1df4 + fbde1f0 + 3056c5c remediation). `src/storage/sqlite-index-store.ts` 1122L -> a 68L re-export facade over 8 modules in `src/storage/sqlite/` (largest 296L). Proven a MOVE, not asserted: bidirectional multiset diff of executable lines gives 677 on each side, 0 lost, 0 gained; an independent adversarial pass compared all 50 top-level declarations and found 0 differences; import-graph cycles identical before and after (5 pre-existing, 0 in src/storage/). The precondition this entry recorded held and is now ASSERTED rather than assumed — `sqliteCtor` lives only in runtime.ts, `connections` only in connection.ts, and tests/storage/sqlite-module-state.test.ts writes each through one module while reading it through another, so a forked copy fails. The audits on the move also surfaced 4 PRE-EXISTING correctness defects in this code, all fixed in follow-up commits with red-first tests; see memory/reviews/2026-08-04-sqlite-index-store-split.md.
- [ ] **B-14 [NIT]** `src/storage/sqlite/accessors.ts:136,163` — `saveIncrementalSqlite` and `removeFileFromIndexSqlite` read `meta.repo` to decide "does an index exist" BEFORE `BEGIN`, so the decision is made outside the transaction it guards — the same check-then-act shape `importLegacyIndexIfEmpty` uses `BEGIN IMMEDIATE` to avoid. Benign TODAY because nothing clears `meta.repo` concurrently, which is why it was left rather than folded into a remediation commit: moving it inside the transaction changes locking on the hottest write path (the postindex hook, one process per edited file) and deserves its own measurement. Source: blind CQ auditor on the B-2 split.
  (>2x the 450L ceiling; 587 non-comment). Extract the read-connection / paging / footprint block,
  mirroring the `index-footprint.ts` extraction already done.
- [ ] **B-3 [NIT]** `indexCacheMemBudgetBytes` (`src/config.ts:76`) duplicates
  `embeddingMemBudgetBytes` (`:53`) — same env-parse + RAM-tier shape. Extract
  `ramTieredBudgetBytes(envVar, tiers)` when a third budget function appears.
- [x] **B-4 [NIT, systemic/pre-existing]** DONE 2026-08-04 (Biome 2.5.7). No meta-linter repo-wide; `"lint"` is `tsc --noEmit`,
  no eslint/biome/oxlint config. Fails CQ40 on every TS file independent of any diff.
- [x] **B-5 [NIT, pre-existing]** DONE 2026-08-04. `openIndexDb` read `schema_version` before taking
  `BEGIN IMMEDIATE` and never re-checks under the lock, so two processes can both run the v1->v2
  migration. Harmless (v2 has no PRIMARY KEY, so the second pass is a redundant copy) but wasteful.
- [ ] **B-6 [pre-carried]** `tests/server/http-session-cwd.test.ts` ECONNRESET flake.

## From review f8979e5..d9e424f (2026-08-04) — IndexSummary / ADR-004 stage 2

- [ ] **B-7 [NIT, pre-existing]** `EXTRACTOR_VERSIONS` (`src/tools/index-shared.ts`) has no entries
  for go, rust, markdown, sql, prisma, swift, dart despite extractors existing for several. This is
  what made R-1's trigger condition reachable.
- [ ] **B-8 [NIT]** `loadIndexSummarySqlite` reads the whole `files` table in one `.all()` with no
  `setImmediate` yield, unlike `readTablePaged`. Harmless while `files` stays orders of magnitude
  smaller than `symbols`; revisit if that stops holding.
- [x] **B-9 [NIT]** DONE 2026-08-04. `summariseIndex`'s `[...index.files]` throws on a malformed index with no
  `files`, and the cache-hit call site is outside `getIndexSummary`'s try/catch. Unreachable via the
  typed path, undefended nonetheless.

## From the CQ audit of f8979e5..d9e424f (returned late; 2026-08-04)

- [x] **B-10 [structural-refactor, CQ14]** DONE 2026-08-04. `loadIndexSqlite` and `loadIndexSummarySqlite` repeat the
  same ~10-line meta-extras block (extractor_version / workspaces / lossy_migration: JSON-parse,
  null-check, assign). Recipe: extract
  `parseIndexMetaExtras(meta: (k: string) => string | undefined): Pick<IndexSummary,
  "extractor_version" | "workspaces" | "lossy_migration">` in `sqlite-index-store.ts` and call it
  from both readers. Deferred rather than done inline: it edits the hot full-load path for a
  maintainability win, which is not a trade to make in the same commit as a correctness fix.
- [x] **B-11 [NIT, CQ25]** DONE 2026-08-04. `loadIndexSummary` has no equivalent of `readIndex`'s `data_version`-aware
  cache, so a repo whose only traffic is `index_status` re-opens a connection every call while its
  `getCodeIndex` sibling is cached. Either add a lightweight summary cache keyed the same way, or
  state the asymmetry in the doc comment — currently it is neither.
- [x] **B-12 [NIT]** DONE 2026-08-04. The line counts quoted in B-2 ("931 raw lines") and in the god-module entry
  ("731L") are stale after this diff: `sqlite-index-store.ts` is ~1100L and `index-store.ts` ~806L.

- [x] **B-13 [NIT]** DONE 2026-08-04 (tests/tools/detect-stack-php.test.ts, 6 tests incl. negatives). `tests/tools/php-tools.test.ts` asserts that `project-profile-stack.ts` contains
  the string `"laravel", "symfony", "yii2"` and calls it Yii2 detection. Biome caught it: the test
  imported `detectStack` and never called it. Renamed to what it actually checks; a real test needs
  a temp dir with a `composer.json` requiring `yiisoft/yii2`, run through `detectStack`.
