import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadEmbeddings,
  saveEmbeddings,
  saveEmbeddingMeta,
  loadEmbeddingMeta,
  getEmbeddingPath,
  getEmbeddingMetaPath,
  batchEmbed,
} from "../../src/storage/embedding-store.js";
import type { EmbeddingMeta } from "../../src/types.js";

let tmpDir: string;
let embeddingPath: string;
let metaPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-embedding-test-"));
  embeddingPath = join(tmpDir, "test.embeddings.ndjson");
  metaPath = join(tmpDir, "test.embeddings.meta.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------------------------------------------------------------------------
// getEmbeddingPath / getEmbeddingMetaPath
// ---------------------------------------------------------------------------

describe("getEmbeddingPath", () => {
  it("replaces .index.json with .embeddings.ndjson", () => {
    const indexPath = "/data/abc123.index.json";
    expect(getEmbeddingPath(indexPath)).toBe("/data/abc123.embeddings.ndjson");
  });
});

describe("getEmbeddingMetaPath", () => {
  it("replaces .index.json with .embeddings.meta.json", () => {
    const indexPath = "/data/abc123.index.json";
    expect(getEmbeddingMetaPath(indexPath)).toBe("/data/abc123.embeddings.meta.json");
  });
});

// ---------------------------------------------------------------------------
// loadEmbeddings / saveEmbeddings
// ---------------------------------------------------------------------------

describe("saveEmbeddings + loadEmbeddings", () => {
  it("round-trips embeddings correctly", async () => {
    const embeddings = new Map<string, Float32Array>([
      ["sym1", new Float32Array([0.1, 0.2, 0.3])],
      ["sym2", new Float32Array([0.4, 0.5, 0.6])],
    ]);

    await saveEmbeddings(embeddingPath, embeddings);
    const loaded = await loadEmbeddings(embeddingPath);

    expect(loaded.size).toBe(2);
    const sym1 = loaded.get("sym1")!;
    expect(sym1[0]).toBeCloseTo(0.1);
    expect(sym1[1]).toBeCloseTo(0.2);
    expect(sym1[2]).toBeCloseTo(0.3);
  });

  it("returns empty Map when file doesn't exist", async () => {
    const result = await loadEmbeddings("/nonexistent/path.ndjson");
    expect(result.size).toBe(0);
  });

  it("skips malformed lines without crashing", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(embeddingPath, '{"id":"good","vec":[1,2,3]}\nBAD LINE\n{"id":"ok","vec":[4,5,6]}\n');
    const result = await loadEmbeddings(embeddingPath);
    expect(result.size).toBe(2);
    expect(result.has("good")).toBe(true);
    expect(result.has("ok")).toBe(true);
  });

  it("preserves Float32Array type", async () => {
    const embeddings = new Map([["s1", new Float32Array([1, 2, 3])]]);
    await saveEmbeddings(embeddingPath, embeddings);
    const loaded = await loadEmbeddings(embeddingPath);
    expect(loaded.get("s1")).toBeInstanceOf(Float32Array);
  });

  it("atomic write: file has correct content after save", async () => {
    const embeddings = new Map([
      ["a", new Float32Array([1, 0])],
      ["b", new Float32Array([0, 1])],
    ]);
    await saveEmbeddings(embeddingPath, embeddings);
    const loaded = await loadEmbeddings(embeddingPath);
    expect(loaded.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// saveEmbeddingMeta / loadEmbeddingMeta
// ---------------------------------------------------------------------------

describe("saveEmbeddingMeta + loadEmbeddingMeta", () => {
  const meta: EmbeddingMeta = {
    model: "voyage-code-3",
    provider: "voyage",
    dimensions: 1024,
    symbol_count: 500,
    updated_at: 1700000000000,
  };

  it("round-trips metadata correctly", async () => {
    await saveEmbeddingMeta(metaPath, meta);
    const loaded = await loadEmbeddingMeta(metaPath);
    expect(loaded).toEqual(meta);
  });

  it("returns null for missing file", async () => {
    const result = await loadEmbeddingMeta("/nonexistent/meta.json");
    expect(result).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(metaPath, "not json");
    const result = await loadEmbeddingMeta(metaPath);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// batchEmbed
// ---------------------------------------------------------------------------

describe("batchEmbed", () => {
  function fakeEmbedFn(texts: string[]): Promise<number[][]> {
    // Return a 3-dimensional embedding where each dim = text.length % 10
    return Promise.resolve(texts.map((t) => [t.length % 10, 0, 0]));
  }

  it("embeds all symbols when no existing embeddings", async () => {
    const symbolTexts = new Map([
      ["sym1", "function getUserById"],
      ["sym2", "class UserService"],
    ]);
    const result = await batchEmbed(symbolTexts, new Map(), fakeEmbedFn, 128);
    expect(result.size).toBe(2);
    expect(result.has("sym1")).toBe(true);
    expect(result.has("sym2")).toBe(true);
  });

  it("skips symbols that already have embeddings", async () => {
    const symbolTexts = new Map([
      ["sym1", "function getUserById"],
      ["sym2", "class UserService"],
    ]);
    const existing = new Map([["sym1", new Float32Array([9, 9, 9])]]);

    let callCount = 0;
    const trackingFn = (texts: string[]) => {
      callCount++;
      return fakeEmbedFn(texts);
    };

    const result = await batchEmbed(symbolTexts, existing, trackingFn, 128);
    expect(result.size).toBe(2);
    // sym1 should keep its existing embedding (9,9,9)
    expect(result.get("sym1")![0]).toBe(9);
    // sym2 should be newly embedded
    expect(result.has("sym2")).toBe(true);
    expect(callCount).toBe(1); // only one batch call for sym2
  });

  it("removes embeddings for symbols no longer in symbolTexts", async () => {
    const symbolTexts = new Map([["sym1", "function a"]]);
    const existing = new Map([
      ["sym1", new Float32Array([1, 0, 0])],
      ["deleted-sym", new Float32Array([0, 1, 0])],
    ]);

    const result = await batchEmbed(symbolTexts, existing, fakeEmbedFn, 128);
    expect(result.has("sym1")).toBe(true);
    expect(result.has("deleted-sym")).toBe(false);
  });

  it("returns existing map unchanged when all already embedded", async () => {
    const symbolTexts = new Map([["sym1", "text"]]);
    const existing = new Map([["sym1", new Float32Array([1, 2, 3])]]);

    let called = false;
    const trackingFn = (texts: string[]) => {
      called = true;
      return fakeEmbedFn(texts);
    };

    const result = await batchEmbed(symbolTexts, existing, trackingFn, 128);
    expect(called).toBe(false);
    expect(result.get("sym1")![0]).toBe(1);
  });

  it("processes symbols in batches", async () => {
    const symbolTexts = new Map(
      Array.from({ length: 10 }, (_, i) => [`sym${i}`, `text ${i}`]),
    );

    const batchSizes: number[] = [];
    const trackingFn = (texts: string[]) => {
      batchSizes.push(texts.length);
      return fakeEmbedFn(texts);
    };

    await batchEmbed(symbolTexts, new Map(), trackingFn, 3); // batch size 3
    // 10 symbols / 3 per batch = 4 batches (3+3+3+1)
    expect(batchSizes).toEqual([3, 3, 3, 1]);
  });
});
