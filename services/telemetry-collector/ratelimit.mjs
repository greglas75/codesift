// Rate limiting for the telemetry collector.
//
// Keyed on the REAL client IP (from the trusted reverse proxy's X-Forwarded-For),
// NEVER on the client-supplied `anon_id`. The bug this closes: the old limiter
// keyed on `payload.anon_id` and returned "not limited" whenever it was absent —
// so a caller on the open /ingest/codesift endpoint could omit or rotate anon_id
// and bypass the limit entirely (verified live: 3 no-id POSTs all 200). A caller
// cannot forge the IP that our own Traefik appends, and a missing IP falls into a
// single shared "unknown" bucket that is still limited (never exempt).

/**
 * Resolve a stable rate-limit key for a request. Behind exactly one trusted proxy
 * (Traefik on coding-vps), the RIGHTMOST X-Forwarded-For entry is the address the
 * proxy actually observed; any entries to its left are client-supplied and
 * untrusted (a client can prepend fakes, but cannot stop Traefik appending the
 * real peer to the right). Falls back to the socket peer, then a shared bucket.
 * @param {{ headers?: Record<string,unknown>, socket?: { remoteAddress?: string } }} req
 * @returns {string} never empty
 */
export function clientKey(req) {
  const raw = req && req.headers ? req.headers["x-forwarded-for"] : undefined;
  const xff = String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ip = xff.length ? xff[xff.length - 1] : (req && req.socket && req.socket.remoteAddress) || "";
  return ip || "unknown";
}

/** Fixed-window per-key counter. `hit` returns true when the key is OVER the limit. */
export class RateLimiter {
  /** @param {{ max: number, windowMs: number }} opts */
  constructor({ max, windowMs }) {
    this.max = max;
    this.windowMs = windowMs;
    /** @type {Map<string, { count: number, resetAt: number }>} */
    this.buckets = new Map();
  }

  /** @returns {boolean} true if this hit exceeds the limit and should be rejected */
  hit(key, now) {
    let e = this.buckets.get(key);
    if (!e || now > e.resetAt) {
      e = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, e);
    }
    e.count++;
    return e.count > this.max;
  }

  /** Drop expired buckets so the map can't grow unbounded. */
  sweep(now) {
    for (const [k, v] of this.buckets) if (now > v.resetAt) this.buckets.delete(k);
  }
}
