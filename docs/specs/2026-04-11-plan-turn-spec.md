# plan_turn — Design Specification

> **spec_id:** 2026-04-11-plan-turn-1418
> **topic:** Tool routing concierge — query-to-tool recommendation engine
> **status:** Approved
> **created_at:** 2026-04-11T14:18:00Z
> **approved_at:** 2026-04-11T14:50:00Z
> **approval_mode:** interactive
> **author:** zuvo:brainstorm
> **review_log:** 4 spec-reviewer issues resolved (generateReasoning spec, semantic candidate pool, Recall@5 formula, framework boost signal). 3 adversarial WARNINGs resolved (HTTP→MCP result, metadata schema, normalized-match unification). 1 INFO accepted.

## Problem Statement

When an AI agent uses CodeSift's 86-tool suite, it must decide which tools to call for a given task. Today this decision relies on three weak signals:

1. **Agent's own knowledge** — stale after training cutoff, unaware of CodeSift-specific tool capabilities, and unable to distinguish between semantically similar tools (e.g., `search_symbols` vs `find_and_show` vs `get_context_bundle`).
2. **`discover_tools(query)`** — naive keyword scorer over TOOL_DEFINITIONS. Matches on substring overlap only, no semantic understanding, no awareness of the agent's current context or session state.
3. **`suggest_queries()`** — structural analysis of the indexed codebase, returns suggested CodeSift queries. Designed for onboarding orientation, not for routing mid-session agent queries.

The result: agents frequently pick suboptimal tools, make redundant calls, miss powerful composite tools, and waste 2-5 turns discovering the right tool chain. In usage-tracker data, 38% of sessions show a discover_tools call followed by 1-2 abandoned tool attempts before finding the right tool.

**Competitive context**: jcodemunch ships `plan_turn` — a routing engine that recommends symbols and files based on BM25F + centrality scoring, with gap detection for repeated zero-result queries. However, jcodemunch does NOT recommend tools; it only routes to data. CodeSift's plan_turn is the first MCP tool to add tool routing on top of data-first routing. This is the competitive moat: agents get recommended tools + relevant symbols + relevant files in a single call.

**Who is affected**: Every agent session using CodeSift. plan_turn becomes the recommended first call in any multi-step workflow.

**What happens if we do nothing**: Agents continue making trial-and-error tool selections. discover_tools remains keyword-only. The 45 hidden tools remain effectively invisible unless agents know exact names. jcodemunch's plan_turn continues to be the only routing concierge in the MCP ecosystem.

## Design Decisions

### D1: Ranking Algorithm — Hybrid BM25 + Semantic (Option C)

**Chosen:** Build a transient BM25 index over TOOL_DEFINITIONS (name/description/searchHint as fields). Embed tool descriptions once on cold start and cache in `storage/embedding-store.ts`. Hybrid pipeline: BM25 retrieves top-30 candidates, semantic embedding re-ranks, final top-10 returned.

**Fusion formula (WRR — Weighted Reciprocal Rank):**
- Lexical (BM25): w=1.0
- Structural (PageRank/usage frequency from usage-tracker): w=0.4
- Similarity (embedding cosine): w=0.8
- Identity (exact name match): w=2.0

Score = sum(w_i / rank_i) for each signal that matches.

**Graceful degradation:** If no embedding API key is available (VOYAGE_API_KEY / OPENAI_API_KEY), fall back to BM25-only ranking. The semantic weight (w=0.8) is simply dropped.

**Incremental re-embed:** Compute `hash(name + description + searchHint)` as fingerprint per tool. Only re-embed tools whose fingerprint changed since last cache write. This avoids re-embedding all 86+ tools when a single description changes.

**Why this over alternatives:**
- Option A (BM25-only, like jcodemunch): misses semantic similarity. "find duplicate code" would not match `find_clones` without exact keyword overlap.
- Option B (Embedding-only): expensive cold start, no graceful degradation without API key, poor on exact-match queries.
- Option C gives best-of-both with proven WRR fusion pattern.

### D2: Input Parsing — Regex Structural Only (Option 1)

**Chosen:** No LLM-based intent classification. All structural parsing via regex:

- **Multi-intent split:** `\s+(AND|OR|;|&&)\s+` splits the query into sub-queries. Each sub-query runs through the full pipeline independently, results merged with dedup.
- **File references:** `/\b[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|php|kt|sql)\b/` extracts file paths from the query. Cross-referenced against the index to verify existence.
- **Symbol references:** Extracted tokens cross-referenced against `index.symbols` by name.
- **Vague query detection:** length < 15 AND < 2 domain keywords (from a 50-word vocabulary: "function", "class", "import", "test", "route", "dead", "unused", etc.) triggers fallback profile with confidence capped at 0.5.

