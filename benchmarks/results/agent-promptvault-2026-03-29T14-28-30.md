# Agent Benchmark Report

**Date:** 2026-03-29T14:28
**Repo:** promptvault
**Model:** sonnet
**Methods:** standard, codesift-bm25

## Summary by Method

| Method | Tasks | Input Tok | Output Tok | Total Tok | Cost | Avg Duration | Avg Turns |
|--------|-------|----------|-----------|----------|------|-------------|----------|
| **standard** | 6 | 44 | 8,618 | 8,662 | $1.29 | 42.0s | 6.7 |
| **codesift-bm25** | 6 | 0 | 0 | 0 | $0.00 | 0.0s | 0.0 |

## Tokens per Task

| Task | standard in | standard out | standard total | codesift-bm25 in | codesift-bm25 out | codesift-bm25 total | Delta |
|------|------:|------:|------:|------:|------:|------:|------:|
| R1 | 0 | 0 | 0 | 0 | 0 | 0 | — |
| R2 | 29 | 5,292 | 5,321 | 0 | 0 | 0 | **-100%** |
| R3 | 15 | 3,326 | 3,341 | 0 | 0 | 0 | **-100%** |
| R4 | 0 | 0 | 0 | 0 | 0 | 0 | — |
| R5 | 0 | 0 | 0 | 0 | 0 | 0 | — |
| R9 | 0 | 0 | 0 | 0 | 0 | 0 | — |
| **TOTAL** | **44** | **8,618** | **8,662** | **0** | **0** | **0** | **-100%** |

## Duration per Task (seconds)

| Task | standard | codesift-bm25 |
|------|------|------|
| R1 | 0.0s | 0.0s |
| R2 | 151.0s | 0.0s |
| R3 | 101.1s | 0.0s |
| R4 | 0.0s | 0.0s |
| R5 | 0.0s | 0.0s |
| R9 | 0.0s | 0.0s |

## Tool Calls per Task

| Task | standard | codesift-bm25 |
|------|------|------|
| R1 | 0 | 0 |
| R2 | 27 | 0 |
| R3 | 13 | 0 |
| R4 | 0 | 0 |
| R5 | 0 | 0 |
| R9 | 0 | 0 |

## Confidence & Completeness

| Task | standard conf | standard complete | codesift-bm25 conf | codesift-bm25 complete |
|------|------|---------|------|---------|
| R1 | LOW | No | LOW | No |
| R2 | HIGH | Yes | LOW | No |
| R3 | HIGH | Yes | LOW | No |
| R4 | LOW | No | LOW | No |
| R5 | LOW | No | LOW | No |
| R9 | LOW | No | LOW | No |
