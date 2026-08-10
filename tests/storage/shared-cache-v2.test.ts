import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat, open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendSharedCache,
  loadSharedCache,
  contentKey,
  _resetSharedCacheForTests,
} from "../../src/storage/shared-embedding-cache.js";

/**
 * The v1 cache held 4.56% of the corpus and had stopped growing. Three defects, and the first one
 * is the reason the other two were never noticed.
 *
 * v1 accumulated a whole batch into ONE string (`payload += JSON.stringify(...)`). At ~16,248 bytes
 * per 768-dim vector that reaches V8's hard `MAX_STRING_LENGTH` (536,870,888) at 33,042 entries and
 * throws `RangeError: Invalid string length` into a bare `catch {}` — zero bytes written, no log.
 * 7 of 37 symbol files exceed that ceiling and hold 64% of the corpus, so the repos that would
 * benefit most were precisely the ones that wrote nothing.
 *
 * Fixing only that would have been WORSE than the bug: at v1's density the corpus projects to
 * 12.1 GB against 2.28 GB at fixed-width float32. The ceiling was an accidental circuit breaker.
 */

const DIM = 768;
let dir: string;
const prevDataDir = process.env["CODESIFT_DATA_DIR"];
const prevSharedCacheBudget = process.env["CODESIFT_MAX_SHARED_CACHE_MB"];

function vec(seed: number): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.fround(Math.sin(seed * 0.37 + i * 0.011));
  return v;
}

const keyOf = (n: number): string => contentKey("embeddinggemma", DIM, `symbol-${n}`);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codesift-sharedv2-"));
  process.env["CODESIFT_DATA_DIR"] = dir;
  // This suite deliberately writes more than 64 MB. Make its read-side
  // expectation independent of the runner's total RAM and default budget.
  process.env["CODESIFT_MAX_SHARED_CACHE_MB"] = "256";
  _resetSharedCacheForTests();
});

