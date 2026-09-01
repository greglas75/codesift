import type { FSWatcher } from "../../storage/watcher.js";
import type { BM25Index } from "../../search/bm25.js";
import type { CodeIndex } from "../../types.js";
import { totalmem as osTotalmem } from "node:os";

export const activeWatchers = new Map<string, FSWatcher>();
export const bm25Indexes = new Map<string, BM25Index>();

/**
 * Bytes a BM25 index occupies, from its own token totals.
 *
 * Measured with a heapUsed delta around a real build: 352,125 symbols / 12,882,846 tokens cost
 * 399 MB, i.e. 32.5 B per token — the postings maps dominate, so tokens are the quantity to price
 * by, not symbols. Rounded UP to 40, on the same reasoning as the index footprint: over-reporting
 * evicts something that would have fitted, under-reporting silently breaks the budget.
 */
function bm25FootprintBytes(index: BM25Index): number {
  let tokens = 0;
  for (const field of Object.keys(index.totalFieldLengths) as (keyof typeof index.totalFieldLengths)[]) {
    tokens += index.totalFieldLengths[field];
  }
  return tokens * 40;
}

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
  const budget = maxBM25CacheBytes();
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

function maxBM25CacheBytes(): number {
  const raw = process.env["CODESIFT_MAX_BM25_CACHE_MB"];
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed * 1024 * 1024;
  }
  // Same RAM tiers as the index and embedding budgets, so the three agree about what a machine
  // this size is willing to hold resident.
  const totalGb = totalSystemMemoryBytes() / 1024 ** 3;
  const mb = totalGb <= 16 ? 256 : totalGb <= 32 ? 512 : 1024;
  return mb * 1024 * 1024;
}

function totalSystemMemoryBytes(): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return osTotalmem();
  } catch {
    return 8 * 1024 ** 3;
  }
}
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
