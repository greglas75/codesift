# CodeSift Benchmark Report

**Date:** 2026-03-28 18:33
**Tasks:** 42
**Adapters:** codesift, ripgrep
**Repos:** codesift-mcp
**Baseline:** ripgrep

## Summary by Adapter

| Adapter | Tasks | Success | Avg Tokens | Avg Time (ms) | Avg Calls |
|---------|-------|---------|------------|---------------|----------|
| **codesift** | 21 | 20/21 (95%) | 1991 | 363 | 1 |
| **ripgrep** | 21 | 8/21 (38%) | 350 | 7 | 1 |

## By Category (with deltas vs baseline)

### ANALYSIS

| Adapter | Tasks | Success | Total Tokens | vs Baseline | Total Time | vs Baseline | Calls |
|---------|-------|---------|-------------|-------------|------------|-------------|-------|
| codesift | 3 | 3/3 | 5141 | +39446% | 475ms | +2869% | 3 |
| ripgrep | 3 | 1/3 | 13 | baseline | 16ms | baseline | 3 |

### RELATIONSHIP

| Adapter | Tasks | Success | Total Tokens | vs Baseline | Total Time | vs Baseline | Calls |
|---------|-------|---------|-------------|-------------|------------|-------------|-------|
| codesift | 2 | 1/2 | 7300 | +364900% | 431ms | +4210% | 3 |
| ripgrep | 2 | 0/2 | 2 | baseline | 10ms | baseline | 2 |

### RETRIEVAL

| Adapter | Tasks | Success | Total Tokens | vs Baseline | Total Time | vs Baseline | Calls |
|---------|-------|---------|-------------|-------------|------------|-------------|-------|
| codesift | 2 | 2/2 | 4031 | +201450% | 2314ms | +23040% | 2 |
| ripgrep | 2 | 0/2 | 2 | baseline | 10ms | baseline | 2 |

### SEMANTIC

| Adapter | Tasks | Success | Total Tokens | vs Baseline | Total Time | vs Baseline | Calls |
|---------|-------|---------|-------------|-------------|------------|-------------|-------|
| codesift | 3 | 3/3 | 4870 | +162233% | 2900ms | +22208% | 3 |
| ripgrep | 3 | 0/3 | 3 | baseline | 13ms | baseline | 3 |

### STRUCTURE

| Adapter | Tasks | Success | Total Tokens | vs Baseline | Total Time | vs Baseline | Calls |
|---------|-------|---------|-------------|-------------|------------|-------------|-------|
| codesift | 3 | 3/3 | 2271 | +75600% | 293ms | +2564% | 3 |
| ripgrep | 3 | 0/3 | 3 | baseline | 11ms | baseline | 3 |

### SYMBOL

| Adapter | Tasks | Success | Total Tokens | vs Baseline | Total Time | vs Baseline | Calls |
|---------|-------|---------|-------------|-------------|------------|-------------|-------|
| codesift | 3 | 3/3 | 10722 | +520% | 648ms | +1806% | 3 |
| ripgrep | 3 | 2/3 | 1730 | baseline | 34ms | baseline | 3 |

### TEXT

| Adapter | Tasks | Success | Total Tokens | vs Baseline | Total Time | vs Baseline | Calls |
|---------|-------|---------|-------------|-------------|------------|-------------|-------|
| codesift | 5 | 5/5 | 7492 | +34% | 581ms | +794% | 5 |
| ripgrep | 5 | 5/5 | 5607 | baseline | 65ms | baseline | 5 |

## Overall Token Comparison

| Category | codesift | ripgrep | Winner |
|----------|--------|--------|--------|
| **analysis** | 5,141 | 13 | **ripgrep** |
| **relationship** | 7,300 | 2 | **ripgrep** |
| **retrieval** | 4,031 | 2 | **ripgrep** |
| **semantic** | 4,870 | 3 | **ripgrep** |
| **structure** | 2,271 | 3 | **ripgrep** |
| **symbol** | 10,722 | 1,730 | **ripgrep** |
| **text** | 7,492 | 5,607 | **ripgrep** |

## Per-Task Detail

