# Implementation Plan: plan_turn Tool Routing Concierge

**Spec:** `docs/specs/2026-04-11-plan-turn-spec.md`
**spec_id:** 2026-04-11-plan-turn-1418
**planning_mode:** spec-driven
**plan_revision:** 1
**status:** Approved
**Created:** 2026-04-11
**Tasks:** 12
**Estimated complexity:** 10 standard, 2 complex

## Architecture Summary

Three production files + two test files + one benchmark fixture:

| Path | Purpose | Size |
|------|---------|------|
| `src/search/tool-ranker.ts` | BM25+semantic+WRR fusion ranker over TOOL_DEFINITIONS. 5 signals (lexical/identity/semantic/structural/framework). BM25 adapter (TOOL_DEFINITIONS→CodeSymbol shape). Cosine similarity. `generateReasoning` template. | ~200L |
| `src/tools/plan-turn-tools.ts` | Handler, inline regex parser, output formatter, edge-case guards, session integration. | ~250L |
| `tests/search/tool-ranker.test.ts` | Unit: WRR math, signal contributions, confidence caps, BM25-only fallback. | ~150L |
| `tests/tools/plan-turn.test.ts` | Unit: parser regex (8 cases), formatter, edge cases. Integration: real TOOL_DEFINITIONS on 5 queries. | ~200L |
| `tests/fixtures/plan-turn-benchmark.jsonl` | 30-query benchmark (spec §Validation). Separate runner. | ~100L |

## Technical Decisions

- **BM25 lifecycle:** Lazy build on first call, transient (module-level cache), fingerprint-based invalidation via `hash(TOOL_DEFINITIONS)`. No disk persistence — 86 tools rebuild in <1ms.
- **BM25 adapter:** Maps `ToolDefinition {name, description, searchHint, category}` → `CodeSymbol {name, docstring, source, signature}`. Adapter lives inside `tool-ranker.ts`, not in bm25.ts.
- **Embedding cache:** Reuse existing `src/storage/embedding-store.ts` with special cache key `"__tool_descriptions__"`. Path `~/.codesift/tool-embeddings.ndjson` (global, not per-repo). SHA-1 hex truncated to 16 chars fingerprint.
- **Batch strategy:** Cold start computes fingerprints for all tools, batch-embeds missing ones via `batchEmbed()` in single API call (~86 tools, well within 2s p95 budget).
- **Session state:** `getSessionState().negativeEvidence` for STOP_AND_REPORT_GAP, `getSessionState().queries` for already-used dedup. Direct reads, zero persistence cost.
- **Usage frequency:** `getUsageStats()` called once per session, cached as `Map<toolName, callCount>` at module level. Provides structural signal (cross-session, stronger than session-only).
- **Framework boost:** `detectAutoLoadTools(cwd)` already exported and async. Call once per plan_turn request, apply +0.6 flat boost to matching tools.
- **No new dependencies.** All primitives exist.

## Quality Strategy

- **CQ3 (input validation):** Parser guards against empty/oversized/malformed queries. Length cap at 1000 chars. Regex patterns anchored to avoid ReDoS.
- **CQ6 (unbounded data):** Output caps per spec §168-170 — tools ≤10, symbols ≤20, files ≤10. BM25 search explicit `topK: 30`. These caps MUST match across Architecture Summary, Quality Strategy, Task 7, and Task 9 (no drift).
- **CQ8 (error handling):** Embedding API failure → fall back to BM25-only (metadata.embedding_available=false). SessionState read failure → skip session features (metadata.session_queries_seen=0). Never throws — returns degraded result with error in metadata.
- **CQ14 (DRY):** BM25 adapter is the only new code, not a copy of buildBM25Index. Embedding logic reuses embedding-store. Session logic reuses session-state.
- **Test gap:** No existing tool-routing benchmarks. Creating one is part of this plan (Task 11).

## Task Breakdown

