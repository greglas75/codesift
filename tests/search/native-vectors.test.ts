// Symbol vectors in Rust memory (ADR-006 stage 11): what the daemon-side cache must get right on top
// of the core's ranking, which the Rust tests and scripts/native-vectors-parity.ts cover.
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getNativeCore } from "../../src/native/index.js";
import {
  markNativeVectorFilesStale,
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
    repo: "r",
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

  it("answers null without a vector file, so the caller uses the TypeScript path", async () => {
    expect(await searchNativeVectors(query({ vectorPath: join(dir, "missing.ndjson") }))).toBeNull();
    expect(nativeVectorCacheStats().entries).toBe(0);
  });

  it("reports the stored width for a query of another one, without searching", async () => {
    const result = await searchNativeVectors(query({ query: new Float32Array([1, 0, 0]) }));
    expect(result).toEqual({ hits: [], dims: 2 });
  });
});
