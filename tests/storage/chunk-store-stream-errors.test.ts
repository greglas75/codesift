import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createWriteStream = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  createWriteStream,
}));

import { saveChunkEmbeddings, saveChunks } from "../../src/storage/chunk-store.js";

class BackpressuredFailingStream extends EventEmitter {
  destroyed = false;

  write(): boolean {
    queueMicrotask(() => this.emit("error", new Error("disk write failed")));
    return false;
  }

  end(): void {
    throw new Error("end must not be reached after a write failure");
  }

  // The writer tears the stream down after a failed write so the descriptor is not left open.
  // A fake without `destroy` turns that cleanup into `stream.destroy is not a function`, which
  // then masks the disk error the test is actually asserting on.
  destroy(): void {
    this.destroyed = true;
  }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codesift-stream-error-"));
  createWriteStream.mockImplementation(() => new BackpressuredFailingStream());
});

afterEach(() => {
  createWriteStream.mockReset();
  rmSync(dir, { recursive: true, force: true });
});

async function expectWriteFailure(operation: Promise<void>): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("writer remained stuck waiting for drain")), 100);
  });
  try {
    await expect(Promise.race([operation, timeout])).rejects.toThrow("disk write failed");
  } finally {
    clearTimeout(timeoutId);
  }
}

describe("chunk-store stream errors during backpressure", () => {
  it("rejects saveChunks instead of waiting forever for drain", async () => {
    await expectWriteFailure(saveChunks(join(dir, "chunks.ndjson"), [{
      id: "repo:file.ts:1",
      file: "file.ts",
      startLine: 1,
      endLine: 1,
      text: "export const value = 1;",
      tokenCount: 6,
    }]));
  });

  it("rejects saveChunkEmbeddings instead of waiting forever for drain", async () => {
    await expectWriteFailure(saveChunkEmbeddings(
      join(dir, "chunk-embeddings.ndjson"),
      new Map([["chunk-1", new Float32Array([1, 2, 3])]]),
    ));
  });
});
