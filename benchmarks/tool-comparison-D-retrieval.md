# Category D: Targeted Retrieval — CodeSift get_symbol vs Read

**Date:** 2026-03-14
**Project:** promptvault (4127 files, 19573 symbols)

---

## Results Summary

| Metryka | CodeSift | **grep+Read** | Winner |
|---------|----------|--------------|--------|
| **Tokeny** | ~72K (est.) | **60,482** | **Bash -16%** |
| **Calls** | 32 | **29** | Bash fewer |
| **Czas** | >300s | **115s** | **Bash 2.6× faster** |

### grep+Read wins on targeted retrieval.

---

## Why CodeSift Loses on D

Each CodeSift retrieval requires **2+ steps**: search (find symbol ID) → get_symbol (retrieve body). grep+Read needs the same 2 steps: grep (find line) → Read (get body).

The overhead is similar, but CodeSift has additional friction:

| Issue | Impact | Tasks affected |
|-------|--------|----------------|
| Test case IDs = undefined | Can't get_symbol, need full suite | D8 |
| Prisma files not indexed | Fallback to searchText | D9 |
| Kind filter needed for precision | Retry required | D6 |
| Search returns noise | Extra filtering | D7 |

## Where CodeSift DOES add value (retrieval)

1. **Batch get_symbols** — retrieve 3-5 symbols from different files in 1 call (D3, D7, D10)
2. **Symbol body boundaries** — returns exactly the function body, not arbitrary line ranges
3. **No line number math** — grep+Read needs offset+limit calculation; get_symbol knows boundaries

## Bugs to Fix

1. **Test case IDs undefined** — test_case symbols should have valid IDs for get_symbol
2. **Prisma grammar** — add .prisma file support or at least basic text extraction
3. **search_symbols noise** — test fixtures ranking above production code

## Value Proposition

> **CodeSift get_symbol: precise symbol boundaries without line number math.** Batch retrieval (get_symbols) is genuinely useful for cross-file reads. But for single-file reads, grep+Read is simpler and cheaper.
