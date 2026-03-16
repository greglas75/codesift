# Runbook: CodeSift Benchmarks

**When to use:** After any code change to CodeSift server (tools, response format, search logic) to verify no token regression.
**Time required:** ~5 minutes per run
**Who can run this:** Anyone with Claude Code + CodeSift MCP configured
**Risk level:** Low (read-only — no data mutations)

## Prerequisites

- [ ] CodeSift MCP server running with `local/promptvault` indexed (18,800+ symbols)
- [ ] Project built: `npm run build` (changes must be compiled)
- [ ] Claude Code installed with CodeSift MCP configured

## How It Works

Each benchmark round launches a **fresh Claude Code sub-agent** (Sonnet 4.6) that:

1. Answers 10 code navigation tasks (T1-T10) about the `promptvault` codebase
2. Uses ONLY `mcp__codesift__codebase_retrieval` (batched queries)
3. Reports `total_tokens` from the agent's usage stats

**Primary metric:** `total_tokens` (lower = better) — includes system prompt (~45K fixed) + tool output + model reasoning.
**Secondary metric:** quality score (0-10 per task).
**Gate:** all tasks HIGH confidence + complete.

## Tasks (T1-T10)

| ID | Task | Type |
|----|------|------|
| T1 | Find `createRisk` definition + params + return type | Find function |
| T2 | Find ALL files importing from risk service | Find usages |
| T3 | Find `DocumentDetail` type fields | Understand type |
| T4 | Trace `withAuth` middleware logic | Trace middleware |
| T5 | Find all Zod schemas in API routes | Find pattern |
| T6 | Analyze `RiskPanel` component props + hooks | Component analysis |
| T7 | Find `ENTITY_NOT_FOUND` definition + all references | Error codes |
| T8 | List all risk API routes + HTTP methods | API routes |
| T9 | Find all `prisma.$transaction` usages | Cross-cutting |
| T10 | Trace document analysis pipeline architecture | Architecture trace |
| T11 | Find dead/unused exports in `src/lib/services` | Dead code (find_dead_code) |
| T12 | Find top 5 most complex functions in codebase | Complexity (analyze_complexity) |
| T13 | Check for circular dependencies in `src/lib/services` | Circular deps (get_knowledge_map) |
| T14 | Generate Mermaid diagram of `analyzeDocument` callees depth 2 | Visualization (trace_call_chain mermaid) |

## Steps

### Step 1: Build the project

```bash
cd ~/DEV/codesift-mcp
npm run build
```

**Expected:** No errors. Changes compiled to `dist/`.

### Step 2: Verify promptvault is indexed

In Claude Code, call:
```
mcp__codesift__list_repos()
```

Verify `local/promptvault` appears with 18,000+ symbols.

### Step 3: Launch benchmark agent

Use the Agent tool with these EXACT parameters:

```
Agent(
  model: "sonnet",
  description: "Benchmark R[N] CodeSift",
  prompt: <see Agent Prompt below>
)
```

### Step 4: Record results

From the agent's response, record:
- `total_tokens` from `<usage>` block
- `tool_uses` count
- `duration_ms`
- Per-task quality (0-10)

### Step 5: Write benchmark report

Create `benchmarks/benchmark-R[N]-YYYY-MM-DD.md` using the format from previous rounds (see Template section).

## Agent Prompt

Copy this EXACTLY. Do not modify the sub-queries — they are tuned across 36 rounds.

### Variant A: Core tasks only (T1-T10) — comparable with R10-R36

```
You are a benchmark agent. Answer T1-T10 about promptvault using ONLY mcp__codesift__ tools.

CRITICAL RULES:
1. First call: ToolSearch(query="codesift codebase_retrieval", max_results=3) to load the tool schema
2. Make EXACTLY 2 calls to mcp__codesift__codebase_retrieval (Call A + Call B)
3. NO other tool calls — no list_repos, no search_text, no Read, no Grep
4. Answer in form style (key:value, max 2 lines per task)
5. Do NOT use Bash, Read, Grep, or any other tool

Call A — tasks T1, T3, T4, T5:
mcp__codesift__codebase_retrieval(
  repo="local/promptvault",
  queries=[
    {"type": "symbols", "query": "createRisk", "top_k": 5, "include_source": true},
    {"type": "symbols", "query": "DocumentDetail", "top_k": 5, "include_source": true},
    {"type": "symbols", "query": "withAuth", "top_k": 5, "include_source": true},
    {"type": "text", "query": "z.object", "file_pattern": "**/route.ts", "max_results": 7}
  ],
  token_budget=20000
)

Call B — tasks T2, T6, T7, T8, T9, T10:
mcp__codesift__codebase_retrieval(
  repo="local/promptvault",
  queries=[
    {"type": "text", "query": "risk.service", "file_pattern": "*.ts", "max_results": 7},
    {"type": "symbols", "query": "RiskPanel", "top_k": 5, "include_source": true},
    {"type": "text", "query": "ENTITY_NOT_FOUND", "max_results": 7},
    {"type": "text", "query": "risks", "file_pattern": "**/route.ts", "max_results": 7},
    {"type": "text", "query": "prisma.$transaction", "file_pattern": "*.service.ts", "max_results": 20},
    {"type": "semantic", "query": "document analysis pipeline upload parse AI risks"}
  ],
  token_budget=20000
)

After both calls, report per-call token cost (estimate: response JSON length / 4), then answer:

TOKENS PER CALL:
Call A: [N] tok
Call B: [N] tok

ANSWERS:
T1: [params + return type]
T2: [file list]
T3: [fields]
T4: [middleware chain]
T5: [schema names + files]
T6: [props + hooks]
T7: [definition + throw sites]
T8: [routes + methods]
T9: [every file:line with $transaction]
T10: [pipeline stages]
```

