# Agent Benchmark Report

**Date:** 2026-03-29T09:01
**Repo:** promptvault
**Model:** sonnet
**Methods:** standard, codesift-bm25

## Summary by Method

| Method | Tasks | Input Tok | Output Tok | Total Tok | Cost | Avg Duration | Avg Turns |
|--------|-------|----------|-----------|----------|------|-------------|----------|
| **standard** | 3 | 21 | 5,583 | 5,604 | $0.71 | 30.9s | 5.0 |
| **codesift-bm25** | 3 | 55 | 17,348 | 17,403 | $1.51 | 106.2s | 12.3 |

## Tokens per Task

| Task | standard in | standard out | standard total | codesift-bm25 in | codesift-bm25 out | codesift-bm25 total | Delta |
|------|------:|------:|------:|------:|------:|------:|------:|
| T1 | 6 | 668 | 674 | 10 | 1,498 | 1,508 | +124% |
| T2 | 7 | 2,820 | 2,827 | 22 | 9,082 | 9,104 | +222% |
| T3 | 8 | 2,095 | 2,103 | 23 | 6,768 | 6,791 | +223% |
| **TOTAL** | **21** | **5,583** | **5,604** | **55** | **17,348** | **17,403** | +211% |

## Duration per Task (seconds)

| Task | standard | codesift-bm25 |
|------|------|------|
| T1 | 15.7s | 28.3s |
| T2 | 41.9s | 137.1s |
| T3 | 35.1s | 153.3s |

## Tool Calls per Task

| Task | standard | codesift-bm25 |
|------|------|------|
| T1 | 4 | 6 |
| T2 | 5 | 16 |
| T3 | 6 | 15 |

## Confidence & Completeness

| Task | standard conf | standard complete | codesift-bm25 conf | codesift-bm25 complete |
|------|------|---------|------|---------|
| T1 | HIGH | Yes | HIGH | Yes |
| T2 | HIGH | Yes | HIGH | Yes |
| T3 | HIGH | Yes | HIGH | Yes |
