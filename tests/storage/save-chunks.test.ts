// saveChunks had no test at all while it was the one remaining writer in this file that built the
// whole ndjson as a single `lines.join("\n")` string — the shape that throws
// `RangeError: Invalid string length` past V8's ~512 MiB ceiling, which its sibling
// saveChunkEmbeddings was already fixed for. It now streams, so these cover the mechanism that
// replaced the join: round-trip fidelity, no temp-file residue, replace-not-append semantics, and
// text that would corrupt a line-oriented format if it were written naively.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  saveChunks,
  saveChunkIndex,
  loadChunks,
  loadChunkEmbeddings,
} from "../../src/storage/chunk-store.js";
import type { CodeChunk } from "../../src/types.js";

let dir: string;
let path: string;

const chunk = (n: number, text = `body ${n}`): CodeChunk => ({
  id: `repo:src/f${n}.ts:${n}`,
  file: `src/f${n}.ts`,
  startLine: n,
  endLine: n + 5,
  text,
  tokenCount: 7,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codesift-savechunks-"));
  path = join(dir, "abc123.chunks.ndjson");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("saveChunks", () => {
  it("round-trips every field through loadChunks", async () => {
    const input = [chunk(1), chunk(2), chunk(3)];
    await saveChunks(path, input);

    const loaded = await loadChunks(path);
    expect(loaded?.size).toBe(3);
    expect(loaded?.get("repo:src/f2.ts:2")).toEqual(chunk(2));
  });

  it("leaves no temp file behind on success", async () => {
    await saveChunks(path, [chunk(1)]);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp."))).toEqual([]);
    expect(readdirSync(dir)).toEqual(["abc123.chunks.ndjson"]);
  });

  it("replaces the previous contents rather than appending to them", async () => {
    await saveChunks(path, [chunk(1), chunk(2)]);
    await saveChunks(path, [chunk(9)]);

    const loaded = await loadChunks(path);
    expect([...(loaded?.keys() ?? [])]).toEqual(["repo:src/f9.ts:9"]);
  });

  it("keeps the previous chunks when publishing embeddings fails", async () => {
    await saveChunks(path, [chunk(1)]);

    await expect(
      saveChunkIndex(
        path,
        [chunk(9)],
        join(dir, "missing", "abc123.chunk-embeddings.ndjson"),
        new Map([["repo:src/f9.ts:9", new Float32Array([0.1, 0.2])]]),
      ),
    ).rejects.toThrow();

    const loaded = await loadChunks(path);
    expect([...(loaded?.keys() ?? [])]).toEqual(["repo:src/f1.ts:1"]);
    expect(readdirSync(dir).some((file) => file.includes(".backup."))).toBe(false);
  });

  it("publishes chunks and embeddings through one atomic manifest", async () => {
    const embeddingPath = join(dir, "abc123.chunk-embeddings.ndjson");
    const embeddings = new Map([["repo:src/f9.ts:9", new Float32Array([0.1, 0.2])]]);

    await saveChunkIndex(path, [chunk(9)], embeddingPath, embeddings);

    expect([...(await loadChunks(path))!.keys()]).toEqual(["repo:src/f9.ts:9"]);
    expect(Array.from((await loadChunkEmbeddings(embeddingPath))!.get("repo:src/f9.ts:9")!))
      .toEqual([expect.closeTo(0.1), expect.closeTo(0.2)]);
    expect(readdirSync(dir).filter((file) => file.endsWith(".chunk-index.json"))).toHaveLength(1);
  });

  it("rejects manifest paths that escape the index directory", async () => {
    writeFileSync(
      join(dir, "abc123.chunk-index.json"),
      JSON.stringify({ version: 1, chunks: "..", embeddings: "safe.ndjson" }),
    );

    await expect(loadChunks(path)).rejects.toThrow("Invalid chunk index manifest");
  });

  it("survives chunk text containing newlines and quotes", async () => {
    // The writer emits one JSON line per chunk, so embedded newlines have to stay
    // escaped inside the string rather than splitting the record in two.
    const gnarly = 'first\nsecond "quoted"\n\ttabbed \\ backslash';
    await saveChunks(path, [chunk(1, gnarly)]);

    expect(readFileSync(path, "utf-8").split("\n").filter(Boolean)).toHaveLength(1);
    const loaded = await loadChunks(path);
    expect(loaded?.get("repo:src/f1.ts:1")?.text).toBe(gnarly);
  });

  it("writes an empty file for an empty chunk list", async () => {
    await saveChunks(path, []);
    expect(readFileSync(path, "utf-8")).toBe("");
  });

  it("sweeps a stale temp file from an earlier killed write, but not a fresh one", async () => {
    // The sweeper measures age by MTIME, not by the timestamp in the name — the
    // name is only how the file is claimed. Backdating the mtime is therefore the
    // only way to age it, and the fresh file below is what stops the sweep from
    // eating a concurrent writer's in-flight temp.
    const stale = `${path}.tmp.1`;
    const fresh = `${path}.tmp.2`;
    writeFileSync(stale, "half a write", "utf-8");
    writeFileSync(fresh, "another writer, right now", "utf-8");
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(stale, threeHoursAgo, threeHoursAgo);

    await saveChunks(path, [chunk(1)]);

    expect(readdirSync(dir).filter((f) => f.includes(".tmp."))).toEqual(["abc123.chunks.ndjson.tmp.2"]);
  });

  it("streams a chunk count large enough to exercise backpressure", async () => {
    // ~20 MB across 20k records: enough that the write stream returns false and the
    // drain path runs, without the minutes a real 512 MiB ceiling test would cost.
    const many = Array.from({ length: 20_000 }, (_, i) => chunk(i, "x".repeat(1000)));
    await saveChunks(path, many);

    const loaded = await loadChunks(path);
    expect(loaded?.size).toBe(20_000);
    expect(loaded?.get("repo:src/f19999.ts:19999")?.text).toHaveLength(1000);
  });
});
