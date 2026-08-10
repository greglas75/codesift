import { Writable } from "node:stream";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeChunk } from "../../src/types.js";

const streamState = vi.hoisted(() => ({ failWrites: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => {
      if (!streamState.failWrites) return actual.createWriteStream(...args);
      return new Writable({
        highWaterMark: 1,
        write(_chunk, _encoding, callback) {
          queueMicrotask(() => callback(new Error("simulated disk full")));
        },
      });
    },
  };
});

const chunk: CodeChunk = {
  id: "repo:src/a.ts:1",
  file: "src/a.ts",
  startLine: 1,
  endLine: 2,
  text: "body",
  tokenCount: 1,
};

describe("streamed chunk writers", () => {
  let dir: string;

  async function expectDiskFailureWithoutHanging(write: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("writer timed out")), 250);
    });
    try {
      await expect(Promise.race([write, timeout])).rejects.toThrow("simulated disk full");
    } finally {
      clearTimeout(timer);
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codesift-savechunks-error-"));
    streamState.failWrites = true;
  });

  afterEach(() => {
    streamState.failWrites = false;
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a write error while waiting for backpressure instead of hanging", async () => {
    const { saveChunks } = await import("../../src/storage/chunk-store.js");
    await expectDiskFailureWithoutHanging(saveChunks(join(dir, "chunks.ndjson"), [chunk]));
  });

  it("rejects an embedding write error while waiting for backpressure", async () => {
    const { saveChunkEmbeddings } = await import("../../src/storage/chunk-store.js");
    const embeddings = new Map([["chunk-1", new Float32Array([0.1, 0.2])]]);
    await expectDiskFailureWithoutHanging(
      saveChunkEmbeddings(join(dir, "chunk-embeddings.ndjson"), embeddings),
    );
  });
});
