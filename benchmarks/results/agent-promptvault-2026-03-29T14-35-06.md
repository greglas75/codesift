# Agent Benchmark Report

**Date:** 2026-03-29T14:35
**Repo:** promptvault
**Model:** sonnet
**Methods:** standard, codesift-bm25

## Summary by Method

| Method | Tasks | Input Tok | Output Tok | Total Tok | Cost | Avg Duration | Avg Turns |
|--------|-------|----------|-----------|----------|------|-------------|----------|
| **standard** | 1 | 1,786 | 3,295 | 5,081 | $0.40 | 96.7s | 16.0 |
| **codesift-bm25** | 1 | 17 | 4,723 | 4,740 | $0.49 | 137.5s | 11.0 |

## Tokens per Task

| Task | standard in | standard out | standard total | codesift-bm25 in | codesift-bm25 out | codesift-bm25 total | Delta |
|------|------:|------:|------:|------:|------:|------:|------:|
| R3 | 1,786 | 3,295 | 5,081 | 17 | 4,723 | 4,740 | **-7%** |
| **TOTAL** | **1,786** | **3,295** | **5,081** | **17** | **4,723** | **4,740** | **-7%** |

## Duration per Task (seconds)

| Task | standard | codesift-bm25 |
|------|------|------|
| R3 | 96.7s | 137.5s |

## Tool Calls per Task

| Task | standard | codesift-bm25 |
|------|------|------|
| R3 | 16 | 11 |

## Confidence & Completeness

| Task | standard conf | standard complete | codesift-bm25 conf | codesift-bm25 complete |
|------|------|---------|------|---------|
| R3 | HIGH | Yes | HIGH | Yes |
