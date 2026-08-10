import type { CodeIndex } from "../types.js";
import { indexCacheMemBudgetBytes } from "../config.js";
import { indexFootprintBytes } from "./index-footprint.js";
import type { IndexSummary } from "./sqlite-index-store.js";

/** Bounded by entry count, not bytes: a summary holds no symbols, so it cannot dominate the heap
 *  the way a materialised index can. */
const MAX_CACHED_SUMMARIES = 16;
const summaryCache = new Map<string, { summary: IndexSummary; dataVersion: number }>();

function copySummary(summary: IndexSummary): IndexSummary {
  const out: IndexSummary = { ...summary, files: [...summary.files] };
  if (summary.workspaces !== undefined) out.workspaces = [...summary.workspaces];
  return out;
}

export function resetSummaryCacheForTesting(): void {
  summaryCache.clear();
}

export function getCachedSummary(
  dbPath: string,
  dataVersion: number,
): IndexSummary | null {
  const cached = summaryCache.get(dbPath);
  if (!cached || cached.dataVersion !== dataVersion) return null;

  summaryCache.delete(dbPath);
  summaryCache.set(dbPath, cached);
  return copySummary(cached.summary);
}

export function cacheLoadedSummary(
  dbPath: string,
  summary: IndexSummary,
  dataVersion: number,
): IndexSummary {
  summaryCache.set(dbPath, { summary, dataVersion });
  while (summaryCache.size > MAX_CACHED_SUMMARIES) {
    const oldest = summaryCache.keys().next();
    if (oldest.done) break;
    summaryCache.delete(oldest.value);
  }
  return copySummary(summary);
}

interface CachedIndex {
  index: CodeIndex;
  dataVersion: number;
}

// `|| 3` would be wrong here: an operator setting 0 to minimise memory would get 3, because
// 0 is falsy. Only a non-numeric value should fall back.
const MAX_CACHED_INDEXES = (() => {
  const raw = process.env["CODESIFT_MAX_CACHED_INDEXES"];
  const parsed = raw === undefined ? 3 : Number(raw);
  return Math.max(1, Number.isNaN(parsed) ? 3 : parsed);
})();
const indexCache = new Map<string, CachedIndex>();

function cachedBytes(): number {
  let total = 0;
  for (const entry of indexCache.values()) total += indexFootprintBytes(entry.index);
  return total;
}

function cacheIndex(dbPath: string, entry: CachedIndex): void {
  indexCache.delete(dbPath);
  indexCache.set(dbPath, entry);

  const budget = indexCacheMemBudgetBytes();
  let total = cachedBytes();
  while (indexCache.size > 1 && (indexCache.size > MAX_CACHED_INDEXES || total > budget)) {
    const oldest = indexCache.entries().next();
    if (oldest.done) break;
    const [key, cachedEntry] = oldest.value;
    total -= indexFootprintBytes(cachedEntry.index);
    indexCache.delete(key);
  }
}

function copyIndex(index: CodeIndex): CodeIndex {
  return { ...index, files: [...index.files], symbols: [...index.symbols] };
}

export function getCachedIndex(dbPath: string, dataVersion: number): CodeIndex | null {
  const cached = indexCache.get(dbPath);
  if (!cached || cached.dataVersion !== dataVersion) return null;

  cacheIndex(dbPath, cached);
  return copyIndex(cached.index);
}

export function cacheLoadedIndex(
  dbPath: string,
  index: CodeIndex,
  dataVersion: number,
): CodeIndex {
  cacheIndex(dbPath, { index, dataVersion });
  return copyIndex(index);
}

export function invalidateIndexCache(dbPath: string): void {
  indexCache.delete(dbPath);
  summaryCache.delete(dbPath);
}

export function resetIndexCacheForTesting(): void {
  indexCache.clear();
}

export function getIndexCacheSizeForTesting(): number {
  return indexCache.size;
}

export function getIndexCacheBytesForTesting(): number {
  return cachedBytes();
}
