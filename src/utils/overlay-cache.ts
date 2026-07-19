/**
 * OverlayCache — small bounded LRU cache for expensive per-symbol overlay
 * computations, keyed `${repo}:${symbol}`.
 *
 * - True LRU: delete+set on hit re-inserts at the end (Map preserves
 *   insertion order), so the oldest untouched key is always evicted first.
 * - TTL eviction: entries expire after `ttlMs`; `null` (negative) results
 *   use a shorter `negativeTtlMs` so failed lookups retry sooner.
 * - sha-based invalidation: a lookup whose sha differs from the stored sha
 *   is a miss, and the stale entry is dropped before recomputing.
 * - In-flight promise dedupe: concurrent getOrCompute() calls for the same
 *   key share a single loader invocation.
 * - Injectable clock (`now`) for deterministic TTL tests — no real sleeps.
 */

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_NEGATIVE_TTL_MS = 30_000;

interface OverlayEntry<T> {
  value: T | null;
  sha: string;
  expiresAt: number;
}

export interface OverlayCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  negativeTtlMs?: number;
  now?: () => number;
}

export class OverlayCache<T> {
  private entries = new Map<string, OverlayEntry<T>>();
  private inflight = new Map<string, Promise<T | null>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly now: () => number;

  constructor(options: OverlayCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Get a cached value or compute it via `loader`. A hit requires both a
   * matching sha and an unexpired entry; otherwise any stale entry is
   * dropped and `loader` runs. Concurrent calls for the same key share one
   * in-flight loader invocation.
   */
  async getOrCompute(
    repo: string,
    symbol: string,
    sha: string,
    loader: () => Promise<T | null>,
  ): Promise<T | null> {
    const key = `${repo}:${symbol}`;
    const cached = this.entries.get(key);
    if (cached) {
      if (cached.sha === sha && cached.expiresAt > this.now()) {
        this.entries.delete(key);
        this.entries.set(key, cached); // re-insert at end: true LRU
        return cached.value;
      }
      this.entries.delete(key); // stale (expired or sha mismatch)
    }

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = loader()
      .then((value) => {
        const ttl = value === null ? this.negativeTtlMs : this.ttlMs;
        this.entries.set(key, { value, sha, expiresAt: this.now() + ttl });
        this.evictOverflow();
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
