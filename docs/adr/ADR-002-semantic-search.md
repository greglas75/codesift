# ADR-002: Hybrid BM25 + Semantic Search Architecture

**Status:** Accepted
**Date:** 2026-03-13 | **Deciders:** Greg Laskowski | **Area:** Search/AI

---

## Context

jcodemunch uses BM25 (keyword ranking) + camelCase token splitting for all search. This works well
for exact symbol lookups (`getUserById`) but fails for conceptual queries:

- "how does authentication work?" → returns nothing (no keyword overlap with auth functions)
- "payment processing flow" → misses `processTransaction`, `chargeCard` etc.
- "error boundary handling" → misses `ErrorFallback`, `withErrorHandler` etc.

Semantic search using embedding models can match by meaning, not just token overlap. The key question
is: **how to add semantic search without breaking existing BM25 behavior?**

**Constraints:**
- Voyage Code 3 embeddings have cost (~$0.0001/1K tokens) — must be optional
- Index must work offline (no embedding provider) with BM25 fallback
- Embedding calls must be batched (avoid per-symbol API calls during indexing)
- Retrieval latency must stay under 2s for typical repos (< 100K symbols)
- Local embedding models (Ollama) are a valid alternative to avoid API costs

---

## Decision

Implement **hybrid search**: BM25 score + semantic cosine similarity score combined with
**Reciprocal Rank Fusion (RRF)**. Semantic search is **opt-in** (requires `CODESIFT_EMBEDDING_PROVIDER`
env var). All existing tools continue to work with BM25-only when no embedding provider is configured.

Semantic search is exposed as a new sub-query type in `codebase_retrieval`:
```json
{"type": "semantic", "query": "how does authentication work?"}
```

---

## Options Considered

### Option A: Hybrid BM25 + Embeddings with RRF ← **CHOSEN**

**Architecture:**
1. Index time: for each symbol, embed `{name} {signature} {docstring} {first 200 chars of body}`
2. Store embeddings in flat file alongside BM25 index (`.codesift/{repo}.embeddings.ndjson`)
3. Query time: run BM25 + cosine similarity in parallel, combine with RRF
4. RRF formula: `score = 1/(k + rank_bm25) + 1/(k + rank_semantic)` where `k=60`

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium — RRF is simple math; embedding storage is straightforward |
| Cost | Optional — only incurred when embedding provider configured |
| Scalability | Flat file embeddings scale to ~500K symbols; vector DB needed beyond that |
| Team familiarity | MEDIUM — embeddings are new, RRF is simple |
| Maintenance | Low — no external vector DB dependency, pure file-based |
| Lock-in | LOW — swap embedding provider without changing search logic |

**Pros:**
- No additional infrastructure (no Qdrant/Pinecone needed for dev usage)
- RRF is the gold standard for hybrid search — outperforms weighted sum
- Optional: zero cost/complexity if embedding provider not configured
- Embedding file is separate from BM25 index — can regenerate independently
- Supports: Voyage Code 3, OpenAI text-embedding-3-small, Ollama (local)

**Cons:**
- Embedding file can be large (~1.5KB per symbol × 50K symbols = ~75MB)
- Initial full-index embedding requires many API calls (batch up to 128 per call)
- No ANN (Approximate Nearest Neighbor) search — linear scan O(n) per query

### Option B: Separate vector database (Qdrant embedded)

Run Qdrant as an embedded library (via Docker or Qdrant Rust client) alongside CodeSift.

| Dimension | Assessment |
|-----------|------------|
| Complexity | HIGH — Qdrant as embedded lib requires Docker or Rust compilation |
| Cost | Zero infrastructure cost, but significant setup complexity |
| Scalability | Excellent — ANN search scales to millions of vectors |
| Team familiarity | LOW — Qdrant is new infrastructure |
| Maintenance | HIGH — another service to configure, monitor, restart |
| Lock-in | MEDIUM — Qdrant-specific filter syntax |

**Pros:** ANN search (fast at scale), filtering, metadata queries

**Cons:**
- MCP tool requiring Docker setup = poor developer experience
- Overkill for typical repos (< 100K symbols where linear scan is fast)
- Embedded Qdrant (via Rust FFI) is complex to package as npm package

### Option C: BM25 only (no semantic search)

Keep jcodemunch's approach. No embeddings, no semantic search.

**Pros:** Zero complexity, no cost, proven

**Cons:** Cannot answer conceptual queries ("how does auth work?") — this is the key differentiator
of CodeSift vs jcodemunch. Not viable as the primary motivation for the rewrite.

### Option D: LLM-reranking (no embeddings)

