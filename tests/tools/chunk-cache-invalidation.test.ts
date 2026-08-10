// Chunk vectors share `embeddingCaches` under the derived key `<repo>:chunks`, but all five
// invalidation sites deleted only `<repo>`. In a long-lived process — the launchd daemon, or a
// stdio session that outlives a re-index — chunk-level semantic search then answered from
// PRE-REINDEX vectors for the rest of that process's life: `loadChunks` re-read the rewritten text
// from disk every query while the vectors stayed frozen, and a chunk id is
// `<repo>:<file>:<startLine>`, so an edited chunk kept its id and was scored by its stale vector.
//
// Symbol search stayed correct throughout, which is what made it invisible: the symptom is one of
// two retrieval paths quietly disagreeing with the file on disk.
import { describe, it, expect, beforeEach } from "vitest";
import {
  embeddingCaches,
  chunkCacheKey,
  invalidateEmbeddingCaches,
} from "../../src/tools/index-tools/state.js";

const REPO = "local/demo";
const vec = (n: number) => new Map([["id", new Float32Array([n])]]);

beforeEach(() => embeddingCaches.clear());

describe("invalidateEmbeddingCaches", () => {
  it("drops the chunk map as well as the symbol map", () => {
    embeddingCaches.set(REPO, vec(1));
    embeddingCaches.set(chunkCacheKey(REPO), vec(2));

    invalidateEmbeddingCaches(REPO);

    expect(embeddingCaches.has(REPO)).toBe(false);
    expect(embeddingCaches.has(chunkCacheKey(REPO))).toBe(false);
  });

  it("is exactly what a bare delete was not — the regression, stated", () => {
    embeddingCaches.set(REPO, vec(1));
    embeddingCaches.set(chunkCacheKey(REPO), vec(2));

    embeddingCaches.delete(REPO);                       // what every call site used to do

    expect(embeddingCaches.has(chunkCacheKey(REPO))).toBe(true);   // …and this is why it broke
  });

  it("leaves other repos alone, including ones whose name is a prefix", () => {
    embeddingCaches.set(REPO, vec(1));
    embeddingCaches.set(chunkCacheKey(REPO), vec(2));
    embeddingCaches.set(`${REPO}-other`, vec(3));
    embeddingCaches.set(chunkCacheKey(`${REPO}-other`), vec(4));

    invalidateEmbeddingCaches(REPO);

    expect(embeddingCaches.has(`${REPO}-other`)).toBe(true);
    expect(embeddingCaches.has(chunkCacheKey(`${REPO}-other`))).toBe(true);
    expect(embeddingCaches.size).toBe(2);
  });

  it("is a no-op on a repo that was never cached", () => {
    expect(() => invalidateEmbeddingCaches("local/never-seen")).not.toThrow();
    expect(embeddingCaches.size).toBe(0);
  });
});

describe("every invalidation site goes through the helper", () => {
  // The bug was five call sites each independently forgetting the same thing, so the guard is a
  // source-level invariant rather than five behavioural tests that the sixth call site would skip.
  it("no source file deletes an embedding cache entry by bare repo name", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { globSync } = await import("node:fs");

    const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
    const files = globSync("**/*.ts", { cwd: srcDir }).map((f) => join(srcDir, f));

    const offenders: string[] = [];
    for (const file of files) {
      // state.ts owns the helper and is the one place allowed to touch the map directly.
      if (file.endsWith("state.ts")) continue;
      const lines = readFileSync(file, "utf-8").split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // Comments discuss this call deliberately — the helper's own docstring quotes the bug.
        // Matching prose would make the invariant fire on its own explanation.
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        const m = /embeddingCaches\.delete\(([^)]*)\)/.exec(code);
        if (!m) continue;
        const arg = m[1]!.trim();

        if (/chunkCacheKey/.test(arg)) continue;               // explicitly the chunk half
        // LRU touch: delete-then-set of the SAME key is a reordering, not an invalidation.
        const next = (lines[i + 1] ?? "").trim();
        if (next.startsWith(`embeddingCaches.set(${arg},`)) continue;
        // Eviction walks keys it already holds, which may themselves be chunk keys.
        if (arg === "k") continue;

        offenders.push(`${file.replace(srcDir, "src")}:${i + 1} -> delete(${arg})`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
