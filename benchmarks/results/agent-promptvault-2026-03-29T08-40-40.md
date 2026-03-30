# Agent Benchmark Report

**Date:** 2026-03-29T08:40
**Repo:** promptvault
**Model:** sonnet
**Methods:** standard, codesift-bm25

## Summary by Method

| Method | Tasks | Total Tokens | Avg Tokens | Total Cost | Avg Duration | Avg Turns |
|--------|-------|-------------|-----------|------------|-------------|----------|
| **standard** | 3 | 7,992 | 2,664 | $0.80 | 37.5s | 6.0 |
| **codesift-bm25** | 3 | 8,001 | 2,667 | $0.95 | 45.9s | 6.0 |

## Tokens per Task

| Task | standard | codesift-bm25 | Delta |
|------|------|------|------|
| T1 | 944 | 728 | **-23%** |
| T2 | 4,671 | 3,796 | **-19%** |
| T3 | 2,377 | 3,477 | +46% |
| **TOTAL** | **7,992** | **8,001** | +0% |

## Duration per Task (seconds)

| Task | standard | codesift-bm25 |
|------|------|------|
| T1 | 18.3s | 16.1s |
| T2 | 55.4s | 65.6s |
| T3 | 38.9s | 55.9s |

## Tool Calls per Task

| Task | standard | codesift-bm25 |
|------|------|------|
| T1 | 5 | 3 |
| T2 | 7 | 9 |
| T3 | 6 | 6 |

## Confidence & Completeness

| Task | standard conf | codesift-bm25 conf |
|------|------|------|
| T1 | LOW | LOW |
| T2 | LOW | LOW |
| T3 | LOW | LOW |