### Task 1: ToolDocument adapter + BM25 index builder
**Files:** `src/search/tool-ranker.ts`, `tests/search/tool-ranker.test.ts`
**Complexity:** standard
**Dependencies:** none

- [ ] RED: Test `buildToolBM25Index(TOOL_DEFINITIONS)` returns a `BM25Index` with one document per tool. Assert index size equals input length. Assert a specific tool (e.g. `"find_dead_code"`) can be retrieved via `searchBM25(index, "dead code", 10)` with score > 0.
- [ ] GREEN: Export `ToolDocument` interface (name, description, searchHint, category). Export `buildToolBM25Index(defs: ToolDefinition[]): BM25Index`. Internal adapter maps each ToolDefinition to a synthetic `CodeSymbol` with fields: `name=name`, `docstring=description`, `source=searchHint?.slice(0, 500) ?? ""`, `signature=category`. Calls existing `buildBM25Index()` from `src/search/bm25.ts:107`.
  Also export module-level cache:
  ```typescript
  let cachedIndex: BM25Index | null = null;
  let cachedFingerprint: string | null = null;
  export function getOrBuildToolBM25Index(defs: ToolDefinition[]): BM25Index
  ```
  `getOrBuildToolBM25Index` computes fingerprint via SHA-1 hex(16) of concatenated `name+description+searchHint`, rebuilds only on fingerprint mismatch.
- [ ] Verify: `npx vitest run tests/search/tool-ranker.test.ts`
  Expected: all new tests pass
- [ ] Acceptance: Spec §Tool Ranker, §D1
- [ ] Commit: `feat(plan-turn): BM25 index adapter for TOOL_DEFINITIONS`

### Task 2: WRR fusion ranker core (lexical + identity)
**Files:** `src/search/tool-ranker.ts`, `tests/search/tool-ranker.test.ts`
**Complexity:** standard
**Dependencies:** Task 1

- [ ] RED: Test `rankTools(query="find_dead_code", context)` returns `find_dead_code` at rank 1 with high confidence (>0.8) due to identity signal. Test `rankTools(query="dead code", context)` returns `find_dead_code` with lower but positive confidence via BM25 lexical. Test WRR weight contributions: lexical W=1.0, identity W=2.0 — identity match should outrank pure lexical.
- [ ] GREEN: Export:
  ```typescript
  interface ToolRankerContext {
    query: string;
    toolDefs: ToolDefinition[];
    embeddings: Map<string, number[]> | null;
    queryEmbedding: number[] | null;
    usageFrequency: Map<string, number>;
    frameworkTools: string[];
  }
  export function rankTools(ctx: ToolRankerContext): ToolRecommendation[]
  ```
  Implementation (lexical + identity signals only in this task):
  - Get BM25 candidates via `getOrBuildToolBM25Index(ctx.toolDefs)` then `searchBM25(index, ctx.query, 30)`
  - Apply W_LEXICAL=1.0 / (rank+1) for each BM25 hit
  - Apply W_IDENTITY=2.0 for exact query-token matches against `TOOL_NAMES_SET`
  - Semantic, structural, framework signals are stubs (no-op) in this task
  - Normalize scores to [0, 1] confidence
  - Return top-10 ToolRecommendation objects
- [ ] Verify: `npx vitest run tests/search/tool-ranker.test.ts -t "rankTools"`
  Expected: identity-match test asserts `find_dead_code` confidence ≥0.8; lexical-match test asserts it appears in top-5
- [ ] Acceptance: Spec §Tool Ranker lines 191-286
- [ ] Commit: `feat(plan-turn): WRR fusion lexical+identity signals`

### Task 3: WRR fusion — semantic + structural + framework signals
**Files:** `src/search/tool-ranker.ts`, `tests/search/tool-ranker.test.ts`
**Complexity:** complex
**Dependencies:** Task 2

