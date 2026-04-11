/**
 * Shared cache for the Next.js framework audit (T11).
 *
 * Sub-tools called by `frameworkAudit` re-walk the same files and re-parse
 * the same trees. This cache shares parsed tree promises and walk results
 * across sub-tools, with a TTL eviction policy so long-running servers don't
 * grow unbounded.
 *
 * Pattern: promise-sharing (not result caching). Concurrent calls for the
 * same key reuse the in-flight promise. After resolution, the result stays
 * in cache until the TTL expires.
 */

import type Parser from "web-tree-sitter";
import { parseFile } from "../parser/parser-manager.js";
import { walkDirectory, type WalkOptions } from "./walk.js";

const DEFAULT_TTL_MS = 60000;

interface CacheEntry<T> {
  promise: Promise<T>;
  expires: number;
}

// ---------------------------------------------------------------------------
// Module-level singleton for framework_audit to share across sub-tools
// ---------------------------------------------------------------------------
let _globalCache: NextjsAuditCache | null = null;

/** Activate the shared cache (called by frameworkAudit at start). */
export function activateGlobalCache(): NextjsAuditCache {
  _globalCache = new NextjsAuditCache();
  return _globalCache;
}

/** Deactivate and clear (called by frameworkAudit at end). */
export function deactivateGlobalCache(): void {
  _globalCache?.clear();
  _globalCache = null;
}

/** Get the active cache, or null if not in a framework_audit context. */
export function getGlobalCache(): NextjsAuditCache | null {
  return _globalCache;
}

/**
 * Proxy for walkDirectory that uses global cache when active.
 * Drop-in replacement — same signature as walkDirectory.
 */
export async function cachedWalkDirectory(root: string, options?: WalkOptions): Promise<string[]> {
  if (_globalCache) return _globalCache.getWalk(root, options);
  return walkDirectory(root, options);
}

/**
 * Proxy for parseFile that uses global cache when active.
 * Drop-in replacement — same signature as parseFile.
 */
export async function cachedParseFile(path: string, source: string): Promise<Parser.Tree | null> {
  if (_globalCache) return _globalCache.getParsedFile(path, source);
  return parseFile(path, source);
}

export class NextjsAuditCache {
  private parseFileCache: Map<string, CacheEntry<Parser.Tree | null>> = new Map();
  private walkCache: Map<string, CacheEntry<string[]>> = new Map();
  private readonly ttl: number;

  constructor() {
    const envTtl = process.env.NEXTJS_AST_CACHE_TTL_MS;
    if (envTtl !== undefined) {
      const parsed = Number(envTtl);
      this.ttl = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS;
    } else {
      this.ttl = DEFAULT_TTL_MS;
    }
  }

  /**
   * Parse and cache a file. Concurrent calls share the same promise.
   * Synchronous (returns the cached/in-flight Promise directly) so that
   * `cache.getParsedFile(p) === cache.getParsedFile(p)` for concurrent calls.
   */
  getParsedFile(path: string, source: string): Promise<Parser.Tree | null> {
    const now = Date.now();
    this.evictExpired(now);

    const cached = this.parseFileCache.get(path);
    if (cached && cached.expires > now) {
      return cached.promise;
    }

    const promise = parseFile(path, source);
    this.parseFileCache.set(path, { promise, expires: now + this.ttl });
    return promise;
  }

  /** Walk and cache a directory. Concurrent calls share the same promise. */
  getWalk(root: string, options?: WalkOptions): Promise<string[]> {
    const key = `${root}::${JSON.stringify(options ?? {})}`;
    const now = Date.now();
    this.evictExpired(now);

    const cached = this.walkCache.get(key);
    if (cached && cached.expires > now) {
      return cached.promise;
    }

    const promise = walkDirectory(root, options);
    this.walkCache.set(key, { promise, expires: now + this.ttl });
    return promise;
  }

  /** Clear all entries. */
  clear(): void {
    this.parseFileCache.clear();
    this.walkCache.clear();
  }

  /** Total cached entries. */
  size(): number {
    return this.parseFileCache.size + this.walkCache.size;
  }

  /** Evict entries whose TTL has passed. */
  private evictExpired(now: number): void {
    for (const [key, entry] of this.parseFileCache) {
      if (entry.expires <= now) this.parseFileCache.delete(key);
    }
    for (const [key, entry] of this.walkCache) {
      if (entry.expires <= now) this.walkCache.delete(key);
    }
  }
}
