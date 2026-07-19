import { describe, it, expect, vi } from "vitest";
import { OverlayCache } from "../../src/utils/overlay-cache.js";

describe("OverlayCache", () => {
  it("evicts the oldest entry when a max-N cache receives its N+1th insert", async () => {
    const cache = new OverlayCache<string>({ maxEntries: 3 });
    const loaderA = vi.fn().mockResolvedValue("a");
    const loaderB = vi.fn().mockResolvedValue("b");
    const loaderC = vi.fn().mockResolvedValue("c");
    const loaderD = vi.fn().mockResolvedValue("d");

    await cache.getOrCompute("repo", "a", "sha1", loaderA);
    await cache.getOrCompute("repo", "b", "sha1", loaderB);
    await cache.getOrCompute("repo", "c", "sha1", loaderC);
    await cache.getOrCompute("repo", "d", "sha1", loaderD); // 4th insert evicts "a" (oldest)

    // "b" and "c" survived the eviction — no re-invocation
    await cache.getOrCompute("repo", "b", "sha1", loaderB);
    await cache.getOrCompute("repo", "c", "sha1", loaderC);
    expect(loaderB).toHaveBeenCalledTimes(1);
    expect(loaderC).toHaveBeenCalledTimes(1);

    // "a" was evicted — re-requesting it invokes the loader again
    await cache.getOrCompute("repo", "a", "sha1", loaderA);
    expect(loaderA).toHaveBeenCalledTimes(2);
  });

  it("expires an entry after ttlMs using an injectable clock (no real sleeps)", async () => {
    let now = 0;
    const cache = new OverlayCache<string>({ ttlMs: 1000, now: () => now });
    const loader = vi.fn().mockResolvedValue("value");

    await cache.getOrCompute("repo", "sym", "sha1", loader);
    now += 500;
    await cache.getOrCompute("repo", "sym", "sha1", loader);
    expect(loader).toHaveBeenCalledTimes(1); // still fresh, no re-invoke

    now += 600; // total elapsed 1100ms > ttlMs
    await cache.getOrCompute("repo", "sym", "sha1", loader);
    expect(loader).toHaveBeenCalledTimes(2); // expired, recomputed
  });

  it("caches a null (negative) result for negativeTtlMs without re-invoking the loader", async () => {
    let now = 0;
    const cache = new OverlayCache<string>({ ttlMs: 10_000, negativeTtlMs: 200, now: () => now });
    const loader = vi.fn().mockResolvedValue(null);

    const r1 = await cache.getOrCompute("repo", "sym", "sha1", loader);
    const r2 = await cache.getOrCompute("repo", "sym", "sha1", loader);
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);

    now += 300; // past negativeTtlMs
    await cache.getOrCompute("repo", "sym", "sha1", loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent getOrCompute calls for the same key into one loader invocation", async () => {
    const cache = new OverlayCache<string>();
    let resolveLoader: ((v: string) => void) | null = null;
    const loader = vi.fn().mockImplementation(
      () => new Promise<string>((resolve) => { resolveLoader = resolve; }),
    );

    const p1 = cache.getOrCompute("repo", "sym", "sha1", loader);
    const p2 = cache.getOrCompute("repo", "sym", "sha1", loader);
    expect(loader).toHaveBeenCalledTimes(1);
    resolveLoader!("shared");
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("shared");
    expect(r2).toBe("shared");
  });

  it("treats a lookup under a different sha as a miss and evicts the stale entry", async () => {
    const cache = new OverlayCache<string>();
    const loaderX = vi.fn().mockResolvedValue("valueX");
    const loaderY = vi.fn().mockResolvedValue("valueY");

    const r1 = await cache.getOrCompute("repo", "sym", "shaX", loaderX);
    expect(r1).toBe("valueX");
    expect(loaderX).toHaveBeenCalledTimes(1);

    const r2 = await cache.getOrCompute("repo", "sym", "shaY", loaderY);
    expect(r2).toBe("valueY");
    expect(loaderY).toHaveBeenCalledTimes(1);

    // old sha entry was evicted — requesting shaX again recomputes
    const r3 = await cache.getOrCompute("repo", "sym", "shaX", loaderX);
    expect(r3).toBe("valueX");
    expect(loaderX).toHaveBeenCalledTimes(2);
  });
});