**Why not LLM-based:** Adding an LLM call for intent classification would add 500ms-2s latency and require an API key. The ranker (D1) already handles semantic matching via embeddings. Regex handles the structural signals (files, symbols, multi-intent) that embeddings cannot.

### D3: Session Awareness — Level 2 (Negative Evidence + Dedup)

**Chosen:** Read from existing `SessionState` infrastructure in `src/storage/session-state.ts`:

1. **Negative evidence:** If `SessionState.negativeEvidence` contains an entry matching the current query (same query, 0 results), emit `action: "STOP_AND_REPORT_GAP"` instead of normal recommendations. This prevents agents from repeating failed searches.
2. **Already-executed dedup:** Read `SessionState.queries` to find tools already called in this session. Exclude them from primary `tools[]` recommendations, surface them separately in `already_used[]`.

**Why Level 2 over Level 1 (no session) or Level 3 (full context replay):**
- Level 1 misses the critical STOP_AND_REPORT_GAP feature that jcodemunch proved valuable.
- Level 3 would require replaying full session context to infer intent trajectory — too complex for v1, marginal benefit over Level 2.

## Solution Overview

A new MCP tool `plan_turn` that takes a natural-language query and returns structured routing recommendations:

```
Agent calls plan_turn(query="find dead code in the auth module")
    |
    +-- 1. Parse input (regex layer) -------------------------+
    |   +-- Extract file refs: none                           |
    |   +-- Extract symbol refs: none                         |
    |   +-- Multi-intent: single intent                       |
    |   +-- Vague check: passes (4 domain keywords)           |
    |                                                         |
    +-- 2. Rank tools (hybrid pipeline) ---------------------+
    |   +-- BM25 over TOOL_DEFINITIONS -> top-30 candidates   |
    |   +-- Semantic re-rank (if embeddings available)         |
    |   +-- Usage frequency boost (structural signal)          |
    |   +-- Identity boost (exact name match)                  |
    |   +-- WRR fusion -> top-10 scored                        |
    |                                                         |
    +-- 3. Enrich with context ------------------------------+
    |   +-- Match symbols from index                          |
    |   +-- Match files from index                            |
    |   +-- Framework profile (detectAutoLoadTools)            |
    |   +-- Session state (dedup, negative evidence)           |
    |                                                         |
    +-- 4. Format response ----------------------------------+
        +-- tools[] with confidence + reasoning               |
        +-- symbols[] with relevance                          |
        +-- files[] with relevance                            |
        +-- reveal_required[] for hidden tools                |
        +-- already_used[] for session dedup                  |
        +-- gap_analysis (if STOP_AND_REPORT_GAP)             |
```

**File organization:**
- `src/tools/plan-turn-tools.ts` — tool handler, input parser, output formatter
- `src/search/tool-ranker.ts` — BM25 index builder, WRR fusion, embedding integration
- Tests alongside: `tests/plan-turn.test.ts`, `tests/tool-ranker.test.ts`

## Detailed Design

### Data Model

