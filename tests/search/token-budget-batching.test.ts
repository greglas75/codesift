import { groupByTokenBudget } from "../../src/search/semantic.js";

const paddedCost = (group: { texts: string[] }): number => {
  const longest = Math.max(...group.texts.map((t) => Math.ceil(t.length / 4)));
  return longest * group.texts.length;
};

describe("groupByTokenBudget — bound padded tokens, not item count", () => {
  it("keeps every batch within the token budget", () => {
    const texts = [...Array(95).fill("x".repeat(88)), "x".repeat(45_712)];
    for (const g of groupByTokenBudget(texts)) {
      expect(paddedCost(g)).toBeLessThanOrEqual(8192);
    }
  });

  it("isolates one oversized input instead of padding the batch up to it", () => {
    // The measured pathology: median chunk 88 chars, one 45 KB outlier. Batching
    // by count padded all 96 rows to ~11 K tokens (~1.1M padded tokens).
    const texts = [...Array(95).fill("x".repeat(88)), "x".repeat(45_712)];
    const groups = groupByTokenBudget(texts);
    const worst = Math.max(...groups.map(paddedCost));
    expect(worst).toBeLessThan(11_428 * 96 / 100); // >100x cheaper
  });

  it("truncates any single input to the token cap", () => {
    const groups = groupByTokenBudget(["x".repeat(1_000_000)]);
    const only = groups[0]?.texts[0] as string;
    expect(only.length).toBe(2048 * 4);
  });

  it("still batches short texts densely", () => {
    const texts = Array(500).fill("x".repeat(40)); // ~10 tokens each
    const groups = groupByTokenBudget(texts);
    expect(groups.length).toBeLessThan(5); // not one-per-call
  });

  it("preserves order and loses nothing — callers map results positionally", () => {
    const texts = ["a".repeat(10), "b".repeat(40_000), "c".repeat(10), "d".repeat(200)];
    const flat = groupByTokenBudget(texts).flatMap((g) => g.texts);
    expect(flat.length).toBe(texts.length);
    expect(flat[0]?.[0]).toBe("a");
    expect(flat[1]?.[0]).toBe("b");
    expect(flat[2]?.[0]).toBe("c");
    expect(flat[3]?.[0]).toBe("d");
  });

  it("handles an empty input", () => {
    expect(groupByTokenBudget([])).toEqual([]);
  });
});
