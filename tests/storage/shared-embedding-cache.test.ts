import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { batchEmbed } from "../../src/storage/embedding-store.js";
import {
  contentKey,
  loadSharedCache,
  appendSharedCache,
  _resetSharedCacheForTests,
} from "../../src/storage/shared-embedding-cache.js";

/**
 * A vector is a pure function of (model, dimensions, text) — nothing about it
 * belongs to a repository. Embeddings were stored per repo anyway, so the same
 * symbol text was sent to the model once per repo containing it.
 *
 * A linked worktree is a separate repo to CodeSift, and its files are usually
 * IDENTICAL to the checkout it came from: measured here,
 * `backlog-wave-1-integration` had 1,799 files and differed from main by ZERO.
 * With 40 worktrees registered, identical text was embedded up to 40 times, and
 * half of the two million symbols still queued were worktrees or temp copies.
 *
 * Auto-indexing no longer registers worktrees, but an explicit
 * `index_folder(path=<worktree>)` still must work — hint H19 tells agents to run
 * exactly that when they are working in one. This makes it cheap rather than
 * forbidden.
 */
let dataDir: string;
let calls: number;
const MODEL = { model: "test-model", dimensions: 4 };

const fakeEmbed = async (texts: string[]): Promise<number[][]> => {
  calls += texts.length;
  return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
};

function corpus(size: number): Map<string, string> {
  return new Map(Array.from({ length: size }, (_, i) => [`sym${i}`, `function f${i}() { return ${i}; }`]));
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "cs-shared-emb-"));
  process.env["CODESIFT_DATA_DIR"] = dataDir;
  _resetSharedCacheForTests();
  calls = 0;
});

afterEach(async () => {
  _resetSharedCacheForTests();
  await rm(dataDir, { recursive: true, force: true });
});

describe("embeddings are shared across repositories by content", () => {
  it("costs nothing for a second repo with identical text", async () => {
    const texts = corpus(50);

    await batchEmbed(texts, new Map(), fakeEmbed, 16, "repoA", MODEL);
    expect(calls).toBe(50);

    // A worktree: separate repo, separate index, NO shared embedding file.
    calls = 0;
    await batchEmbed(texts, new Map(), fakeEmbed, 16, "repoB", MODEL);
    expect(calls).toBe(0);
  });

  it("embeds only the symbols that genuinely differ", async () => {
    const texts = corpus(50);
    await batchEmbed(texts, new Map(), fakeEmbed, 16, "repoA", MODEL);

    calls = 0;
    const changed = new Map(texts);
    changed.set("sym7", "function f7() { return 999; }");
    await batchEmbed(changed, new Map(), fakeEmbed, 16, "repoB", MODEL);
    expect(calls).toBe(1);
  });

  it("never serves a vector from a different model", async () => {
    // Vectors from different models are not interchangeable, and serving one
    // for the other corrupts every similarity score instead of failing.
    const texts = corpus(20);
    await batchEmbed(texts, new Map(), fakeEmbed, 16, "repoA", MODEL);

    calls = 0;
    await batchEmbed(texts, new Map(), fakeEmbed, 16, "repoB", { model: "other", dimensions: 4 });
    expect(calls).toBe(20);

    calls = 0;
    await batchEmbed(texts, new Map(), fakeEmbed, 16, "repoC", { model: "test-model", dimensions: 8 });
    expect(calls).toBe(20);
  });

  it("behaves exactly as before when no model identity is passed", async () => {
    // CLI paths and older callers must be unaffected: no lookup, no writes.
    const texts = corpus(10);
    await batchEmbed(texts, new Map(), fakeEmbed, 16, "repoA");
    expect(calls).toBe(10);

    calls = 0;
    await batchEmbed(texts, new Map(), fakeEmbed, 16, "repoB");
    expect(calls).toBe(10);
  });

  it("survives a corrupt cache file rather than failing the run", async () => {
    // The cache is an optimization; a broken one must degrade to "compute it
    // again", never to an error that fails indexing.
    appendSharedCache([{ key: contentKey(MODEL.model, MODEL.dimensions, "x"), vec: new Float32Array([1, 2, 3, 4]) }]);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(join(dataDir, "shared-embeddings.v1.ndjson"), "{not json\n", "utf-8");
    _resetSharedCacheForTests();

    const cache = await loadSharedCache();
    expect(cache.size).toBe(1); // the good line survived, the bad one was skipped
  });
});
