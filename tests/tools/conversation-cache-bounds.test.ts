// The conversation BM25 cache was the second cache of BM25 indexes in the process and had none of
// what the first one got — no LRU, no budget, no entry cap, and not even the accidental eviction that
// used to keep that one small. Nothing had ever removed an entry from it.
//
// Its size was not bounded by how many conversation indexes exist on disk, because the loader BUILDS
// from symbols rather than reading a persisted index: 3 of 1,258 conversation repos here had a
// `.bm25.ndjson` at all. What bounded it was how many repos got searched — and
// `searchAllConversations` searched every one in a single `Promise.all`, written when its own comment
// said "~20+".
//
// Measured 2026-09-27, one `search_all_conversations` on this install: 1,258 projects, 53.7 s,
// heapUsed 5 MB -> 3,262 MB, and 2,784 MB still retained after an explicit GC. A second identical
// call took 0.6 s, which is the proof that all of it was still referenced rather than merely
// allocated.
//
// The freshness cases cover the defect the memory bound would otherwise have masked: the lookup was
// `if (!bm25) build`, so the first search in a process fixed the answer for that process's life —
// 27 hours in the daemon, during which no newly recorded conversation could be found. Eviction also
// happens to refresh, so a cache with a bound hides a cache with no revalidation.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { BM25Index } from "../../src/search/bm25.js";
import {
  getConversationBM25Index,
  setConversationBM25Index,
  conversationCacheStats,
  clearConversationEmbeddingsCacheForTesting,
} from "../../src/tools/conversation-cache.js";

/** An index whose priced footprint is exactly `tokens * 40`, so a budget test can be exact. */
function indexOfTokens(tokens: number): BM25Index {
  return {
    fields: {
      name: new Map(), signature: new Map(), docstring: new Map(), body: new Map(), comments: new Map(),
    },
    avgFieldLengths: { name: 0, signature: 0, docstring: 0, body: 0, comments: 0 },
    docCount: 0,
    symbols: new Map(),
    centrality: new Map(),
    fieldLengths: new Map(),
    totalFieldLengths: { name: tokens, signature: 0, docstring: 0, body: 0, comments: 0 },
  } as unknown as BM25Index;
}

const MB = 1024 * 1024;
let prevBudget: string | undefined;

beforeEach(() => {
  prevBudget = process.env["CODESIFT_MAX_CONVERSATION_BM25_CACHE_MB"];
  clearConversationEmbeddingsCacheForTesting();
});

afterEach(() => {
  if (prevBudget === undefined) delete process.env["CODESIFT_MAX_CONVERSATION_BM25_CACHE_MB"];
  else process.env["CODESIFT_MAX_CONVERSATION_BM25_CACHE_MB"] = prevBudget;
  clearConversationEmbeddingsCacheForTesting();
});

describe("conversation BM25 cache bound", () => {
  it("evicts least-recently-used entries once over budget", () => {
    process.env["CODESIFT_MAX_CONVERSATION_BM25_CACHE_MB"] = "2";
    // 0.9 MB each: two fit in the 2 MB budget, three cannot. Sized off the budget rather than at it
    // — `ceil(MB / 40) * 40` is 1,048,600 B, so two of THOSE already exceed 2 MB by 48 bytes and the
    // first draft of this test evicted on the second insert.
    const tokens = Math.floor((0.9 * MB) / 40);
    setConversationBM25Index("conversations/a", indexOfTokens(tokens));
    setConversationBM25Index("conversations/b", indexOfTokens(tokens));
    expect(conversationCacheStats().bm25).toBe(2);

    setConversationBM25Index("conversations/c", indexOfTokens(tokens));
    expect(conversationCacheStats().bm25).toBe(2);
    expect(getConversationBM25Index("conversations/a")).toBeNull();
    expect(getConversationBM25Index("conversations/c")).not.toBeNull();
  });

  it("a read makes an entry recently used, so a cold repo is dropped before a hot one", () => {
    process.env["CODESIFT_MAX_CONVERSATION_BM25_CACHE_MB"] = "2";
    const tokens = Math.floor((0.9 * MB) / 40);
    setConversationBM25Index("conversations/a", indexOfTokens(tokens));
    setConversationBM25Index("conversations/b", indexOfTokens(tokens));
    // Touch `a`, so `b` is now the coldest.
    expect(getConversationBM25Index("conversations/a")).not.toBeNull();

    setConversationBM25Index("conversations/c", indexOfTokens(tokens));
    expect(getConversationBM25Index("conversations/a")).not.toBeNull();
    expect(getConversationBM25Index("conversations/b")).toBeNull();
  });

  it("never evicts the repo being served, even alone over budget", () => {
    // Otherwise a single large conversation corpus rebuilds and discards its own index every call.
    process.env["CODESIFT_MAX_CONVERSATION_BM25_CACHE_MB"] = "1";
    setConversationBM25Index("conversations/huge", indexOfTokens(Math.ceil((8 * MB) / 40)));
    expect(getConversationBM25Index("conversations/huge")).not.toBeNull();
  });

  it("prices the cache so /health reports bytes, not just a count", () => {
    process.env["CODESIFT_MAX_CONVERSATION_BM25_CACHE_MB"] = "64";
    setConversationBM25Index("conversations/a", indexOfTokens(1000));
    const stats = conversationCacheStats();
    expect(stats.bm25).toBe(1);
    expect(stats.bm25_bytes).toBe(40_000);
  });
  it("takes a quarter of the BM25 tier when not set directly", () => {
    // Four full-tier budgets in one process (indexes, code BM25, embeddings, conversations) is 4 GB of
    // deliberate residency on this machine — correct individual bounds that still reach the ceiling.
    delete process.env["CODESIFT_MAX_CONVERSATION_BM25_CACHE_MB"];
    process.env["CODESIFT_MAX_BM25_CACHE_MB"] = "8";          // tier 8 MB -> conversations get 2 MB
    const tokens = Math.floor((0.9 * MB) / 40);
    setConversationBM25Index("conversations/a", indexOfTokens(tokens));
    setConversationBM25Index("conversations/b", indexOfTokens(tokens));
    setConversationBM25Index("conversations/c", indexOfTokens(tokens));
    expect(conversationCacheStats().bm25).toBe(2);
    delete process.env["CODESIFT_MAX_BM25_CACHE_MB"];
  });
});

describe("conversation BM25 cache freshness", () => {
  it("drops an entry the index has outrun", () => {
    setConversationBM25Index("conversations/a", indexOfTokens(10), 1_000);
    expect(getConversationBM25Index("conversations/a", 2_000)).toBeNull();
  });

  it("keeps an entry built at or after the index's own timestamp", () => {
    setConversationBM25Index("conversations/a", indexOfTokens(10), 2_000);
    expect(getConversationBM25Index("conversations/a", 2_000)).not.toBeNull();
    expect(getConversationBM25Index("conversations/a", 1_000)).not.toBeNull();
  });

  it("keeps the entry when the caller cannot say how fresh the index is", () => {
    // An unknown timestamp is the pre-existing behaviour and the conservative direction — a caller
    // that cannot read the index must not be able to empty the cache.
    setConversationBM25Index("conversations/a", indexOfTokens(10), 1_000);
    expect(getConversationBM25Index("conversations/a", 0)).not.toBeNull();
  });
});
