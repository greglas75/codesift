# Code review: fc4866b..803f259 (15729ad → acead75 → 803f259)

## Tool Availability

| Tool / Index       | Status                         | Used For        |
|--------------------|--------------------------------|-----------------|
| CodeSift MCP       | UNAVAILABLE (Cursor session)   | —               |
| Vitest             | OK (22/22 targeted tests)      | verification    |
| adversarial-review | OK (codex-5.3, 2 passes)       | cross-review    |

## META

- **Scope:** `git diff fc4866b..803f259` — 13 files, +582/-5 (noise excluded: none material beyond lockfile in stat).
- **Commits (chronological):** `15729ad` TS import extractor → `acead75` get-tsconfig dep → `803f259` tsconfig paths resolver.
- **Important:** At tip `803f259`, `extractTypeScriptImports` / `resolveTsAliasedImport` are **not yet referenced from production code** (`import-graph.ts` unchanged in this range); integration is deferred to later tasks in the 19-task series.

```
===============================================================
CODE REVIEW | TIER 3 (DEEP — inline; >500 LOC insertion total)
SCOPE:  13 files, +582/-5 | INTENT: FEATURE (AST imports + path resolver)
AUDIT:  SOLO | Adversarial: codex-5.3 ×2 | RISK: LOW
Risk signals: [ ] API  [ ] DB  [ ] Auth  [ ] Money  [x] 500+L (total diff)
===============================================================
```

## VERDICT

**WARN** — one adversarial CRITICAL finding on absolute import specifiers warrants hardening before trusting resolver output across arbitrary repos; remaining items are coverage and ergonomics.

## DEPLOYMENT RISK

**LOW** — utilities + tests + fixtures only in this slice; no runtime route/auth/db changes. Risk rises once wired into `import-graph` without fixing absolute-path handling.

## SEVERITY SUMMARY

| Tier        | Count |
|-------------|------:|
| MUST-FIX    | 1 |
| RECOMMENDED | 6 |
| NIT         | 2 |

## CHANGE SUMMARY

- Adds `src/utils/ts-imports.ts`: tree-sitter walk for `import_statement` / `export_statement` with `is_type_only` heuristics (incl. empty `{}` named imports).
- Adds `src/utils/tsconfig-paths.ts`: `get-tsconfig` + dual cache, `resolveTsAliasedImport`, `clearTsconfigCache`, file-vs-dir probing for path aliases.
- Adds `get-tsconfig` dependency in `package.json`.
- Adds monorepo fixture under `tests/fixtures/tsconfig-monorepo/` and Vitest coverage.

## SKIPPED STEPS

- CodeSift pre-compute (hotspots, impact_analysis): MCP unavailable.
- CQ Auditor / Behavior subagents: Cursor sequential mode — covered inline.
- Third adversarial pass: passes 1–2 yielded actionable deltas; stopped per token budget.

## VERIFICATION PASSED

```text
npx vitest run tests/utils/ts-imports.test.ts tests/parser/tsconfig-paths.test.ts
✓ 22 tests passed
```

## FINDINGS

### MUST-FIX

**R-1** [CROSS:codex-5.3] Absolute import specifiers can bypass intended alias resolution boundaries  
- **File:** `src/utils/tsconfig-paths.ts` (`resolveTsAliasedImport`)  
- **Confidence:** 95/100 (effective 100 per adversarial CRITICAL rule)  
- **Evidence:** Only `importPath.startsWith(".")` is rejected; `join(baseUrl, "/abs/path")` resolves to an absolute path on Node, so `probeFile` may return filesystem paths outside `repoRoot` if such files exist.  
- **Fix:** Reject `isAbsolute(importPath)` early; after resolution, require resolved path is under `resolve(repoRoot)` (segment-safe prefix), else return `null`.

### RECOMMENDED

**R-2** [CROSS:codex-5.3] `dirToConfigCache` keyed by `dir` only — wrong tsconfig if the same absolute directory is analyzed under different `repoRoot` values in one long-lived process. Include `repoRoot` in the cache key.

**R-3** [CROSS:codex-5.3] `TS_EXTENSIONS` omits `.mts`, `.cts`, `.mjs`, `.cjs` (and optional `.json`) — legitimate aliased targets may not resolve.

**R-4** [CROSS:codex-5.3] No handling for `import = require('...')` / `export =` / legacy TS export forms — dependency graph gaps for CommonJS-interop files.

**R-5** [CROSS:codex-5.3] Per-specifier `export { type X } from 'y'` not distinguished — may over-count runtime re-exports vs statement-level `export type`.

**R-6** [CROSS:codex-5.3] `import { type A } from 'mod'` marked type-only — under `verbatimModuleSyntax` runtime edges may still exist; document limitation or align with compiler options if available.

**R-7** **Integration gap (series context):** This commit range does not call the new helpers from `import-graph.ts`; acceptable for Task 3–5 slicing but increases drift risk until a later task lands wiring.

### NIT

**R-8** Test name promises “warns” on malformed tsconfig but does not assert `console.warn` (observability of failure mode).

**R-9** First-pass adversarial “repo prefix `/repo` vs `/repo2`” concern does not match current `relative()`-based containment check — dismissed.

## QUALITY WINS

1. Explicit regression for `import { } from "y"` remaining **runtime** (avoids silent drop from circular-deps logic).
2. `probeFile` + `statSync().isFile()` documents and tests directory-vs-`index.ts` ambiguity (`@components/Button`).
3. Parse failures intentionally **not** cached — good recovery UX when users fix broken tsconfig mid-session.

## TEST ANALYSIS

- Strong behavioral coverage for core import/export shapes and monorepo fixture paths.
- Gaps: absolute specifier rejection (R-1), multi-repo cache key (R-2), extra extensions (R-3), legacy import/export syntax (R-4).

---

**Classification printed:** `[CLASSIFIED] Diff type: mixed`

## PHASE 1 — LOADED

| Include | Status |
|---------|--------|
| codesift-setup.md | READ |
| env-compat.md | READ (partial) |
| quality-gates.md | READ (CQ + Q sections) |
| cross-provider-review.md | READ (partial) |
| cq-patterns*.md | SKIP (inline CQ) |
| cq-checklist.md | SKIP |
| testing.md | SKIP (skill path missing at repo `.codex`; gates from quality-gates) |
| security.md | SKIP (no auth/secrets in diff) |
| knowledge-prime/curate | SKIP (no knowledge\*.md) |
