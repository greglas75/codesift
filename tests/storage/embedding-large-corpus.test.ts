// Regression: a repo large enough to overflow the argument stack could never be embedded.
//
// `batchEmbed` copied its work queue with `toEmbed.push(...stillToEmbed)`, which spreads one
// argument per symbol onto the call stack. V8 overflows that between 100k and 125k arguments, so
// every repo above ~100k symbols threw "Maximum call stack size exceeded" before issuing a single
// model call. Twelve repos on this machine were over the line, including the four largest.
//
// It stayed invisible because the caller logged the throw and returned normally, and `embed-child`
// then printed its success marker regardless — so the failure was indistinguishable from a
// completed run. Both halves are covered here.
import { describe, it, expect } from "vitest";
import { batchEmbed } from "../../src/storage/embedding-store.js";

// Comfortably past the measured overflow point (~100k–125k) and past any plausible growth in the
// V8 stack, while still cheap: the vectors are 2-dimensional and never leave memory.
const CORPUS = 200_000;
const DIM = 2;

describe("batchEmbed on a corpus past the argument-spread limit", () => {
  it("embeds a 200k-symbol corpus instead of overflowing the stack", async () => {
    const texts = new Map<string, string>();
    for (let i = 0; i < CORPUS; i++) texts.set(`sym${i}`, `body ${i}`);

    let embedded = 0;
    const embed = async (batch: string[]): Promise<number[][]> => {
      embedded += batch.length;
      return batch.map(() => new Array<number>(DIM).fill(0.5));
    };

    // No cacheKey and no sharedModel: the shared cross-repo cache is a separate concern, and
    // leaving it out keeps this test about the queue copy alone.
    const result = await batchEmbed(texts, new Map(), embed, 50_000);

    expect(embedded).toBe(CORPUS);
    expect(result.size).toBe(CORPUS);
    // Spot-check both ends — a partially-consumed queue would still satisfy a size check alone
    // if the loop bounds were wrong in the other direction.
    expect(result.get("sym0")).toBeInstanceOf(Float32Array);
    expect(result.get(`sym${CORPUS - 1}`)).toBeInstanceOf(Float32Array);
  });

  it("still reuses existing vectors and drops symbols that left the corpus", async () => {
    // The large-corpus path must not have quietly changed what the small-corpus path does.
    const texts = new Map([["keep", "a"], ["fresh", "b"]]);
    const existing = new Map([
      ["keep", new Float32Array([1, 1])],
      ["gone", new Float32Array([9, 9])],
    ]);

    const seen: string[] = [];
    const embed = async (batch: string[]): Promise<number[][]> => {
      seen.push(...batch);
      return batch.map(() => [0.5, 0.5]);
    };

    const result = await batchEmbed(texts, existing, embed, 16);

    expect(seen).toEqual(["b"]);                       // "keep" was not re-embedded
    expect(result.get("keep")).toEqual(new Float32Array([1, 1]));
    expect(result.has("gone")).toBe(false);            // stale symbol pruned
    expect(result.size).toBe(2);
  });
});
