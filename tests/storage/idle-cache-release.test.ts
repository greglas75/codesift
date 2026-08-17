// Cache eviction was budget-based only and ran on ACCESS, so a server that loaded an index and
// then went quiet held all of it for as long as its client stayed connected.
//
// Measured on this Mac: 27 codesift processes holding 8.4 GB — 23 of them spawned by a single
// client that keeps one server per session — ages around 1h50m, individual resident sets up to
// 2.6 GB, while swap sat at 17.6 of 18.4 GB. Nothing leaked. The caches were immortal, and the
// paging that caused is what makes tool calls miss their 90s budget and read as "codesift is down".
import { describe, it, expect, beforeEach } from "vitest";
import {
  bm25Indexes,
  codeIndexes,
  embeddingCaches,
  embeddingCacheSources,
  releaseCachedIndexes,
  markToolActivity,
  millisSinceLastActivity,
  _setLastActivityForTests,
} from "../../src/tools/index-tools/state.js";
import { startIdleCacheRelease } from "../../src/server.js";

function seedCaches(): void {
  codeIndexes.set("local/a", { symbols: [], files: [] } as never);
  bm25Indexes.set("local/a", { centrality: new Map() } as never);
  embeddingCaches.set("local/a", new Map([["s1", new Float32Array([1, 2])]]));
  embeddingCacheSources.set("local/a", "/tmp/a.ndjson");
}

beforeEach(() => {
  codeIndexes.clear();
  bm25Indexes.clear();
  embeddingCaches.clear();
  embeddingCacheSources.clear();
  markToolActivity();
});

describe("releaseCachedIndexes", () => {
  it("drops every materialised cache and reports what it dropped", () => {
    seedCaches();
    const freed = releaseCachedIndexes();

    expect(freed).toEqual({ indexes: 1, bm25: 1, embeddings: 1 });
    expect(codeIndexes.size).toBe(0);
    expect(bm25Indexes.size).toBe(0);
    expect(embeddingCaches.size).toBe(0);
    // Sources too — a stale source path would make a later load think it had already read that file.
    expect(embeddingCacheSources.size).toBe(0);
  });

  it("is safe to call when nothing is cached", () => {
    expect(releaseCachedIndexes()).toEqual({ indexes: 0, bm25: 0, embeddings: 0 });
  });
});

describe("activity tracking", () => {
  it("resets on a tool call", () => {
    _setLastActivityForTests(60_000);
    expect(millisSinceLastActivity()).toBeGreaterThanOrEqual(60_000);
    markToolActivity();
    expect(millisSinceLastActivity()).toBeLessThan(1_000);
  });
});

describe("startIdleCacheRelease", () => {
  it("is disabled by CODESIFT_IDLE_RELEASE_MS=0", () => {
    const prev = process.env["CODESIFT_IDLE_RELEASE_MS"];
    process.env["CODESIFT_IDLE_RELEASE_MS"] = "0";
    try {
      expect(startIdleCacheRelease()).toBeNull();
    } finally {
      if (prev === undefined) delete process.env["CODESIFT_IDLE_RELEASE_MS"];
      else process.env["CODESIFT_IDLE_RELEASE_MS"] = prev;
    }
  });

  it("releases once the idle window has passed, and not before", async () => {
    const prev = process.env["CODESIFT_IDLE_RELEASE_MS"];
    process.env["CODESIFT_IDLE_RELEASE_MS"] = "40";
    const timer = startIdleCacheRelease();
    try {
      seedCaches();
      markToolActivity();
      // Still active: a busy server must not have its indexes pulled out from under it.
      await new Promise((r) => setTimeout(r, 25));
      expect(codeIndexes.size).toBe(1);

      _setLastActivityForTests(5_000);
      await new Promise((r) => setTimeout(r, 90));
      expect(codeIndexes.size).toBe(0);
    } finally {
      if (timer) clearInterval(timer);
      if (prev === undefined) delete process.env["CODESIFT_IDLE_RELEASE_MS"];
      else process.env["CODESIFT_IDLE_RELEASE_MS"] = prev;
    }
  });

  it("does not keep the process alive on its own", () => {
    const timer = startIdleCacheRelease();
    try {
      // `unref`'d timers report hasRef() === false; a referenced one would make every stdio server
      // outlive its client, which is the opposite of what this is for.
      expect(timer?.hasRef()).toBe(false);
    } finally {
      if (timer) clearInterval(timer);
    }
  });
});
