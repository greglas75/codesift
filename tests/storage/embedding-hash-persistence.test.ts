import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  batchEmbed,
  saveEmbeddings,
  loadEmbeddings,
  primeContentHashes,
  contentHashesFor,
  contentHashesForPath,
} from "../../src/storage/embedding-store.js";

/**
 * Content hashes decide whether a symbol needs re-embedding. They lived in a
 * module-level Map that was never written anywhere, so a fresh process loaded
 * the vectors from disk, found no hashes, compared every symbol as changed, and
 * re-embedded the whole corpus.
 *
 * That is 4,178,280 symbols across 1,587 local repos — 16.5 hours on an M5 GPU
 * at the measured 70 emb/s, 93 hours on CPU — repeated on every MCP server
 * start, and a server starts once per session. It is why killing a runaway
 * embedding process just produced another one doing the same work minutes
 * later.
 */
let dir: string;
let embeddingPath: string;
let calls: number;

const fakeEmbed = async (texts: string[]): Promise<number[][]> => {
  calls += texts.length;
  return texts.map(() => Array(8).fill(0.1));
};

function corpus(size: number): Map<string, string> {
  return new Map(
    Array.from({ length: size }, (_, i) => [`sym${i}`, `function f${i}() { return ${i}; }`]),
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cs-emb-hash-"));
  embeddingPath = join(dir, "x.embeddings.ndjson");
  calls = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("content hashes survive a process restart", () => {
  it("re-embeds nothing when the corpus is unchanged", async () => {
    const texts = corpus(50);

    const first = await batchEmbed(texts, new Map(), fakeEmbed, 16, "repoA");
    expect(calls).toBe(50);
    await saveEmbeddings(embeddingPath, first, contentHashesFor("repoA"));

    // A DIFFERENT cache key stands in for a fresh process: the in-memory map
    // knows nothing, exactly as after a restart.
    calls = 0;
    const loaded = await loadEmbeddings(embeddingPath);
    primeContentHashes("repoB", contentHashesForPath(embeddingPath));
    await batchEmbed(texts, loaded, fakeEmbed, 16, "repoB");

    expect(calls).toBe(0);
  });

  it("re-embeds only what actually changed", async () => {
    const texts = corpus(50);
    const first = await batchEmbed(texts, new Map(), fakeEmbed, 16, "repoA");
    await saveEmbeddings(embeddingPath, first, contentHashesFor("repoA"));

    const loaded = await loadEmbeddings(embeddingPath);
    primeContentHashes("repoB", contentHashesForPath(embeddingPath));

    calls = 0;
    const changed = new Map(texts);
    changed.set("sym7", "function f7() { return 999; }");
    await batchEmbed(changed, loaded, fakeEmbed, 16, "repoB");

    expect(calls).toBe(1);
  });

  it("still re-embeds everything without persisted hashes (the old files)", async () => {
    // Files written before hashes existed carry no `h`. Those entries must be
    // re-embedded once, which restores the invariant rather than trusting a
    // vector whose source text is unknown.
    const texts = corpus(20);
    const first = await batchEmbed(texts, new Map(), fakeEmbed, 16, "repoA");
    await saveEmbeddings(embeddingPath, first); // no hashes — legacy shape

    const raw = await readFile(embeddingPath, "utf-8");
    expect(raw).not.toContain('"h"');

    calls = 0;
    const loaded = await loadEmbeddings(embeddingPath);
    primeContentHashes("repoC", contentHashesForPath(embeddingPath));
    await batchEmbed(texts, loaded, fakeEmbed, 16, "repoC");

    expect(calls).toBe(20);
  });

  it("writes the hash beside the vector, not in a second file that can drift", async () => {
    const texts = corpus(3);
    const embeddings = await batchEmbed(texts, new Map(), fakeEmbed, 16, "repoA");
    await saveEmbeddings(embeddingPath, embeddings, contentHashesFor("repoA"));

    const lines = (await readFile(embeddingPath, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { id: string; vec: number[]; h?: number };
      expect(typeof parsed.h).toBe("number");
      expect(parsed.vec).toHaveLength(8);
    }
  });
});
