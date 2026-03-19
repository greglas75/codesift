import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  decomposeQuery,
} from "../../src/retrieval/codebase-retrieval.js";

// ---------------------------------------------------------------------------
// estimateTokens — locks ~4 chars/token estimation
// ---------------------------------------------------------------------------
describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns ceil(length / 3) for short strings", () => {
    expect(estimateTokens("a")).toBe(1); // 1/3 → ceil = 1
    expect(estimateTokens("ab")).toBe(1); // 2/3 → ceil = 1
    expect(estimateTokens("abc")).toBe(1); // 3/3 → ceil = 1
    expect(estimateTokens("abcd")).toBe(2); // 4/3 → ceil = 2
    expect(estimateTokens("abcde")).toBe(2); // 5/3 → ceil = 2
  });

  it("scales linearly for longer text", () => {
    const text = "x".repeat(100);
    expect(estimateTokens(text)).toBe(34); // ceil(100/3) = 34
  });

  it("rounds up for non-divisible lengths", () => {
    const text = "x".repeat(101);
    expect(estimateTokens(text)).toBe(34); // ceil(101/3) = 34
  });
});

// ---------------------------------------------------------------------------
// decomposeQuery — locks query splitting for RRF
// ---------------------------------------------------------------------------
describe("decomposeQuery", () => {
  it("returns short queries (≤8 words) as single-element array", () => {
    expect(decomposeQuery("how does auth work")).toEqual([
      "how does auth work",
    ]);
  });

  it("returns single word as-is", () => {
    expect(decomposeQuery("authentication")).toEqual(["authentication"]);
  });

  it("returns empty string as-is", () => {
    expect(decomposeQuery("")).toEqual([""]);
  });

  it("returns exactly 8 words as-is", () => {
    const query = "one two three four five six seven eight";
    expect(decomposeQuery(query)).toEqual([query]);
  });

  it("splits at connector word in middle zone", () => {
    // 9 words with a connector in the 35-65% range
    const query =
      "find all exported functions and classes that handle authentication";
    const result = decomposeQuery(query);
    expect(result).toHaveLength(2);
    // "and" at position 4/9 ≈ 44% — inside the 35-65% zone
    expect(result[0]).toBe("find all exported functions");
    expect(result[1]).toBe("classes that handle authentication");
  });

  it("splits at midpoint when no connector found", () => {
    // 9 words with no connector in the split zone
    const query = "alpha beta gamma delta epsilon zeta eta theta iota";
    const result = decomposeQuery(query);
    expect(result).toHaveLength(2);
    // Should split near the middle
    expect(result[0]!.split(" ").length).toBeGreaterThanOrEqual(3);
    expect(result[1]!.split(" ").length).toBeGreaterThanOrEqual(3);
  });

  it("recognizes standard connector words", () => {
    const connectors = [
      "and",
      "or",
      "from",
      "to",
      "with",
      "using",
      "for",
      "via",
      "then",
    ];
    for (const conn of connectors) {
      // Build a 10-word query with connector at position 5 (50% — in the 35-65% zone)
      const query = `word1 word2 word3 word4 word5 ${conn} word7 word8 word9 word10`;
      const result = decomposeQuery(query);
      expect(result).toHaveLength(2);
      // Neither part should contain the connector
      expect(result[0]).not.toContain(` ${conn} `);
      expect(result[0]!.endsWith(` ${conn}`)).toBe(false);
    }
  });

  it("prefers connectors in the 35-65% zone", () => {
    // "and" at position 2 out of 10 = 20% (outside zone)
    // "with" at position 5 out of 10 = 50% (inside zone)
    const query =
      "find and search functions with special parameters across modules today";
    const result = decomposeQuery(query);
    expect(result).toHaveLength(2);
    // Should split at "with" (position 5/10 = 50%) not "and" (position 2/10 = 20%)
    expect(result[0]).toContain("and");
    expect(result[0]).toBe("find and search functions");
  });
});
