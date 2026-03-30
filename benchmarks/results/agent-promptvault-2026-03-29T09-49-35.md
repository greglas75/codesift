# Agent Benchmark Report

**Date:** 2026-03-29T09:49
**Repo:** promptvault
**Model:** sonnet
**Methods:** standard, codesift-bm25

## Summary by Method

| Method | Tasks | Input Tok | Output Tok | Total Tok | Cost | Avg Duration | Avg Turns |
|--------|-------|----------|-----------|----------|------|-------------|----------|
| **standard** | 18 | 127 | 50,118 | 50,245 | $5.11 | 46.8s | 6.7 |
| **codesift-bm25** | 18 | 218 | 62,941 | 63,159 | $5.99 | 63.2s | 7.5 |

## Tokens per Task

| Task | standard in | standard out | standard total | codesift-bm25 in | codesift-bm25 out | codesift-bm25 total | Delta |
|------|------:|------:|------:|------:|------:|------:|------:|
| T1 | 5 | 671 | 676 | 11 | 1,660 | 1,671 | +147% |
| T10 | 14 | 3,847 | 3,861 | 0 | 0 | 0 | **-100%** |
| T11 | 0 | 0 | 0 | 8 | 3,187 | 3,195 | — |
| T12 | 0 | 0 | 0 | 7 | 1,060 | 1,067 | — |
| T13 | 6 | 2,803 | 2,809 | 11 | 1,629 | 1,640 | **-42%** |
| T14 | 9 | 8,283 | 8,292 | 8 | 2,321 | 2,329 | **-72%** |
| T15 | 15 | 6,194 | 6,209 | 18 | 3,008 | 3,026 | **-51%** |
| T16 | 4 | 1,301 | 1,305 | 12 | 3,496 | 3,508 | +169% |
| T17 | 9 | 3,216 | 3,225 | 11 | 5,681 | 5,692 | +76% |
| T18 | 11 | 3,496 | 3,507 | 12 | 4,025 | 4,037 | +15% |
| T2 | 9 | 2,729 | 2,738 | 15 | 6,720 | 6,735 | +146% |
| T3 | 5 | 1,385 | 1,390 | 19 | 3,142 | 3,161 | +127% |
| T4 | 7 | 1,554 | 1,561 | 17 | 3,387 | 3,404 | +118% |
| T5 | 8 | 6,169 | 6,177 | 16 | 10,926 | 10,942 | +77% |
| T6 | 6 | 1,350 | 1,356 | 19 | 2,784 | 2,803 | +107% |
| T7 | 4 | 712 | 716 | 5 | 1,196 | 1,201 | +68% |
| T8 | 5 | 883 | 888 | 21 | 5,019 | 5,040 | +468% |
| T9 | 10 | 5,525 | 5,535 | 8 | 3,700 | 3,708 | **-33%** |
| **TOTAL** | **127** | **50,118** | **50,245** | **218** | **62,941** | **63,159** | +26% |

## Duration per Task (seconds)

| Task | standard | codesift-bm25 |
|------|------|------|
| T1 | 14.9s | 32.3s |
| T10 | 93.2s | 0.0s |
| T11 | 0.0s | 48.3s |
| T12 | 0.0s | 23.1s |
| T13 | 41.4s | 42.7s |
| T14 | 104.7s | 39.4s |
| T15 | 120.1s | 63.6s |
| T16 | 18.7s | 71.4s |
| T17 | 58.7s | 107.3s |
| T18 | 58.3s | 76.0s |
| T2 | 51.5s | 97.9s |
| T3 | 24.2s | 64.2s |
| T4 | 34.3s | 86.0s |
| T5 | 71.3s | 138.1s |
| T6 | 25.7s | 64.7s |
| T7 | 17.3s | 39.7s |
| T8 | 17.0s | 92.7s |
| T9 | 90.3s | 50.8s |

## Tool Calls per Task

| Task | standard | codesift-bm25 |
|------|------|------|
| T1 | 3 | 7 |
| T10 | 19 | 0 |
| T11 | 0 | 4 |
| T12 | 0 | 3 |
| T13 | 4 | 5 |
| T14 | 7 | 4 |
| T15 | 23 | 12 |
| T16 | 2 | 8 |
| T17 | 7 | 7 |
| T18 | 14 | 8 |
| T2 | 7 | 9 |
| T3 | 3 | 13 |
| T4 | 7 | 9 |
| T5 | 6 | 12 |
| T6 | 4 | 11 |
| T7 | 2 | 4 |
| T8 | 3 | 15 |
| T9 | 10 | 4 |

## Confidence & Completeness

| Task | standard conf | standard complete | codesift-bm25 conf | codesift-bm25 complete |
|------|------|---------|------|---------|
| T1 | HIGH | Yes | HIGH | Yes |
| T10 | HIGH | Yes | LOW | No |
| T11 | LOW | No | HIGH | Yes |
| T12 | LOW | No | HIGH | Yes |
| T13 | HIGH | Yes | HIGH | Yes |
| T14 | HIGH | Yes | HIGH | Yes |
| T15 | HIGH | Yes | HIGH | Yes |
| T16 | HIGH | Yes | HIGH | Yes |
| T17 | HIGH | Yes | HIGH | Yes |
| T18 | HIGH | Yes | HIGH | Yes |
| T2 | HIGH | Yes | HIGH | Yes |
| T3 | HIGH | Yes | HIGH | Yes |
| T4 | HIGH | Yes | HIGH | Yes |
| T5 | HIGH | Yes | HIGH | Yes |
| T6 | HIGH | Yes | HIGH | Yes |
| T7 | HIGH | Yes | HIGH | Yes |
| T8 | HIGH | Yes | HIGH | Yes |
| T9 | HIGH | Yes | HIGH | Yes |
