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
  contentHashesFor,
  primeContentHashes,
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

describe("batchEmbed with batches in flight at once", () => {
  // Answers arriving out of order must not land on another batch's ids, and the checkpoint must
  // still be written in batch order.
  it("pairs every vector with its own text and reports batches in order", async () => {
    const texts = new Map(Array.from({ length: 10 }, (_, i) => [`id${i}`, String(i)]));
    const reported: string[][] = [];

    const result = await batchEmbed(
      texts, new Map(),
      // The first batch answers last.
      async (batch) => {
        await new Promise((r) => setTimeout(r, batch[0] === "0" ? 30 : 1));
        return batch.map((t) => [Number(t)]);
      },
      3, undefined, undefined,
      async (done) => { reported.push(done.map((d) => d.id)); },
      4,
    );

    expect([...result].map(([id, v]) => [id, v[0]])).toEqual(
      Array.from({ length: 10 }, (_, i) => [`id${i}`, i]),
    );
    expect(reported).toEqual([["id0", "id1", "id2"], ["id3", "id4", "id5"], ["id6", "id7", "id8"], ["id9"]]);
  });

  // A paid API must not be asked twice for batches that succeeded beside a failed one.
  it("checkpoints the batches that succeeded before reporting a failed one", async () => {
    const texts = new Map(Array.from({ length: 9 }, (_, i) => [`id${i}`, String(i)]));
    const reported: string[] = [];

    const run = batchEmbed(
      texts, new Map(),
      async (batch) => {
        if (batch.includes("3")) throw new Error("upstream 500");
        return batch.map((t) => [Number(t)]);
      },
      3, undefined, undefined,
      async (done) => { reported.push(...done.map((d) => d.id)); },
      4,
    );

    await expect(run).rejects.toThrow("upstream 500");
    expect(reported).toEqual(["id0", "id1", "id2", "id6", "id7", "id8"]);
  });
});

describe("batchEmbed when text only moved to another line", () => {
  // A line added above a chunk renamed it (ids end in the line), and a worktree on another branch
  // re-embedded ~100k chunks whose text it already had vectors for.
  it("reuses the stored vector of the same text in the same file", async () => {
    const stored = new Float32Array([7, 7]);
    // Learn the hash batchEmbed gives "same text" by embedding it once under the old id.
    await batchEmbed(new Map([["r:a.ts:10", "same text"]]), new Map(), async (t) => t.map(() => [7, 7]), 8, "moved-repo");
    const storedHash = contentHashesFor("moved-repo").get("r:a.ts:10")!;
    primeContentHashes("moved-repo-2", new Map([["r:a.ts:10", storedHash]]));
    const sent: string[] = [];

    const result = await batchEmbed(
      new Map([["r:a.ts:11", "same text"], ["r:b.ts:11", "same text"]]),
      new Map([["r:a.ts:10", stored]]),
      async (texts) => { sent.push(...texts); return texts.map(() => [1, 1]); },
      8, "moved-repo-2",
    );

    expect(result.get("r:a.ts:11")).toBe(stored);
    // Another file is another place: the same text there is not paired by a 32-bit hash.
    expect(sent).toEqual(["same text"]);
    expect([...result.get("r:b.ts:11")!]).toEqual([1, 1]);
  });
});