- [ ] RED: Test semantic signal — with synthetic embeddings map where tool A has cosine=0.95 to query but NOT in BM25 top-30, A still appears in top-10 results (semantic-only surfacing). Test structural signal — tool B with highest usage frequency gets a boost. Test framework signal — tool C in `frameworkTools` list gets +0.6 flat boost. Test `BM25-only fallback` — if `embeddings=null`, ranker still returns valid results (no crash).
- [ ] GREEN: Extend `rankTools` with three additional signal loops:
  - **Semantic**: if `ctx.embeddings && ctx.queryEmbedding`, compute cosineSim for ALL tools (not just BM25 candidates), take top-10 semantic matches, inject scores `W_SEMANTIC=0.8 / (rank+1)`. Export helper `cosineSimilarity(a: number[], b: number[]): number`.
  - **Structural**: sort scored tools by `usageFrequency`, inject `W_STRUCTURAL=0.4 / (rank+1)` for top-10 frequent.
  - **Framework**: for each tool name in `ctx.frameworkTools`, add flat `W_FRAMEWORK=0.6`.
  - **Confidence calibration** (per spec §282-285): if vague query (query <15 chars AND <2 domain keywords), cap all confidences at 0.5 (vague_query flag). If single-keyword query (whitespace-split length === 1 AND not a file/symbol ref), cap at 0.6 (single_keyword flag). If BM25 score variance <0.1, cap at 0.4 (low_discrimination flag). All three caps apply in min(); lowest wins.
- [ ] Verify: `npx vitest run tests/search/tool-ranker.test.ts`
  Expected: all new signal tests pass, BM25-only fallback test passes
- [ ] Acceptance: Spec §D1 (hybrid ranking), §Tool Ranker full algorithm
- [ ] Commit: `feat(plan-turn): semantic + structural + framework signals`

### Task 4: generateReasoning template function
**Files:** `src/search/tool-ranker.ts`, `tests/search/tool-ranker.test.ts`
**Complexity:** standard
**Dependencies:** Task 3

- [ ] RED: Test `generateReasoning("find_dead_code", "find unused exports", signalsMap)` returns a string mentioning lexical match terms. Test output always non-empty (at least `"general match"` fallback). Test identity-match case returns `"exact name match"`. Test framework case returns `"relevant to <framework> stack"`.
- [ ] GREEN: Export internal `SignalWeights {lexical, identity, semantic, structural, framework, matchedTerms}` interface. Update `rankTools` to populate a `signals: Map<string, SignalWeights>` as it scores. Export `generateReasoning(id, query, signals)` with the exact template logic from spec §189-200 (identity → "exact name match", lexical >0.5 → keyword match list, semantic >0.7 → "semantic similarity", structural >0.3 → "high usage frequency", framework → "relevant to X stack", fallback → "general match"). Wire into `rankTools` so each `ToolRecommendation.reasoning` is populated.
- [ ] Verify: `npx vitest run tests/search/tool-ranker.test.ts -t "generateReasoning"`
  Expected: template tests pass; every ToolRecommendation in integration tests has non-empty reasoning
- [ ] Acceptance: Spec §D1 (reasoning field), §Tool Ranker
- [ ] Commit: `feat(plan-turn): template-based reasoning generation`

### Task 5: Tool embedding cache integration
**Files:** `src/search/tool-ranker.ts`, `tests/search/tool-ranker.test.ts`
**Complexity:** complex
**Dependencies:** Task 3

- [ ] RED: Test `getToolEmbeddings(TOOL_DEFINITIONS)` — mock `batchEmbed` and `loadEmbeddings`/`saveEmbeddings`. First call: cache miss → `batchEmbed` called with all tool descriptions. Second call with same defs: cache hit → `batchEmbed` NOT called. Add new tool: only new tool re-embedded. Test `getToolEmbeddings` returns null when `CODESIFT_OPENAI_API_KEY` and `CODESIFT_VOYAGE_API_KEY` both absent.
- [ ] GREEN: Export `async function getToolEmbeddings(defs: ToolDefinition[]): Promise<Map<string, number[]> | null>`. Implementation:
  - Compute per-tool fingerprint: `sha1(name + description + (searchHint ?? "")).hex(16)`
  - Load existing embeddings from `~/.codesift/tool-embeddings.ndjson` via `loadEmbeddings("__tool_descriptions__")` (or equivalent path helper)
  - Identify tools whose fingerprint is missing
  - If any missing AND API key available: batch-embed descriptions via `batchEmbed()`, save result via `saveEmbeddings()`
  - If no API key: return null (caller switches to BM25-only)
  - Return Map<toolName, vector> for all tools in current defs
