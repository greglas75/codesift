import type { FSWatcher } from "../../storage/watcher.js";
import { bm25CacheBudgetBytes, bm25FootprintBytes, type BM25Index } from "../../search/bm25.js";
import type { CodeIndex } from "../../types.js";
import { indexFootprintBytes } from "../../storage/index-footprint.js";
import { indexCacheMemBudgetBytes } from "../../config.js";

export const activeWatchers = new Map<string, FSWatcher>();
export const bm25Indexes = new Map<string, BM25Index>();

/**
 * Keep the BM25 cache inside a budget, evicting least-recently-used first.
 *
 * This cache had NO bound of any kind — no LRU, no budget, no entry cap — while every neighbour has
 * one (`CODESIFT_MAX_INDEX_CACHE_MB` for indexes, `CODESIFT_MAX_EMBEDDING_MEM_MB` for embeddings, a
 * watcher cap, an LRU parse cache). It survived because eviction happened by ACCIDENT: every
 * `index_file` deleted its repo's entry, and the PostToolUse hook fires on every agent edit, so the
 * map was constantly being emptied by the thing that looked like cache invalidation.
 *
 * 69a49cd made those edits update the index in place instead of dropping it — a 595x win on the
 * edit path, and it removed the only thing keeping this map small. The daemon then climbed to the
 * 16 GB heap ceiling and crash-looped: 15.1 GB, 16.0 GB, restart, repeat, with clients that
 * happened to initialize during a restart window getting no tools at all for their whole session.
 *
 * At ~400 MB for a large repository, the budget holds two or three. That is the point: a repo
 * evicted here is rebuilt on next use, which now costs one build rather than one per edit.
 */
export function rememberBM25Index(repoName: string, index: BM25Index): void {
  bm25Indexes.delete(repoName);
  bm25Indexes.set(repoName, index);
  evictBM25OverBudget(repoName);
}

/** Mark an entry as most-recently-used, so eviction drops cold repos rather than merely old ones. */
export function touchBM25Index(repoName: string): void {
  const existing = bm25Indexes.get(repoName);
  if (!existing) return;
  bm25Indexes.delete(repoName);
  bm25Indexes.set(repoName, existing);
}

function evictBM25OverBudget(pinned: string): void {
  const budget = bm25CacheBudgetBytes();
  let total = 0;
  for (const index of bm25Indexes.values()) total += bm25FootprintBytes(index);
  if (total <= budget) return;

  for (const [name, index] of bm25Indexes) {
    if (total <= budget) break;
    // Never evict the repo being served, even when it alone exceeds the budget — otherwise every
    // call into a large repository would rebuild and immediately discard its own index.
    if (name === pinned) continue;
    total -= bm25FootprintBytes(index);
    bm25Indexes.delete(name);
  }
}


export const codeIndexes = new Map<string, CodeIndex>();

/**
 * Put a loaded index into `codeIndexes`, evicting least-recently-used entries past the index byte
 * budget — the most recent one is always kept.
 *
 * `codeIndexes` had no bound at all: entries left only when that repo's files changed or the whole
 * server went idle, and a daemon serving ~30 sessions is never idle. The byte budget that ADR-004 put on
 * the storage-level cache (`storage/index-cache.ts`) did not reach it — this map kept every index
 * referenced after the storage cache let go. Measured on the Mac daemon 2026-10-09: 9 indexes, 4.9 GB
 * priced, over a 4 GB budget and still growing. Third occurrence of one class here (the conversation
 * BM25 cache, the code BM25 cache): a second map of one structure with no bound of its own.
 */
export function rememberCodeIndex(repoName: string, index: CodeIndex): void {
  codeIndexes.delete(repoName);
  codeIndexes.set(repoName, index);
  const budget = indexCacheMemBudgetBytes();
  let total = 0;
  for (const cached of codeIndexes.values()) total += indexFootprintBytes(cached);
  while (codeIndexes.size > 1 && total > budget) {
    const oldest = codeIndexes.keys().next().value!;
    total -= indexFootprintBytes(codeIndexes.get(oldest)!);
    codeIndexes.delete(oldest);
  }
}

/** Mark an index as just used, so budget eviction takes the stalest one first. */
export function touchCodeIndex(repoName: string): void {
  const index = codeIndexes.get(repoName);
  if (index === undefined) return;
  codeIndexes.delete(repoName);
  codeIndexes.set(repoName, index);
}
export const embeddingCaches = new Map<string, Map<string, Float32Array>>();
export const embeddingCacheGenerations = new Map<string, number>();
export const embeddingCacheSources = new Map<string, string>();

export function invalidateEmbeddingCache(cacheKey: string): void {
  embeddingCaches.delete(cacheKey);
  embeddingCacheSources.delete(cacheKey);
  embeddingCacheGenerations.set(cacheKey, (embeddingCacheGenerations.get(cacheKey) ?? 0) + 1);
}

/** Compare and publish synchronously so invalidation cannot interleave with the set. */
export function cacheEmbeddingIfGenerationCurrent(
  cacheKey: string,
  generation: number,
  embeddings: Map<string, Float32Array>,
  source?: string,
): boolean {
  if ((embeddingCacheGenerations.get(cacheKey) ?? 0) !== generation) return false;
  embeddingCaches.set(cacheKey, embeddings);
  if (source) embeddingCacheSources.set(cacheKey, source);
  return true;
}

