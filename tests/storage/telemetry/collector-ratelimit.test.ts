import { describe, it, expect } from "vitest";
// The collector is a zero-dep .mjs service; its rate-limit logic is extracted so
// it is unit-testable without spinning up the HTTP server.
import { clientKey, RateLimiter } from "../../../services/telemetry-collector/ratelimit.mjs";

describe("collector clientKey", () => {
  it("uses the RIGHTMOST X-Forwarded-For entry (the trusted-proxy-appended IP)", () => {
    // client can prepend a fake to the left; Traefik appends the real peer to the right
    const req = { headers: { "x-forwarded-for": "1.2.3.4 , 203.0.113.9" } };
    expect(clientKey(req)).toBe("203.0.113.9");
  });

  it("falls back to the socket peer when no XFF header is present", () => {
    expect(clientKey({ headers: {}, socket: { remoteAddress: "198.51.100.7" } })).toBe("198.51.100.7");
  });

  it("returns the shared 'unknown' bucket (never empty) when neither is available", () => {
    expect(clientKey({ headers: {} })).toBe("unknown");
    expect(clientKey({})).toBe("unknown");
  });
});

describe("collector RateLimiter — closes the anon_id-omission bypass", () => {
  const now = 1_000_000;

  it("limits by key regardless of any anon_id (the limiter never sees anon_id)", () => {
    const rl = new RateLimiter({ max: 3, windowMs: 60_000 });
    const key = "unknown"; // no-IP requests all share this bucket
    // Simulates the live-demonstrated attack: N POSTs with NO anon_id, same source.
    expect(rl.hit(key, now)).toBe(false); // 1
    expect(rl.hit(key, now)).toBe(false); // 2
    expect(rl.hit(key, now)).toBe(false); // 3 (== max, still ok)
    expect(rl.hit(key, now)).toBe(true); // 4 → OVER limit, rejected
    expect(rl.hit(key, now)).toBe(true); // stays rejected within the window
  });

  it("isolates buckets per client IP", () => {
    const rl = new RateLimiter({ max: 1, windowMs: 60_000 });
    expect(rl.hit("10.0.0.1", now)).toBe(false);
    expect(rl.hit("10.0.0.1", now)).toBe(true); // second from same IP → over
    expect(rl.hit("10.0.0.2", now)).toBe(false); // different IP → fresh bucket
  });

  it("resets after the window elapses", () => {
    const rl = new RateLimiter({ max: 1, windowMs: 60_000 });
    expect(rl.hit("10.0.0.1", now)).toBe(false);
    expect(rl.hit("10.0.0.1", now)).toBe(true);
    expect(rl.hit("10.0.0.1", now + 60_001)).toBe(false); // window rolled over
  });

  it("sweep() drops only expired buckets", () => {
    const rl = new RateLimiter({ max: 5, windowMs: 60_000 });
    rl.hit("expired", now);
    rl.hit("fresh", now + 30_000);
    rl.sweep(now + 60_001); // "expired" resetAt=now+60000 < this; "fresh" resetAt=now+90000 > this
    expect(rl.buckets.has("expired")).toBe(false);
    expect(rl.buckets.has("fresh")).toBe(true);
  });
});
