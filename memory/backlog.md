# Review backlog (zuvo:review)

<!-- fingerprint: file|rule|signature -->

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

<!-- zuvo:refactor 2026-07-12 b5fbc75 — project profile split carry-forward -->
- [ ] [MED] `project-profile-stack.ts|CQ11|legacy-stack-complexity` — detectStack remains a large legacy helper after verbatim extraction; split framework, workspace, and build-tool phases in a follow-up. Source: independent CQ auditor.
- [ ] [MED] `project-profile-nest.ts|CQ11|legacy-nest-complexity` — Nest convention parsing remains over the utility/function limit after verbatim extraction; split module/provider and middleware parsing in a follow-up. Source: independent CQ auditor.
- [ ] [MED] `project-profile-summary.ts|CQ11|summary-dispatch-complexity` — buildConventionsSummary remains high-complexity; use table/handler dispatch in a follow-up. Source: independent CQ auditor.
- [ ] [MED] `project-profile-stack.ts|CQ17|serial-workspace-reads` — workspace package and tsconfig reads remain sequential; parallelize with bounded concurrency in a follow-up. Source: independent CQ auditor.
- [ ] [MED] `project-profile-extractors.ts|CQ17|serial-convention-reads` — test setup and sample convention reads remain sequential; parallelize safely in a follow-up. Source: independent CQ auditor.
- [ ] [MED] `project-tools.ts|CQ23|analyze-cache-ttl` — analyzeProject's process-global cache lacks TTL/eviction; inherited untouched behavior and outside this stack/convention split. Source: independent CQ auditor.
- [ ] [MED] `project-profile-extractors.ts|coverage|git-health-test` — extractGitHealth lacks a direct scoped characterization test. Source: independent CQ auditor.
- [ ] [MED] `project-tools.ts|coverage|extractor-error-path` — analyzeProject's partial `*_extractor_error` path lacks a direct scoped characterization test. Source: independent CQ auditor.

<!-- zuvo:refactor 2026-07-14 30fcbea..47f3216 — core tool groups -->
- [ ] [MED] `registry.ts|CQ6|invalidate-cache-auto-repo` — `invalidate_cache` advertises optional repository auto-detection, but `invalidateCache` looks up the raw undefined key. Resolve through `resolveRegisteredRepoMeta` in the index registry; deferred because the implementation is outside this refactor's registration scope. Source: adversarial review.

<!-- zuvo:review 2026-07-14 8ebe14b..77e76f1 — all refactor commits -->
- [ ] [LOW] `formatters-nextjs.ts|CQ11|domain-formatter-size` — [below-threshold, 46/100] 449-line Next.js formatter domain still contains three >50-line formatters. Resolution recipe: (1) extract component/route formatters, (2) extract audit/diagnostic formatters, (3) retain `formatters-nextjs.ts` as the domain export facade and verify dispatch characterization tests. Defer-reason: [structural-refactor (multi-file)]. Source: confidence-rescored review.
