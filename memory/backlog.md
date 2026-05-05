# Review backlog (zuvo:review)

<!-- fingerprint: file|rule|signature -->

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
