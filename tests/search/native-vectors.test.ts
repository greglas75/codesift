// Symbol vectors in Rust memory (ADR-006 stage 11): what the daemon-side cache must get right on top
// of the core's ranking, which the Rust tests and scripts/native-vectors-parity.ts cover.
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getNativeCore } from "../../src/native/index.js";
import { computeRRFScores } from "../../src/retrieval/retrieval-utils.js";
import { cosineSimilarity } from "../../src/search/semantic.js";
import {
  chunkSetKey,
  dropNativeVectors,
  markNativeVectorFilesStale,
  rankNativeRrf,
  nativeVectorCacheStats,
  resetNativeVectorsForTesting,
  searchNativeVectors,
  type NativeVectorQuery,
} from "../../src/search/native-vectors.js";

const core = getNativeCore("vectors");

function vectorFile(path: string, lines: Array<[string, number[]]>, mtime: number): void {
  writeFileSync(path, lines.map(([id, vec]) => JSON.stringify({ id, vec })).join("\n") + "\n");
  utimesSync(path, mtime, mtime);
}

describe.skipIf(!core)("searchNativeVectors", () => {
  let dir: string;
  let path: string;
  let symbols: Array<{ id: string; file: string }>;
  let listCalls: number;

  const query = (overrides: Partial<NativeVectorQuery> = {}): NativeVectorQuery => ({
    set: "r",
    vectorPath: path,
    rebase: null,
    listFiles: async () => {
      listCalls++;
      return { ids: symbols.map((s) => s.id), files: symbols.map((s) => s.file) };
    },
    query: new Float32Array([1, 0]),
    topK: 10,
    contains: undefined,
    excludeTests: false,
    ...overrides,
  });
  const ids = async (q: NativeVectorQuery) => (await searchNativeVectors(q))?.hits.map((h) => h.id);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "native-vectors-"));
    path = join(dir, "r.embeddings.ndjson");
    symbols = [{ id: "a", file: "src/a.ts" }, { id: "b", file: "src/b.ts" }];
    listCalls = 0;
    vectorFile(path, [["a", [1, 0]], ["b", [0, 1]]], 1_000);
  });

  afterEach(() => {
    resetNativeVectorsForTesting();
    rmSync(dir, { recursive: true, force: true });
  });

  // Bug it catches: the vectors an embedding run rewrote never reach a long-lived daemon.
  it("reloads when the vector file is rewritten", async () => {
    expect(await ids(query())).toEqual(["a", "b"]);
    vectorFile(path, [["a", [0, 1]], ["b", [1, 0]]], 2_000);
    expect(await ids(query())).toEqual(["b", "a"]);
  });

  // Bug it catches: a symbol deleted by an edit keeps being returned from the attached files.
  it("re-attaches files after the repo's symbols change, and only then", async () => {
    await ids(query());
    await ids(query());
    expect(listCalls).toBe(1);
    symbols = [{ id: "b", file: "src/b.ts" }];
    markNativeVectorFilesStale("r");
    expect(await ids(query())).toEqual(["b"]);
    expect(listCalls).toBe(2);
  });

  // Bug it catches: a CLI hook's index_file (another process) never reaches markNativeVectorFilesStale,
  // so the daemon kept ranking symbols that edit deleted.
  it("re-attaches files when another process moved the index's data version", async () => {
    let version = 1;
    const q = query({ filesVersion: async () => version });
    await ids(q);
    await ids(q);
    expect(listCalls).toBe(1);
    symbols = [{ id: "a", file: "src/a.ts" }];
    version = 2;
    expect(await ids(q)).toEqual(["a"]);
    expect(listCalls).toBe(2);
  });

  // Bug it catches: a transient SQLITE_BUSY while listing files released a set that loaded fine, so
  // the next query paid the whole load again.
  it("keeps a loaded set when only listing its files fails, and attaches on the next call", async () => {
    let fail = true;
    const q = query({
      listFiles: async () => {
        listCalls++;
        if (fail) throw new Error("SQLITE_BUSY");
        return { ids: symbols.map((s) => s.id), files: symbols.map((s) => s.file) };
      },
    });
    expect(await searchNativeVectors(q)).toBeNull();
    expect(nativeVectorCacheStats().entries).toBe(1);
    fail = false;
    expect(await ids(q)).toEqual(["a", "b"]);
    expect(listCalls).toBe(2);
  });

  // Bug it catches: a repo removed from the registry kept gigabytes of vectors in Rust memory.
  it("frees a repo's sets when the repo is dropped", async () => {
    await ids(query());
    expect(nativeVectorCacheStats().entries).toBe(1);
    dropNativeVectors("r");
    expect(nativeVectorCacheStats().entries).toBe(0);
  });

  it("answers null without a vector file, so the caller uses the TypeScript path", async () => {
    expect(await searchNativeVectors(query({ vectorPath: join(dir, "missing.ndjson") }))).toBeNull();
    expect(nativeVectorCacheStats().entries).toBe(0);
  });

  it("reports the stored width for a query of another one, without searching", async () => {
    const result = await searchNativeVectors(query({ query: new Float32Array([1, 0, 0]) }));
    expect(result).toEqual({ hits: [], dims: 2 });
  });
});

