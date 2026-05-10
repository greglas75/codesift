# Code review — `3d4e52e^..c087544` (2026-05-04)

**Scope:** 3 commits (`3d4e52e`, `4fc8a1c`, `c087544`) | +1316 / −25 | 13 files | **TIER 3 (DEEP)**  
**Intent:** BUGFIX (index stale / extractor tolerance) + release `0.5.27` + FEATURE (multi-language `resolve_constant_value`)  
**Mode:** REPORT (no fixes applied)

## Tool Availability

| Tool / Index | Status | Used For |
|--------------|--------|----------|
| CodeSift MCP | UNAVAILABLE (this Cursor session) | Pre-compute skipped |
| Vitest | OK | Targeted regression on changed tests |
| adversarial-review.sh | OK (claude + cursor-agent; gemini timeout pass 2) | Cross-model findings |

## Verdict

**WARN — merge acceptable; schedule follow-ups for maintainability and edge cases.**

Tests: `38/38` passed (`index-store`, `status-tools`, `constant-resolution-tools`).

## Deployment risk

**MEDIUM** — MCP tool behavior (`index_status` string for STALE), index invalidation semantics, large new TS resolver surface. Recommend full test suite in CI before release (already green on spot checks).

Risk factors: +2 API/contract (MCP responses), +1 >500 LOC, +1 new production module, +1 multi-area blast radius ≈ **5 → HIGH** if counting strictly; cap to **MEDIUM** for internal tooling with good test coverage.

## Findings (merged, deduped)

### RECOMMENDED

- **R-1** — `isExtractorVersionCurrent` vs `findExtractorVersionMismatch` duplicate tolerance logic; delegate to single helper to avoid drift.  
  Confidence: 78/100 · Evidence: both build `indexedLanguages` and skip missing keys the same way.

- **R-2** — `buildNormalizedPathMap` recomputed inside `loadTypeScriptFileContext` per file (O(files × depth)). Memoize on resolution state.  
  Confidence: 76/100 · [CROSS:claude]

- **R-3** — `detectStale` mirrors `getCodeIndex` repo resolution; extract shared `resolveRepoMeta` to prevent divergence.  
  Confidence: 70/100 · [CROSS:claude]

- **R-4** — `detectStale`: wrap `loadIndexOrStale` in try/catch so corrupted JSON does not reject `indexStatus`.  
  Confidence: 72/100 · [CROSS:claude]

- **R-5** — TS constant resolver: `readFile` catch collapses all errors to `null`; narrow to ENOENT or surface error code for debugging.  
  Confidence: 74/100 · [CROSS:cursor-agent]

- **R-6** — `Number(node.text)` for literals risks precision loss / Infinity for very large integers; mark unresolved or bigint path.  
  Confidence: 73/100 · [CROSS:cursor-agent]

- **R-7** — `file_pattern` uses substring `includes`; document or tighten matching (segment/glob) to avoid wrong-language inference.  
  Confidence: 65/100 · [CROSS:cursor-agent]

- **R-8** — Edge case: `extractor_version: {}` with `files: []` yields “current” under new tolerance (all langs skipped). Consider treating empty snapshot as invalid.  
  Confidence: 71/100 · [CROSS:cursor-agent]

- **R-9** — `typescript-constants-tools.ts` ~813 LOC — CQ11 / maintainability; split resolver vs AST helpers vs eval (parity with large `python-constants-tools`).  
  Confidence: 68/100

- **R-10** — Non-relative / tsconfig-path alias imports not resolved; limits monorepo constant tracing — document limitation or extend `tsconfig-paths` integration.  
  Confidence: 62/100 · [CROSS:claude] (note: `tsconfig-paths.ts` improved for dir `index.ts` in this same train — partial infra exists)

### NIT

- **R-11** — `inferLanguages` fallback `["python"]` when no signals — can confuse “wrong language” vs “symbol missing”; consider empty list or explicit `inference: "none"`.  
  Confidence: 58/100 · [CROSS:claude]

- **R-12** — Duplicate `getCodeIndex` load between orchestrator and language resolvers; pass index through if APIs allow.  
  Confidence: 55/100 · [CROSS:cursor-agent]

- **R-13** — Per-request file/AST cache unbounded for deep graphs — cap/LRU if memory becomes an issue.  
  Confidence: 52/100 · [CROSS:cursor-agent]

## Quality wins

1. Regression tests for extractor tolerance and `loadIndexOrStale` “ok” when new language has no files — directly addresses translation-qa style false “NOT INDEXED”.
2. Structured `stale` on `indexStatus` + human-readable STALE line in MCP handler improves agent UX.
3. Integration tests for TS import styles (default, namespace, alias chain) and mixed-repo dual matches.

## Skipped steps

- CodeSift `analyze_hotspots` / `impact_analysis` (MCP not used this session).
- `cq-patterns-core.md` full text not loaded byte-for-byte; gates applied from `quality-gates.md` + checklist summary.

---

`reviewed/3d4e52e`, `reviewed/4fc8a1c`, `reviewed/c087544` tags created on audit completion.
