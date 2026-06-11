import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadConversationEmbeddingsCached,
  clearConversationEmbeddingsCacheForTesting,
} from "../../src/tools/conversation-tools.js";

describe("conversation embeddings cache (mtime-validated)", () => {
  let dir: string;

  beforeEach(async () => {
    clearConversationEmbeddingsCacheForTesting();
    dir = await mkdtemp(join(tmpdir(), "conv-emb-cache-"));
  });

  afterAll(async () => {
    clearConversationEmbeddingsCacheForTesting();
  });

  it("returns the same Map instance on a repeat call (cache hit)", async () => {
    const path = join(dir, "x.embeddings.ndjson");
    await writeFile(path, '{"id":"a","vec":[0.1,0.2]}\n');

    const first = await loadConversationEmbeddingsCached(path);
    const second = await loadConversationEmbeddingsCached(path);
    expect(first.size).toBe(1);
    expect(second).toBe(first); // identity = no disk re-read

    await rm(dir, { recursive: true, force: true });
  });

  it("reloads when the file mtime changes", async () => {
    const path = join(dir, "y.embeddings.ndjson");
    await writeFile(path, '{"id":"a","vec":[0.1,0.2]}\n');
    const first = await loadConversationEmbeddingsCached(path);
    expect(first.size).toBe(1);

    await writeFile(path, '{"id":"a","vec":[0.1,0.2]}\n{"id":"b","vec":[0.3,0.4]}\n');
    // Force a distinct mtime even on coarse-grained filesystems
    const future = new Date(Date.now() + 5_000);
    await utimes(path, future, future);

    const second = await loadConversationEmbeddingsCached(path);
    expect(second.size).toBe(2);
    expect(second).not.toBe(first);

    await rm(dir, { recursive: true, force: true });
  });

  it("caches the empty result for a missing file", async () => {
    const path = join(dir, "missing.embeddings.ndjson");
    const first = await loadConversationEmbeddingsCached(path);
    const second = await loadConversationEmbeddingsCached(path);
    expect(first.size).toBe(0);
    expect(second).toBe(first);

    await rm(dir, { recursive: true, force: true });
  });
});