```typescript
// Input
interface PlanTurnOptions {
  repo?: string;              // auto-resolves from CWD
  query: string;              // natural-language description of task
  token_budget?: number;      // max output tokens (default: 8000)
  include_symbols?: boolean;  // include symbol recommendations (default: true)
  include_files?: boolean;    // include file recommendations (default: true)
}

// Parsed query (internal)
interface ParsedQuery {
  original: string;
  normalized: string;         // lowercased, trimmed, truncated to 1000 chars
  truncated: boolean;         // true if original > 1000 chars
  intents: string[];          // split sub-queries (1 if no multi-intent)
  file_refs: string[];        // extracted file paths
  symbol_refs: string[];      // extracted symbol names
  is_vague: boolean;          // length < 15 AND < 2 domain keywords
}

// Tool recommendation
interface ToolRecommendation {
  name: string;               // tool name
  confidence: number;         // 0.0-1.0
  reasoning: string;          // why this tool fits (1 sentence)
  suggested_params?: Record<string, string>;  // pre-filled params
  is_hidden: boolean;         // true if tool is not in CORE_TOOL_NAMES
}

// Symbol recommendation
interface SymbolRecommendation {
  name: string;
  file: string;
  kind: string;
  relevance: number;          // 0.0-1.0
}

// File recommendation
interface FileRecommendation {
  path: string;
  relevance: number;          // 0.0-1.0
  reason: string;             // "referenced in query" | "contains matching symbols" | "framework entry point"
}

// Output
interface PlanTurnResult {
  tool: "plan_turn";
  query: string;
  truncated: boolean;
  confidence: number;         // overall confidence (max of tools[].confidence)
  tools: ToolRecommendation[];          // max 10, sorted by confidence desc
  symbols: SymbolRecommendation[];      // max 20, sorted by relevance desc
  files: FileRecommendation[];          // max 10, sorted by relevance desc
  reveal_required: string[];            // hidden tool names that should be revealed
  already_used: string[];               // tools called earlier in this session
  gap_analysis?: GapAnalysis;           // present when STOP_AND_REPORT_GAP
  framework_context?: string;           // detected framework (e.g., "astro", "nextjs")
  metadata: PlanTurnMetadata;
}

// Complete metadata shape — every edge-case flag used anywhere in the spec
// MUST be declared here. No ad-hoc fields at runtime.
interface PlanTurnMetadata {
  // Execution stats
  intents_detected: number;         // 1 normally, 2+ when multi-intent split triggered
  bm25_candidates: number;          // how many tools BM25 returned before re-rank
  embedding_available: boolean;     // false when API key missing or embedding call failed
  session_queries_seen: number;     // size of SessionState.queries at call time
  duration_ms: number;              // total end-to-end latency

  // Edge-case flags (all optional; present only when condition triggers)
  truncated?: boolean;              // query was >1000 chars and truncated to 800
  vague_query?: boolean;            // <15 chars AND <2 domain keywords — confidences capped at 0.5
  stale_index?: boolean;            // index.updated_at > 5min ago
  low_discrimination?: boolean;     // BM25 score variance <0.1 — all confidences capped at 0.4
  framework_mismatch?: boolean;     // query mentioned framework not present in repo (e.g. "Rust" in TS repo)
  cold_start?: boolean;             // first plan_turn call in session — embedding cache was cold
}

// Gap analysis (jcodemunch-inspired)
interface GapAnalysis {
  action: "STOP_AND_REPORT_GAP";
  prior_query: string;              // the previously-seen query (normalized form)
  prior_result_count: number;       // always 0 in v1, left as number for forward compat
  suggestion: string;               // e.g., "This query returned 0 results before. Try broadening scope or using semantic_search."
}
```

### Tool Ranker (`src/search/tool-ranker.ts`)

**BM25 Index Construction:**

```typescript
interface ToolDocument {
  id: string;                 // tool name
  name: string;               // field weight: 3.0
  description: string;        // field weight: 1.0
  searchHint: string;         // field weight: 2.0
  category: string;           // field weight: 0.5
}
```

On first call, build a BM25 index over all entries in TOOL_DEFINITIONS by wrapping each as a synthetic document. The existing `buildBM25Index()` in `src/search/bm25.ts` accepts `CodeSymbol[]`; the tool ranker maps `ToolDocument` fields to CodeSymbol fields (`name` -> `name`, `description` -> `docstring`, `searchHint` -> `source`). The BM25 index is built once per process lifetime and invalidated only if TOOL_DEFINITIONS changes (fingerprint check).

**Embedding Cache:**

Tool description embeddings are stored in the existing `embeddingCaches` Map keyed by `"__tool_descriptions__"`. Each entry stores `{fingerprint: string, vector: number[]}`. On startup, compute `hash(name + description + searchHint)` for each tool. If fingerprint matches cache, reuse vector. Otherwise, batch-embed changed tools via the configured embedding provider (Voyage `voyage-code-3` or OpenAI `text-embedding-3-small`).

**WRR Fusion Algorithm:**

