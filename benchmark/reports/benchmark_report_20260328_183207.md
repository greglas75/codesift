# CodeSift Benchmark Report

**Date:** 2026-03-28 18:32
**Tasks:** 42
**Adapters:** codesift, ripgrep
**Repos:** codesift-mcp
**Baseline:** ripgrep

## Summary by Adapter

| Adapter | Tasks | Success | Avg Tokens | Avg Time (ms) | Avg Calls |
|---------|-------|---------|------------|---------------|----------|
| **codesift** | 21 | 20/21 (95%) | 2644 | 384 | 1 |
| **ripgrep** | 21 | 8/21 (38%) | 350 | 8 | 1 |

## By Category (with deltas vs baseline)

### ANALYSIS

| Adapter | Tasks | Success | Total Tokens | vs Baseline | Total Time | vs Baseline | Calls |
|---------|-------|---------|-------------|-------------|------------|-------------|-------|
| codesift | 3 | 3/3 | 5141 | +39446% | 593ms | +4842% | 3 |
| ripgrep | 3 | 1/3 | 13 | baseline | 12ms | baseline | 3 |

### RELATIONSHIP

| Adapter | Tasks | Success | Total Tokens | vs Baseline | Total Time | vs Baseline | Calls |
|---------|-------|---------|-------------|-------------|------------|-------------|-------|
| codesift | 2 | 1/2 | 7300 | +364900% | 602ms | +7425% | 3 |
| ripgrep | 2 | 0/2 | 2 | baseline | 8ms | baseline | 2 |

### RETRIEVAL

| Adapter | Tasks | Success | Total Tokens | vs Baseline | Total Time | vs Baseline | Calls |
|---------|-------|---------|-------------|-------------|------------|-------------|-------|
| codesift | 2 | 2/2 | 4031 | +201450% | 2468ms | +9772% | 2 |
| ripgrep | 2 | 0/2 | 2 | baseline | 25ms | baseline | 2 |

### SEMANTIC

| Adapter | Tasks | Success | Total Tokens | vs Baseline | Total Time | vs Baseline | Calls |
|---------|-------|---------|-------------|-------------|------------|-------------|-------|
| codesift | 3 | 3/3 | 4870 | +162233% | 2868ms | +20386% | 3 |
| ripgrep | 3 | 0/3 | 3 | baseline | 14ms | baseline | 3 |

### STRUCTURE

| Adapter | Tasks | Success | Total Tokens | vs Baseline | Total Time | vs Baseline | Calls |
|---------|-------|---------|-------------|-------------|------------|-------------|-------|
| codesift | 3 | 3/3 | 2271 | +75600% | 315ms | +1212% | 3 |
| ripgrep | 3 | 0/3 | 3 | baseline | 24ms | baseline | 3 |

### SYMBOL

| Adapter | Tasks | Success | Total Tokens | vs Baseline | Total Time | vs Baseline | Calls |
|---------|-------|---------|-------------|-------------|------------|-------------|-------|
| codesift | 3 | 3/3 | 10722 | +520% | 634ms | +1711% | 3 |
| ripgrep | 3 | 2/3 | 1730 | baseline | 35ms | baseline | 3 |

### TEXT

| Adapter | Tasks | Success | Total Tokens | vs Baseline | Total Time | vs Baseline | Calls |
|---------|-------|---------|-------------|-------------|------------|-------------|-------|
| codesift | 5 | 5/5 | 21199 | +278% | 596ms | +1046% | 5 |
| ripgrep | 5 | 5/5 | 5607 | baseline | 52ms | baseline | 5 |

## Overall Token Comparison

| Category | codesift | ripgrep | Winner |
|----------|--------|--------|--------|
| **analysis** | 5,141 | 13 | **ripgrep** |
| **relationship** | 7,300 | 2 | **ripgrep** |
| **retrieval** | 4,031 | 2 | **ripgrep** |
| **semantic** | 4,870 | 3 | **ripgrep** |
| **structure** | 2,271 | 3 | **ripgrep** |
| **symbol** | 10,722 | 1,730 | **ripgrep** |
| **text** | 21,199 | 5,607 | **ripgrep** |

## Per-Task Detail

