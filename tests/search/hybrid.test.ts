import { describe, it, expect } from "vitest";
import { hybridRank } from "../../src/search/hybrid.js";
import type { CodeSymbol, SearchResult } from "../../src/types.js";

function makeSymbol(id: string, name: string): CodeSymbol {
  return {
    id,
    repo: "local/test",
    name,
    kind: "function",
    file: "src/test.ts",
    start_line: 1,
    end_line: 10,
  };
}

function makeResult(id: string, name: string, score: number, matches?: string[]): SearchResult {
  const result: SearchResult = { symbol: makeSymbol(id, name), score };
  if (matches) result.matches = matches;
  return result;
}

describe("hybridRank", () => {
  const symA = makeResult("a", "getUserById", 10);
  const symB = makeResult("b", "createUser", 8);
  const symC = makeResult("c", "deleteUser", 6);
  const symD = makeResult("d", "updateUser", 4);

  it("combines two identical lists into same order", () => {
    const bm25 = [symA, symB, symC];
    const semantic = [symA, symB, symC];
    const result = hybridRank(bm25, semantic, 3);
    expect(result).toHaveLength(3);
    expect(result[0]!.symbol.id).toBe("a");
    expect(result[1]!.symbol.id).toBe("b");
    expect(result[2]!.symbol.id).toBe("c");
  });

  it("promotes symbols that appear in both lists", () => {
    // symA only in bm25, symB in both, symC only in semantic
    const bm25 = [symA, symB];
    const semantic = [symC, symB];
    const result = hybridRank(bm25, semantic, 3);
    // symB appears in both → highest RRF score
    expect(result[0]!.symbol.id).toBe("b");
  });

  it("respects topK limit", () => {
    const bm25 = [symA, symB, symC, symD];
    const semantic = [symD, symC, symB, symA];
    const result = hybridRank(bm25, semantic, 2);
    expect(result).toHaveLength(2);
  });

  it("handles empty bm25 list (pure semantic)", () => {
    const result = hybridRank([], [symA, symB, symC], 3);
    expect(result).toHaveLength(3);
    expect(result[0]!.symbol.id).toBe("a"); // rank 0 in semantic
  });

  it("handles empty semantic list (pure bm25)", () => {
    const result = hybridRank([symA, symB, symC], [], 3);
    expect(result).toHaveLength(3);
    expect(result[0]!.symbol.id).toBe("a");
  });

  it("handles both lists empty", () => {
    const result = hybridRank([], [], 10);
    expect(result).toHaveLength(0);
  });

  it("RRF scores are positive", () => {
    const bm25 = [symA, symB];
    const semantic = [symB, symA];
    const result = hybridRank(bm25, semantic, 2);
    for (const r of result) {
      expect(r.score).toBeGreaterThan(0);
    }
  });

  it("deduplicates symbols across lists", () => {
    const bm25 = [symA, symB, symA]; // symA duplicated (shouldn't happen but guard)
    const semantic = [symA, symC];
    const result = hybridRank(bm25, semantic, 10);
    const ids = result.map((r) => r.symbol.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
  });

  it("preserves matches from first encounter", () => {
    const withMatches = makeResult("a", "getUserById", 10, ["user", "id"]);
    const result = hybridRank([withMatches], [symA], 1);
    expect(result[0]!.matches).toEqual(["user", "id"]);
  });

  it("uses default k=60 giving expected RRF formula", () => {
    // single result at rank 0: score = 1/(60+1) ≈ 0.016
    const bm25 = [symA];
    const semantic: SearchResult[] = [];
    const result = hybridRank(bm25, semantic, 1);
    expect(result[0]!.score).toBeCloseTo(1 / 61, 5);
  });

  it("symbol in both lists at rank 0: score = 2/(k+1)", () => {
    const result = hybridRank([symA], [symA], 1);
    expect(result[0]!.score).toBeCloseTo(2 / 61, 5);
  });
});
