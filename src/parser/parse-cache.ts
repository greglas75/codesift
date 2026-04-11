/**
 * Parse cache — memoize tree-sitter parse trees by content hash.
 *
 * During indexing, a single Python file may be parsed twice:
 *   1. By extractPythonSymbols() in the symbol extraction pipeline
 *   2. By collectImportEdges() when building the Python import graph
 *
 * This cache stores parsed trees keyed by a cheap content hash so the
 * second call is a no-op. Size-bounded via LRU eviction (default 500
 * entries ≈ 10-50 MB on typical Python codebases).
 *
 * The cache is a singleton used across the indexing pipeline. Tests
 * can reset via `resetParseCache()`.
 */
import type Parser from "web-tree-sitter";

interface CacheEntry {
  tree: Parser.Tree;
  language: string;
  contentHash: string;
  lastAccessed: number;
}

const MAX_ENTRIES = 500;
const cache = new Map<string, CacheEntry>();
let hits = 0;
let misses = 0;
let accessCounter = 0;

/**
 * Compute a fast 32-bit hash of source + language.
 * Not cryptographic — just collision-resistant enough for cache keys.
 */
function hashContent(language: string, source: string): string {
  // djb2 hash variant — fast, good distribution for source text
  let h = 5381;
  for (let i = 0; i < source.length; i++) {
    h = ((h << 5) + h) ^ source.charCodeAt(i);
  }
  // Include language in key since the same source might parse differently
  // (though in practice every file has exactly one language).
  return `${language}:${source.length}:${h >>> 0}`;
}

/**
 * Get a cached parse tree, or null if not cached.
 * Updates LRU access time on hit.
 */
export function getCachedParse(
  language: string,
  source: string,
): Parser.Tree | null {
  const key = hashContent(language, source);
  const entry = cache.get(key);
  if (!entry) {
    misses++;
    return null;
  }
  hits++;
  entry.lastAccessed = ++accessCounter;
  return entry.tree;
}

/**
 * Store a parse tree in the cache. Evicts least-recently-accessed
 * entries if the cache exceeds MAX_ENTRIES.
 */
export function setCachedParse(
  language: string,
  source: string,
  tree: Parser.Tree,
): void {
  const key = hashContent(language, source);
  if (cache.has(key)) {
    const existing = cache.get(key)!;
    existing.lastAccessed = ++accessCounter;
    return;
  }

  // Evict LRU if full
  if (cache.size >= MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [k, e] of cache) {
      if (e.lastAccessed < oldestTime) {
        oldestTime = e.lastAccessed;
        oldestKey = k;
      }
    }
    if (oldestKey) cache.delete(oldestKey);
  }

  cache.set(key, {
    tree,
    language,
    contentHash: key,
    lastAccessed: ++accessCounter,
  });
}

/**
 * Reset the cache and stats. Primarily for tests.
 */
export function resetParseCache(): void {
  cache.clear();
  hits = 0;
  misses = 0;
  accessCounter = 0;
}

/**
 * Get cache stats for debugging / observability.
 */
export function getParseCacheStats(): {
  size: number;
  hits: number;
  misses: number;
  hit_rate: number;
} {
  const total = hits + misses;
  return {
    size: cache.size,
    hits,
    misses,
    hit_rate: total === 0 ? 0 : hits / total,
  };
}