- [ ] Verify: `npx vitest run tests/search/tool-ranker.test.ts -t "getToolEmbeddings"`
  Expected: all cache-behavior tests pass
- [ ] Acceptance: Spec §D1 (embedding cache, fingerprint invalidation, graceful degradation)
- [ ] Commit: `feat(plan-turn): tool embedding cache with incremental updates`
- [ ] **Early quality checkpoint (smoke benchmark):** Before moving to Task 6, write a 5-query smoke benchmark inline in `tests/search/tool-ranker.test.ts`: 5 representative queries (e.g. "find dead code", "trace API route", "audit dependencies", "analyze complexity", "find clones") paired with expected top-5 tool sets. Assert Recall@5 ≥0.6 on this smoke set (lower bar than final 0.7 — we only have 5 queries, not 30, and semantic may be disabled without API key). Measure cold-call latency, assert <2s. **If smoke fails, stop and investigate ranker quality BEFORE building the handler.** This front-loads the highest-uncertainty gate to catch ranking failures early.

### Task 6: Query parser (regex structural)
**Files:** `src/tools/plan-turn-tools.ts`, `tests/tools/plan-turn.test.ts`
**Complexity:** standard
**Dependencies:** none

- [ ] RED: Test `parseQuery("find slow queries", index)` returns ParsedQuery with `original="find slow queries"`, `normalized="find slow queries"`, `intents: ["find slow queries"]`, `file_refs: []`, `symbol_refs: []`, `is_vague: false`, `truncated: false`. Test multi-intent: `parseQuery("audit deps AND refactor auth", index)` returns 2 intents. Test file ref: `parseQuery("review src/auth.ts", index)` puts `"src/auth.ts"` in file_refs. Test symbol ref: `parseQuery("trace createUser", index)` with `createUser` in index.symbols puts it in symbol_refs. Test vague: `parseQuery("help", index)` returns `is_vague: true`. Test truncation: 2000-char input truncated, normalized capped at 1000 chars, `truncated: true`. Test empty: `parseQuery("", index)` returns empty intents, flagged vague. Test regex safety: `parseQuery("handleANDGate", index)` does NOT split on "AND" (whitespace required).
- [ ] GREEN: Export (match spec §128 exactly — snake_case):
  ```typescript
  interface ParsedQuery {
    original: string;
    normalized: string;        // lowercased, trimmed, capped at 1000 chars
    truncated: boolean;        // true if original.length > 1000
    intents: string[];         // split sub-queries (1 if no multi-intent)
    file_refs: string[];       // extracted file paths
    symbol_refs: string[];     // extracted symbol names (cross-ref'd against index.symbols)
    is_vague: boolean;         // length < 15 AND < 2 domain keywords
  }
  export function parseQuery(raw: string, index: CodeIndex): ParsedQuery
  ```
  Implementation (per spec §336-355):
  - `original = raw`; `truncated = raw.length > 1000`
  - `normalized = raw.slice(0, 1000).toLowerCase().trim()`
  - If normalized is empty or whitespace-only: return vague result with empty arrays
  - Multi-intent split: `normalized.split(/\s+(?:and|or|;|&&)\s+/i)` — anchored whitespace both sides
  - File ref regex: `/\b[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|php|kt|sql)\b/g`
  - Symbol ref: extract tokens matching `/\b[a-zA-Z_][a-zA-Z0-9_]{2,}\b/g`, then filter by `index.symbols.some(s => s.name === token)` — parser receives CodeIndex to enable cross-ref
  - Vague detection: normalized.length <15 AND wordCount <3 AND no domain keywords from `VAGUE_STOPWORDS` set
  - Spec §128 uses `original` (raw input, unmodified) — needed by negative-evidence matcher to hash the exact string the user submitted, since normalization is lossy.
