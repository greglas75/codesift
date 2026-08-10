// batchEmbed had no retry, so one request that stalled instead of answering threw all the way out
// and the caller discarded the ENTIRE repo's pass — every batch that had already succeeded with it.
// Measured 2026-08-10 while re-embedding: ResearchShieldNew lost 1226s of work to a single stalled
// request, designer's chunk pass lost 1871s. With retry the same repo completed 379,808 vectors in
// 65 minutes, hitting two stalls on the way.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { batchEmbed } from "../../src/storage/embedding-store.js";

const DIM = 3;
const vecFor = (text: string): number[] => [text.length, 1, 0];

function texts(n: number): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < n; i++) m.set(`s${i}`, `body-${i}`);
  return m;
}

/** What the runtime actually threw: a DOMException whose name is TimeoutError. */
function stall(): DOMException {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

describe("batchEmbed stall retry", () => {
  it("splits a stalled batch and still returns every vector, in order", async () => {
    let stalled = false;
    const seen: number[] = [];
    const embed = async (batch: string[]): Promise<number[][]> => {
      if (!stalled && batch.length === 32) { stalled = true; throw stall(); }
      seen.push(batch.length);
      return batch.map(vecFor);
    };

    const result = await batchEmbed(texts(32), new Map(), embed, 32);

    expect(seen).toEqual([16, 16]);            // one split, both halves issued
    expect(result.size).toBe(32);
    // Order matters: a mis-stitched split would pair vectors with the wrong ids.
    expect(result.get("s0")).toEqual(new Float32Array(vecFor("body-0")));
    expect(result.get("s31")).toEqual(new Float32Array(vecFor("body-31")));
  });

  it("keeps splitting when a half stalls too", async () => {
    const stalledSizes = new Set([32, 16]);
    const seen: number[] = [];
    const embed = async (batch: string[]): Promise<number[][]> => {
      if (stalledSizes.has(batch.length)) { stalledSizes.delete(batch.length); throw stall(); }
      seen.push(batch.length);
      return batch.map(vecFor);
    };

    const result = await batchEmbed(texts(32), new Map(), embed, 32);

    expect(result.size).toBe(32);
    expect(seen.reduce((a, b) => a + b, 0)).toBe(32); // every text embedded exactly once
  });

  it("does NOT retry an error the model actually answered with", async () => {
    // An HTTP 4xx is a real answer about the input. Retrying it, or halving it, only fails slower —
    // and would hide a genuine "your batch is malformed" behind four more attempts.
    let calls = 0;
    const embed = async (): Promise<number[][]> => {
      calls++;
      throw new Error("Ollama API error: 400");
    };

    await expect(batchEmbed(texts(32), new Map(), embed, 32)).rejects.toThrow("400");
    expect(calls).toBe(1);
  });

  it("does not retry a caller-initiated abort", async () => {
    let calls = 0;
    const embed = async (): Promise<number[][]> => {
      calls++;
      throw new DOMException("The operation was aborted", "AbortError");
    };

    await expect(batchEmbed(texts(32), new Map(), embed, 32)).rejects.toThrow(/aborted/i);
    expect(calls).toBe(1);
  });

  it("rejects a short provider response before vectors can shift onto the wrong symbols", async () => {
    const embed = async (batch: string[]): Promise<number[][]> => batch.slice(1).map(vecFor);

    await expect(batchEmbed(texts(12), new Map(), embed, 12)).rejects.toThrow(
      "returned 11 vectors for 12 texts",
    );
  });

  it.each([
    { label: "empty", vectors: Array.from({ length: 12 }, () => []) },
    { label: "inconsistent", vectors: Array.from({ length: 12 }, (_, i) => i === 4 ? [1] : [1, 2]) },
    { label: "non-finite", vectors: Array.from({ length: 12 }, (_, i) => i === 4 ? [1, Number.NaN] : [1, 2]) },
    { label: "float32-overflowing", vectors: Array.from({ length: 12 }, (_, i) => i === 4 ? [1, 1e100] : [1, 2]) },
  ])("rejects $label provider vectors before they reach storage", async ({ vectors }) => {
    await expect(batchEmbed(texts(12), new Map(), async () => vectors, 12)).rejects.toThrow(
      "malformed vectors",
    );
  });

  it("gives up instead of splitting forever", async () => {
    let calls = 0;
    const embed = async (): Promise<number[][]> => { calls++; throw stall(); };

    await expect(batchEmbed(texts(64), new Map(), embed, 64)).rejects.toThrow(/timeout/i);
    // Bounded by the split depth and the floor below which splitting is pointless — the exact
    // count matters less than that it terminates and stays small.
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThan(40);
  });

  it("does not split a batch already too small for size to be the problem", async () => {
    let calls = 0;
    const embed = async (): Promise<number[][]> => { calls++; throw stall(); };

    await expect(batchEmbed(texts(4), new Map(), embed, 4)).rejects.toThrow(/timeout/i);
    expect(calls).toBe(1);
  });

  it("costs nothing when nothing stalls", async () => {
    const seen: number[] = [];
    const embed = async (batch: string[]): Promise<number[][]> => {
      seen.push(batch.length);
      return batch.map(vecFor);
    };

    const result = await batchEmbed(texts(50), new Map(), embed, 20);

    expect(seen).toEqual([20, 20, 10]);   // plain batching, no extra calls
    expect(result.size).toBe(50);
    expect(result.get("s7")).toHaveLength(DIM);
  });
});