```typescript
function rankTools(
  query: string,
  bm25Results: Array<{id: string; score: number}>,  // top-30
  embeddings: Map<string, number[]> | null,
  queryEmbedding: number[] | null,
  usageFrequency: Map<string, number>,
): ToolRecommendation[] {
  const scores = new Map<string, number>();

  // 1. Lexical signal (BM25 rank)
  const W_LEXICAL = 1.0;
  for (let i = 0; i < bm25Results.length; i++) {
    const id = bm25Results[i].id;
    scores.set(id, (scores.get(id) ?? 0) + W_LEXICAL / (i + 1));
  }

  // 2. Identity signal (exact name match)
  const W_IDENTITY = 2.0;
  const queryTokens = query.toLowerCase().split(/\s+/);
  for (const token of queryTokens) {
    if (TOOL_NAMES_SET.has(token)) {
      scores.set(token, (scores.get(token) ?? 0) + W_IDENTITY);
    }
  }

  // 3. Semantic signal (embedding cosine similarity)
  // Operates on ALL tools (not just BM25 candidates) to catch semantic-only
  // matches that BM25 missed. Top-10 semantic results are injected into the
  // score map even if BM25 didn't surface them. This prevents the "perfect
  // semantic match but low keyword overlap" gap identified in spec review.
  const W_SEMANTIC = 0.8;
  if (embeddings && queryEmbedding) {
    const allToolIds = [...embeddings.keys()];
    const similarities = allToolIds.map(id => ({
      id,
      sim: cosineSimilarity(queryEmbedding, embeddings.get(id)!),
    }));
    similarities.sort((a, b) => b.sim - a.sim);
    // Inject top-10 semantic results into score map (ensures semantic-only hits aren't lost)
    for (let i = 0; i < Math.min(10, similarities.length); i++) {
      scores.set(
        similarities[i].id,
        (scores.get(similarities[i].id) ?? 0) + W_SEMANTIC / (i + 1),
      );
    }
  }

  // 4. Structural signal (usage frequency from usage-tracker)
  const W_STRUCTURAL = 0.4;
  const usageSorted = [...scores.keys()]
    .filter(id => usageFrequency.has(id))
    .sort((a, b) => (usageFrequency.get(b) ?? 0) - (usageFrequency.get(a) ?? 0));
  for (let i = 0; i < usageSorted.length; i++) {
    scores.set(
      usageSorted[i],
      (scores.get(usageSorted[i]) ?? 0) + W_STRUCTURAL / (i + 1),
    );
  }

  // 5. Framework signal (boost tools matching detected project framework)
  // detectAutoLoadTools() returns tool names enabled for this project's
  // framework (e.g. PHP tools when composer.json detected). These tools
  // get a flat boost to ensure framework-relevant tools surface even if
  // the query doesn't mention the framework explicitly.
  const W_FRAMEWORK = 0.6;
  if (frameworkTools && frameworkTools.length > 0) {
    for (const toolName of frameworkTools) {
      scores.set(toolName, (scores.get(toolName) ?? 0) + W_FRAMEWORK);
    }
  }

  // Normalize to 0.0-1.0 confidence
  const maxScore = Math.max(...scores.values());
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, score]) => ({
      name: id,
      confidence: round2(score / maxScore),
      reasoning: generateReasoning(id, query, signals),
      is_hidden: !CORE_TOOL_NAMES.has(id),
    }));
}

// generateReasoning — template-based, not LLM-generated.
// Selects a template based on which WRR signals contributed most.
function generateReasoning(id: string, query: string, signals: Map<string, SignalWeights>): string {
  const s = signals.get(id);
  if (!s) return `Matches query "${query.slice(0, 40)}"`;
  const parts: string[] = [];
  if (s.identity > 0) parts.push(`exact name match`);
  if (s.lexical > 0.5) parts.push(`keyword match on "${s.matchedTerms.join(", ")}"`);
  if (s.semantic > 0.7) parts.push(`semantic similarity to query`);
  if (s.structural > 0.3) parts.push(`high usage frequency`);
  if (s.framework) parts.push(`relevant to ${s.framework} stack`);
  return parts.length > 0 ? parts.join("; ") : `general match`;
}
```

**Confidence calibration:**
- Vague queries: all confidences capped at 0.5.
- Single-keyword queries: confidences capped at 0.6.
- Multi-intent queries: per-intent confidence, overall is max across intents.

### Input Parser (`src/tools/plan-turn-tools.ts`)

```typescript
function parseQuery(query: string, index: CodeIndex): ParsedQuery {
  // 1. Truncate
  const truncated = query.length > 1000;
  const normalized = query.slice(0, 1000).toLowerCase().trim();

  // 2. Multi-intent split
  const intents = normalized.split(/\s+(and|or|;|&&)\s+/).filter(
    s => !["and", "or", ";", "&&"].includes(s)
  );

  // 3. File references
  const filePattern = /\b[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|php|kt|sql)\b/g;
  const file_refs = [...normalized.matchAll(filePattern)]
    .map(m => m[0])
    .filter(f => index.files.has(f) || index.files.has("src/" + f));

  // 4. Symbol references
  const tokens = normalized.split(/\s+/);
  const symbol_refs = tokens.filter(t => index.symbols?.has(t));

  // 5. Vague detection
  const DOMAIN_KEYWORDS = new Set([
    "function", "class", "import", "export", "test", "route", "dead",
    "unused", "type", "interface", "complexity", "duplicate", "clone",
    "pattern", "secret", "dependency", "circular", "hotspot", "reference",
    "symbol", "definition", "call", "trace", "diagram", "mermaid",
    "rename", "refactor", "audit", "review", "diff", "community",
    "module", "boundary", "coupling", "churn", "impact", "blast",
    "breaking", "migration", "endpoint", "api", "hook", "component",
    "performance", "bundle", "outline", "tree", "search", "find",
  ]);
  const domainHits = tokens.filter(t => DOMAIN_KEYWORDS.has(t)).length;
  const is_vague = normalized.length < 15 && domainHits < 2;

  return { original: query, normalized, truncated, intents, file_refs, symbol_refs, is_vague };
}
```

