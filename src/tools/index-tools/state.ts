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