export const lastFullIndexAt = new Map<string, number>();

/**
 * Chunk vectors share `embeddingCaches` under a DERIVED key, so this is the one
 * place it is spelled — see {@link invalidateEmbeddingCaches} for why that matters.
 */
export function chunkCacheKey(repoName: string): string {
  return `${repoName}:chunks`;
}

/**
 * Drop every resident embedding map belonging to a repo — symbols AND chunks.
 *
 * The obvious `embeddingCaches.delete(repoName)` evicts only half of what it
 * appears to, because chunk vectors are stored under `<repo>:chunks`. Every
 * invalidation site did exactly that: re-indexing a file, the watcher seeing a
 * change, `invalidate_cache`, and repo removal all left the chunk vectors behind.
 *
 * In a long-lived process — the launchd daemon, or a stdio session that outlives
 * a re-index — chunk-level semantic search then answered from PRE-REINDEX vectors
 * for the rest of that process's life. `loadChunks` re-reads the rewritten text
 * from disk on every query while the vectors stayed frozen, and a chunk id is
 * `<repo>:<file>:<startLine>`, so an edited chunk keeps its id and gets scored by
 * its stale vector; chunks in newly added files are missing from the cache
 * entirely. No error, no signal, and symbol search stays correct throughout —
 * which is exactly what made it invisible.
 *
 * This is a live definition rather than a comment on five call sites because the
 * bug was that five call sites each independently forgot the same thing.
 */
export function invalidateEmbeddingCaches(repoName: string): void {
  // Delegates to the generation-aware single-key form rather than deleting directly. Two
  // invalidation mechanisms landed here from separate branches — a plain delete (symbols AND
  // chunks) and a generation bump (one key, so a concurrent load cannot republish what was just
  // invalidated). Keeping both as independent code paths would mean a repo removed through this
  // function never bumps its generation, and an in-flight load could put the old map back after
  // the caches were cleared. One mechanism, called twice.
  invalidateEmbeddingCache(repoName);
  invalidateEmbeddingCache(chunkCacheKey(repoName));
}

// ---------------------------------------------------------------------------
// Idle release
// ---------------------------------------------------------------------------

/**
 * Drop every materialised cache this process is holding.
 *
 * Eviction was budget-based ONLY, and budget eviction runs on ACCESS — so a server that loaded an
 * index and then went quiet held all of it forever. Measured on this Mac: 27 codesift processes
 * holding 8.4 GB, 23 of them spawned by one client that keeps a server per session alive; ages
 * ~1h50m, individual resident sets up to 2.6 GB, while swap sat at 17.6 of 18.4 GB. Nothing was
 * leaking — the caches were simply immortal.
 *
 * Cheap to undo: the next call reloads from disk (a cold load is seconds, and the SQLite backend
 * made warm loads ~17800x faster than the JSON one it replaced). Holding gigabytes for hours
 * against a possible future query is the worse trade on a machine running many sessions at once.
 *
 * Watchers are deliberately NOT stopped: they are cheap, and dropping them would silently stop
 * incremental updates for a repo the client still has open.
 */
/**
 * Entry counts and each cache's OWN priced bytes, for the `/health` cache report.
 *
 * Reported together because they disagree, and the disagreement is the diagnostic: a count-bounded
 * cache looks small while holding gigabytes, which is the defect ADR-004 fixed for the index cache
 * and the one still latent wherever a count is the only bound.
 */
export function cacheEntryCounts(): {
  indexes: number;
  index_bytes: number;
  bm25: number;
  bm25_bytes: number;
  embeddings: number;
} {
  let indexBytes = 0;
  for (const index of codeIndexes.values()) indexBytes += indexFootprintBytes(index);
  let bm25Bytes = 0;
  for (const index of bm25Indexes.values()) bm25Bytes += bm25FootprintBytes(index);
  return {
    indexes: codeIndexes.size,
    index_bytes: indexBytes,
    bm25: bm25Indexes.size,
    bm25_bytes: bm25Bytes,
    embeddings: embeddingCaches.size,
  };
}

export function releaseCachedIndexes(): { indexes: number; bm25: number; embeddings: number } {
  const released = {
    indexes: codeIndexes.size,
    bm25: bm25Indexes.size,
    embeddings: embeddingCaches.size,
  };
  codeIndexes.clear();
  bm25Indexes.clear();
  // Bump generations so an in-flight load cannot publish into the cache we just cleared.
  for (const key of embeddingCaches.keys()) invalidateEmbeddingCache(key);
  embeddingCaches.clear();
  embeddingCacheSources.clear();
  return released;
}

let lastActivityAt = Date.now();

/** Called on every tool invocation — the only signal that this process is still in use. */
export function markToolActivity(): void {
  lastActivityAt = Date.now();
}

export function millisSinceLastActivity(): number {
  return Date.now() - lastActivityAt;
}

/** Test seam: pretend the process has been idle for `ms`. */
export function _setLastActivityForTests(ms: number): void {
  lastActivityAt = Date.now() - ms;
}

/**
 * Below this, rebuilding is cheaper than the disk it would cost. 1 s is roughly where a repo is
 * large enough that a restart is noticeable to whoever is waiting on the first search.
 */
export const BM25_PERSIST_MIN_BUILD_MS = 1_000;
