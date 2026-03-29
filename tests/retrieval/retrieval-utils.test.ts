import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  filterEmbeddingsByFile,
  computeRRFScores,
  formatChunksAsText,
  decomposeQuery,
} from "../../src/retrieval/retrieval-utils.js";
import type { CodeChunk } from "../../src/types.js";

// ---------------------------------------------------------------------------
// filterEmbeddingsByFile
// ---------------------------------------------------------------------------
describe("filterEmbeddingsByFile", () => {
  const makeEmbeddings = () =>
    new Map<string, Float32Array>([
      ["chunk-1", new Float32Array([1, 0])],
      ["chunk-2", new Float32Array([0, 1])],
      ["chunk-3", new Float32Array([1, 1])],
    ]);

  const fileLookup = new Map<string, string | undefined>([
    ["chunk-1", "src/auth/login.ts"],
    ["chunk-2", "src/utils/helpers.ts"],
    ["chunk-3", "tests/auth/login.test.ts"],
  ]);

  it("returns all embeddings when no filters active", () => {
    const result = filterEmbeddingsByFile(makeEmbeddings(), fileLookup, undefined, false);
    expect(result.size).toBe(3);
  });

  it("filters by file path substring", () => {
    const result = filterEmbeddingsByFile(makeEmbeddings(), fileLookup, "auth", false);
    expect(result.size).toBe(2);
    expect(result.has("chunk-1")).toBe(true);
    expect(result.has("chunk-3")).toBe(true);
    expect(result.has("chunk-2")).toBe(false);
  });

  it("excludes test files", () => {
    const result = filterEmbeddingsByFile(makeEmbeddings(), fileLookup, undefined, true);
    expect(result.size).toBe(2);
    expect(result.has("chunk-1")).toBe(true);
    expect(result.has("chunk-2")).toBe(true);
    expect(result.has("chunk-3")).toBe(false);
  });

  it("combines file filter and test exclusion", () => {
    const result = filterEmbeddingsByFile(makeEmbeddings(), fileLookup, "auth", true);
    expect(result.size).toBe(1);
    expect(result.has("chunk-1")).toBe(true);
  });

  it("excludes entries with no file in lookup", () => {
    const sparseLookup = new Map<string, string | undefined>([
      ["chunk-1", "src/foo.ts"],
      ["chunk-2", undefined],
    ]);
    const embeddings = new Map<string, Float32Array>([
      ["chunk-1", new Float32Array([1])],
      ["chunk-2", new Float32Array([2])],
      ["chunk-3", new Float32Array([3])],
    ]);
    const result = filterEmbeddingsByFile(embeddings, sparseLookup, undefined, true);
    expect(result.size).toBe(1);
    expect(result.has("chunk-1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeRRFScores
// ---------------------------------------------------------------------------
describe("computeRRFScores", () => {
  const mockCosSim = (a: Float32Array, b: Float32Array): number => {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
    return dot;
  };

  it("returns empty map for empty inputs", () => {
    const result = computeRRFScores([], new Map(), mockCosSim);
    expect(result.size).toBe(0);
  });

  it("scores entries by RRF formula (1/(k+rank+1))", () => {
    const embeddings = new Map<string, Float32Array>([
      ["a", new Float32Array([1, 0])],
      ["b", new Float32Array([0, 1])],
    ]);
    const vecs = [[1, 0]]; // query vector aligned with "a"
    const result = computeRRFScores(vecs, embeddings, mockCosSim);

    // "a" has higher cosine similarity → rank 0 → score = 1/(60+0+1) = 1/61
    // "b" has lower similarity → rank 1 → score = 1/(60+1+1) = 1/62
    expect(result.get("a")).toBeCloseTo(1 / 61, 6);
    expect(result.get("b")).toBeCloseTo(1 / 62, 6);
  });

  it("accumulates scores across multiple query vectors", () => {
    const embeddings = new Map<string, Float32Array>([
      ["a", new Float32Array([1, 0])],
      ["b", new Float32Array([0, 1])],
    ]);
    const vecs = [[1, 0], [0, 1]]; // first favors "a", second favors "b"
    const result = computeRRFScores(vecs, embeddings, mockCosSim);

    // "a": rank 0 in vec1 (1/61) + rank 1 in vec2 (1/62)
    // "b": rank 1 in vec1 (1/62) + rank 0 in vec2 (1/61)
    // Both should have equal total scores
    expect(result.get("a")).toBeCloseTo(result.get("b")!, 6);
  });

  it("skips null/undefined vectors", () => {
    const embeddings = new Map<string, Float32Array>([
      ["a", new Float32Array([1])],
    ]);
    const vecs: (number[] | null)[] = [null, [1]];
    const result = computeRRFScores(vecs, embeddings, mockCosSim);
    expect(result.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// formatChunksAsText
// ---------------------------------------------------------------------------
describe("formatChunksAsText", () => {
  const makeChunks = (): Map<string, CodeChunk> =>
    new Map([
      ["c1", { id: "c1", file: "src/foo.ts", startLine: 1, endLine: 5, text: "line1\nline2\nline3\nline4\nline5", tokenCount: 10 }],
      ["c2", { id: "c2", file: "src/foo.ts", startLine: 8, endLine: 10, text: "line8\nline9\nline10", tokenCount: 6 }],
      ["c3", { id: "c3", file: "tests/foo.test.ts", startLine: 1, endLine: 3, text: "test1\ntest2\ntest3", tokenCount: 6 }],
    ]);

  it("formats chunks with file path headers and line numbers", () => {
    const result = formatChunksAsText(["c1"], makeChunks(), false);
    expect(result).toContain("The following code sections were retrieved:");
    expect(result).toContain("Path: src/foo.ts");
    expect(result).toContain("     1\tline1");
    expect(result).toContain("     5\tline5");
  });

  it("excludes test file chunks when excludeTests=true", () => {
    const result = formatChunksAsText(["c1", "c3"], makeChunks(), true);
    expect(result).toContain("Path: src/foo.ts");
    expect(result).not.toContain("Path: tests/foo.test.ts");
  });

  it("merges overlapping/adjacent chunks within same file", () => {
    const chunks: Map<string, CodeChunk> = new Map([
      ["c1", { id: "c1", file: "src/a.ts", startLine: 1, endLine: 5, text: "a\nb\nc\nd\ne", tokenCount: 5 }],
      ["c2", { id: "c2", file: "src/a.ts", startLine: 3, endLine: 8, text: "c\nd\ne\nf\ng\nh", tokenCount: 6 }],
    ]);
    const result = formatChunksAsText(["c1", "c2"], chunks, false);
    // Should merge into one section since c2 starts within c1's range
    const pathCount = (result.match(/Path: src\/a\.ts/g) ?? []).length;
    expect(pathCount).toBe(1);
  });

  it("keeps separate chunks that are far apart", () => {
    const chunks: Map<string, CodeChunk> = new Map([
      ["c1", { id: "c1", file: "src/a.ts", startLine: 1, endLine: 5, text: "a\nb\nc\nd\ne", tokenCount: 5 }],
      ["c2", { id: "c2", file: "src/a.ts", startLine: 20, endLine: 25, text: "t\nu\nv\nw\nx\ny", tokenCount: 6 }],
    ]);
    const result = formatChunksAsText(["c1", "c2"], chunks, false);
    // Both chunks should appear under the same Path header
    expect(result).toContain("     1\ta");
    expect(result).toContain("    20\tt");
  });

  it("skips chunk IDs not in the chunks map", () => {
    const result = formatChunksAsText(["nonexistent"], makeChunks(), false);
    expect(result).toBe("The following code sections were retrieved:");
  });
});

// ---------------------------------------------------------------------------
// estimateTokens (also tested in codebase-retrieval.test.ts — basic coverage here)
// ---------------------------------------------------------------------------
describe("estimateTokens", () => {
  it("computes ceil(length/3)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// decomposeQuery (also tested in codebase-retrieval.test.ts — basic coverage here)
// ---------------------------------------------------------------------------
describe("decomposeQuery", () => {
  it("returns short queries as-is", () => {
    expect(decomposeQuery("hello world")).toEqual(["hello world"]);
  });

  it("splits long queries at connector", () => {
    const result = decomposeQuery("find all exported functions and classes that handle authentication");
    expect(result).toHaveLength(2);
  });
});
