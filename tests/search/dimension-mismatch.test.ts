import {
  detectDimensionMismatch,
  dimensionMismatchMessage,
  searchSemantic,
} from "../../src/search/semantic.js";
import type { CodeSymbol } from "../../src/types.js";

function vec(dim: number, fill = 0.1): Float32Array {
  return new Float32Array(dim).fill(fill);
}

describe("detectDimensionMismatch — stop semantic search failing silently", () => {
  it("reports the stored dimensionality when it differs from the query", () => {
    // The real incident: index embedded with OpenAI text-embedding-3-small
    // (1536d), later queried with the local nomic model (768d).
    const embeddings = new Map([["a", vec(1536)], ["b", vec(1536)]]);
    expect(detectDimensionMismatch(768, embeddings)).toEqual({ storedDim: 1536 });
  });

  it("returns null when dimensions agree", () => {
    const embeddings = new Map([["a", vec(768)]]);
    expect(detectDimensionMismatch(768, embeddings)).toBeNull();
  });

  it("returns null for an empty map — that is 'no embeddings', a different problem", () => {
    expect(detectDimensionMismatch(768, new Map())).toBeNull();
  });

  it("message names both dimensions and gives a concrete remedy", () => {
    const msg = dimensionMismatchMessage(768, 1536);
    expect(msg).toContain("1536");
    expect(msg).toContain("768");
    expect(msg).toMatch(/re-embed|index_folder/i);
  });

  it("documents the silent failure it guards: searchSemantic drops every mismatched vector", () => {
    const embeddings = new Map([["a", vec(1536)], ["b", vec(1536)]]);
    const symbols = new Map<string, CodeSymbol>();
    const results = searchSemantic(vec(768), embeddings, symbols, 10);
    // Empty, with no error and no warning — indistinguishable from "nothing
    // matched". This is exactly why the detector above must run first.
    expect(results).toEqual([]);
    expect(detectDimensionMismatch(768, embeddings)).not.toBeNull();
  });
});
