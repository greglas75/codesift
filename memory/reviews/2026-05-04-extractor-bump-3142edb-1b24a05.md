# Code review: 3142edb^..1b24a05

**Scope:** Three commits — TS extractor `3.0.0` version bump, CHANGELOG entry, review fixes (tsconfig cache, path normalization, language-aware stale index messaging).

**Tool availability**

| Tool / Index | Status | Used For |
|--------------|--------|----------|
| CodeSift MCP | UNAVAILABLE (Cursor session; native git/read) | N/A |
| adversarial-review.sh | OK | 2 sequential `--rotate` passes |
| vitest | OK | `index-store`, `_helpers`, `ts-imports` |

**Verdict:** **MERGE OK** with follow-ups (no release-blocking defects in this slice; several correctness/UX items warrant backlog).

**Deployment risk:** **LOW–MEDIUM** — `EXTRACTOR_VERSIONS.typescript` → `3.0.0` forces reindex (documented). Stale-index warnings improved; partial `loadIndex` migration remains per CHANGELOG.

---

## Findings (merged, deduplicated)

### MUST-FIX

— None confirmed after lead review. Adversarial **CRITICAL** on `import { }` vs `is_type_only` downgraded to **RECOMMENDED**: behavior largely pre-exists; this diff adds a regression test that locks questionable semantics (see R-1).

### RECOMMENDED

- **R-1** [RECOMMENDED] `tests/utils/ts-imports.test.ts` — Empty `import { } from "./y"` is asserted `is_type_only: true`, but ES modules still evaluate the target for side effects; `find_circular_deps` excludes `type_only` edges → possible false negatives. [CROSS:cursor-agent] Confidence 72/100 — Align contract: treat as runtime module edge for graph purposes, or add a separate `loads_module` (or similar) flag; do not encode the weak contract in a new test without that design pass.
- **R-2** [RECOMMENDED] `src/utils/import-graph.ts` — `relative(root, aliased)` assumes resolved paths stay under `index.root`; differs from prior `startsWith` guard. Confidence 65/100 — Reconcile with explicit subpath check when aliases resolve outside root.
- **R-3** [RECOMMENDED] `src/utils/tsconfig-paths.ts` — `cur.startsWith(repoRootAbs)` is a string prefix containment check. Confidence 58/100 — Prefer normalized path containment (case / drive / UNC). [CROSS:cursor-agent]
- **R-4** [RECOMMENDED] `src/utils/tsconfig-paths.ts` — Negative `dirToConfigCache` now fills **all visited ancestors** with `null`; if `tsconfig.json` appears later, discovery can stay wrong until `clearTsconfigCache()` / restart. Confidence 70/100 — Narrow negative caching or invalidate on watcher. [CROSS:cursor-agent]
- **R-5** [RECOMMENDED] `src/utils/tsconfig-paths.ts` — Success path caches config path for **all ancestors**; delete/replace `tsconfig` can leave stale absolute paths across more directories than before. Confidence 62/100 — Revalidate or narrow cache. [CROSS:cursor-agent]
- **R-6** [RECOMMENDED] `src/tools/index-tools.ts` — `clearTsconfigCache()` only on exact `tsconfig.json`. Confidence 68/100 — Extend to `tsconfig.*.json` / `jsconfig.json` patterns used in monorepos. [CROSS:cursor-agent]
- **R-7** [RECOMMENDED] Deferred work already noted in CHANGELOG — Many call sites still use `loadIndex` and stay silent on extractor skew; inconsistent UX vs `getCodeIndex`. Track Task 16 / centralize reads.

### NIT

- **R-8** `src/storage/index-store.ts` — Only first language mismatch reported in iteration order; multi-bump ops see incomplete picture. Confidence 45/100.
- **R-9** `src/storage/index-store.ts` — `findExtractorVersionMismatch` ignores extra keys in stored `extractor_version` not in `currentVersions`. Confidence 40/100.
- **R-10** `src/parser/extractors/typescript.ts` — `replace(/\s+/g, "")` on heritage `node.text` is pragmatic but less robust than structured member walk. Confidence 50/100.

## Quality wins (max 3)

1. **Language-aware stale payloads** — `loadIndexOrStale` + `staleToMcpError` now name the mismatching extractor language instead of implying TypeScript-only.
2. **Import-graph path normalization** — `path.relative` + POSIX join fixes cross-platform edge keys vs string slicing.
3. **Tsconfig parse failure not cached** — Malformed `tsconfig` can recover mid-session without waiting for full `index_folder`.

## Test analysis

Vitest (scoped): `tests/storage/index-store.test.ts`, `tests/tools/_helpers.test.ts`, `tests/utils/ts-imports.test.ts` — **42/42 passed**.

**Concern:** R-1 — new test documents `is_type_only` for empty `{}`; verify against intended meaning of `type_only` in `find_circular_deps` before treating as stable contract.

## Skipped steps

- CodeSift pre-compute (`search_patterns`, `analyze_complexity`, `impact_analysis`) — not run; native review only.
- Confidence Re-Scorer sub-agent — TIER 2 lead inline scoring used.
- `analyze_hotspots` — not run; deploy risk scored without hotspot +2.
