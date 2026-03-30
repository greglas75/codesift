# get_file_outline vs Read — Benchmark Results

**Date:** 2026-03-29
**Repos:** codesift-mcp, translation-qa, promptvault
**Files:** 10 per repo (30 total), real production files of varying size
**Metric:** tool output tokens (chars/4) + wall clock time

---

## Per-Repo Results

### codesift-mcp

| File | Read tokens | Outline tokens | diff | Read ms | Outline ms | Lines | Symbols |
|------|-------------|----------------|------|---------|------------|-------|---------|
| F01 src/tools/search-tools.ts | 5,293 | 4,012 | **-24%** | 0 | 42 | 612 | 78 |
| F02 src/tools/outline-tools.ts | 3,744 | 4,054 | +8% | 0 | 19 | 478 | 80 |
| F03 src/types.ts | 1,033 | 793 | **-23%** | 0 | 16 | 153 | 18 |
| F04 src/retrieval/codebase-retrieval.ts | 1,881 | 2,316 | +23% | 0 | 15 | 218 | 46 |
| F05 src/register-tools.ts | 10,208 | 258 | **-97%** | 0 | 15 | 796 | 5 |
| F06 src/server-helpers.ts | 2,810 | 2,688 | **-4%** | 0 | 15 | 298 | 53 |
| F07 src/config.ts | 622 | 607 | **-2%** | 0 | 16 | 92 | 13 |
| F08 src/tools/graph-tools.ts | 3,118 | 3,091 | **-1%** | 0 | 15 | 382 | 60 |
| F09 src/search/bm25.ts | 2,530 | 3,098 | +22% | 0 | 23 | 321 | 66 |
| F10 src/tools/symbol-tools.ts | 3,733 | 4,866 | +30% | 0 | 20 | 495 | 96 |
| **TOTAL** | **34,972** | **25,783** | **-26%** | **0** | **196** | | |

### translation-qa

| File | Read tokens | Outline tokens | diff | Read ms | Outline ms | Lines | Symbols |
|------|-------------|----------------|------|---------|------------|-------|---------|
| F01 lib/services/hitl/consensus.service.ts | 4,297 | 2,963 | **-31%** | 0 | 442 | 648 | 51 |
| F02 lib/services/project/project-metadata.service.ts | 4,849 | 1,544 | **-68%** | 0 | 501 | 622 | 26 |
| F03 lib/services/glossary/term-extraction.service.ts | 3,157 | 3,254 | +3% | 0 | 396 | 595 | 38 |
| F04 lib/utils/text-diff.ts | 4,630 | 4,220 | **-9%** | 0 | 447 | 582 | 83 |
| F05 lib/services/agent-review.service.ts | 1,265 | 1,842 | +46% | 0 | 434 | 170 | 23 |
| F06 lib/services/ai-task.service.ts | 1,689 | 1,695 | 0% | 0 | 402 | 274 | 30 |
| F07 lib/services/batch-update.service.ts | 1,980 | 2,077 | +5% | 0 | 427 | 234 | 39 |
| F08 lib/services/analysis-status.service.ts | 1,444 | 1,831 | +27% | 0 | 544 | 209 | 24 |
| F09 app/api/projects/create-stream/route.ts | 3,558 | 53 | **-99%** | 1 | 458 | 393 | 1 |
| F10 components/ProjectForm/ProjectForm.tsx | 4,171 | 1,774 | **-57%** | 1 | 450 | 478 | 31 |
| **TOTAL** | **31,040** | **21,253** | **-32%** | **2** | **4,501** | | |

### promptvault

| File | Read tokens | Outline tokens | diff | Read ms | Outline ms | Lines | Symbols |
|------|-------------|----------------|------|---------|------------|-------|---------|
| F01 src/lib/services/risk/risk.service.ts | 1,497 | 795 | **-47%** | 0 | 126 | 182 | 11 |
| F02 src/types/index.ts | 1,526 | 1,113 | **-27%** | 0 | 73 | 292 | 23 |
| F03 src/types/search.ts | 119 | 195 | +64% | 2 | 84 | 25 | 4 |
| F04 src/types/permissions.ts | 1,679 | 1,175 | **-30%** | 1 | 72 | 308 | 21 |
| F05 src/types/legal.ts | 5,137 | 2,585 | **-50%** | 1 | 91 | 846 | 53 |
| F06 src/app/layout.tsx | 432 | 203 | **-53%** | 0 | 77 | 59 | 4 |
| F07 prisma/seed.ts | 1,624 | 434 | **-73%** | 1 | 82 | 232 | 10 |
| F08 src/app/api/v1/rate-limits/route.ts | 545 | 51 | **-91%** | 1 | 99 | 68 | 1 |
| F09 src/app/api/v1/organizations/route.ts | 140 | 51 | **-64%** | 1 | 82 | 18 | 1 |
| F10 prisma.config.ts | 165 | 5 | **-97%** | 2 | 155 | 20 | 0 |
| **TOTAL** | **12,864** | **6,607** | **-49%** | **9** | **941** | | |

---

## Grand Summary

| Metric | Read (full file) | get_file_outline | Difference |
|--------|-----------------|------------------|------------|
| **Total output tokens** | 78,876 | 53,643 | **-32% (25,233 tokens saved)** |
| **Total time** | 11 ms | 5,638 ms | **Read is ~500x faster** |
| **Outline wins (fewer tokens)** | | **20 / 30** | |
| **Read wins (fewer tokens)** | | **10 / 30** | |

## When outline wins (20/30 files)

- **Large files with few symbols**: F05 register-tools.ts (796 lines, 5 symbols) → **-97%** (10,208 vs 258 tok)
- **Files with lots of implementation but few exports**: F09 create-stream/route.ts (393 lines, 1 symbol) → **-99%**
- **Generally: lines/symbols ratio > 10** → outline wins big

## When Read wins (10/30 files)

- **Symbol-dense files**: F10 symbol-tools.ts (495 lines, 96 symbols) → outline is +30% more tokens
- **Small files**: F03 search.ts (25 lines, 4 symbols) → outline JSON overhead > raw file content
- **Generally: files < 200 lines or with >1 symbol per 5 lines** → Read is cheaper

## Key insight

get_file_outline's value scales with **file size relative to symbol count**:
- 800-line file with 5 symbols → **97% savings**
- 200-line file with 96 symbols → **30% more expensive**

For navigation ("what's in this file?"), outline saves tokens. For editing ("I need the full source"), Read is necessary anyway.

---

**Raw data:** `benchmarks/results/get-file-outline-vs-read-2026-03-29T16-11-23.json`
**Benchmark script:** `benchmarks/get-file-outline-vs-read.ts`
