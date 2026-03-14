# Category C: File Structure — CodeSift vs Bash (UPDATED v2 with compact mode)

**Date:** 2026-03-14
**Project:** promptvault (4127 files, 19573 symbols)

---

## Results Summary

| Metryka | Sift v1 (no compact) | **Sift v2 (compact)** | Bash find/ls |
|---------|----------------------|----------------------|--------------|
| **Tokeny** | 113,542 | **37,471** | 45,489 |
| **Calls** | 10 | **1** | 10 |
| **Czas** | 465s | **21s** | 46s |
| **Output chars** | 716K | **83K** | 18K |

### Final Score: CodeSift v2 vs Bash
- **Tokens: -18%** (37.5K vs 45.5K)
- **Speed: +54%** (21s vs 46s)
- **Calls: -90%** (1 vs 10)

---

## Bugs Fixed
1. **path_prefix rooting** — no ancestor directory wrapping
2. **depth truncation** — now correctly limits depth
3. **name_pattern glob** — multi-wildcard support (`*risk*.test.*`)
4. **compact mode (NEW)** — flat list [{path, symbols}] instead of nested JSON tree
5. **min_symbols filter (NEW)** — server-side filtering, no need to fetch full tree

## Key Impact of compact mode
| Task | v1 chars | **v2 chars** | Reduction |
|------|----------|-------------|-----------|
| C6 (>20 syms) | 543K | **24K** | **22×** |
| C7 (route.ts) | 72K | **9K** | **8×** |
| C9 (repo) | 50K | **33K** | **1.5×** |

## Value Proposition
> **CodeSift file tree with compact mode: 18% fewer tokens, 54% faster than Bash find/ls.** Symbol counts per file included — Bash needs separate wc/grep calls.
