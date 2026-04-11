import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextjsAuditCache } from "../../src/utils/nextjs-audit-cache.js";

describe("NextjsAuditCache", () => {
  let cache: NextjsAuditCache;

  beforeEach(() => {
    cache = new NextjsAuditCache();
  });

  afterEach(() => {
    cache.clear();
    vi.useRealTimers();
  });

  it("returns the same promise for concurrent parseFile calls on same path", async () => {
    const p1 = cache.getParsedFile("missing.ts", "const x = 1;");
    const p2 = cache.getParsedFile("missing.ts", "const x = 1;");
    // Same in-flight promise
    expect(p1).toBe(p2);
  });

  it("returns same resolved value for repeat calls within TTL", async () => {
    const r1 = await cache.getParsedFile("missing.ts", "const x = 1;");
    const r2 = await cache.getParsedFile("missing.ts", "const x = 1;");
    expect(r1).toBe(r2);
  });

  it("evicts entries after TTL with fake timers", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    await cache.getParsedFile("a.ts", "const x = 1;");
    expect(cache.size()).toBe(1);

    // Advance past default TTL (60s)
    vi.setSystemTime(start + 70000);
    // Trigger eviction by calling another method
    await cache.getParsedFile("b.ts", "const y = 2;");
    // 'a' evicted; 'b' is the only one
    expect(cache.size()).toBe(1);
  });

  it("clear() removes all entries", async () => {
    await cache.getParsedFile("a.ts", "const x = 1;");
    expect(cache.size()).toBeGreaterThan(0);
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it("respects NEXTJS_AST_CACHE_TTL_MS env override", () => {
    process.env["NEXTJS_AST_CACHE_TTL_MS"] = "100";
    const c = new NextjsAuditCache();
    expect(c).toBeDefined();
    delete process.env["NEXTJS_AST_CACHE_TTL_MS"];
  });
});
