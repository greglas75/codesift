# Agent Benchmark Report

**Date:** 2026-03-29T15:02
**Repo:** promptvault
**Model:** sonnet
**Methods:** standard, codesift-bm25

## Summary by Method

| Method | Tasks | Input Tok | Output Tok | Total Tok | Cost | Avg Duration | Avg Turns |
|--------|-------|----------|-----------|----------|------|-------------|----------|
| **standard** | 6 | 2,747 | 17,753 | 20,500 | $2.07 | 97.1s | 11.2 |
| **codesift-bm25** | 6 | 107 | 26,691 | 26,798 | $3.10 | 120.0s | 15.2 |

## Tokens per Task

| Task | standard in | standard out | standard total | codesift-bm25 in | codesift-bm25 out | codesift-bm25 total | Delta |
|------|------:|------:|------:|------:|------:|------:|------:|
| R1 | 2,597 | 4,146 | 6,743 | 15 | 3,445 | 3,460 | **-49%** |
| R2 | 119 | 1,992 | 2,111 | 25 | 5,951 | 5,976 | +183% |
| R3 | 4 | 757 | 761 | 8 | 1,063 | 1,071 | +41% |
| R4 | 13 | 5,194 | 5,207 | 25 | 7,862 | 7,887 | +51% |
| R5 | 9 | 5,159 | 5,168 | 17 | 6,303 | 6,320 | +22% |
| R6 | 5 | 505 | 510 | 17 | 2,067 | 2,084 | +309% |
| **TOTAL** | **2,747** | **17,753** | **20,500** | **107** | **26,691** | **26,798** | +31% |

## Duration per Task (seconds)

| Task | standard | codesift-bm25 |
|------|------|------|
| R1 | 221.0s | 94.7s |
| R2 | 63.5s | 161.4s |
| R3 | 31.1s | 47.1s |
| R4 | 115.9s | 202.7s |
| R5 | 121.5s | 130.0s |
| R6 | 29.8s | 84.0s |

## Tool Calls per Task

| Task | standard | codesift-bm25 |
|------|------|------|
| R1 | 18 | 12 |
| R2 | 12 | 25 |
| R3 | 3 | 4 |
| R4 | 18 | 17 |
| R5 | 13 | 22 |
| R6 | 3 | 11 |

## Confidence & Completeness

| Task | standard conf | standard complete | codesift-bm25 conf | codesift-bm25 complete |
|------|------|---------|------|---------|
| R1 | LOW | No | LOW | No |
| R2 | LOW | No | LOW | No |
| R3 | LOW | No | LOW | No |
| R4 | LOW | No | LOW | No |
| R5 | LOW | No | LOW | No |
| R6 | LOW | No | LOW | No |
