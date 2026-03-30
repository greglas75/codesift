# Agent Benchmark Report

**Date:** 2026-03-29T14:29
**Repo:** promptvault
**Model:** sonnet
**Methods:** standard, codesift-bm25

## Summary by Method

| Method | Tasks | Input Tok | Output Tok | Total Tok | Cost | Avg Duration | Avg Turns |
|--------|-------|----------|-----------|----------|------|-------------|----------|
| **standard** | 1 | 0 | 0 | 0 | $0.00 | 0.0s | 0.0 |
| **codesift-bm25** | 1 | 14 | 4,626 | 4,640 | $0.47 | 115.9s | 10.0 |

## Tokens per Task

| Task | standard in | standard out | standard total | codesift-bm25 in | codesift-bm25 out | codesift-bm25 total | Delta |
|------|------:|------:|------:|------:|------:|------:|------:|
| R3 | 0 | 0 | 0 | 14 | 4,626 | 4,640 | — |
| **TOTAL** | **0** | **0** | **0** | **14** | **4,626** | **4,640** |

## Duration per Task (seconds)

| Task | standard | codesift-bm25 |
|------|------|------|
| R3 | 0.0s | 115.9s |

## Tool Calls per Task

| Task | standard | codesift-bm25 |
|------|------|------|
| R3 | 0 | 10 |

## Confidence & Completeness

| Task | standard conf | standard complete | codesift-bm25 conf | codesift-bm25 complete |
|------|------|---------|------|---------|
| R3 | LOW | No | HIGH | Yes |