### API Surface

Single MCP tool registered in TOOL_DEFINITIONS:

```typescript
{
  name: "plan_turn",
  description: "Route an agent query to the best CodeSift tools. Returns recommended tools with confidence scores, relevant symbols, and relevant files. Call this first when unsure which tool to use.",
  searchHint: "route plan recommend suggest which tool query intent concierge",
  category: "discovery",
  schema: {
    repo: { type: "string", description: "Repository identifier (auto-resolves from CWD)" },
    query: { type: "string", description: "Natural-language description of what you want to do" },
    token_budget: { type: "number", description: "Max output tokens (default: 8000)" },
    include_symbols: { type: "boolean", description: "Include symbol recommendations (default: true)" },
    include_files: { type: "boolean", description: "Include file recommendations (default: true)" },
  },
  handler: planTurnHandler,
}
```

**Tool visibility:** `plan_turn` is added to `CORE_TOOL_NAMES` — it must be visible by default since its purpose is to help agents find other tools.

### Integration Points

| Component | Integration | Direction |
|-----------|-------------|-----------|
| `TOOL_DEFINITIONS` (register-tools.ts) | Read all tool entries for BM25 index + embedding | Input |
| `buildBM25Index()` (search/bm25.ts) | Build transient BM25 over tool documents | Input |
| `embeddingCaches` (storage/embedding-store.ts) | Cache/retrieve tool description embeddings | Read/Write |
| `SessionState` (storage/session-state.ts) | Read negativeEvidence, queries | Input |
| `detectAutoLoadTools()` (register-tools.ts) | Framework-specific tool boost | Input |
| `analyze_project()` (project-tools.ts) | Project profile for framework context | Input |
| `usage_stats()` (usage-tools.ts) | Tool usage frequency for structural signal | Input |
| `CORE_TOOL_NAMES` (register-tools.ts) | Determine which tools are hidden | Input |
| `CodeIndex.symbols` | Cross-reference symbol names in query | Input |
| `CodeIndex.files` | Cross-reference file paths in query | Input |
| `buildResponseHint()` (server-helpers.ts) | Append hint codes to response | Output |

### Edge Cases

| Case | Handling |
|------|---------|
| Empty query (`""` or whitespace) | Return fallback profile: `tools: [{name: "suggest_queries", confidence: 1.0}]`, no symbols/files |
| Query > 1000 chars | Truncate to 1000 chars, set `truncated: true` in response |
| Multi-intent query | Split on `AND/OR/;/&&`, run pipeline per intent, merge tools (dedup by name, keep highest confidence), cap at 10 |
| Query contains valid filename in index | Short-circuit: that file appears in `files[]` with `relevance: 1.0`, `reason: "referenced in query"` |
| Vague query (< 15 chars, < 2 domain keywords) | Cap all tool confidences at 0.5, add metadata flag |
| No tool matches (BM25 returns empty) | Return `tools: [{name: "discover_tools", confidence: 0.3, reasoning: "No strong matches found. Use discover_tools for broader search."}]` |
| More than 20 BM25 matches above threshold | Score threshold at 0.2 minimum confidence + hard cap at 10 tools |
| All matched tools are hidden | Populate `reveal_required[]` with all hidden tool names from `tools[]` |
| Stale symbols in index | Flag in metadata: `stale_index: true` when index age > 5 minutes |
| Repo not indexed | Return `{error: "repo_not_indexed", suggestion: "Run index_folder(path=<root>) first"}` without throwing |
| Cold start (no embeddings cached) | Use BM25-only ranking for first call; trigger async embedding in background |
| Repeated query in session (exact normalized match) | Check SessionState.negativeEvidence; if any prior entry's normalized form equals current query's normalized form AND had 0 results, emit `gap_analysis` with STOP_AND_REPORT_GAP. Normalization: lowercase + collapse whitespace + strip punctuation. **No fuzzy matching** in v1 to avoid false STOPs. |
| Already-executed tools in session | Move to `already_used[]`, exclude from primary `tools[]` unless they are the only matches |

### Failure Modes

#### 1. Query Parser (Regex Layer)

