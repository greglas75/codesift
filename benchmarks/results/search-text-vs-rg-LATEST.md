# search_text vs rg — Benchmark Results

**Date:** 2026-03-29
**Repos:** codesift-mcp, translation-qa, promptvault (3 repos, small/medium/large)
**Queries:** 10 real search patterns from production usage data
**Metric:** tool output tokens (chars/4) + wall clock time

---

## Per-Repo Results

### codesift-mcp (small repo)

| Query | rg tokens | sift tokens | diff | rg ms | sift ms | rg results | sift results |
|-------|-----------|-------------|------|-------|---------|------------|--------------|
| Q01 TODO [*.ts] | 228 | 189 | **-17%** | 16 | 96 | 5 | 5 |
| Q02 import [*.ts] | 24,624 | 1,548 | **-94%** | 19 | 28 | 769 | 26 |
| Q03 export default [*.ts] | 54 | 38 | **-30%** | 16 | 25 | 2 | 2 |
| Q04 console.log | 51,208 | 1,520 | **-97%** | 17 | 27 | 144 | 20 |
| Q05 async function | 61,975 | 3,211 | **-95%** | 21 | 27 | 234 | 58 |
| Q06 throw new Error [src/**] | 2,275 | 1,387 | **-39%** | 15 | 49 | 67 | 26 |
| Q07 useState [*.tsx] | 0 | 1 | n/a | 22 | 23 | 0 | 0 |
| Q08 process.env [*.ts] | 1,592 | 858 | **-46%** | 17 | 47 | 51 | 16 |
| Q09 export (GET\|POST\|PUT\|DELETE) | 68 | 53 | **-22%** | 16 | 26 | 2 | 2 |
| Q10 catch\s*\( [*.ts] | 1,165 | 793 | **-32%** | 17 | 25 | 48 | 48 |
| **TOTAL** | **143,189** | **9,598** | **-93%** | **177** | **373** | | |

### translation-qa (medium repo)

| Query | rg tokens | sift tokens | diff | rg ms | sift ms | rg results | sift results |
|-------|-----------|-------------|------|-------|---------|------------|--------------|
| Q01 TODO [*.ts] | 1,363 | 1,066 | **-22%** | 116 | 472 | 36 | 36 |
| Q02 import [*.ts] | 436,072 | 3,335 | **-99%** | 77 | 568 | 11,931 | 65 |
| Q03 export default [*.ts] | 588 | 398 | **-32%** | 70 | 402 | 23 | 23 |
| Q04 console.log | 71,228 | 1,413 | **-98%** | 143 | 518 | 2,169 | 20 |
| Q05 async function | 46,537 | 4,711 | **-90%** | 166 | 526 | 1,308 | 94 |
| Q06 throw new Error [src/**] | 0 | 1 | n/a | 38 | 384 | 0 | 0 |
| Q07 useState [*.tsx] | 33,551 | 2,539 | **-92%** | 54 | 445 | 941 | 46 |
| Q08 process.env [*.ts] | 15,418 | 3,368 | **-78%** | 81 | 660 | 482 | 66 |
| Q09 export (GET\|POST\|PUT\|DELETE) | 0 | 1 | n/a | 113 | 564 | 0 | 0 |
| Q10 catch\s*\( [*.ts] | 38,502 | 5,108 | **-87%** | 78 | 381 | 1,400 | 122 |
| **TOTAL** | **643,259** | **21,940** | **-97%** | **936** | **4,920** | | |

### promptvault (large repo)

| Query | rg tokens | sift tokens | diff | rg ms | sift ms | rg results | sift results |
|-------|-----------|-------------|------|-------|---------|------------|--------------|
| Q01 TODO [*.ts] | 76 | 50 | **-34%** | 36 | 182 | 2 | 2 |
| Q02 import [*.ts] | 133,751 | 2,396 | **-98%** | 32 | 116 | 3,283 | 45 |
| Q03 export default [*.ts] | 166 | 89 | **-46%** | 30 | 96 | 6 | 6 |
| Q04 console.log | 6,562 | 1,555 | **-76%** | 39 | 99 | 179 | 25 |
| Q05 async function | 19,495 | 3,452 | **-82%** | 37 | 99 | 501 | 68 |
| Q06 throw new Error [src/**] | 0 | 1 | n/a | 18 | 78 | 0 | 0 |
| Q07 useState [*.tsx] | 14,371 | 2,653 | **-82%** | 27 | 125 | 341 | 48 |
| Q08 process.env [*.ts] | 5,786 | 1,436 | **-75%** | 28 | 96 | 162 | 25 |
| Q09 export (GET\|POST\|PUT\|DELETE) | 0 | 1 | n/a | 46 | 114 | 0 | 0 |
| Q10 catch\s*\( [*.ts] | 13,002 | 4,037 | **-69%** | 36 | 139 | 359 | 88 |
| **TOTAL** | **193,209** | **15,670** | **-92%** | **329** | **1,144** | | |

---

## Grand Summary

| Metric | rg (ripgrep) | search_text | Difference |
|--------|-------------|-------------|------------|
| **Total output tokens** | 979,657 | 47,208 | **-95% (932,449 tokens saved)** |
| **Total time** | 1,441 ms | 6,437 ms | **+347% (sift is 4.5x slower)** |
| **Sift wins (fewer tokens)** | | **25 / 30** | |
| **rg wins (fewer tokens)** | | **5 / 30** | |

## Why search_text uses fewer tokens

1. **Result cap (200 max)** — rg returns all matches (e.g. 11,931 import lines). search_text caps at 200.
2. **Auto-grouping** — When >50 matches, groups by file: `{file, count, lines[]}` instead of every line.
3. **Compact format** — When <50 matches and no context lines, returns `file:line: content` (plain text, no JSON overhead).
4. **Zero context lines** — Default context_lines=0, no surrounding lines wasted.

## Why search_text is slower

1. **MCP protocol overhead** — JSON-RPC serialization, tool schema validation.
2. **Index lookup** — `getCodeIndex()` loads the repository index before searching.
3. **execFileSync wrapper** — ripgrep is called via Node.js child_process, adding ~20-50ms per call.

## Honest caveats

- rg has no default result limit. Claude Code's built-in Grep tool defaults to `head_limit=250`, which would reduce rg's token output significantly (but still more than search_text for high-match queries).
- Token savings come primarily from the result cap, not from a fundamentally different search algorithm.
- Speed penalty is real and structural (MCP overhead). For latency-sensitive single searches, rg is faster.
- "Coverage warnings" (16/30 queries) indicate search_text returned fewer results than rg — this is by design (cap), not a bug.

---

**Raw data:** `benchmarks/results/search-text-vs-rg-2026-03-29T16-06-03.json`
**Benchmark script:** `benchmarks/search-text-vs-grep.ts`
**Optimizations applied:** OPT-1 (ripgrep backend), OPT-2 (context_lines=0), OPT-3 (compact format)