describe.skipIf(!core)("rankNativeRrf", () => {
  let dir: string;
  afterEach(() => {
    resetNativeVectorsForTesting();
    rmSync(dir, { recursive: true, force: true });
  });

  // Bug it catches: a fusion that broke ties, summed, or placed text-only ids differently from the
  // TypeScript one would reorder a hybrid answer. Few distinct values make ties the common case.
  it("fuses sub-queries and text boosts exactly as computeRRFScores and the hybrid handler do", async () => {
    dir = mkdtempSync(join(tmpdir(), "native-rrf-"));
    const path = join(dir, "r.chunk-embeddings.ndjson.generation.g");
    const vectors = new Map<string, Float32Array>();
    const files = new Map<string, string>();
    for (let i = 0; i < 300; i++) {
      vectors.set(`r:f${i % 17}.ts:${i}`, new Float32Array([i % 5, (i * 3) % 4, 1, (i % 2) * 0.5]));
      files.set(`r:f${i % 17}.ts:${i}`, i % 11 === 0 ? `src/f${i % 17}.test.ts` : `src/f${i % 17}.ts`);
    }
    vectorFile(path, [...vectors].map(([id, v]) => [id, Array.from(v)]), 1_000);
    const vecs = [[1, 0, 0.2, 0], [0, 1, 0.5, 1], [2, 2, 1, 0]];
    const extra: Array<[string, number]> = [["r:f3.ts:3", 1 / 61], ["text-only", 1 / 62], ["r:f3.ts:3", 1 / 63], ["r:f0.ts:0", 1 / 64]];
    for (const [contains, excludeTests, topK] of [[undefined, false, 300], [undefined, true, 9], ["f1", true, 25]] as const) {
      const filtered = new Map([...vectors].filter(([id]) => {
        const file = files.get(id)!;
        return (!contains || file.includes(contains)) && !(excludeTests && file.includes(".test."));
      }));
      const scores = computeRRFScores(vecs, filtered, cosineSimilarity);
      for (const [id, s] of extra) scores.set(id, (scores.get(id) ?? 0) + s);
      const want = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK).map(([id]) => id);

      const got = await rankNativeRrf({
        set: chunkSetKey("r"),
        vectorPath: path,
        rebase: null,
        listFiles: async () => ({ ids: [...files.keys()], files: [...files.values()] }),
        queries: vecs.map((v) => new Float32Array(v)),
        topK,
        contains,
        excludeTests,
        extra,
      });
      expect(got?.ids).toEqual(want);
    }
  });
});
