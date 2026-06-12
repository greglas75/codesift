import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureModelFile, MAX_DOWNLOAD_BYTES } from "../../src/utils/hf-hub-download.js";
import { MAX_ZERO_READS } from "../../src/utils/hf-download-stream.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function makeMultiChunkStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function makeErrorStream(firstChunk: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(firstChunk);
      controller.error(new Error("stream interrupted"));
    },
  });
}

function mockOkResponse(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {
      get(name: string): string | null {
        return headers[name.toLowerCase()] ?? null;
      },
    } as unknown as Headers,
    body: makeStream(bytes),
  } as unknown as Response;
}

function mockOkResponseWithStream(
  stream: ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {
      get(name: string): string | null {
        return headers[name.toLowerCase()] ?? null;
      },
    } as unknown as Headers,
    body: stream,
  } as unknown as Response;
}

function mockOkResponseNullBody(headers: Record<string, string> = {}): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {
      get(name: string): string | null {
        return headers[name.toLowerCase()] ?? null;
      },
    } as unknown as Headers,
    body: null,
  } as unknown as Response;
}

function mockErrorResponse(status: number, statusText: string): Response {
  return {
    ok: false,
    status,
    statusText,
    headers: {
      get(_name: string): string | null { return null; },
    } as unknown as Headers,
    body: null,
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("ensureModelFile", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "hf-hub-test-"));
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(cacheDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  describe("validation", () => {
    it("throws on empty modelId", async () => {
      await expect(
        ensureModelFile("", "model.safetensors", cacheDir),
      ).rejects.toThrow(/invalid|empty/i);
    });

    it("throws on empty filename", async () => {
      await expect(
        ensureModelFile("minishlab/potion-code-16M", "", cacheDir),
      ).rejects.toThrow(/invalid|empty/i);
    });

    it("throws on modelId containing '..'", async () => {
      await expect(
        ensureModelFile("../evil/path", "model.safetensors", cacheDir),
      ).rejects.toThrow(/invalid|traversal|\.\./i);
    });

    it("throws on filename containing '..'", async () => {
      await expect(
        ensureModelFile("minishlab/potion-code-16M", "../evil.txt", cacheDir),
      ).rejects.toThrow(/invalid|traversal|\.\./i);
    });

    it("throws on modelId starting with '/'", async () => {
      await expect(
        ensureModelFile("/absolute/model", "model.safetensors", cacheDir),
      ).rejects.toThrow(/invalid|traversal/i);
    });

    it("throws on filename starting with '/'", async () => {
      await expect(
        ensureModelFile("minishlab/potion-code-16M", "/absolute/file.bin", cacheDir),
      ).rejects.toThrow(/invalid|traversal/i);
    });
  });

  // -------------------------------------------------------------------------
  // Cache
  // -------------------------------------------------------------------------

  describe("cache", () => {
    it("returns cached path without calling fetch a second time", async () => {
      const mockBytes = new Uint8Array([0x01, 0x02, 0x03]);
      const fetchMock = (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockOkResponse(mockBytes),
      );

      // First call — downloads
      await ensureModelFile("minishlab/potion-code-16M", "model.safetensors", cacheDir);
      const callsAfterFirst = fetchMock.mock.calls.length;

      // Second call — must use cache
      const result = await ensureModelFile("minishlab/potion-code-16M", "model.safetensors", cacheDir);
      expect(fetchMock.mock.calls.length).toBe(callsAfterFirst); // no additional fetch
      expect(existsSync(result)).toBe(true);
    });

    it("cache-hit second call returns same bytes as original download", async () => {
      const mockBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe]);
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockOkResponse(mockBytes),
      );

      // First call — downloads
      const firstResult = await ensureModelFile("minishlab/potion-code-16M", "model.safetensors", cacheDir);

      // Second call — cache hit
      const secondResult = await ensureModelFile("minishlab/potion-code-16M", "model.safetensors", cacheDir);

      expect(secondResult).toBe(firstResult);
      const written = await readFile(secondResult);
      expect(new Uint8Array(written)).toEqual(mockBytes);
    });
  });

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------

  describe("download", () => {
    it("downloads file to correct path and returns absolute path with matching content", async () => {
      const mockBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockOkResponse(mockBytes),
      );

      const result = await ensureModelFile(
        "minishlab/potion-code-16M",
        "model.safetensors",
        cacheDir,
      );

      const expected = join(cacheDir, "minishlab%2Fpotion-code-16M", "model.safetensors");
      expect(result).toBe(expected);

      const written = await readFile(result);
      expect(new Uint8Array(written)).toEqual(mockBytes);
    });

    it("slugifies multi-segment modelId (org/sub/model) to org%2Fsub%2Fmodel", async () => {
      const mockBytes = new Uint8Array([0x01]);
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockOkResponse(mockBytes),
      );

      const result = await ensureModelFile("org/sub/model", "weights.bin", cacheDir);

      const expected = join(cacheDir, "org%2Fsub%2Fmodel", "weights.bin");
      expect(result).toBe(expected);
      expect(existsSync(result)).toBe(true);
    });

    it("FIX-A: different modelIds with slashes vs dashes produce different slug directories", async () => {
      // "a/b--c" and "a--b/c" must NOT collide
      // Under old replaceAll("/","--"): "a/b--c" → "a--b--c" and "a--b/c" → "a--b--c" — COLLISION
      // Under new slugify: "a/b--c" → "a%2Fb--c" and "a--b/c" → "a--b%2Fc" — distinct
      const bytes1 = new Uint8Array([0x01]);
      const bytes2 = new Uint8Array([0x02]);
      (globalThis.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockOkResponse(bytes1))
        .mockResolvedValueOnce(mockOkResponse(bytes2));

      const r1 = await ensureModelFile("a/b--c", "f.bin", cacheDir);
      const r2 = await ensureModelFile("a--b/c", "f.bin", cacheDir);

      // Paths must differ
      expect(r1).not.toBe(r2);
      // Slugs are what we expect
      expect(r1).toContain("a%2Fb--c");
      expect(r2).toContain("a--b%2Fc");
    });

    it("passes AbortSignal and exact URL to fetch", async () => {
      const mockBytes = new Uint8Array([0xaa, 0xbb]);
      const fetchMock = (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockOkResponse(mockBytes),
      );

      await ensureModelFile("minishlab/potion-code-16M", "model.safetensors", cacheDir);

      expect(fetchMock).toHaveBeenCalledWith(
        "https://huggingface.co/minishlab/potion-code-16M/resolve/main/model.safetensors",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Error paths
  // -------------------------------------------------------------------------

  describe("error paths", () => {
    it("throws descriptive error for non-OK responses including HTTP status, writes no file", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockErrorResponse(404, "Not Found"),
      );

      await expect(
        ensureModelFile("minishlab/potion-code-16M", "model.safetensors", cacheDir),
      ).rejects.toThrow(/404/);

      const finalPath = join(cacheDir, "minishlab%2Fpotion-code-16M", "model.safetensors");
      expect(existsSync(finalPath)).toBe(false);
    });

    it("throws descriptive error when content-length exceeds cap, writes no file", async () => {
      const oversizeBytes = MAX_DOWNLOAD_BYTES + 1;
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockOkResponse(new Uint8Array(4), {
          "content-length": String(oversizeBytes),
        }),
      );

      await expect(
        ensureModelFile("minishlab/potion-code-16M", "model.safetensors", cacheDir),
      ).rejects.toThrow(/500|cap|too large|exceed/i);

      const finalPath = join(cacheDir, "minishlab%2Fpotion-code-16M", "model.safetensors");
      expect(existsSync(finalPath)).toBe(false);
    });

    it("throws cap error and removes tmp file when streaming exceeds maxBytes (test seam)", async () => {
      // Emit 65 bytes total in two chunks, with maxBytes=64
      const chunk1 = new Uint8Array(40).fill(0xaa);
      const chunk2 = new Uint8Array(25).fill(0xbb); // total 65 > 64
      const stream = makeMultiChunkStream([chunk1, chunk2]);

      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockOkResponseWithStream(stream),
      );

      await expect(
        ensureModelFile("minishlab/potion-code-16M", "model.safetensors", cacheDir, {
          maxBytes: 64,
        }),
      ).rejects.toThrow(/cap|exceed|500/i);

      const modelDir = join(cacheDir, "minishlab%2Fpotion-code-16M");
      let files: string[] = [];
      try {
        const { readdir } = await import("node:fs/promises");
        files = await readdir(modelDir);
      } catch {
        // dir may not exist — also fine
      }
      const tmpFiles = files.filter((f) => f.includes(".tmp."));
      expect(tmpFiles).toHaveLength(0);

      const finalPath = join(modelDir, "model.safetensors");
      expect(existsSync(finalPath)).toBe(false);
    });

    it("throws descriptive error when response.body is null with ok:true", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockOkResponseNullBody(),
      );

      await expect(
        ensureModelFile("minishlab/potion-code-16M", "model.safetensors", cacheDir),
      ).rejects.toThrow(/body is null|response body/i);
    });

    it("removes tmp file and rethrows on fetch rejection (network error)", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("network failure"),
      );

      await expect(
        ensureModelFile("minishlab/potion-code-16M", "model.safetensors", cacheDir),
      ).rejects.toThrow(/network failure|download failed/i);

      const modelDir = join(cacheDir, "minishlab%2Fpotion-code-16M");
      let files: string[] = [];
      try {
        const { readdir } = await import("node:fs/promises");
        files = await readdir(modelDir);
      } catch {
        // dir may not exist — also fine
      }
      const tmpFiles = files.filter((f) => f.includes(".tmp."));
      expect(tmpFiles).toHaveLength(0);

      const finalPath = join(modelDir, "model.safetensors");
      expect(existsSync(finalPath)).toBe(false);
    });

    it("removes tmp file when stream errors mid-read", async () => {
      const firstChunk = new Uint8Array(100).fill(0xff);
      const stream = makeErrorStream(firstChunk);

      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockOkResponseWithStream(stream),
      );

      await expect(
        ensureModelFile("minishlab/potion-code-16M", "model.safetensors", cacheDir),
      ).rejects.toThrow(/stream interrupted|download failed/i);

      const modelDir = join(cacheDir, "minishlab%2Fpotion-code-16M");
      let files: string[] = [];
      try {
        const { readdir } = await import("node:fs/promises");
        files = await readdir(modelDir);
      } catch {
        // dir may not exist — also fine
      }
      const tmpFiles = files.filter((f) => f.includes(".tmp."));
      expect(tmpFiles).toHaveLength(0);

      const finalPath = join(modelDir, "model.safetensors");
      expect(existsSync(finalPath)).toBe(false);
    });

    // CRITICAL-2: truncated download rejected
    it("throws incomplete-download error when stream ends with fewer bytes than content-length", async () => {
      // content-length says 100 bytes but stream only emits 4
      const shortData = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockOkResponse(shortData, { "content-length": "100" }),
      );

      await expect(
        ensureModelFile("minishlab/potion-code-16M", "model.safetensors", cacheDir),
      ).rejects.toThrow(/incomplete download|got 4 of 100/i);

      const finalPath = join(cacheDir, "minishlab%2Fpotion-code-16M", "model.safetensors");
      expect(existsSync(finalPath)).toBe(false);

      // No tmp files left
      const modelDir = join(cacheDir, "minishlab%2Fpotion-code-16M");
      let files: string[] = [];
      try {
        const { readdir } = await import("node:fs/promises");
        files = await readdir(modelDir);
      } catch { /* dir may not exist */ }
      expect(files.filter((f) => f.includes(".tmp."))).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // FIX-1: filename containing "/" must be rejected (path-separator check)
  // -------------------------------------------------------------------------

  describe("filename path-separator rejection", () => {
    it("throws when filename contains a forward slash (subpath)", async () => {
      await expect(
        ensureModelFile("minishlab/potion-code-16M", "onnx/model.safetensors", cacheDir),
      ).rejects.toThrow(/path separator|separator/i);
    });
  });

  // -------------------------------------------------------------------------
  // FIX-2: per-chunk inactivity timeout
  // -------------------------------------------------------------------------

  describe("inactivity timeout", () => {
    it("rejects with stalled message and cleans up tmp when reader stalls on 2nd chunk", async () => {
      // First chunk resolves immediately; second read never resolves
      let readCalls = 0;
      const stallStream = new ReadableStream<Uint8Array>({
        pull(controller) {
          readCalls++;
          if (readCalls === 1) {
            controller.enqueue(new Uint8Array([0x01, 0x02]));
          }
          // second pull: never enqueues and never closes — simulates stall
        },
      });

      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockOkResponseWithStream(stallStream),
      );

      await expect(
        ensureModelFile("minishlab/potion-code-16M", "model.safetensors", cacheDir, {
          inactivityMs: 50,
        }),
      ).rejects.toThrow(/stalled|no data/i);

      // tmp file must be cleaned up
      const modelDir = join(cacheDir, "minishlab%2Fpotion-code-16M");
      let files: string[] = [];
      try {
        const { readdir } = await import("node:fs/promises");
        files = await readdir(modelDir);
      } catch { /* dir may not exist */ }
      expect(files.filter((f) => f.includes(".tmp."))).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // FIX-B: zero-progress guard — stream emitting only zero-length chunks
  // -------------------------------------------------------------------------

  describe("zero-progress guard", () => {
    it("rejects with no-progress error and cleans up tmp when stream emits >MAX_ZERO_READS empty chunks then data", async () => {
      // Stream emits MAX_ZERO_READS+1 empty chunks, then a real chunk — must reject before the real chunk.
      let pulled = 0;
      const zeroThenDataStream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++;
          if (pulled <= MAX_ZERO_READS + 1) {
            // zero-length chunk — resolves instantly, no bytes
            controller.enqueue(new Uint8Array(0));
          } else {
            // real data that should never be reached
            controller.enqueue(new Uint8Array([0x42]));
            controller.close();
          }
        },
      });

      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockOkResponseWithStream(zeroThenDataStream),
      );

      await expect(
        ensureModelFile("minishlab/potion-code-16M", "model.safetensors", cacheDir),
      ).rejects.toThrow(/no progress/i);

      // tmp file must be cleaned up
      const modelDir = join(cacheDir, "minishlab%2Fpotion-code-16M");
      let files: string[] = [];
      try {
        const { readdir } = await import("node:fs/promises");
        files = await readdir(modelDir);
      } catch { /* dir may not exist */ }
      expect(files.filter((f) => f.includes(".tmp."))).toHaveLength(0);

      // final file must not exist
      const finalPath = join(modelDir, "model.safetensors");
      expect(existsSync(finalPath)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // connect-only timeout — slow body must NOT abort after timeoutMs
  // -------------------------------------------------------------------------

  describe("connect-only timeout", () => {
    it("does NOT abort a slow but active body whose total duration exceeds timeoutMs", async () => {
      // Headers resolve immediately; body emits 3 chunks each delayed 60ms.
      // With timeoutMs=50 the OLD AbortSignal.timeout approach would abort
      // the entire operation before the second chunk arrives (~120ms elapsed).
      // With the new manual-controller fix only the connect phase is bounded,
      // so the download completes successfully.
      const chunkDelay = 60; // ms between chunks — intentionally > timeoutMs
      const chunk = new Uint8Array(4).fill(0x42);

      const slowBodyStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let i = 0; i < 3; i++) {
            await new Promise<void>((resolve) => setTimeout(resolve, chunkDelay));
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });

      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockOkResponseWithStream(slowBodyStream),
      );

      // timeoutMs=50 is shorter than first chunk delay (60ms) — would kill the
      // whole thing under old behavior, but must succeed under the new one.
      const result = await ensureModelFile(
        "minishlab/potion-code-16M",
        "model.safetensors",
        cacheDir,
        { timeoutMs: 50, inactivityMs: 5000 },
      );

      const written = await readFile(result);
      // 3 chunks × 4 bytes = 12 bytes
      expect(written.byteLength).toBe(12);
    }, 5000 /* generous wall-clock budget */);
  });

  // -------------------------------------------------------------------------
  // FIX-3: transparent decompression — skip completeness check when content-encoding present
  // -------------------------------------------------------------------------

  describe("transparent decompression", () => {
    it("resolves when content-encoding gzip causes decompressed size to exceed content-length", async () => {
      // content-length is compressed size (10), body emits 40 bytes (decompressed)
      const decompressedBytes = new Uint8Array(40).fill(0xab);
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockOkResponse(decompressedBytes, {
          "content-encoding": "gzip",
          "content-length": "10",
        }),
      );

      const result = await ensureModelFile(
        "minishlab/potion-code-16M",
        "model.safetensors",
        cacheDir,
      );

      // file exists and has full decompressed content
      const written = await readFile(result);
      expect(written.byteLength).toBe(40);
    });

    it("also skips content-length>cap pre-check when content-encoding is present", async () => {
      // content-length is compressed size exceeding cap — should NOT throw because encoding present
      const oversizeBytes = MAX_DOWNLOAD_BYTES + 1;
      const actualBytes = new Uint8Array(4).fill(0x01);
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockOkResponse(actualBytes, {
          "content-encoding": "gzip",
          "content-length": String(oversizeBytes),
        }),
      );

      // Should resolve successfully (streaming cap still enforced on actual bytes)
      const result = await ensureModelFile(
        "minishlab/potion-code-16M",
        "model.safetensors",
        cacheDir,
      );
      expect(existsSync(result)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // FIX-4: cache integrity — empty cached file triggers re-download
  // -------------------------------------------------------------------------

  describe("cache integrity", () => {
    it("re-downloads when cached file exists but is empty (0 bytes)", async () => {
      const { writeFile, mkdir: mkdirFs } = await import("node:fs/promises");
      const modelDir = join(cacheDir, "minishlab%2Fpotion-code-16M");
      await mkdirFs(modelDir, { recursive: true });
      const finalPath = join(modelDir, "model.safetensors");
      // Pre-create empty file simulating a corrupted/interrupted previous download
      await writeFile(finalPath, new Uint8Array(0));

      const freshBytes = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);
      const fetchMock = (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockOkResponse(freshBytes),
      );

      const result = await ensureModelFile(
        "minishlab/potion-code-16M",
        "model.safetensors",
        cacheDir,
      );

      // fetch MUST have been called (re-download triggered)
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // File now has the fresh content
      const written = await readFile(result);
      expect(new Uint8Array(written)).toEqual(freshBytes);
    });
  });

  // -------------------------------------------------------------------------
  // 0-byte download guard
  // -------------------------------------------------------------------------

  describe("empty download guard", () => {
    it("rejects with 'empty download' error when body stream closes immediately with 0 bytes, leaves no file, no tmp", async () => {
      // Stream closes with no chunks and no content-length header
      const emptyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });

      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockOkResponseWithStream(emptyStream),
      );

      await expect(
        ensureModelFile("minishlab/potion-code-16M", "model.safetensors", cacheDir),
      ).rejects.toThrow(/empty download/i);

      const modelDir = join(cacheDir, "minishlab%2Fpotion-code-16M");
      const finalPath = join(modelDir, "model.safetensors");
      expect(existsSync(finalPath)).toBe(false);

      // No tmp files left
      let files: string[] = [];
      try {
        const { readdir } = await import("node:fs/promises");
        files = await readdir(modelDir);
      } catch { /* dir may not exist */ }
      expect(files.filter((f) => f.includes(".tmp."))).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // CRITICAL-1: in-process concurrency dedup
  // -------------------------------------------------------------------------

  describe("concurrency dedup", () => {
    it("two concurrent calls fetch exactly once and both resolve to the same path with correct content", async () => {
      const mockBytes = new Uint8Array([0x11, 0x22, 0x33, 0x44]);

      // Use a deferred stream so both calls are in-flight simultaneously
      let streamStart!: () => void;
      const streamReady = new Promise<void>((resolve) => { streamStart = resolve; });
      const deferredStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          await streamReady;
          controller.enqueue(mockBytes);
          controller.close();
        },
      });

      const fetchMock = (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockOkResponseWithStream(deferredStream),
      );

      // Start both calls concurrently before resolving the stream
      const p1 = ensureModelFile("minishlab/potion-code-16M", "model.safetensors", cacheDir);
      const p2 = ensureModelFile("minishlab/potion-code-16M", "model.safetensors", cacheDir);

      // Now let the stream flow
      streamStart();

      const [r1, r2] = await Promise.all([p1, p2]);

      // fetch called exactly once
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // both resolve to same path
      expect(r1).toBe(r2);

      // file content is correct
      const written = await readFile(r1);
      expect(new Uint8Array(written)).toEqual(mockBytes);
    });
  });
});
