# Agent Benchmark Report

**Date:** 2026-03-29T11:27
**Repo:** tgm-survey
**Model:** sonnet
**Methods:** standard, codesift-bm25

## Summary by Method

| Method | Tasks | Input Tok | Output Tok | Total Tok | Cost | Avg Duration | Avg Turns |
|--------|-------|----------|-----------|----------|------|-------------|----------|
| **standard** | 1 | 8 | 2,681 | 2,689 | $0.33 | 79.2s | 11.0 |
| **codesift-bm25** | 1 | 26 | 7,198 | 7,224 | $0.77 | 163.4s | 33.0 |

## Tokens per Task

| Task | standard in | standard out | standard total | codesift-bm25 in | codesift-bm25 out | codesift-bm25 total | Delta |
|------|------:|------:|------:|------:|------:|------:|------:|
| R1 | 8 | 2,681 | 2,689 | 26 | 7,198 | 7,224 | +169% |
| **TOTAL** | **8** | **2,681** | **2,689** | **26** | **7,198** | **7,224** | +169% |

## Duration per Task (seconds)

| Task | standard | codesift-bm25 |
|------|------|------|
| R1 | 79.2s | 163.4s |

## Tool Calls per Task

| Task | standard | codesift-bm25 |
|------|------|------|
| R1 | 11 | 33 |

## Confidence & Completeness

| Task | standard conf | standard complete | codesift-bm25 conf | codesift-bm25 complete |
|------|------|---------|------|---------|
| R1 | HIGH | Yes | HIGH | Yes |