| Scenario | Impact | Mitigation |
|----------|--------|------------|
| Multi-intent regex splits mid-word (e.g., "standard library") | False split produces nonsensical sub-queries | Require whitespace on both sides of connectors; validate each sub-query has >= 2 chars after split, merge back if not |
| File reference regex matches non-file strings (e.g., version "3.2.ts") | Phantom file reference that does not exist in index | All file refs are cross-referenced against `index.files`; unmatched refs are silently dropped |
| Symbol cross-reference matches common words that happen to be symbol names (e.g., "get", "set", "error") | Irrelevant symbols pollute `symbols[]` | Only include symbol matches with name length >= 4 chars or exact case match; cap at 20 symbols |
| Regex catastrophic backtracking on adversarial input | Parser hangs, blocks response | All regex patterns are linear-time (no nested quantifiers); 1000-char input cap prevents amplification |

#### 2. BM25 Tool Index

| Scenario | Impact | Mitigation |
|----------|--------|------------|
| TOOL_DEFINITIONS is empty (corrupt or race condition during startup) | BM25 index is empty, no results | Guard: if TOOL_DEFINITIONS.length === 0, return error `{error: "tool_index_empty"}` |
| BM25 returns all tools with near-identical scores (non-discriminating query like "code") | Top-10 is essentially random | Apply confidence cap: if score variance < 0.1, cap all confidences at 0.4 and add metadata `low_discrimination: true` |
| Tool description contains misleading keywords (e.g., "dead" in a tool unrelated to dead code) | False positive ranking | searchHint field (weight 2.0) acts as curated keyword list; description (weight 1.0) has lower influence; WRR fusion with other signals dampens single-signal noise |
| BM25 index build fails (out of memory on huge TOOL_DEFINITIONS) | Tool cannot function | TOOL_DEFINITIONS is bounded (~160 entries, ~50KB); OOM is not realistic. Guard: try/catch with fallback to linear scan by name-only matching |

#### 3. Embedding Layer (Semantic)

| Scenario | Impact | Mitigation |
|----------|--------|------------|
| No API key configured (VOYAGE_API_KEY and OPENAI_API_KEY both missing) | Semantic signal unavailable | Graceful degradation: skip W_SEMANTIC (0.8) weight entirely, use BM25 + structural + identity only. Log once: "plan_turn: embedding unavailable, using BM25-only ranking" |
| Embedding API returns error (rate limit, network failure, invalid key) | Semantic re-ranking fails for this call | try/catch around embedding call; fall back to BM25-only for this invocation; do not cache partial results; set `metadata.embedding_available: false` |
| Embedding dimensions mismatch between cached vectors and new model version | Cosine similarity produces garbage scores | Fingerprint includes model name. If model changes, all cached embeddings are invalidated and re-computed |
| Embedding API latency spike (> 5s) | Cold start exceeds 2s p95 target | Timeout embedding batch at 3s. If timeout, proceed with BM25-only. Embedding completes in background and is cached for next call |
| Stale embedding cache (tool description changed but cache not invalidated) | Semantic scores reflect old description | Fingerprint `hash(name + description + searchHint)` ensures any description change triggers re-embed |

#### 4. Session State Reader

| Scenario | Impact | Mitigation |
|----------|--------|------------|
| SessionState is null/undefined (new session, no prior queries) | Cannot check negative evidence or dedup | Guard: if SessionState is null, skip session-aware features entirely. Set `metadata.session_queries_seen: 0` |
| SessionState.negativeEvidence contains stale entries from a different task context | False STOP_AND_REPORT_GAP on a valid new query | Match negative evidence only by **exact normalized form** (lowercase + collapsed whitespace + stripped punctuation). Different wording = different query = no match. Same rule as Edge Cases row. v2 may add similarity-based matching with explicit opt-in. |
| SessionState.queries is very large (100+ entries in a long session) | Dedup logic scans all entries | O(n) scan is acceptable for n <= 1000. Cap at 200 most recent entries. |
| SessionState file is corrupted (invalid JSON on disk) | Reader throws, blocks plan_turn | try/catch around SessionState read; fall back to no-session mode. Log warning |

#### 5. Output Formatter

| Scenario | Impact | Mitigation |
|----------|--------|------------|
| Combined output exceeds token_budget | Response too large for agent context window | Progressive truncation: first drop `symbols[]` below relevance 0.3, then drop `files[]`, then trim `reasoning` fields to 50 chars, then reduce `tools[]` to top-5 |
| All tools in recommendation are hidden | Agent cannot call them without reveal | `reveal_required[]` is always populated for hidden tools. Additionally, prepend advisory text: "Run describe_tools(names=[...], reveal=true) to enable these tools." |
| Multi-intent merge produces duplicate tool entries | Confusion in output | Dedup by tool name, keep entry with highest confidence |
| Zero tools pass confidence threshold | Empty `tools[]` violates invariant | Invariant guard: if `tools[]` would be empty, insert `[{name: "discover_tools", confidence: 0.3}]` |