- [ ] Verify: `npx vitest run tests/tools/plan-turn.test.ts -t "parseQuery"`
  Expected: 7 parser tests pass
- [ ] Acceptance: Spec §D2 (regex-only parsing), §Input Parser lines 287-330
- [ ] Commit: `feat(plan-turn): regex structural query parser`

### Task 7: plan_turn handler + session integration
**Files:** `src/tools/plan-turn-tools.ts`, `tests/tools/plan-turn.test.ts`
**Complexity:** complex
**Dependencies:** Tasks 4, 5, 6

- [ ] RED: Test `planTurn(repo, "find dead code")` returns PlanTurnResult with non-empty tools[], `metadata.duration_ms > 0`, `metadata.embedding_available` boolean. Test STOP_AND_REPORT_GAP: seed SessionState.negativeEvidence with normalized form of query, assert next call returns `gap_analysis.action === "STOP_AND_REPORT_GAP"`. Test already_used dedup: seed SessionState.queries with prior `find_dead_code` call, assert it appears in `already_used[]` not `tools[]`. Test unindexed repo: returns `{error: "repo_not_indexed"}` without throwing.
- [ ] GREEN: Export `async function planTurn(repo: string, query: string, options?: PlanTurnOptions): Promise<PlanTurnResult>`. Implementation:
  - Guard: `getCodeIndex(repo)` — if null, return structured error
  - Parse query via `parseQuery(query)`
  - Build ToolRankerContext: `getSessionState()` for session data, `getUsageStats()` cached Map, `detectAutoLoadTools(cwd)` for framework boost, `getToolEmbeddings(TOOL_DEFINITIONS)` for semantic
  - Call `rankTools(ctx)` for each intent, merge/dedup results
  - Normalize current query to check against `negativeEvidence`: `query.trim().toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s]/g, "")`
  - If normalized match found with `result_count === 0`: populate `gap_analysis` field
  - Read `SessionState.queries` to build `already_used[]`, remove those entries from primary `tools[]` unless top-3
  - Populate metadata: `intents_detected`, `bm25_candidates`, `embedding_available`, `session_queries_seen`, `duration_ms`, plus conditional edge flags (truncated, vague_query, stale_index, low_discrimination, framework_mismatch, cold_start)
  - Enforce output caps per spec §168-170: tools ≤10, **symbols ≤20**, files ≤10, always at least 1 tool (fallback `discover_tools`)
  - Populate `reveal_required[]` for hidden tools in result
- [ ] Verify: `npx vitest run tests/tools/plan-turn.test.ts -t "planTurn"`
  Expected: happy path + STOP_AND_REPORT_GAP + dedup + error cases pass
- [ ] Acceptance: Spec §Solution Overview, §Data Model, §D3 (Session Level 2), §Ship Criteria 1-12
- [ ] Commit: `feat(plan-turn): main handler with session awareness`

### Task 8: Register plan_turn in TOOL_DEFINITIONS
**Files:** `src/register-tools.ts`, `tests/tools/plan-turn.test.ts`
**Complexity:** standard
**Dependencies:** Task 7

- [ ] RED: Test plan_turn is in TOOL_DEFINITIONS with `category: "discovery"` (per spec §383), searchHint populated, schema declares `query` (required) and optional params. Test `CORE_TOOL_NAMES.has("plan_turn") === true`. Test `discover_tools({query: "plan turn routing"})` surfaces plan_turn in top-5 results. Test ToolCategory union includes `"discovery"` literal.
- [ ] GREEN: Add import `import { planTurn } from "./tools/plan-turn-tools.js";`. Add TOOL_DEFINITIONS entry:
  ```typescript
  {
    name: "plan_turn",
    category: "discovery",  // per spec §383 — new category for routing tools
    searchHint: "plan turn routing recommend tools symbols files gap analysis session aware concierge",
    description: "Routes a natural-language query to the most relevant CodeSift tools, symbols, and files. Uses hybrid BM25+semantic ranking with session-aware dedup. Call at the start of a task to get a prioritized action list.",
    schema: { /* see spec §API Surface */ },
    handler: async (args) => { /* call planTurn, format output */ }
  }
  ```
  Add `"plan_turn"` to `CORE_TOOL_NAMES` Set. If `"discovery"` is not yet in the `ToolCategory` union type, add it.