### Variant B: Full suite (T1-T14) — includes new analysis tools

Adds Calls C-I for T11-T18 (all new analysis tools).
Uses direct tool calls (not codebase_retrieval) since these are standalone tools.

```
You are a benchmark agent. Answer T1-T18 about promptvault using ONLY mcp__codesift__ tools.

CRITICAL RULES:
1. First: ToolSearch(query="codesift", max_results=30) to load ALL tool schemas
2. Call A + Call B: same as Variant A (for T1-T10)
3. Call C: mcp__codesift__find_dead_code(repo="local/promptvault", file_pattern="src/lib/services")
4. Call D: mcp__codesift__analyze_complexity(repo="local/promptvault", top_n=5, min_complexity=5)
5. Call E: mcp__codesift__get_knowledge_map(repo="local/promptvault", focus="src/lib/services")
6. Call F: mcp__codesift__trace_call_chain(repo="local/promptvault", symbol_name="analyzeDocument", direction="callees", depth=2, output_format="mermaid")
7. Call G: mcp__codesift__find_clones(repo="local/promptvault", file_pattern="src/lib/services", min_similarity=0.7)
8. Call H: mcp__codesift__analyze_hotspots(repo="local/promptvault", since_days=90, top_n=10)
9. Call I: mcp__codesift__search_patterns(repo="local/promptvault", pattern="empty-catch")
10. Call J: mcp__codesift__get_context_bundle(repo="local/promptvault", symbol_name="createRisk")
11. NO other tool calls. Answer in form style.

After all calls, report per-call token cost (estimate: response JSON length / 4), then answer:

TOKENS PER CALL:
Call A: [N] tok
Call B: [N] tok
Call C (find_dead_code): [N] tok
Call D (analyze_complexity): [N] tok
Call E (get_knowledge_map): [N] tok
Call F (trace_call_chain): [N] tok
Call G (find_clones): [N] tok
Call H (analyze_hotspots): [N] tok
Call I (search_patterns): [N] tok
Call J (get_context_bundle): [N] tok

ANSWERS:
T1-T10: [same as Variant A]
T11: [dead exports — name, file, kind]
T12: [top 5 complex functions — name, file, cyclomatic_complexity, nesting]
T13: [circular deps — cycle paths or "none"]
T14: [Mermaid diagram verbatim]
T15: [code clones — pairs + similarity, or "none"]
T16: [top 10 hotspot files — file, commits, churn_score]
T17: [empty-catch matches — name, file, line]
T18: [context: imports, siblings, types_used]
```

### Which variant to use

- **After server-side changes** (response format, search logic): use Variant A — comparable with R10-R36
- **After adding new tools** (find_dead_code, analyze_complexity, etc.): use Variant B — validates new functionality
- **Release benchmark**: run both variants

## Historical Baselines

