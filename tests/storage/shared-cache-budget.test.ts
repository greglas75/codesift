// The shared cache had no memory bound, and until the writer was fixed it did not need one: appends
// threw RangeError above ~33k entries into a bare catch, so the file was accidentally frozen at
// 4.56% of the corpus. Fixing the writer and adding chunk texts to the same cache let it grow for
// real — measured on the live 856 MB file, loadSharedCache cost +1.16 GB RSS and starved the event
// loop for 5,384 ms inside a long-lived MCP server on a machine running 24-37 codesift processes.
//
// Stopping early is correct degradation here: the cache's only failure mode is a MISS, so a
// partially loaded one is still completely correct. These cover that it stops, that it stays
// correct when it does, and that the read no longer blocks.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DIM = 768;
const VECTOR_BYTES = DIM * 4;

let dir: string;
let prevDataDir: string | undefined;
let prevBudget: string | undefined;

async function fresh() {
  vi.resetModules();
  return import("../../src/storage/shared-embedding-cache.js");
}

/** Write n distinct vectors through the real writer, so the file is exactly what production makes. */
async function seed(n: number): Promise<string[]> {
  const { appendSharedCache, contentKey, _resetSharedCacheForTests } = await fresh();
  _resetSharedCacheForTests();
  const keys: string[] = [];
  const entries = [];
  for (let i = 0; i < n; i++) {
    const key = contentKey("m", DIM, `text-${i}`);
    keys.push(key);
    const vec = new Float32Array(DIM);
    vec[0] = i;
    entries.push({ key, vec });
  }
  appendSharedCache(entries);
  return keys;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codesift-cachebudget-"));
  prevDataDir = process.env["CODESIFT_DATA_DIR"];
  prevBudget = process.env["CODESIFT_MAX_SHARED_CACHE_MB"];
  process.env["CODESIFT_DATA_DIR"] = dir;
  delete process.env["CODESIFT_MAX_SHARED_CACHE_MB"];
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env["CODESIFT_DATA_DIR"];
  else process.env["CODESIFT_DATA_DIR"] = prevDataDir;
  if (prevBudget === undefined) delete process.env["CODESIFT_MAX_SHARED_CACHE_MB"];
  else process.env["CODESIFT_MAX_SHARED_CACHE_MB"] = prevBudget;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("shared cache memory budget", () => {
  it("stops at the budget instead of materialising the whole file", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const keys = await seed(400);                                   // ~1.17 MB of vectors

    // One megabyte holds 341 vectors of 3,072 payload bytes; the budget must bite before 400.
    process.env["CODESIFT_MAX_SHARED_CACHE_MB"] = "1";
    const { loadSharedCache } = await fresh();
    const map = await loadSharedCache();

    expect(map.size).toBeGreaterThan(0);
    expect(map.size).toBeLessThan(400);
    expect(map.size * VECTOR_BYTES).toBeLessThanOrEqual(1024 * 1024);
    // What IS loaded must still be correct — a truncated read that corrupted the prefix would be
    // far worse than not reading at all.
    const first = map.get(keys[0]!);
    expect(first).toBeInstanceOf(Float32Array);
    expect(first?.[0]).toBe(0);
  });

  it("loads everything when the budget is ample", async () => {
    const keys = await seed(50);
    process.env["CODESIFT_MAX_SHARED_CACHE_MB"] = "64";
    const { loadSharedCache } = await fresh();
    const map = await loadSharedCache();

    expect(map.size).toBe(50);
    expect(map.get(keys[49]!)?.[0]).toBe(49);
  });

  it("treats a budget of 0 as 'do not read the shared cache at all'", async () => {
    await seed(20);
    process.env["CODESIFT_MAX_SHARED_CACHE_MB"] = "0";
    const { loadSharedCache } = await fresh();

    expect((await loadSharedCache()).size).toBe(0);
  });

  it("says so when it stops early, rather than silently under-loading", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await seed(400);
    process.env["CODESIFT_MAX_SHARED_CACHE_MB"] = "1";
    const { loadSharedCache } = await fresh();
    await loadSharedCache();

    const said = spy.mock.calls.flat().join(" ");
    expect(said).toMatch(/budget/i);
    expect(said).toContain("CODESIFT_MAX_SHARED_CACHE_MB");
  });

  it("ignores a nonsensical budget instead of disabling the bound", async () => {
    await seed(10);
    process.env["CODESIFT_MAX_SHARED_CACHE_MB"] = "not-a-number";
    const { loadSharedCache } = await fresh();

    // Falls back to the RAM-scaled default, which is far above 10 vectors.
    expect((await loadSharedCache()).size).toBe(10);
  });

  it("does not block the event loop while reading", async () => {
    await seed(600);
    process.env["CODESIFT_MAX_SHARED_CACHE_MB"] = "64";
    const { loadSharedCache } = await fresh();

    // A synchronous reader starves this timer completely: it fires zero times.
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    await loadSharedCache();
    clearInterval(timer);

    expect(ticks).toBeGreaterThan(0);
  });
});