- [ ] Verify: `npx vitest run tests/tools/plan-turn.test.ts -t "registration"`
  Expected: registration tests pass
- [ ] Acceptance: Ship Criteria #12 (plan_turn registered in CORE_TOOL_NAMES)
- [ ] Commit: `feat(plan-turn): register as core MCP tool`

### Task 9: Output formatter + edge case guards
**Files:** `src/tools/plan-turn-tools.ts`, `tests/tools/plan-turn.test.ts`
**Complexity:** standard
**Dependencies:** Task 7

- [ ] RED: Test empty result still returns `tools: [{name: "discover_tools", ...}]`. Test >10 tools get capped. Test >20 symbols get capped. Test hidden tools populate `reveal_required[]`. Test vague query caps confidence at 0.5 and sets metadata flag. Test single-keyword query caps at 0.55. Test stale_index flag fires when index.updated_at >5min ago. Test framework_mismatch flag fires for "audit Rust" query on TypeScript repo.
- [ ] GREEN: Extract `formatPlanTurnResult()` helper in plan-turn-tools.ts. Apply guards in order:
  - If tools.length === 0: append `{name: "discover_tools", confidence: 0.3, reasoning: "No direct matches, fall back to explicit search"}`
  - Cap tools at 10, symbols at 20, files at 10 (per spec §168-170)
  - Extract hidden tool names (`!CORE_TOOL_NAMES.has(name)`) into `reveal_required[]`
  - Compute edge flags and populate metadata
  - Round confidences to 2 decimal places
- [ ] Verify: `npx vitest run tests/tools/plan-turn.test.ts -t "formatter"`
  Expected: all guard tests pass
- [ ] Acceptance: Ship Criteria #3, #4, #6, #7; §Edge Cases table
- [ ] Commit: `feat(plan-turn): output formatter with edge-case guards`

### Task 10: Integration test on real TOOL_DEFINITIONS
**Files:** `tests/tools/plan-turn.test.ts`
**Complexity:** standard
**Dependencies:** Task 9

- [ ] RED: Integration test suite with 5 representative queries: (1) "find dead code" → find_dead_code in top-3, (2) "find slow queries" → find_perf_hotspots in top-5, (3) "" → suggest_queries in tools, (4) "audit deps AND refactor auth" → multi-intent, ≥1 tool per intent, (5) "review src/register-tools.ts" → file ref path appears in files[]. All assertions run against real TOOL_DEFINITIONS import (not mocked).
- [ ] GREEN: No new production code. Wire up integration tests using the real TOOL_DEFINITIONS import. Mock only `getCodeIndex`, `getToolEmbeddings` (return null to force BM25-only path — avoids API key requirement), `getUsageStats`, `detectAutoLoadTools`, `getSessionState`.
- [ ] Verify: `npx vitest run tests/tools/plan-turn.test.ts -t "integration"`
  Expected: all 5 integration tests pass on BM25-only path
- [ ] Acceptance: Success Criteria #1 (Recall@5 validation proxy), Ship Criteria #5
- [ ] Commit: `test(plan-turn): integration tests against real TOOL_DEFINITIONS`

### Task 11: Benchmark fixture + runner script
**Files:** `tests/fixtures/plan-turn-benchmark.jsonl`, `scripts/run-plan-turn-benchmark.ts`
**Complexity:** standard
**Dependencies:** Task 10