afterEach(async () => {
  if (prevDataDir === undefined) delete process.env["CODESIFT_DATA_DIR"];
  else process.env["CODESIFT_DATA_DIR"] = prevDataDir;
  if (prevSharedCacheBudget === undefined) delete process.env["CODESIFT_MAX_SHARED_CACHE_MB"];
  else process.env["CODESIFT_MAX_SHARED_CACHE_MB"] = prevSharedCacheBudget;
  _resetSharedCacheForTests();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function cacheFile(): Promise<string> {
  return join(dir, "shared-embeddings.v2.bin");
}

describe("a batch past v1's ceiling is written, not silently dropped", () => {
  it("stores a batch past the string ceiling — v1 wrote zero bytes and said nothing", async () => {
    await loadSharedCache(); // establishes the in-memory map so dedup is live

    // Derive the ceiling from the actual encoded width rather than hardcoding 33,042: that number
    // came from REAL vectors (16,248 B/line) and synthetic ones encode slightly shorter, so a fixed
    // N would sit just under the limit and prove nothing.
    const oneLine = JSON.stringify({ k: keyOf(0), v: Array.from(vec(0)) }).length + 1;
    const MAX_STRING = 536_870_888;
    const N = Math.ceil(MAX_STRING / oneLine) + 500;

    const entries = Array.from({ length: N }, (_, i) => ({ key: keyOf(i), vec: vec(i) }));

    // The v1 failure, reproduced on this exact input: one string for the whole batch.
    let v1Error: string | null = null;
    try {
      let payload = "";
      for (const e of entries) payload += JSON.stringify({ k: e.key, v: Array.from(e.vec) }) + "\n";
      if (payload.length === 0) throw new Error("unreachable");
    } catch (err) {
      v1Error = (err as Error).message;
    }
    expect(v1Error).toMatch(/Invalid string length/);

    appendSharedCache(entries);
    _resetSharedCacheForTests();
    const loaded = await loadSharedCache();
    expect(loaded.size).toBe(N);
  }, 120_000);
});

describe("round trip is exact and compact", () => {
  it("returns bit-identical float32 vectors", async () => {
    await loadSharedCache();
    const entries = [0, 1, 2].map((i) => ({ key: keyOf(i), vec: vec(i) }));
    appendSharedCache(entries);

    _resetSharedCacheForTests();
    const loaded = await loadSharedCache();
    for (const e of entries) {
      const got = loaded.get(e.key);
      expect(got).toBeDefined();
      // Not "close enough": a float32 stored as float32 must come back identical, and the
      // measurement that justified this format showed the source values already are float32.
      expect(Array.from(got as Float32Array)).toEqual(Array.from(e.vec));
    }
  });

  it("uses fixed-width records — 3,094 bytes per 768-dim vector, not 16,248", async () => {
    await loadSharedCache();
    const n = 100;
    appendSharedCache(Array.from({ length: n }, (_, i) => ({ key: keyOf(i), vec: vec(i) })));

    const size = (await stat(await cacheFile())).size;
    expect(size).toBe(n * (16 + 2 + 4 + DIM * 4));
    // Against v1's measured 16,248 bytes per line.
    expect(size / n).toBeLessThan(16_248 / 5);
  });
});

describe("duplicates are not re-appended", () => {
  it("writing the same keys twice does not grow the file", async () => {
    await loadSharedCache();
    const entries = Array.from({ length: 50 }, (_, i) => ({ key: keyOf(i), vec: vec(i) }));

    appendSharedCache(entries);
    const first = (await stat(await cacheFile())).size;

    appendSharedCache(entries); // v1 appended all 50 again; 11.3% of its lines were repeats
    const second = (await stat(await cacheFile())).size;

    expect(second).toBe(first);
    _resetSharedCacheForTests();
    expect((await loadSharedCache()).size).toBe(50);
  });
});

describe("a torn tail costs one record, not the cache", () => {
  it("keeps every complete record when the last one is truncated", async () => {
    await loadSharedCache();
    const entries = Array.from({ length: 10 }, (_, i) => ({ key: keyOf(i), vec: vec(i) }));
    appendSharedCache(entries);

    // A writer killed mid-append is the expected failure here, not an exotic one.
    const path = await cacheFile();
    const full = (await stat(path)).size;
    const fh = await open(path, "r+");
    await fh.truncate(full - 500);
    await fh.close();

    _resetSharedCacheForTests();
    const loaded = await loadSharedCache();
    expect(loaded.size).toBe(9);
    expect(loaded.has(keyOf(0))).toBe(true);
  });

  it("stops at an impossible dimension instead of allocating on a corrupt byte", async () => {
    await loadSharedCache();
    appendSharedCache([0, 1].map((i) => ({ key: keyOf(i), vec: vec(i) })));

    const path = await cacheFile();
    const fh = await open(path, "r+");
    // Corrupt the SECOND record's dim field to something absurd.
    const rec = 16 + 2 + 4 + DIM * 4;
    await fh.write(Buffer.from([0xff, 0xff]), 0, 2, rec + 16);
    await fh.close();

    _resetSharedCacheForTests();
    const loaded = await loadSharedCache();
    expect(loaded.size).toBe(1); // the first record survives; reading stops at the bad one
  });
});

/**
 * The point of the cache, asserted end to end.
 *
 * Everything above proves the file is written correctly. None of it proves the thing the cache
 * exists for: that a SECOND repo containing the same text does not call the model again. That is
 * the whole justification — a linked worktree is a separate repo to CodeSift and its files are
 * usually byte-identical to the checkout it came from.
 *
 * The embed function counts its calls, so a cache miss is impossible to mistake for a hit.
 */
describe("a second repo with identical content does not call the model", () => {
  it("embeds once, then serves the same texts from cache", async () => {
    const { batchEmbed } = await import("../../src/storage/embedding-store.js");
    await loadSharedCache();

    const texts = new Map(Array.from({ length: 40 }, (_, i) => [`repoA:sym${i}`, `function f${i}() {}`]));
    const model = { model: "embeddinggemma", dimensions: DIM };

    let modelCalls = 0;
    let textsEmbedded = 0;
    const embed = async (batch: string[]): Promise<number[][]> => {
      modelCalls++;
      textsEmbedded += batch.length;
      return batch.map((_, i) => Array.from(vec(i)));
    };

    const first = await batchEmbed(texts, new Map(), embed, 100, "repoA", model);
    expect(first.size).toBe(40);
    expect(textsEmbedded).toBe(40);
    const callsAfterFirst = modelCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Same TEXTS, different repo and different symbol ids — exactly a worktree of the first.
    const worktreeTexts = new Map(
      Array.from({ length: 40 }, (_, i) => [`repoB:sym${i}`, `function f${i}() {}`]),
    );
    const second = await batchEmbed(worktreeTexts, new Map(), embed, 100, "repoB", model);

    expect(second.size).toBe(40);
    // The assertion the whole feature rests on.
    expect(textsEmbedded).toBe(40);
    expect(modelCalls).toBe(callsAfterFirst);

    // And it served the right vectors, not merely something.
    expect(Array.from(second.get("repoB:sym7") as Float32Array))
      .toEqual(Array.from(first.get("repoA:sym7") as Float32Array));
  });

  it("still calls the model for text it has never seen", async () => {
    const { batchEmbed } = await import("../../src/storage/embedding-store.js");
    await loadSharedCache();
    const model = { model: "embeddinggemma", dimensions: DIM };

    let textsEmbedded = 0;
    const embed = async (batch: string[]): Promise<number[][]> => {
      textsEmbedded += batch.length;
      return batch.map((_, i) => Array.from(vec(i)));
    };

    await batchEmbed(new Map([["a:1", "alpha"]]), new Map(), embed, 100, "a", model);
    await batchEmbed(new Map([["b:1", "beta"]]), new Map(), embed, 100, "b", model);
    // Two distinct texts: a cache that returned a hit here would be silently corrupting results.
    expect(textsEmbedded).toBe(2);
  });
});

/**
 * A record that fails its checksum must not be served.
 *
 * Corruption injection against the first draft measured the cost of not checking: two flipped bytes
 * inside a vector produced 1000 of 1000 records "read successfully", one of them silently wrong.
 * A wrong embedding yields a plausible similarity score, which is worse than a cache miss — the
 * miss is recoverable and the wrong answer is not detectable.
 *
 * And one implausible dim byte at record 10 cost 99% of the file, because the reader stopped rather
 * than guess where the next record began. With the length intact the next offset IS known, so a
 * failing checksum now costs exactly one record.
 */
describe("a corrupt vector is dropped, not served", () => {
  it("skips the damaged record and keeps every other one", async () => {
    await loadSharedCache();
    const entries = Array.from({ length: 20 }, (_, i) => ({ key: keyOf(i), vec: vec(i) }));
    appendSharedCache(entries);

    const REC = 16 + 2 + 4 + DIM * 4;
    const fh = await open(await cacheFile(), "r+");
    // Flip two bytes deep inside record 5's vector — the shape stays perfectly plausible.
    await fh.write(Buffer.from([0x7f, 0x7f]), 0, 2, REC * 5 + 16 + 2 + 4 + 400);
    await fh.close();

    _resetSharedCacheForTests();
    const loaded = await loadSharedCache();

    expect(loaded.size).toBe(19);          // one dropped, not one served wrong
    expect(loaded.has(keyOf(5))).toBe(false);
    expect(loaded.has(keyOf(4))).toBe(true);
    expect(loaded.has(keyOf(19))).toBe(true); // and reading continued past it
  });

  it("round trip still returns the exact vector when the checksum matches", async () => {
    await loadSharedCache();
    const e = { key: keyOf(1), vec: vec(1) };
    appendSharedCache([e]);
    _resetSharedCacheForTests();
    const loaded = await loadSharedCache();
    expect(Array.from(loaded.get(e.key) as Float32Array)).toEqual(Array.from(e.vec));
  });
});