| Task | Adapter | Repo | OK | Tokens | Time (ms) | Calls | Error |
|------|---------|------|----|--------|-----------|-------|-------|
| analysis-001 | codesift | codesift-mcp | Y | 4646 | 168 | 1 |  |
| analysis-001 | ripgrep | codesift-mcp | N | 1 | 5 | 1 |  |
| analysis-002 | codesift | codesift-mcp | Y | 475 | 108 | 1 |  |
| analysis-002 | ripgrep | codesift-mcp | Y | 11 | 6 | 1 | Clone detection not supported |
| analysis-003 | codesift | codesift-mcp | Y | 20 | 199 | 1 |  |
| analysis-003 | ripgrep | codesift-mcp | N | 1 | 5 | 1 |  |
| relationship-004 | codesift | codesift-mcp | N | 1753 | 286 | 2 |  |
| relationship-004 | ripgrep | codesift-mcp | N | 1 | 5 | 1 |  |
| relationship-005 | codesift | codesift-mcp | Y | 5547 | 145 | 1 |  |
| relationship-005 | ripgrep | codesift-mcp | N | 1 | 5 | 1 |  |
| retrieval-003 | codesift | codesift-mcp | Y | 211 | 1260 | 1 |  |
| retrieval-003 | ripgrep | codesift-mcp | N | 1 | 5 | 1 |  |
| retrieval-004 | codesift | codesift-mcp | Y | 3820 | 1054 | 1 |  |
| retrieval-004 | ripgrep | codesift-mcp | N | 1 | 5 | 1 |  |
| semantic-002 | codesift | codesift-mcp | Y | 514 | 1041 | 1 |  |
| semantic-002 | ripgrep | codesift-mcp | N | 1 | 4 | 1 |  |
| semantic-003 | codesift | codesift-mcp | Y | 4310 | 1053 | 1 |  |
| semantic-003 | ripgrep | codesift-mcp | N | 1 | 4 | 1 |  |
| semantic-004 | codesift | codesift-mcp | Y | 46 | 806 | 1 |  |
| semantic-004 | ripgrep | codesift-mcp | N | 1 | 5 | 1 |  |
| structure-001 | codesift | codesift-mcp | Y | 723 | 98 | 1 |  |
| structure-001 | ripgrep | codesift-mcp | N | 1 | 4 | 1 |  |
| structure-002 | codesift | codesift-mcp | Y | 1547 | 101 | 1 |  |
| structure-002 | ripgrep | codesift-mcp | N | 1 | 4 | 1 |  |
| structure-004 | codesift | codesift-mcp | Y | 1 | 94 | 1 |  |
| structure-004 | ripgrep | codesift-mcp | N | 1 | 3 | 1 |  |
| symbol-002 | codesift | codesift-mcp | Y | 1 | 212 | 1 |  |
| symbol-002 | ripgrep | codesift-mcp | N | 1 | 10 | 1 |  |
| symbol-003 | codesift | codesift-mcp | Y | 1102 | 209 | 1 |  |
| symbol-003 | ripgrep | codesift-mcp | Y | 369 | 13 | 1 |  |
| symbol-005 | codesift | codesift-mcp | Y | 9619 | 227 | 1 |  |
| symbol-005 | ripgrep | codesift-mcp | Y | 1360 | 11 | 1 |  |
| text-001 | codesift | codesift-mcp | Y | 901 | 133 | 1 |  |
| text-001 | ripgrep | codesift-mcp | Y | 787 | 13 | 1 |  |
| text-002 | codesift | codesift-mcp | Y | 1992 | 123 | 1 |  |
| text-002 | ripgrep | codesift-mcp | Y | 1093 | 17 | 1 |  |
| text-003 | codesift | codesift-mcp | Y | 440 | 92 | 1 |  |
| text-003 | ripgrep | codesift-mcp | Y | 362 | 13 | 1 |  |
| text-004 | codesift | codesift-mcp | Y | 2653 | 110 | 1 |  |
| text-004 | ripgrep | codesift-mcp | Y | 2180 | 11 | 1 |  |
| text-005 | codesift | codesift-mcp | Y | 1506 | 123 | 1 |  |
| text-005 | ripgrep | codesift-mcp | Y | 1185 | 11 | 1 |  |
