import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getEmbeddingCache,
  _cachedEmbeddingReposForTesting,
} from "../../src/tools/index-tools.js";
import { getChunkEmbeddingCache } from "../../src/tools/index-tools/registry.js";
import {
  getChunkEmbeddingPath,
  getChunkPath,
  resolveChunkIndexPaths,
  saveChunkIndex,
} from "../../src/storage/chunk-store.js";
import { resetConfigCache } from "../../src/config.js";

const DIMS = 768;
const VECS_PER_REPO = 200; // 200×768×4 ≈ 614KB per repo → 2 repos exceed a 1MB budget

function writeRepo(dir: string, hash: string): string {
  const idxPath = join(dir, `${hash}.index.json`);
  writeFileSync(idxPath, "{}");
  const lines: string[] = [];
  for (let i = 0; i < VECS_PER_REPO; i++) {
    const vec = Array.from({ length: DIMS }, (_, j) => ((i + j) % 17) / 17);
    lines.push(JSON.stringify({ id: `${hash}:sym${i}`, vec }));
  }
  writeFileSync(join(dir, `${hash}.embeddings.ndjson`), lines.join("\n") + "\n");
  return idxPath;
}

function writeChunkEmbeddings(dir: string, hash: string, count: number): void {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const vec = Array.from({ length: DIMS }, (_, j) => ((i + j) % 17) / 17);
    lines.push(JSON.stringify({ id: `${hash}:chunk${i}`, vec }));
  }
  writeFileSync(join(dir, `${hash}.chunk-embeddings.ndjson`), lines.join("\n") + "\n");
}

describe("getEmbeddingCache — lite mode + LRU memory bound", () => {
  let dir: string;
  let previousEmbeddingMemMb: string | undefined;
  beforeEach(() => {
    previousEmbeddingMemMb = process.env.CODESIFT_MAX_EMBEDDING_MEM_MB;
    dir = mkdtempSync(join(tmpdir(), "emb-mem-"));
    const repos: Record<string, unknown> = {};
    for (const name of ["local/a", "local/b", "local/c"]) {
      repos[name] = { name, index_path: writeRepo(dir, name.replace("/", "_")) };
    }
    writeFileSync(join(dir, "registry.json"), JSON.stringify({ updated_at: 1, repos }));
    process.env.CODESIFT_DATA_DIR = dir;
    // Force embeddings ON by default. "unset" now auto-decides by total RAM, so
    // on ~16 GB CI runners the LRU tests below would get null. The explicit
    // lite-mode test sets "1" itself, overriding this.
    process.env.CODESIFT_DISABLE_LOCAL_EMBEDDINGS = "0";
    resetConfigCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CODESIFT_DATA_DIR;
    delete process.env.CODESIFT_DISABLE_LOCAL_EMBEDDINGS;
    if (previousEmbeddingMemMb === undefined) delete process.env.CODESIFT_MAX_EMBEDDING_MEM_MB;
    else process.env.CODESIFT_MAX_EMBEDDING_MEM_MB = previousEmbeddingMemMb;
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lite mode (CODESIFT_DISABLE_LOCAL_EMBEDDINGS=1) returns null without caching", async () => {
    process.env.CODESIFT_DISABLE_LOCAL_EMBEDDINGS = "1";
    const r = await getEmbeddingCache("local/a");
    expect(r).toBeNull();
    expect(_cachedEmbeddingReposForTesting()).not.toContain("local/a");
  });

  it("loads embeddings normally when not disabled", async () => {
    const r = await getEmbeddingCache("local/a");
    expect(r).not.toBeNull();
    expect(r!.size).toBe(VECS_PER_REPO);
    expect(_cachedEmbeddingReposForTesting()).toContain("local/a");
  });

  it("LRU-evicts least-recently-used repos over the budget (bounds resident RAM)", async () => {
    process.env.CODESIFT_MAX_EMBEDDING_MEM_MB = "1"; // ~1MB holds <2 of the ~614KB repos
    await getEmbeddingCache("local/a");
    await getEmbeddingCache("local/b");
    await getEmbeddingCache("local/c");
    const resident = _cachedEmbeddingReposForTesting();
    // Oldest evicted; most-recent retained; never all 3 resident at once.
    expect(resident).not.toContain("local/a");
    expect(resident).toContain("local/c");
    expect(resident.length).toBeLessThan(3);
  });

  it("re-accessing an evicted repo reloads it (cache miss → present again)", async () => {
    process.env.CODESIFT_MAX_EMBEDDING_MEM_MB = "1";
    await getEmbeddingCache("local/a");
    await getEmbeddingCache("local/b"); // evicts a
    expect(_cachedEmbeddingReposForTesting()).not.toContain("local/a");
    const reloaded = await getEmbeddingCache("local/a"); // reload
    expect(reloaded).not.toBeNull();
    expect(reloaded!.size).toBe(VECS_PER_REPO);
  });

  it("refuses a chunk embedding map larger than the resident-memory budget", async () => {
    process.env.CODESIFT_MAX_EMBEDDING_MEM_MB = "1";
    resetConfigCache();
    writeChunkEmbeddings(dir, "local_a", 400); // ~1.2 MiB of Float32Array payload alone

    const loaded = await getChunkEmbeddingCache("local/a");

    expect(loaded).toBeNull();
    expect(_cachedEmbeddingReposForTesting()).not.toContain("local/a:chunks");
  });

  it("reloads a chunk cache when the manifest points at a new generation", async () => {
    writeChunkEmbeddings(dir, "local_a", 1);
    expect((await getChunkEmbeddingCache("local/a"))?.has("local_a:chunk0")).toBe(true);

    const indexPath = join(dir, "local_a.index.json");
    const chunkPath = getChunkPath(indexPath);
    const embeddingPath = getChunkEmbeddingPath(indexPath);
    await saveChunkIndex(
      chunkPath,
      [],
      embeddingPath,
      new Map([["fresh", new Float32Array(DIMS).fill(0.25)]]),
    );
    const active = await resolveChunkIndexPaths(chunkPath, embeddingPath);

    const refreshed = await getChunkEmbeddingCache("local/a");
    expect(refreshed?.has("fresh")).toBe(true);
    expect(refreshed?.has("local_a:chunk0")).toBe(false);
    expect(active.embeddings).toContain(".generation.");
  });
});
