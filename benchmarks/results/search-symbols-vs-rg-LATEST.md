# search_symbols vs rg — Benchmark Results

**Date:** 2026-03-29
**Repos:** codesift-mcp, translation-qa, promptvault
**Queries:** 10 real symbol search patterns
**Metric:** tool output tokens (chars/4) + wall clock time

---

## Per-Repo Results

### codesift-mcp

| Query | rg tokens | sift tokens | diff | rg ms | sift ms | rg results | sift results |
|-------|-----------|-------------|------|-------|---------|------------|--------------|
| S01 searchText (function) | 665 | 1,880 | +183% | 25 | 199 | 28 | 10 |
| S02 create (function) | 914 | 1,258 | +38% | 18 | 9 | 39 | 7 |
| S03 Config (interface) | 1,897 | 363 | **-81%** | 18 | 10 | 83 | 3 |
| S04 Service (class) | 1,294 | 137 | **-89%** | 18 | 9 | 55 | 1 |
| S05 handle | 3,820 | 1,613 | **-58%** | 17 | 11 | 174 | 10 |
| S06 use (function) [*.tsx] | 0 | 1 | n/a | 21 | 9 | 0 | 0 |
| S07 Props (type) | 0 | 1 | n/a | 19 | 8 | 0 | 0 |
| S08 processPayment (function) | 3,712 | 1,454 | **-61%** | 17 | 9 | 153 | 10 |
| S09 validate (function) | 123 | 457 | +272% | 24 | 21 | 4 | 3 |
| S10 export [*.service.ts] | 0 | 1 | n/a | 17 | 8 | 0 | 0 |
| **TOTAL** | **12,425** | **7,165** | **-42%** | **194** | **295** | | |

### translation-qa

| Query | rg tokens | sift tokens | diff | rg ms | sift ms | rg results | sift results |
|-------|-----------|-------------|------|-------|---------|------------|--------------|
| S01 searchText (function) | 0 | 1,699 | n/a | 185 | 4,456 | 0 | 10 |
| S02 create (function) | 41,588 | 1,672 | **-96%** | 113 | 424 | 1,610 | 10 |
| S03 Config (interface) | 27,545 | 1,322 | **-95%** | 95 | 476 | 1,048 | 10 |
| S04 Service (class) | 17,543 | 1,488 | **-92%** | 100 | 416 | 702 | 10 |
| S05 handle | 9,942 | 1,620 | **-84%** | 94 | 499 | 378 | 10 |
| S06 use (function) [*.tsx] | 373 | 1,641 | +340% | 57 | 500 | 12 | 9 |
| S07 Props (type) | 5,876 | 515 | **-91%** | 107 | 400 | 218 | 4 |
| S08 processPayment (function) | 0 | 1,994 | n/a | 95 | 491 | 0 | 10 |
| S09 validate (function) | 2,454 | 1,783 | **-27%** | 97 | 390 | 66 | 10 |
| S10 export [*.service.ts] | 13,354 | 1,838 | **-86%** | 61 | 395 | 369 | 8 |
| **TOTAL** | **118,675** | **15,572** | **-87%** | **1,004** | **8,447** | | |

### promptvault

| Query | rg tokens | sift tokens | diff | rg ms | sift ms | rg results | sift results |
|-------|-----------|-------------|------|-------|---------|------------|--------------|
| S01 searchText (function) | 0 | 1,745 | n/a | 56 | 792 | 0 | 10 |
| S02 create (function) | 34,265 | 1,754 | **-95%** | 71 | 44 | 1,221 | 10 |
| S03 Config (interface) | 8,111 | 545 | **-93%** | 38 | 47 | 263 | 4 |
| S04 Service (class) | 0 | 1 | n/a | 40 | 44 | 0 | 0 |
| S05 handle | 1,385 | 1,385 | 0% | 37 | 46 | 49 | 10 |
| S06 use (function) [*.tsx] | 204 | 1,464 | +618% | 26 | 45 | 5 | 6 |
| S07 Props (type) | 1,342 | 311 | **-77%** | 39 | 46 | 47 | 3 |
| S08 processPayment (function) | 0 | 1,813 | n/a | 36 | 52 | 0 | 10 |
| S09 validate (function) | 613 | 1,691 | +176% | 48 | 115 | 15 | 10 |
| S10 export [*.service.ts] | 14,838 | 154 | **-99%** | 30 | 45 | 377 | 1 |
| **TOTAL** | **60,758** | **10,863** | **-82%** | **421** | **1,276** | | |

---

## Grand Summary

| Metric | rg (ripgrep) | search_symbols | Difference |
|--------|-------------|----------------|------------|
| **Total output tokens** | 191,858 | 33,600 | **-82% (158,258 tokens saved)** |
| **Total time** | 1,619 ms | 10,018 ms | **+519% (sift is 6.2x slower)** |
| **Sift wins (fewer tokens)** | | **15 / 30** | |
| **rg wins (fewer tokens)** | | **14 / 30** | |
| **Ties** | | **1 / 30** | |

## Why search_symbols wins on large repos

- BM25 ranking + top_k cap (default 10 with source) vs rg returning ALL matching lines
- S02 "create (function)": rg returns 1,610 lines (41K tok), search_symbols returns top 10 ranked results (1.7K tok)
- On medium/large repos, rg regex for function definitions matches hundreds of lines

## Why rg wins on small results

- When rg finds <10 matches, its raw text output is smaller than search_symbols JSON (which includes source code, signatures, scores)
- S09 "validate": rg finds 4 lines (123 tok), search_symbols returns 3 results with source (457 tok)
- search_symbols includes `include_source=true` by default — each result has the full function body

## Key difference from search_text

search_symbols returns **structured symbol data** (name, kind, file, line, signature, source) — not just text matches. An agent using rg would need follow-up Read calls to get the same context, adding more tokens not counted here.

---

**Raw data:** `benchmarks/results/search-symbols-vs-rg-2026-03-29T16-11-40.json`
**Benchmark script:** `benchmarks/search-symbols-vs-grep.ts`
