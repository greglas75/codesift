# Benchmark Template: Code Navigation Tools Comparison

**Project**: promptvault (Next.js 14+, TypeScript, Prisma)
**Index size**: ~1456 files, ~6392 symbols (jcodemunch baseline — CodeSift may differ)
**Model**: Claude Sonnet 4.6 (or Opus 4.6 for fair comparison)

---

## Methods to Compare

| Method | Tools | Description |
|--------|-------|-------------|
| **Standard** | Read, Grep, Glob | Built-in Claude Code tools only — baseline |
| **Auggie** | auggie-mcp codebase-retrieval + Read/Grep/Glob | Semantic embedding search (current champion: 70,586 tokens, Round 9b) |
| **CodeSift BM25** | codesift-mcp tools (BM25 only) | Phase 2 milestone — parity with jcodemunch |
| **CodeSift Hybrid** | codesift-mcp tools (BM25 + semantic) | Phase 3 milestone — should beat Auggie |

---

## Tasks (T1-T10)

| ID | Task | Type | Expected answer |
|----|------|------|-----------------|
| T1 | Find `createRisk` definition + params + return type | Find function | Function signature + 2 params + return type |
| T2 | Find ALL files importing from risk service | Find usages | 6 API routes + page.tsx + 4 test files |
| T3 | Find `DocumentDetail` type fields | Understand type | All fields incl. `legalEntity` |
| T4 | Trace `withAuth` middleware logic | Trace middleware | HOF chain + session extraction |
| T5 | Find all Zod schemas in API routes | Find pattern | List of schema names + file paths |
| T6 | Analyze `RiskPanel` component props + hooks | Component analysis | Props interface + usages of hooks |
| T7 | Find `ENTITY_NOT_FOUND` definition + all references | Error codes | Definition + all call sites |
| T8 | List all risk API routes + HTTP methods | API routes | Complete route list with methods |
| T9 | Find all `prisma.$transaction` usages | Cross-cutting | All transaction sites with context |
| T10 | Trace document analysis pipeline architecture | Architecture trace | Full pipeline: upload → parse → AI → risks |

---

## Agent Prompt Template

Run each task in a **fresh agent** with NO prior context. Use this prompt:

```
Using [METHOD] tools only, answer the following question about the promptvault codebase
(root: /Users/greglas/DEV/Methodology Platform/promptvault):

[TASK DESCRIPTION]

When done, report:
- Tool calls made: N
- Tokens used: N (estimate from context)
- Answer confidence: HIGH / MEDIUM / LOW
- Answer complete: Yes / Partial / No
- Answer: [your answer]
```

For **Standard**: "Using Read, Grep, and Glob tools only..."
For **Auggie**: "Using mcp__auggie-mcp__codebase-retrieval + Read/Grep/Glob..."
For **CodeSift BM25**: "Using mcp__codesift__ tools only (no semantic queries)..."
For **CodeSift Hybrid**: "Using mcp__codesift__ tools (including semantic sub-queries)..."

---

## Results Table Template

### Tool Calls

| Task | Standard | Auggie | CodeSift BM25 | CodeSift Hybrid |
|------|---------|--------|----------------|-----------------|
| T1   |         |        |                |                 |
| T2   |         |        |                |                 |
| T3   |         |        |                |                 |
| T4   |         |        |                |                 |
| T5   |         |        |                |                 |
| T6   |         |        |                |                 |
| T7   |         |        |                |                 |
| T8   |         |        |                |                 |
| T9   |         |        |                |                 |
| T10  |         |        |                |                 |
| **Total** |    |        |                |                 |

### Tokens

| Task | Standard | Auggie | CodeSift BM25 | CodeSift Hybrid |
|------|---------|--------|----------------|-----------------|
| T1   |         |        |                |                 |
| T2   |         |        |                |                 |
| T3   |         |        |                |                 |
| T4   |         |        |                |                 |
| T5   |         |        |                |                 |
| T6   |         |        |                |                 |
| T7   |         |        |                |                 |
| T8   |         |        |                |                 |
| T9   |         |        |                |                 |
| T10  |         |        |                |                 |
| **Total** |    |        |                |                 |

### Confidence & Completeness

| Task | Standard | Auggie | CodeSift BM25 | CodeSift Hybrid |
|------|---------|--------|----------------|-----------------|
| T1   |         |        |                |                 |
| T2   |         |        |                |                 |
| T3   |         |        |                |                 |
| T4   |         |        |                |                 |
| T5   |         |        |                |                 |
| T6   |         |        |                |                 |
| T7   |         |        |                |                 |
| T8   |         |        |                |                 |
| T9   |         |        |                |                 |
| T10  |         |        |                |                 |

---

## Historical Baselines (from jcodemunch benchmarks)

All rounds: promptvault repo, T1-T10, Claude Opus 4.6. Quality: **10/10 all rounds** (except R9: 9/10 — T2/T9 exhaustiveness).

### Tokens per round

