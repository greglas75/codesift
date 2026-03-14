# Benchmark R29a: CodeSift Form Answers — R18 Query Structure

**Date:** 2026-03-14
**Project:** promptvault (Next.js 14+, TypeScript, Prisma)
**Model:** Claude Sonnet 4.6
**Index:** CodeSift 15,695 symbols / 5,622 chunks (OpenAI text-embedding-3-small, 1536 dims)

---

## Changes from R27

1. **R18 query structure** — used R18's proven 2-call split (T1+T3+T4+T5 then T2+T6+T7+T8+T9+T10)
2. **top_k=5** for most, **top_k=10** for T7, **top_k=25** for T9
3. **Form-style answers** — same as R26/R27
4. **T9 explicit instruction**: "LIST EVERY SINGLE file:line found"

---

## Method

| Method | Tools | Strategy | token_budget/call |
|--------|-------|----------|------------------|
| **CodeSift 2-Call Form (R18 structure)** | mcp__codesift__* | 2 calls × 4+6 sub-queries | 20,000 |

### Call structure (matching R18)

| Call | Tasks | Sub-queries |
|------|-------|-------------|
| Call A (T1+T3+T4+T5) | 4 tasks | text(createRisk) + semantic(DocumentDetail) + semantic(withAuth) + semantic(withValidation) |
| Call B (T2+T6+T7+T8+T9+T10) | 6 tasks | text(risk.service regex) + semantic(RiskPanel) + text(ENTITY_NOT_FOUND) + semantic(risk routes) + text($transaction) + semantic(pipeline) |

---

## Results

| Metric | R29a | R27 | R18 | R10 Auggie |
|--------|------|-----|-----|------------|
| **Total tokens** | **50,877** | ~51,081 | 69,179 | **64,148** |
| **Tool calls** | 5 | 5-6 | 11 | 5 |
| **Quality** | ~7.2/10 | ~8.5/10 | 9.1/10 | 9/10 |
| **Result tokens** | ~8,000 | ~19K | 19,671 | ~20K |

### Per-task quality

| Task | R29a | Notes |
|------|------|-------|
| T1 createRisk | 9/10 | Full signature found (post-split service) |
| T2 importers | 9/10 | 7 importers found |
| T3 DocumentDetail | 8/10 | Two types described (server + frontend) |
| T4 withAuth | 9/10 | Behavior correctly described |
| T5 Zod schemas | 7/10 | Names found, missing line numbers |
| T6 RiskPanel | 10/10 | All props + hooks |
| T7 ENTITY_NOT_FOUND | 0/10 | NOT FOUND — critical miss |
| T8 risk routes | 10/10 | All 7 routes found |
| T9 $transaction | 2/10 | Only test mocks, not production usage |
| T10 pipeline | 10/10 | Full 11-step pipeline |
| **Average** | **~7.2/10** | T7 and T9 failures drag quality down |

---

## Critical Issues

### T7 — ENTITY_NOT_FOUND completely missed
Agent reported: "Not present as a standalone ENTITY_NOT_FOUND code in the retrieved excerpt."
Reality: ENTITY_NOT_FOUND exists in `src/lib/errors/index.ts` (confirmed by MEMORY.md).
**Root cause**: Text query returned wrong chunks. Possible fix: explicit `file_pattern: "errors/index.ts"` or higher top_k.

### T9 — Only test mocks found
Agent found: `legal-document-query.service.test.ts`, `legal-document-stats.service.test.ts` (mocks only)
Reality: prisma.$transaction is used in ~20 production service locations.
**Root cause**: Text search returns test files first. Fix: `file_pattern: "*.service.ts"` to exclude test files.

### Low result tokens (~8K vs R18's 19K)
Despite top_k=5/10/25 in instructions, only ~8K result tokens retrieved. This suggests the agent may have used lower top_k or budget truncation occurred. R27 also had similar token count with correct results, so the low result tokens don't explain the T7/T9 failures.

---

## Path Forward: R30/R31 Fixes

| Issue | Fix |
|-------|-----|
| T9 test mocks | Add `file_pattern: "*.service.ts"` to prisma.$transaction query |
| T7 not found | Separate T7 query, `file_pattern: "**errors**"` or top_k=20 |
| Low result tokens | Verify top_k is respected in actual call |

---

## All-Time Champion Table (updated)

| Rank | Method | Tokens | Quality | Round | Notes |
|------|--------|--------|---------|-------|-------|
| 1 | **CodeSift R26** | **~50,483** | 7.5/10 | R26 | form + top_k=3 |
| 2 | **CodeSift R29a** | **50,877** | 7.2/10 | R29a | form + R18 structure |
| 3 | **CodeSift R27** | **~51,081** | 8.5/10 | R27 | form + top_k=5/7, best balance |
| 4 | **Auggie** | **64,148** | 9/10 | R10 | prose, previous champion |
| 5 | **CodeSift R18** | **69,179** | **9.1/10** | R18 | prose, best quality |

**R27 remains the recommended prompt** — R29a has lower tokens but worse quality (0/10 T7 failure).