## Acceptance Criteria

### Ship Criteria

1. `plan_turn(query="")` returns a successful MCP tool result (no thrown error) with `tools: [{name: "suggest_queries", confidence: 1.0}]`.
2. `plan_turn` on an unindexed repo returns `{error: "repo_not_indexed"}` without throwing an exception.
3. Output `tools[]` never exceeds 10 entries for any input.
4. Output `tools[]` is never empty — minimum fallback is `[{name: "discover_tools"}]`.
5. Query containing a valid `.ts` or `.py` filename that exists in the index produces that file in `files[]`.
6. All matched hidden tools (not in CORE_TOOL_NAMES) populate `reveal_required[]`.
7. Query > 1000 chars is accepted without error, response includes `truncated: true`.
8. Multi-intent query (e.g., "find dead code AND trace the auth route") returns results for both intents.
9. BM25-only mode (no embedding API key) returns valid recommendations without error.
10. Session with negative evidence for a query matching the current query by **exact normalized form** (lowercase + whitespace-collapsed + punctuation-stripped) returns `gap_analysis` with `action: "STOP_AND_REPORT_GAP"`. Fuzzy match MUST NOT trigger STOP in v1.
11. `already_used[]` correctly reflects tools called earlier in the session.
12. `plan_turn` is registered in CORE_TOOL_NAMES and visible in ListTools.

### Success Criteria

1. **Precision@5 >= 70%**: Of the top-5 recommended tools, >= 70% are actually invoked by the agent in the subsequent 5 turns. Measured via usage-tracker session logs over 100 sessions.
2. **Cold-start latency p95 <= 2s**: First call in a session (including BM25 index build + embedding retrieval from cache). Measured in benchmark suite.
3. **Warm latency p95 <= 200ms**: Subsequent calls in the same session (BM25 index + embeddings already cached in memory). Measured in benchmark suite.
4. **Multi-intent recall >= 80%**: For queries with 2+ intents, each intent produces >= 1 relevant tool in >= 80% of test cases.
5. **Calibration**: Mean confidence across single-keyword queries (e.g., "dead", "route", "test") is <= 0.55.

## Validation Methodology

### Benchmark Suite (30 Test Queries)

A benchmark file `tests/fixtures/plan-turn-benchmark.json` containing 30 queries with expected tool lists:

| # | Query | Expected Top Tools | Category |
|---|-------|--------------------|----------|
| 1 | "find dead code" | find_dead_code, find_unused_imports | direct |
| 2 | "trace the /api/auth endpoint" | trace_route | direct |
| 3 | "what does the buildBM25Index function do" | get_context_bundle, get_symbol | semantic |
| 4 | "find duplicate code" | find_clones | semantic |
| 5 | "show me the file tree" | get_file_tree | direct |
| 6 | "circular dependencies" | find_circular_deps, detect_communities | direct |
| 7 | "review my changes" | review_diff, changed_symbols | composite |
| 8 | "complexity hotspots" | analyze_complexity, analyze_hotspots | composite |
| 9 | "find all usages of parseQuery" | find_references, find_and_show | direct |
| 10 | "security audit" | scan_secrets, audit_scan | composite |
| 11 | "how is authentication implemented" | semantic_search, codebase_retrieval | semantic |
| 12 | "rename the variable foo to bar" | rename_symbol | direct |
| 13 | "find anti-patterns in my code" | search_patterns | direct |
| 14 | "visualize the call chain" | trace_call_chain | direct |
| 15 | "what changed in the last 3 commits" | changed_symbols, diff_outline | direct |
| 16 | "" (empty) | suggest_queries | edge |
| 17 | "x" (single char) | discover_tools | edge-vague |
| 18 | "find dead code AND trace auth route" | find_dead_code, trace_route | multi-intent |
| 19 | "check src/tools/plan-turn-tools.ts" | get_file_outline | file-ref |
| 20 | "performance problems in the codebase" | analyze_complexity, analyze_hotspots, search_patterns | semantic |
| 21 | "module boundaries and coupling" | detect_communities, check_boundaries, classify_roles | composite |
| 22 | "git churn analysis" | analyze_hotspots | direct |
| 23 | "find where UserService is used" | find_references | symbol-ref |
| 24 | "compare old and new code structure" | diff_outline, changed_symbols | semantic |
| 25 | "astro islands hydration" | astro_analyze_islands, astro_hydration_audit | framework |
| 26 | "PHP class hierarchy" | php_class_hierarchy | framework |
| 27 | "help me understand this codebase" | suggest_queries, get_repo_outline | onboarding |
| 28 | "react hooks that break rules" | react_hooks_audit | framework |
| 29 | "find secrets and leaked keys" | scan_secrets | direct |
| 30 | "what tests cover the auth module" | impact_analysis | semantic |