| Round | Date | Index | Standard | Auggie | Munch | Champion | Notes |
|-------|------|-------|---------|--------|-------|----------|-------|
| R1 | 2026-03-05 | 6,392 sym | 116,958 | 146,057 | **99,878** | Munch | Baseline |
| R2 | 2026-03-05 | 6,392 sym | **94,983** | 129,349 | 102,238 | Standard | Post-P0 (camelCase + imports) |
| R3 | 2026-03-05 | 18,789 sym | **90,129** | 108,086 | 105,636 | Standard | Full feature set |
| R4 | 2026-03-05 | 18,789 sym | 93,666 | 110,026 | **91,956** | Munch | Post-perf opts |
| R5 | 2026-03-05 | 18,789 sym | 102,804 | 102,235 | 102,826 | **Auggie** | Post-token bloat opts; 3-way tie |
| R6 | 2026-03-05 | 18,789 sym | **82,391** | **82,117** | 92,714 | Auggie | Composite tools; trace_call_chain broken |
| R6b | 2026-03-05 | 18,789 sym | — | — | **86,399** | Munch | trace_call_chain fixed rerun |
| R7 | 2026-03-05 | 18,789 sym | **80,359** | 107,482 | 103,809 | Standard | CLAUDE.md architecture overview added |
| R8 | 2026-03-05 | 18,789 sym | **80,517** | 99,039 | 101,109 | Standard | Shorter tool descriptions |
| R8 Hybrid | 2026-03-05 | 18,789 sym | — | — | **70,508** | **Hybrid** | All tools available; new record |
| R9a | 2026-03-13 | 17,198 sym | 80,856 | — | — | Standard | jcodemunch unavailable; fallback |
| R9b | 2026-03-13 | 17,198 sym | — | **70,586** | — | **Auggie** | Auggie batched codebase_retrieval; new record |
| R9c | 2026-03-13 | 17,198 sym | — | — | 79,791 | — | Munch codebase_retrieval (3 calls + 8 follow-ups) |

### Duration per round (seconds)

| Round | Standard | Auggie | Munch |
|-------|---------|--------|-------|
| R1 | 212 | 242 | 208 |
| R2 | 218 | 271 | 221 |
| R3 | 165 | 200 | 191 |
| R4 | 216 | 187 | 213 |
| R5 | 236 | 232 | 211 |
| R6 | 173 | 158 | 258 |
| R6b | — | — | **156** |
| R7 | **123** | 157 | 200 |
| R8 | 150 | 161 | 174 |
| R8 Hybrid | — | — | **166** |
| R9 | 147 | **118** | 306 |

### Tool calls per round (system-level)

| Round | Standard | Auggie | Munch |
|-------|---------|--------|-------|
| R1 | 26 | 20 | 29 |
| R2 | 23 | 22 | 32 |
| R3 | 34 | 22 | 41 |
| R4 | 28 | 17 | 31 |
| R5 | 34 | 17 | 43 |
| R6 | 30 | 15 | 34 |
| R6b | — | — | 30 |
| R7 | 20 | 19 | 47 |
| R8 | 27 | 19 | 35 |
| R8 Hybrid | — | — | 24 |
| R9 | 34 | **8** | 58 |

### 8-Round Averages (R1-R8, excluding R6b and Hybrid)

| Method | Avg Tokens | vs Best | Avg Duration | Avg Tool Calls |
|--------|-----------|---------|-------------|---------------|
| **Standard** | **92,726** | baseline | **187s** | 27.8 |
| Munch | 99,231 | +7.0% | 197s | 36.0 |
| Auggie | 110,549 | +19.2% | 201s | 18.9 |

### Key insights from 9 rounds

1. **Standard won most rounds on avg tokens** — boosted by CLAUDE.md architecture overview in R7+R8 (80K range)
2. **Munch most consistent**: 86-106K range, zero Read calls, exact AST results
3. **Auggie R9b broke through** with batching: 70,586 (new record) — but 0 follow-ups key; R9c Munch needed 8
4. **Hybrid agent (R8)**: Munch for symbol queries + Grep for text = 70,508 tokens — best of both
5. **codebase_retrieval pattern**: The single biggest efficiency gain (per-task calls → batched calls)
6. **All 250+ task executions**: 10/10 quality (R9: 9/10) — tool choice never affected answer quality

---

**Current champion:** Auggie R9b, 70,586 tokens (5 batch calls, 0 follow-ups)
**CodeSift BM25 target:** ≤ 79,791 tokens (beat Munch R9c)
**CodeSift Hybrid target:** < 70,586 tokens (beat Auggie R9b)

---

## Semantic Queries (for T4, T10 specifically — architecture/conceptual tasks)

These tasks benefit most from semantic search. Expected queries for CodeSift Hybrid:

```json
[
  {"type": "semantic", "query": "authentication middleware session handling"},
  {"type": "semantic", "query": "document analysis pipeline flow"},
  {"type": "semantic", "query": "risk creation from AI analysis"},
  {"type": "call_chain", "symbol_name": "withAuth", "direction": "callees", "depth": 3},
  {"type": "context", "query": "document processing stages", "max_tokens": 2000}
]
```

---

## Scoring

**Primary metric:** total tokens (lower = better)
**Secondary metric:** tool calls (lower = better)
**Gate:** all tasks must be HIGH confidence + complete

When CodeSift Hybrid has fewer tokens AND fewer tool calls than Auggie → Phase 3 milestone achieved.
