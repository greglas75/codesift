import type { FSWatcher } from "../../storage/watcher.js";
import type { BM25Index } from "../../search/bm25.js";
import type { CodeIndex } from "../../types.js";

export const activeWatchers = new Map<string, FSWatcher>();
export const bm25Indexes = new Map<string, BM25Index>();
export const codeIndexes = new Map<string, CodeIndex>();
export const embeddingCaches = new Map<string, Map<string, Float32Array>>();

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
  embeddingCaches.delete(repoName);
  embeddingCaches.delete(chunkCacheKey(repoName));
}
