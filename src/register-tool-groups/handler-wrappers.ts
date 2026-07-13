/**
 * Reusable, server-agnostic wrappers for MCP tool handlers. Pure module (no
 * server/registration imports) so it composes around any async handler and is
 * unit-testable in isolation.
 */

type AnyArgs = readonly unknown[];

/** Sentinel returned when a wrapped handler exceeds its time budget. */
export interface TimeoutResult {
  status: "timed_out";
  tool?: string;
}

/**
 * Resolve to a `TimeoutResult` if `handler` runs longer than `ms`; otherwise
 * pass its value/rejection straight through. A slow handler that settles after
 * the timeout is swallowed (no unhandled rejection); the timer is cleared on settle.
 */
export function withTimeout<A extends AnyArgs, R>(
  handler: (...args: A) => Promise<R>,
  ms: number,
  toolName?: string,
): (...args: A) => Promise<R | TimeoutResult> {
  return (...args: A): Promise<R | TimeoutResult> =>
    new Promise<R | TimeoutResult>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(
          toolName !== undefined ? { status: "timed_out", tool: toolName } : { status: "timed_out" },
        );
      }, ms);
      // Attach an onRejected handler so a late rejection after timeout is swallowed (never unhandled).
      handler(...args).then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          if (settled) return; // abandoned after timeout — swallow.
          settled = true;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
}

/**
 * Bounded LRU cache keyed by `keyFn(...args)`. A HIT invokes the handler zero
 * extra times; concurrent same-key calls share ONE in-flight promise (single
 * execution); rejections are NOT cached (entry removed on failure) so failures
 * are retryable, not sticky.
 *
 * `shouldCache` (optional) additionally evicts *resolved* results that must not
 * be memoized — e.g. an error response that a handler RESOLVES rather than
 * rejects (`{ isError: true }`). Without it such a transient failure would stick
 * in the cache until the key changes. In-flight coalescing is preserved:
 * concurrent same-key calls still share the one promise; eviction only runs
 * after it settles.
 */
export function withCache<A extends AnyArgs, R>(
  handler: (...args: A) => Promise<R>,
  keyFn: (...args: A) => string,
  maxEntries = 256,
  shouldCache?: (result: R) => boolean,
): (...args: A) => Promise<R> {
  const cache = new Map<string, Promise<R>>();
  return (...args: A): Promise<R> => {
    const key = keyFn(...args);
    const hit = cache.get(key);
    if (hit !== undefined) {
      // Refresh recency (LRU): re-insert at the end of Map order.
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const pending = handler(...args);
    cache.set(key, pending);
    // Drop failed entries on rejection, AND drop resolved-but-uncacheable
    // results (shouldCache=false). The awaiter still sees the outcome via the
    // returned `pending`; this side chain only manages retention.
    pending.then(
      (value) => {
        if (shouldCache && !shouldCache(value) && cache.get(key) === pending) {
          cache.delete(key);
        }
      },
      () => {
        if (cache.get(key) === pending) cache.delete(key);
      },
    );
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value; // evict oldest beyond cap
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return pending;
  };
}

/** Deterministic JSON with recursively sorted object keys (for stable cache keys). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : val,
  );
}