| Round | Date | Tokens | Quality | Calls | Notes |
|-------|------|--------|---------|-------|-------|
| R10 | 2026-03-13 | 84,051 | 9/10 | 25 | First CodeSift run (BM25 only) |
| R18 | 2026-03-13 | 69,179 | 9.1/10 | 11 | Best quality, 2 calls |
| R23 | 2026-03-14 | 69,161 | 8.3/10 | 4 | Proved tool call overhead ~0 |
| R26 | 2026-03-14 | 50,483 | 7.5/10 | ~4 | Lowest tokens (form answers, top_k=3) |
| **R27** | **2026-03-14** | **51,081** | **8.5/10** | **~4** | **Champion — best quality/token ratio** |
| R36 | 2026-03-14 | 51,076 | 6.8/10 | 2 | Auggie comparison (for reference) |
| R38 | 2026-03-16 | 66,184 | 8.5/10 | 4 | Post-optimization (no embeddings) |
| R40 | 2026-03-16 | 60,801 | 9.5/10 | 13 | Post-optimization (with embeddings, T1-T10 only) |
| R41 | 2026-03-16 | 87,465 | ~6/14 | 16 | First T1-T14 run. T11,T12=0 (tools not loaded). T13=10, T14=3 |
| **R42** | **2026-03-16** | **111,865** | **~8.8/18** | **30** | **First T1-T18 promptvault. All new tools working. T16=3 (git issue)** |
| **R43** | **2026-03-16** | **108,485** | **~9.0/18** | **25** | **First T1-T18 tgm-survey-platform. T12: complexity=92! T15: 11 clones. T16=0 (shallow clone)** |

## Report Template

```markdown
# Benchmark R[N]: [Title]

**Date:** YYYY-MM-DD
**Project:** promptvault (Next.js 14+, TypeScript, Prisma)
**Model:** Claude Sonnet 4.6
**Index:** CodeSift [N] symbols / [N] chunks

## Changes from R[N-1]

[What changed in the server code since last run]

## Results

| Metric | R[N] | R27 (baseline) |
|--------|------|----------------|
| **Total tokens** | | 51,081 |
| **Quality** | /10 | 8.5/10 |
| **Tool calls** | | ~4 |

### Per-task quality + tokens

| Task | Score | Tokens | Notes |
|------|-------|--------|-------|
| T1 | /10 | | |
| T2 | /10 | | |
| T3 | /10 | | |
| T4 | /10 | | |
| T5 | /10 | | |
| T6 | /10 | | |
| T7 | /10 | | |
| T8 risk routes | /10 | 8/10 | |
| T9 $transaction | /10 | 5/10 | |
| T10 pipeline | /10 | 9/10 | |

## Key Findings

[What improved/regressed and why]
```

## Token Budget Breakdown

Understanding where tokens come from (from R23 analysis):

| Component | ~Tokens | Controllable? |
|-----------|---------|---------------|
| System prompt + conversation | ~45,000 | No (Claude Code fixed) |
| Tool output (codebase_retrieval) | ~19,500 | **Yes — server changes affect this** |
| Model answers + reasoning | ~4,500 | Partially (prompt engineering) |
| **Total** | **~69,000** | |

Server-side optimizations (list_repos compact, search_symbols cleanup) reduce the "Tool output" component. The ~45K system prompt is fixed overhead.

## Troubleshooting

**Agent makes more than 2 codebase_retrieval calls:**
The agent prompt must be strict. Key phrases: "EXACTLY 2 calls", "NO other tool calls". If the agent still deviates, it means the prompt is too loose — tighten constraints.

**Agent calls ToolSearch/list_repos first:**
Include "NO list_repos" in the prompt. Pre-bake the repo name `local/promptvault`.

**Token count much higher than ~51K:**
Check if the agent added extra calls. The `tool_uses` in the usage block should be 3-4 (1 ToolSearch + 2 codebase_retrieval). If >6, the agent deviated from the prompt.

**Quality drops on T9 ($transaction):**
T9 is the hardest task — text search returns test mocks before production files. Use `file_pattern: "*.service.ts"` in the sub-query to exclude tests.

**T11/T12 return "tool not available" (Variant B):**
New tools (`find_dead_code`, `analyze_complexity`) require MCP server restart after `npm run build`. Run `/mcp` in Claude Code to reconnect, then re-run the benchmark.

**T14 mermaid doesn't work:**
The `output_format` parameter was added after the tool schema was cached. Restart MCP (`/mcp`) so ToolSearch returns the updated schema with `output_format`.

## Verification

After running, compare:
- **Tokens vs R27 (51,081):** within +/- 5K = normal variance. >5K regression = investigate.
- **Quality vs R27 (8.5/10):** within +/- 1 point = normal. >2 point drop = regression.

<!-- Evidence Map
| Section | Source file(s) |
|---------|---------------|
| Tasks T1-T10 | benchmarks/benchmark-template-promptvault.md:22-33 |
| Agent prompt | Derived from R27 call structure (benchmark-R27-2026-03-14.md:27-30) |
| Historical baselines | benchmark-R10/R18/R23/R26/R27 files |
| Token breakdown | benchmark-R23-2026-03-14.md:66-73 |
| Report template | Pattern from all benchmark-R*.md files |
| Troubleshooting | Derived from R37 run (77K due to extra calls) and R23 analysis |
-->
