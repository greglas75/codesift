import { describe, it, expect, vi, beforeEach } from "vitest";
import { rerankResults, rerankChunkIds, _resetReranker } from "../../src/search/reranker.js";
import type { SearchResult, CodeChunk } from "../../src/types.js";

// Mock @huggingface/transformers
const mockReranker = vi.fn(async (input: string) => {
  // Score based on the document part (after [SEP])
  const docPart = input.split("[SEP]")[1] ?? "";
  const score = docPart.includes("matchMe") ? 0.95 : 0.1;
  return [{ label: "LABEL_0", score }];
});

const mockPipeline = vi.fn(async () => mockReranker);

vi.mock("@huggingface/transformers", () => ({
  pipeline: mockPipeline,
}));

function makeResult(name: string, score: number, source?: string): SearchResult {
  return {
    symbol: {
      id: `test:file.ts:${name}:1`,
      name,
      kind: "function",
      file: "file.ts",
      start_line: 1,
      end_line: 10,
      source: source ?? `function ${name}() {}`,
    },
    score,
  };
}

function makeChunk(id: string, text: string): CodeChunk {
  return {
    id,
    file: "file.ts",
    startLine: 1,
    endLine: 10,
    text,
    tokenCount: 20,
  };
}

describe("rerankResults", () => {
  beforeEach(() => {
    _resetReranker();
  });

  it("returns single result unchanged", async () => {
    const results = [makeResult("foo", 1.0)];
    const reranked = await rerankResults("query", results);
    expect(reranked).toHaveLength(1);
    expect(reranked[0]!.symbol.name).toBe("foo");
  });

  it("returns empty array unchanged", async () => {
    const reranked = await rerankResults("query", []);
    expect(reranked).toHaveLength(0);
  });

  it("reorders results by cross-encoder score", async () => {
    const results = [
      makeResult("low", 0.9, "function low() {}"),
      makeResult("high", 0.5, "function matchMe() {}"),
    ];

    const reranked = await rerankResults("find matchMe", results);
    expect(reranked).toHaveLength(2);
    // "high" should be first because its source contains "matchMe" → higher CE score
    expect(reranked[0]!.symbol.name).toBe("high");
    expect(reranked[1]!.symbol.name).toBe("low");
  });

  it("preserves remainder beyond topN", async () => {
    const results = [
      makeResult("a", 0.9),
      makeResult("b", 0.8),
      makeResult("c", 0.7),
    ];

    const reranked = await rerankResults("query", results, 2);
    expect(reranked).toHaveLength(3);
    // First 2 are reranked, 3rd is appended as remainder
    expect(reranked[2]!.symbol.name).toBe("c");
  });

  it("uses singleton model (second call reuses pipeline)", async () => {
    const results = [makeResult("a", 0.9), makeResult("b", 0.8)];

    await rerankResults("query", results);
    const callsAfterFirst = mockPipeline.mock.calls.length;

    await rerankResults("query2", results);
    // pipeline() should not be called again (singleton)
    expect(mockPipeline.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe("rerankChunkIds", () => {
  beforeEach(() => {
    _resetReranker();
  });

  it("returns single chunk unchanged", async () => {
    const chunks = new Map([["c1", makeChunk("c1", "hello")]]);
    const result = await rerankChunkIds("query", ["c1"], chunks);
    expect(result).toEqual(["c1"]);
  });

  it("reorders chunk IDs by cross-encoder score", async () => {
    const chunks = new Map([
      ["c1", makeChunk("c1", "irrelevant code")],
      ["c2", makeChunk("c2", "matchMe relevant code")],
    ]);

    const result = await rerankChunkIds("find matchMe", ["c1", "c2"], chunks);
    expect(result[0]).toBe("c2");
    expect(result[1]).toBe("c1");
  });

  it("preserves remainder beyond topN", async () => {
    const chunks = new Map([
      ["c1", makeChunk("c1", "a")],
      ["c2", makeChunk("c2", "b")],
      ["c3", makeChunk("c3", "c")],
    ]);

    const result = await rerankChunkIds("query", ["c1", "c2", "c3"], chunks, 2);
    expect(result).toHaveLength(3);
    expect(result[2]).toBe("c3");
  });
});

describe("graceful fallback", () => {
  it("returns original results when @huggingface/transformers fails to load", async () => {
    // Reset and override mock to simulate failure
    _resetReranker();
    vi.doMock("@huggingface/transformers", () => {
      throw new Error("Module not found");
    });

    // Re-import to get fresh module with failed mock
    const { rerankResults: freshRerank, _resetReranker: freshReset } =
      await import("../../src/search/reranker.js");
    freshReset();

    const results = [makeResult("a", 0.9), makeResult("b", 0.8)];
    const reranked = await freshRerank("query", results);

    // Should return original order since model failed to load
    expect(reranked).toHaveLength(2);
    expect(reranked[0]!.symbol.name).toBe("a");

    // Restore original mock
    vi.doMock("@huggingface/transformers", () => ({
      pipeline: vi.fn(async () =>
        vi.fn(async (input: string) => [{ label: "LABEL_0", score: input.includes("matchMe") ? 0.95 : 0.1 }]),
      ),
    }));
  });
});
