# CodeSift Benchmark Report

**Date:** 2026-03-28 18:31
**Tasks:** 21
**Adapters:** ripgrep
**Repos:** codesift-mcp
**Baseline:** ripgrep

## Summary by Adapter

| Adapter | Tasks | Success | Avg Tokens | Avg Time (ms) | Avg Calls |
|---------|-------|---------|------------|---------------|----------|
| **ripgrep** | 21 | 8/21 (38%) | 350 | 8 | 1 |

## By Category (with deltas vs baseline)

### ANALYSIS

| Adapter | Tasks | Success | Total Tokens | vs Baseline | Total Time | vs Baseline | Calls |
|---------|-------|---------|-------------|-------------|------------|-------------|-------|
| ripgrep | 3 | 1/3 | 13 | baseline | 16ms | baseline | 3 |

### RELATIONSHIP

| Adapter | Tasks | Success | Total Tokens | vs Baseline | Total Time | vs Baseline | Calls |
|---------|-------|---------|-------------|-------------|------------|-------------|-------|
| ripgrep | 2 | 0/2 | 2 | baseline | 10ms | baseline | 2 |

### RETRIEVAL

| Adapter | Tasks | Success | Total Tokens | vs Baseline | Total Time | vs Baseline | Calls |
|---------|-------|---------|-------------|-------------|------------|-------------|-------|
| ripgrep | 2 | 0/2 | 2 | baseline | 9ms | baseline | 2 |

### SEMANTIC

| Adapter | Tasks | Success | Total Tokens | vs Baseline | Total Time | vs Baseline | Calls |
|---------|-------|---------|-------------|-------------|------------|-------------|-------|
| ripgrep | 3 | 0/3 | 3 | baseline | 14ms | baseline | 3 |

### STRUCTURE

| Adapter | Tasks | Success | Total Tokens | vs Baseline | Total Time | vs Baseline | Calls |
|---------|-------|---------|-------------|-------------|------------|-------------|-------|
| ripgrep | 3 | 0/3 | 3 | baseline | 11ms | baseline | 3 |

### SYMBOL

| Adapter | Tasks | Success | Total Tokens | vs Baseline | Total Time | vs Baseline | Calls |
|---------|-------|---------|-------------|-------------|------------|-------------|-------|
| ripgrep | 3 | 2/3 | 1730 | baseline | 32ms | baseline | 3 |

### TEXT

| Adapter | Tasks | Success | Total Tokens | vs Baseline | Total Time | vs Baseline | Calls |
|---------|-------|---------|-------------|-------------|------------|-------------|-------|
| ripgrep | 5 | 5/5 | 5607 | baseline | 85ms | baseline | 5 |

## Per-Task Detail

| Task | Adapter | Repo | OK | Tokens | Time (ms) | Calls | Error |
|------|---------|------|----|--------|-----------|-------|-------|
| analysis-001 | ripgrep | codesift-mcp | N | 1 | 5 | 1 |  |
| analysis-002 | ripgrep | codesift-mcp | Y | 11 | 7 | 1 | Clone detection not supported |
| analysis-003 | ripgrep | codesift-mcp | N | 1 | 4 | 1 |  |
| relationship-004 | ripgrep | codesift-mcp | N | 1 | 6 | 1 |  |
| relationship-005 | ripgrep | codesift-mcp | N | 1 | 4 | 1 |  |
| retrieval-003 | ripgrep | codesift-mcp | N | 1 | 4 | 1 |  |
| retrieval-004 | ripgrep | codesift-mcp | N | 1 | 5 | 1 |  |
| semantic-002 | ripgrep | codesift-mcp | N | 1 | 4 | 1 |  |
| semantic-003 | ripgrep | codesift-mcp | N | 1 | 5 | 1 |  |
| semantic-004 | ripgrep | codesift-mcp | N | 1 | 5 | 1 |  |
| structure-001 | ripgrep | codesift-mcp | N | 1 | 5 | 1 |  |
| structure-002 | ripgrep | codesift-mcp | N | 1 | 3 | 1 |  |
| structure-004 | ripgrep | codesift-mcp | N | 1 | 3 | 1 |  |
| symbol-002 | ripgrep | codesift-mcp | N | 1 | 10 | 1 |  |
| symbol-003 | ripgrep | codesift-mcp | Y | 369 | 11 | 1 |  |
| symbol-005 | ripgrep | codesift-mcp | Y | 1360 | 11 | 1 |  |
| text-001 | ripgrep | codesift-mcp | Y | 787 | 40 | 1 |  |
| text-002 | ripgrep | codesift-mcp | Y | 1093 | 11 | 1 |  |
| text-003 | ripgrep | codesift-mcp | Y | 362 | 12 | 1 |  |
| text-004 | ripgrep | codesift-mcp | Y | 2180 | 11 | 1 |  |
| text-005 | ripgrep | codesift-mcp | Y | 1185 | 11 | 1 |  |