Use the LLM itself to rerank BM25 results. No separate embedding model needed.

**Pros:** No API key required (reuses Claude), better understanding of context

**Cons:**
- High latency (LLM reranking adds 2-5s per query)
- High token cost (sending many symbol bodies to Claude)
- Creates circular dependency: CodeSift is a tool FOR Claude, using Claude inside it

---

## Trade-off Analysis

Option A (hybrid BM25 + embeddings flat file) is the correct balance for a developer tool:
- Most repos < 100K symbols → linear scan cosine similarity is fast enough (< 50ms)
- No infrastructure dependency (no Docker, no Qdrant) → installs with `npm install codesift-mcp`
- Optional opt-in → zero cost for BM25-only usage (jcodemunch parity by default)

Option B (Qdrant) would be correct if CodeSift were a cloud service indexing millions of repos.
As a local developer tool, it's overengineered.

---

## Decision Rationale

Flat-file hybrid search with RRF provides the right balance between capability and operational simplicity.
The target user is a developer running CodeSift locally — they should not need to start Docker or
configure a vector database. The flat-file approach scales to typical monorepos (10K-500K symbols)
with sub-100ms query time.

---

## Architecture Detail

### Embedding Providers (in priority order)

| Provider | Model | Dims | Cost | Config |
|----------|-------|------|------|--------|
| Voyage AI | `voyage-code-3` | 1024 | $0.0001/1K tokens | `CODESIFT_VOYAGE_API_KEY` |
| OpenAI | `text-embedding-3-small` | 1536 | $0.00002/1K tokens | `CODESIFT_OPENAI_API_KEY` |
| Ollama | `nomic-embed-text` | 768 | Free (local) | `CODESIFT_OLLAMA_URL` |

### Symbol text for embedding

```
{symbol_kind} {symbol_name}
{signature}
{docstring_first_line}
{body_first_200_chars}
```

Example:
```
function getUserById
async getUserById(id: string): Promise<User | null>
Fetches a user by their UUID from the database
return prisma.user.findUnique({ where: { id }, include: { workspace: true } });
```

### Index file structure

```
.codesift/
  {repo-hash}.index.json          # BM25 index (existing)
  {repo-hash}.embeddings.ndjson   # One embedding per line: {"id": "...", "vec": [...]}
  {repo-hash}.meta.json           # embedding model, dims, last-updated
```

### Hybrid ranking (RRF)

```typescript
function hybridRank(bm25Results: ScoredSymbol[], semanticResults: ScoredSymbol[], k = 60): ScoredSymbol[] {
  const scores = new Map<string, number>();
  bm25Results.forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (k + i)));
  semanticResults.forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (k + i)));
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ ...symbolMap.get(id)!, score }));
}
```

### codebase_retrieval semantic sub-query

```json
{
  "type": "semantic",
  "query": "how does authentication work?",
  "top_k": 10,
  "file_filter": "src/auth/**"
}
```

Returns: top-k symbols ranked by semantic similarity, with `score` and `source` fields.

---

## Consequences

- **Easier:**
  - Conceptual queries work without knowing exact symbol names
  - `codebase_retrieval` becomes significantly more powerful for architecture exploration
  - Embedding provider is swappable without changing search logic

- **Harder:**
  - Initial full index: must embed all symbols (batched, but still takes time for large repos)
  - Incremental updates: new/changed symbols must be re-embedded (add to batch queue)
  - Memory: embedding vectors are kept in memory during search (~8MB for 50K symbols at 1024 dims float32)
  - Debugging hybrid scores: RRF is opaque — hard to explain why a symbol ranked #3

- **Revisit when:**
  - If repos exceed 500K symbols and linear scan becomes slow → add HNSW index (usearch npm)
  - If Voyage Code 3 is deprecated → evaluate voyage-3 or OpenAI ada-3
  - If local-first becomes critical → evaluate fastembed (ONNX runtime, no API key)

---

## Action Items

- [ ] Implement `search/semantic.ts` — provider abstraction (Voyage / OpenAI / Ollama)
- [ ] Implement `search/hybrid.ts` — RRF combining BM25 + semantic scores
- [ ] Implement embedding batch queue in `storage/embedding-store.ts` (batch size: 128, auto-flush)
- [ ] Add `{"type": "semantic"}` sub-query handler in `retrieval/codebase-retrieval.ts`
- [ ] Add `CODESIFT_VOYAGE_API_KEY` / `CODESIFT_OPENAI_API_KEY` / `CODESIFT_OLLAMA_URL` to config
- [ ] Write benchmark: BM25-only vs hybrid on PromptVault repo (10 conceptual queries)
