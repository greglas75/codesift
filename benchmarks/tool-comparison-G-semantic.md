# Category G: Semantic/Concept Questions — CodeSift context vs Auggie vs Bash grep

**Date:** 2026-03-14
**Project:** promptvault (4127 files, 19707 symbols)
**NOTE:** CodeSift used BM25-based `context` command, NOT embedding-based semantic search (no embeddings configured). Auggie was unavailable (429 rate limit).

---

## Results

| Task | Question | Sift quality | Bash quality | Sift chars | Bash chars |
|------|----------|-------------|-------------|-----------|-----------|
| G1 | Permission system | **8** | 7 | 18,938 | 7,746 |
| G2 | Caching strategies | 2 | **4** | 8,665 | 3,407 |
| G3 | Error handling | 7 | 7 | 16,225 | 2,828 |
| G4 | Multi-tenancy | 2 | **6** | 18,217 | 2,571 |
| G5 | Document pipeline | 6 | 6 | 25,875 | 4,607 |
| G6 | API security | **7** | 6 | 26,111 | 3,606 |
| G7 | State management | 5 | **6** | 16,041 | 3,014 |
| G8 | Testing patterns | 4 | **5** | 23,537 | 3,502 |
| G9 | Qdrant integration | **8** | 6 | 27,505 | 3,363 |
| G10 | DB transactions | 3 | **5** | 14,769 | 4,026 |
| **AVG** | | **5.2** | **5.8** | **19,588** | **3,867** |

### Bash wins: higher quality, 5× less data.

---

## Why CodeSift `context` Failed

1. **BM25 ≠ Semantic** — `assemble_context` uses keyword matching (BM25), not vector embeddings. When concept names don't appear in code (e.g., "caching" → code uses `redis.setex()`, "multi-tenancy" → code uses `where: { workspaceId }`), BM25 can't find them.

2. **Noise sources** consuming token budget:
   - `generated/prisma/schema.prisma` (mirrors actual schema — duplicate content)
   - Markdown audit reports matching on keyword overlap
   - Test fixtures ranked equal to production code
   - Generic `where` variables matching concept keywords

3. **Works ONLY when concept = symbol name:**
   - G1 (8/10): "permission" → `withPermission*` functions exist
   - G9 (8/10): "qdrant" → files named `qdrant*`
   - G4 (2/10): "multi-tenancy" → no symbols named "tenant*"

## What Would Fix This

1. **Enable embedding-based semantic search** — requires CODESIFT_OPENAI_API_KEY or CODESIFT_VOYAGE_API_KEY
2. **Filter noise sources** — exclude generated/, audit-results/, *.md from code search
3. **Prioritize production over test code** — lower ranking for test fixtures
4. **Deduplicate Prisma schemas** — generated/prisma mirrors prisma/schema

## Next Steps

- Configure embedding provider (OpenAI text-embedding-3-small recommended)
- Reindex with embeddings
- Rerun Cat-G with `codebase_retrieval type:"semantic"` instead of BM25 `context`
- Compare: BM25 context vs Semantic embedding vs Auggie vs Bash grep
