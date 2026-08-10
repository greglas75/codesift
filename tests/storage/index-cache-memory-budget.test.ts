import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  saveIndex,
  loadIndex,
  resetIndexBackendForTesting,
  resetMigrationCacheForTesting,
  resetIndexCacheForTesting,
  getIndexCacheSizeForTesting,
  getIndexCacheBytesForTesting,
} from "../../src/storage/index-store.js";
import { closeAllIndexDbs } from "../../src/storage/sqlite-index-store.js";
import {
  indexFootprintBytes,
  recordIndexFootprint,
} from "../../src/storage/index-footprint.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";
import { HAS_NODE_SQLITE } from "../helpers/node-sqlite.js";

const describeWithSqlite = HAS_NODE_SQLITE ? describe : describe.skip;
const itWithSqlite = HAS_NODE_SQLITE ? it : it.skip;

/**
 * The cache was bounded by ENTRY COUNT, which prices a 411 MB index and a 2 MB one identically.
 * Index sizes span two orders of magnitude, so "at most three" was not a memory ceiling at all.
 */

let dir: string;

function makeSymbol(file: string, name: string, line: number, source?: string): CodeSymbol {
  const sym: CodeSymbol = {
    id: `test:${file}:${name}:${line}`,
    repo: "test/repo",
    name,
    kind: "function",
    file,
    start_line: line,
    end_line: line + 1,
  };
  if (source !== undefined) sym.source = source;
  return sym;
}

function makeIndex(symbols: CodeSymbol[]): CodeIndex {
  const files = [...new Set(symbols.map((s) => s.file))].map((path) => ({
    path,
    language: "typescript",
    symbol_count: symbols.filter((s) => s.file === path).length,
    last_modified: 1,
  }));
  return {
    repo: "test/repo",
    root: "/tmp/root",
    symbols,
    files,
    created_at: 1,
    updated_at: 2,
    symbol_count: symbols.length,
    file_count: files.length,
  };
}

/** A repo whose symbols carry `padBytes` of source each — the knob that makes an index "big". */
function sizedIndex(nSymbols: number, padBytes: number): CodeIndex {
  const pad = "x".repeat(padBytes);
  return makeIndex(
    Array.from({ length: nSymbols }, (_, i) => makeSymbol(`f${i}.ts`, `fn${i}`, i + 1, pad)),
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codesift-cachebudget-"));
  process.env["CODESIFT_INDEX_BACKEND"] = "sqlite";
  resetIndexBackendForTesting();
  resetMigrationCacheForTesting();
  resetIndexCacheForTesting();
});

afterEach(async () => {
  closeAllIndexDbs();
  delete process.env["CODESIFT_INDEX_BACKEND"];
  delete process.env["CODESIFT_MAX_INDEX_CACHE_MB"];
  resetIndexBackendForTesting();
  resetIndexCacheForTesting();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("index footprint", () => {
  it("prefers the loader's measured tally over the estimate", () => {
    const index = sizedIndex(10, 100);
    const estimated = indexFootprintBytes(index);
    expect(estimated).toBeGreaterThan(0);
    expect(estimated).not.toBe(12_345); // or the assertion below would prove nothing

    recordIndexFootprint(index, 12_345);
    expect(indexFootprintBytes(index)).toBe(12_345);
  });

  it("estimates an unmeasured index from its counts rather than returning nothing", () => {
    // "Size unknown" is not a usable answer when the caller is deciding what to evict: it can only
    // collapse into treating a huge index as free, or refusing to cache anything.
    const small = indexFootprintBytes(makeIndex([makeSymbol("a.ts", "a", 1)]));
    const large = indexFootprintBytes(sizedIndex(500, 0));
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small * 100);
  });

  itWithSqlite("counts source text, so two indexes with equal symbol counts are not priced the same", async () => {
    const lean = join(dir, "lean.index.json");
    const fat = join(dir, "fat.index.json");
    await saveIndex(lean, sizedIndex(40, 0));
    await saveIndex(fat, sizedIndex(40, 4_000));

    resetIndexCacheForTesting();
    const leanLoaded = await loadIndex(lean);
    const leanBytes = getIndexCacheBytesForTesting();
    resetIndexCacheForTesting();
    const fatLoaded = await loadIndex(fat);
    const fatBytes = getIndexCacheBytesForTesting();

    expect(leanLoaded!.symbols).toHaveLength(fatLoaded!.symbols.length);
    expect(fatBytes).toBeGreaterThan(leanBytes * 2);
  });
});

describeWithSqlite("index cache evicts on a byte budget", () => {
  it("drops older repos once the budget is exceeded, regardless of entry count", async () => {
    // Budget of 1 MB against ~40 KB of padded source per index: the third load must not simply
    // sit alongside the first two the way an entry cap of 3 allowed.
    process.env["CODESIFT_MAX_INDEX_CACHE_MB"] = "1";

    for (const name of ["a", "b", "c"]) {
      const p = join(dir, `${name}.index.json`);
      await saveIndex(p, sizedIndex(120, 4_000));
      await loadIndex(p);
    }

    expect(getIndexCacheBytesForTesting()).toBeLessThanOrEqual(1024 * 1024);
    expect(getIndexCacheSizeForTesting()).toBeLessThan(3);
  });

  it("keeps several small repos resident — the budget is bytes, not entries", async () => {
    process.env["CODESIFT_MAX_INDEX_CACHE_MB"] = "64";
    for (const name of ["a", "b"]) {
      const p = join(dir, `${name}.index.json`);
      await saveIndex(p, sizedIndex(5, 10));
      await loadIndex(p);
    }
    expect(getIndexCacheSizeForTesting()).toBe(2);
  });

  it("keeps the index it just loaded even when that one index exceeds the whole budget", async () => {
    // Evicting it would re-read the same index on the next call and evict it again: an unbounded
    // reload loop costing far more than the memory reclaimed.
    process.env["CODESIFT_MAX_INDEX_CACHE_MB"] = "1";
    const p = join(dir, "huge.index.json");
    await saveIndex(p, sizedIndex(400, 8_000)); // ~3 MB of source against a 1 MB budget
    await loadIndex(p);

    expect(getIndexCacheSizeForTesting()).toBe(1);
    expect(getIndexCacheBytesForTesting()).toBeGreaterThan(1024 * 1024);

    // And it is a real cache entry: the second read is served without touching the loader.
    const again = await loadIndex(p);
    expect(again!.symbols).toHaveLength(400);
    expect(getIndexCacheSizeForTesting()).toBe(1);
  });
});