### Measurement Protocol

1. **Offline Recall@5**: Run each benchmark query through `plan_turn`. For each query, score 1 if ANY expected tool appears in the top-5 recommendations, 0 otherwise. Report `sum(hits) / total_queries` (i.e. `hits / 30` for 30 benchmark queries). Target: ≥0.70 (21/30 queries have at least one expected tool in top-5).

2. **Online Precision@5**: Over 100 real agent sessions (collected via usage-tracker), for each `plan_turn` call, check if the recommended top-5 tools were actually called within the next 5 tool invocations in the same session. Report aggregate precision.

3. **Latency**: Run benchmark suite 10 times. Report p50, p95, p99 for cold (first run) and warm (subsequent runs) separately.

4. **Calibration**: Compute mean confidence of top-1 recommendation across the 30 benchmark queries. Single-keyword subset (queries 16, 17, "dead", "route", "test", "code" added as extras) should have mean <= 0.55.

5. **Multi-intent**: Queries 18 and additional multi-intent test cases. Score: fraction of intents with >= 1 relevant tool in results. Target >= 80%.

## Rollback Strategy

`plan_turn` is a purely additive new tool with no modifications to existing tools or data structures.

**Rollback procedure:**
1. Remove `plan_turn` entry from TOOL_DEFINITIONS in `register-tools.ts`.
2. Remove `"plan_turn"` from CORE_TOOL_NAMES.
3. Delete `src/tools/plan-turn-tools.ts` and `src/search/tool-ranker.ts`.
4. Delete test files.
5. No data migration needed — the tool ranker's BM25 index is transient (in-memory, rebuilt per process). Embedding cache entries under `"__tool_descriptions__"` are orphaned but harmless (< 1MB).
6. No other tools depend on `plan_turn`. No schema changes to existing types.

**Partial rollback:** If only the embedding layer causes issues, set `W_SEMANTIC = 0` in `tool-ranker.ts` to disable semantic re-ranking without removing the tool.

## Backward Compatibility

- **No breaking changes.** `plan_turn` is a new tool that does not modify the behavior or API surface of any existing tool.
- **`discover_tools` remains.** It continues to serve as a direct keyword search. `plan_turn` is the recommended alternative for NL queries, but discover_tools is not deprecated.
- **`suggest_queries` remains.** It continues to serve structural codebase orientation. plan_turn references it as a fallback for empty queries.
- **SessionState schema unchanged.** plan_turn reads existing `negativeEvidence` and `queries` fields. No new fields added to SessionState.
- **TOOL_DEFINITIONS schema unchanged.** plan_turn reads existing `name`, `description`, `searchHint`, `category` fields. No new fields required.
- **Embedding cache is additive.** New cache key `"__tool_descriptions__"` does not conflict with existing per-repo embedding caches.

## Out of Scope

- **LLM-based intent classification** — plan_turn uses regex + BM25 + embeddings. No LLM call for parsing or classification. Deferred as potential v2 enhancement if Precision@5 < 70%.
- **Tool chain sequencing** — plan_turn recommends individual tools, not ordered workflows (e.g., "call A, then B with output of A"). Tool chaining is an agent responsibility. Deferred to v2.
- **Cross-repo routing** — plan_turn operates within a single indexed repo. Multi-repo routing via `cross_repo_search` is a separate concern.
- **Auto-execution** — plan_turn recommends tools but does not execute them. The agent decides which to call.
- **Confidence explanation UI** — plan_turn returns `reasoning` strings but does not provide a breakdown of which signals (BM25, semantic, usage, identity) contributed to the score. Deferred to v2 for debugging.
- **Custom tool definitions** — plan_turn only routes to CodeSift's own TOOL_DEFINITIONS. User-defined MCP tools from other servers are not included.
- **Training data collection** — Logging (query, recommendation, actual_usage) tuples for offline model improvement. Deferred to v2; usage-tracker already captures the raw data.
- **Feedback loop** — Agent reporting back "this recommendation was helpful/unhelpful" to improve future rankings. Deferred to v2.
- **Budget advisor** — jcodemunch's plan_turn includes token budget estimation per recommended tool. Deferred to v2.
- **Prior evidence** — jcodemunch surfaces prior session evidence (symbols/files explored). SessionState already tracks this, but surfacing it in plan_turn output is deferred to v2.

## Open Questions

None — all design questions resolved during specification phase.