| Task | Adapter | Repo | OK | Tokens | Time (ms) | Calls | Error |
|------|---------|------|----|--------|-----------|-------|-------|
| analysis-001 | codesift | codesift-mcp | Y | 4646 | 194 | 1 |  |
| analysis-001 | ripgrep | codesift-mcp | N | 1 | 4 | 1 |  |
| analysis-002 | codesift | codesift-mcp | Y | 475 | 118 | 1 |  |
| analysis-002 | ripgrep | codesift-mcp | Y | 11 | 4 | 1 | Clone detection not supported |
| analysis-003 | codesift | codesift-mcp | Y | 20 | 281 | 1 |  |
| analysis-003 | ripgrep | codesift-mcp | N | 1 | 4 | 1 |  |
| relationship-004 | codesift | codesift-mcp | N | 1753 | 485 | 2 |  |
| relationship-004 | ripgrep | codesift-mcp | N | 1 | 4 | 1 |  |
| relationship-005 | codesift | codesift-mcp | Y | 5547 | 117 | 1 |  |
| relationship-005 | ripgrep | codesift-mcp | N | 1 | 4 | 1 |  |
| retrieval-003 | codesift | codesift-mcp | Y | 211 | 1221 | 1 |  |
| retrieval-003 | ripgrep | codesift-mcp | N | 1 | 5 | 1 |  |
| retrieval-004 | codesift | codesift-mcp | Y | 3820 | 1247 | 1 |  |
| retrieval-004 | ripgrep | codesift-mcp | N | 1 | 20 | 1 |  |
| semantic-002 | codesift | codesift-mcp | Y | 514 | 914 | 1 |  |
| semantic-002 | ripgrep | codesift-mcp | N | 1 | 4 | 1 |  |
| semantic-003 | codesift | codesift-mcp | Y | 4310 | 1111 | 1 |  |
| semantic-003 | ripgrep | codesift-mcp | N | 1 | 5 | 1 |  |
| semantic-004 | codesift | codesift-mcp | Y | 46 | 843 | 1 |  |
| semantic-004 | ripgrep | codesift-mcp | N | 1 | 5 | 1 |  |
| structure-001 | codesift | codesift-mcp | Y | 723 | 98 | 1 |  |
| structure-001 | ripgrep | codesift-mcp | N | 1 | 7 | 1 |  |
| structure-002 | codesift | codesift-mcp | Y | 1547 | 121 | 1 |  |
| structure-002 | ripgrep | codesift-mcp | N | 1 | 10 | 1 |  |
| structure-004 | codesift | codesift-mcp | Y | 1 | 96 | 1 |  |
| structure-004 | ripgrep | codesift-mcp | N | 1 | 7 | 1 |  |
| symbol-002 | codesift | codesift-mcp | Y | 1 | 220 | 1 |  |
| symbol-002 | ripgrep | codesift-mcp | N | 1 | 10 | 1 |  |
| symbol-003 | codesift | codesift-mcp | Y | 1102 | 215 | 1 |  |
| symbol-003 | ripgrep | codesift-mcp | Y | 369 | 13 | 1 |  |
| symbol-005 | codesift | codesift-mcp | Y | 9619 | 199 | 1 |  |
| symbol-005 | ripgrep | codesift-mcp | Y | 1360 | 12 | 1 |  |
| text-001 | codesift | codesift-mcp | Y | 2522 | 115 | 1 |  |
| text-001 | ripgrep | codesift-mcp | Y | 787 | 12 | 1 |  |
| text-002 | codesift | codesift-mcp | Y | 5877 | 155 | 1 |  |
| text-002 | ripgrep | codesift-mcp | Y | 1093 | 11 | 1 |  |
| text-003 | codesift | codesift-mcp | Y | 440 | 98 | 1 |  |
| text-003 | ripgrep | codesift-mcp | Y | 362 | 10 | 1 |  |
| text-004 | codesift | codesift-mcp | Y | 7544 | 113 | 1 |  |
| text-004 | ripgrep | codesift-mcp | Y | 2180 | 9 | 1 |  |
| text-005 | codesift | codesift-mcp | Y | 4816 | 115 | 1 |  |
| text-005 | ripgrep | codesift-mcp | Y | 1185 | 10 | 1 |  |
