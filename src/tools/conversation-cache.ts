import { stat } from "node:fs/promises";
import { bm25CacheBudgetBytes, bm25FootprintBytes, type BM25Index } from "../search/bm25.js";

/**
 * BM25 indexes for conversation repos.
 *
 * This is the SECOND cache of BM25 indexes in the process, and it had none of what the first one
 * got: no LRU, no budget, no entry cap, and — unlike its sibling — not even the accidental eviction
 * that used to keep that one small. Nothing has ever removed an entry from it.
 *
 * Its size is not bounded by how many conversation indexes exist on disk either, because
 * `loadConversationIndex` BUILDS the index from symbols rather than reading a persisted one: only 3
 * of 1,258 conversation repos here have a `.bm25.ndjson` at all. What bounds it is how many repos get
 * searched, and `searchAllConversations` searches every one of them in a single `Promise.all`.
 *
 * Measured 2026-09-27, one `search_all_conversations` call on this install:
 *
 *   projects_searched 1,258 · 53.7 s · heapUsed 5 MB -> 3,262 MB
 *   RETAINED after an explicit GC: 2,784 MB
 *   a second identical call: 0.6 s — proving all of it is still referenced
 *
 * The fan-out comment in `searchAllConversations` says "with ~20+ conversation repos". That was true
 * when it was written. Pricing and budget come from `search/bm25.js` so this cache and the code one
 * cannot drift apart on what an index costs.
 */
const bm25Indexes = new Map<string, BM25Index>();

/**
 * Index freshness, so a long-lived process stops answering from a snapshot.
 *
 * The lookup was `if (!bm25) build`, with no revalidation anywhere — so the first search in a process
 * fixed the answer for the life of that process. In the daemon, which had been up 27 hours when this
 * was found, conversation search could not see a single conversation recorded since its first call.
 * That is a correctness defect the memory bound would otherwise have hidden, since eviction also
 * happens to refresh.
 */
const indexedAt = new Map<string, number>();

const embeddingsCache = new Map<string, {
  mtimeMs: number;
  embeddings: Map<string, Float32Array>;
}>();

/**
 * How many conversation embedding maps stay resident.
 *
 * Each load is individually capped by `embeddingMemBudgetBytes()`, which bounds one entry and says
 * nothing about their number — the same "count is not size" mistake ADR-004 fixed for the index
 * cache, inverted. Conversation embeddings are small here (0.03 GB on disk across 1,258 repos), so a
 * modest entry cap is enough; it exists so the failure mode is bounded rather than proportional to
 * how many projects the machine has ever had.
 */
const MAX_EMBEDDING_ENTRIES = 64;

/**
 * Newest index mtime this cache entry is known to cover, or 0 when unknown.
 *
 * Passed in by the caller because the cache does not know where a conversation repo's index lives;
 * an entry built without one is never considered stale, which is the pre-existing behaviour and the
 * conservative direction for a caller that cannot tell.
 */
export function getConversationBM25Index(repoName: string, freshAsOfMs = 0): BM25Index | null {
  const index = bm25Indexes.get(repoName);
  if (!index) return null;
  const builtAt = indexedAt.get(repoName) ?? 0;
  if (freshAsOfMs > 0 && builtAt > 0 && freshAsOfMs > builtAt) {
    bm25Indexes.delete(repoName);
    indexedAt.delete(repoName);
    return null;
  }
  // Re-insert so iteration order is least-recently-used first.
  bm25Indexes.delete(repoName);
  bm25Indexes.set(repoName, index);
  return index;
}

export function setConversationBM25Index(repoName: string, index: BM25Index, builtAtMs = Date.now()): void {
  bm25Indexes.delete(repoName);
  bm25Indexes.set(repoName, index);
  indexedAt.set(repoName, builtAtMs);
  evictOverBudget(repoName);
}

/**
 * Drop least-recently-used entries until the cache fits its budget.
 *
 * The repo being served is never evicted, even alone over budget: otherwise a single large
 * conversation corpus would rebuild and discard its own index on every call.
 */
/**
 * Share of the BM25 budget this cache may hold.
 *
 * A quarter, not the whole tier. Conversation search is a secondary retrieval path, and giving it the
 * same budget as the code BM25 cache would put four full-tier budgets in one process (indexes, code
 * BM25, embeddings, conversations) — 4 GB of deliberate residency on a machine this size, which is
 * how a process with correct individual bounds still walks into its heap ceiling.
 *
 * It costs little: a conversation index here averages ~2.2 MB (2,784 MB across 1,258 repos), so a
 * quarter-tier still holds around a hundred of them — the recently-active projects — and a miss costs
 * a rebuild, never an error. `CODESIFT_MAX_CONVERSATION_BM25_CACHE_MB` overrides directly.
 */
function conversationBudgetBytes(): number {
  const raw = process.env["CODESIFT_MAX_CONVERSATION_BM25_CACHE_MB"];
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed * 1024 * 1024;
  }
  return Math.floor(bm25CacheBudgetBytes() / 4);
}

function evictOverBudget(pinned: string): void {
  const budget = conversationBudgetBytes();
  let total = 0;
  for (const index of bm25Indexes.values()) total += bm25FootprintBytes(index);
  if (total <= budget) return;
  for (const [name, index] of bm25Indexes) {
    if (total <= budget) break;
    if (name === pinned) continue;
    total -= bm25FootprintBytes(index);
    bm25Indexes.delete(name);
    indexedAt.delete(name);
  }
}

/** Entry count and priced bytes, for the cache report on /health. */
export function conversationCacheStats(): {
  bm25: number;
  bm25_bytes: number;
  embeddings: number;
} {
  let bytes = 0;
  for (const index of bm25Indexes.values()) bytes += bm25FootprintBytes(index);
  return { bm25: bm25Indexes.size, bm25_bytes: bytes, embeddings: embeddingsCache.size };
}

export async function loadConversationEmbeddingsCached(
  embeddingPath: string,
): Promise<Map<string, Float32Array>> {
  let mtimeMs = -1;
  try {
    mtimeMs = (await stat(embeddingPath)).mtimeMs;
  } catch {
    // Missing files load as an empty embedding map.
  }
  const cached = embeddingsCache.get(embeddingPath);
  if (cached?.mtimeMs === mtimeMs) {
    embeddingsCache.delete(embeddingPath);
    embeddingsCache.set(embeddingPath, cached);
    return cached.embeddings;
  }
  const { loadEmbeddings } = await import("../storage/embedding-store.js");
  const { embeddingMemBudgetBytes } = await import("../config.js");
  const embeddings = await loadEmbeddings(embeddingPath, embeddingMemBudgetBytes());
  embeddingsCache.delete(embeddingPath);
  embeddingsCache.set(embeddingPath, { mtimeMs, embeddings });
  while (embeddingsCache.size > MAX_EMBEDDING_ENTRIES) {
    const oldest = embeddingsCache.keys().next().value;
    if (oldest === undefined) break;
    embeddingsCache.delete(oldest);
  }
  return embeddings;
}

export function clearConversationEmbeddingsCacheForTesting(): void {
  embeddingsCache.clear();
  bm25Indexes.clear();
  indexedAt.clear();
}