- [ ] RED: (no test file — benchmark is a measurement tool, not a test). Instead: assert the fixture file has exactly 30 entries, each with `query` and `expected_tools[]` fields, via a lightweight structural check in the runner.
- [ ] GREEN: Create `tests/fixtures/plan-turn-benchmark.jsonl` with 30 queries from spec §Validation. Each line is a JSON object:
  ```json
  {"query": "find dead code", "expected_tools": ["find_dead_code", "find_unused_imports"]}
  {"query": "trace an API endpoint", "expected_tools": ["trace_route", "find_and_show"]}
  {"query": "audit dependencies", "expected_tools": ["dependency_audit"]}
  ...
  ```
  Create `scripts/run-plan-turn-benchmark.ts` — reads fixture, runs `planTurn` for each query, computes Recall@5 (1 if any expected tool in top-5 else 0), reports aggregate `hits / 30`, logs p50/p95 latency for cold/warm. Separate from vitest — run via `npx tsx scripts/run-plan-turn-benchmark.ts`. Document in script header that BM25-only path runs without API key; semantic path requires `CODESIFT_OPENAI_API_KEY` or `CODESIFT_VOYAGE_API_KEY`.
- [ ] Verify: `npx tsx scripts/run-plan-turn-benchmark.ts` (BM25-only path)
  Expected: reports Recall@5 ≥ 0.70 (Success Criteria #1), prints p50/p95 latency
- [ ] Acceptance: Success Criteria #1, §Validation Methodology
- [ ] Commit: `test(plan-turn): 30-query benchmark with Recall@5 runner`

### Task 12: Docs + metadata sync
**Files:** `CLAUDE.md`, `README.md`, `rules/codesift.md`, `rules/codesift.mdc`, `rules/codex.md`, `rules/gemini.md`, `src/instructions.ts`
**Complexity:** standard
**Dependencies:** Task 11

- [ ] RED: Test tool count in `src/instructions.ts` matches `TOOL_DEFINITIONS.length`. Test `CORE_TOOL_NAMES.size` matches the count stated in `CLAUDE.md` Architecture section. Add a guard test in `tests/instructions.test.ts` if not present.
- [ ] GREEN: Update 7 files with +1 tool, +1 core, new category `discovery`:
  - `src/instructions.ts` — bump counts in CODESIFT_INSTRUCTIONS header (e.g. "161 MCP tools, 48 core, 113 hidden"); add H# hint entry if plan_turn deserves one (optional, decide at task time)
  - `CLAUDE.md` — Architecture section tool count, new `plan-turn-tools.ts` file entry, add `discovery` category to the list
  - `README.md` — tool count in hero, MCP tools table add plan_turn row, "When to use" table add entry `plan_turn` → "Starting a task, don't know which tool to use"
  - `rules/codesift.md`, `rules/codesift.mdc`, `rules/codex.md`, `rules/gemini.md` — tool count in Tool Discovery section, add plan_turn to Tool Mapping table (category: `discovery`, description: "NL query → routing recommendation")
- [ ] Verify: `grep -rn "159 MCP\|159 tools\|160 MCP\|160 tools" src/ rules/ CLAUDE.md README.md` returns zero stale entries after update. `npx vitest run tests/instructions.test.ts` passes.
- [ ] Acceptance: documentation parity — no drift between code count and docs
- [ ] Commit: `docs(plan-turn): update tool counts and add to rules tables`

## Verification

After all 12 tasks:
1. `npx vitest run tests/search/tool-ranker.test.ts tests/tools/plan-turn.test.ts` — all tests pass
2. `npx tsx scripts/run-plan-turn-benchmark.ts` — Recall@5 ≥0.70, p95 warm ≤200ms (BM25-only), cold ≤2s (semantic)
3. `npm run build` — zero TypeScript errors
4. Manual: start MCP server, call `discover_tools(query="plan turn")`, verify plan_turn surfaces, call `plan_turn(query="audit this repo")` on real repo, verify non-empty tools[] with reasoning
5. No stale tool count references in docs (verified in Task 12)
