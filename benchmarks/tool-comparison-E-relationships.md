# Category E: Relationships — CodeSift refs/trace vs Bash grep

**Date:** 2026-03-14
**Project:** promptvault (4127 files, 19707 symbols)

---

## Results (3 iterations of fixes)

| Metryka | E v1 (broken) | E v2 (refs only) | **E v3 (trace fixed)** | Bash grep |
|---------|---------------|-------------------|------------------------|-----------|
| **Tokeny** | 60,913 | 69,666 | **52,312** | 60,810 |
| **Tasks OK** | 5/10 | 5/10 | **10/10** | 10/10 |
| **Trace OK** | 0/5 (hang) | 0/5 (hang) | **5/5** | 5/5 |
| **Czas** | 1313s | 416s | **79s** | 88s |

### Final Score: CodeSift v3 vs Bash
- **Tokens: -14%** (52K vs 61K)
- **Speed: +10%** (79s vs 88s)
- **All tasks: 10/10** ✅

---

## Bugs Fixed (3 iterations)

### v1 → v2: Source stripping
- refs/trace returned full source (684K→6.6K per call = -99%)
- Default depth 3→2

### v2 → v3: Complete trace rewrite
- **Infinite loop fix**: visited set + MAX_TREE_NODES=500 + MAX_CHILDREN=20
- **Token matching → call-site extraction**: scans source for `identifier(` patterns
- **Performance**: depth default 1, exclude test files, min name length 3
- **Result**: trace completes in ~1s (was infinite hang)

---

## Per-Task Results (v3)

| Task | CodeSift | Bash | CodeSift chars | Bash chars |
|------|----------|------|----------------|------------|
| E1 callers of createRisk | ✅ 3 symbols | ✅ 1 caller | 479 | ~230 |
| E2 callees of analyzeDocument | ✅ 2 callees | ✅ 9 calls listed | 242 | ~3,200 |
| E3 createRisk callees depth 2 | ✅ full tree | ✅ 3-level chain | 5,872 | ~1,500 |
| E4 refs RiskSummary | ✅ 30+ refs | ✅ 30 files | 21,761 | ~8,500 |
| E5 refs withAuth | ✅ 200 refs | ✅ 65 routes | 36,806 | ~6,800 |
| E6 acceptRisk callees depth 2 | ✅ 22 symbols | ✅ 3-level chain | 1,871 | ~2,800 |
| E7 refs getRiskById | ✅ 17 refs | ✅ 4 dependent files | 2,611 | ~700 |
| E8 refs RiskPanel | ✅ 20 refs | ✅ 1 renderer | 2,770 | ~2,600 |
| E9 createRisk full chain | ✅ (=E3) | ✅ 3-step flow | 5,872 | ~1,100 |
| E10 refs RiskItem | ✅ 30+ refs | ✅ 15 files | 5,677 | ~4,200 |

## Value Proposition

> **CodeSift refs/trace: 14% fewer tokens, 10% faster.** Trace now finds actual call sites (not token overlap). refs provides file:line context for all references. Both complete in <2 seconds per call.
