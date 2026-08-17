import type { FSWatcher } from "../../storage/watcher.js";
import type { BM25Index } from "../../search/bm25.js";
import type { CodeIndex } from "../../types.js";

export const activeWatchers = new Map<string, FSWatcher>();
export const bm25Indexes = new Map<string, BM25Index>();
export const codeIndexes = new Map<string, CodeIndex>();
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
