import { describe, it, expect } from "vitest";
import { buildSymbolText, searchSemantic, VoyageProvider, OpenAIProvider, OllamaProvider, createEmbeddingProvider } from "../../src/search/semantic.js";
import type { CodeSymbol } from "../../src/types.js";

function makeSymbol(overrides: Partial<CodeSymbol> = {}): CodeSymbol {
  return {
    id: "local/test:src/auth.ts:getUserById:10",
    repo: "local/test",
    name: "getUserById",
    kind: "function",
    file: "src/auth.ts",
    start_line: 10,
    end_line: 20,
    signature: "async getUserById(id: string): Promise<User | null>",
    docstring: "Fetches a user by their UUID",
    source: "return prisma.user.findUnique({ where: { id } });",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildSymbolText
// ---------------------------------------------------------------------------

describe("buildSymbolText", () => {
  it("includes kind, name, signature, docstring first line, and body prefix", () => {
    const sym = makeSymbol();
    const text = buildSymbolText(sym);
    expect(text).toContain("function getUserById");
    expect(text).toContain("async getUserById(id: string)");
    expect(text).toContain("Fetches a user by their UUID");
    expect(text).toContain("prisma.user.findUnique");
  });

  it("works with minimal symbol (no signature/docstring/source)", () => {
    const sym = makeSymbol({ signature: undefined, docstring: undefined, source: undefined });
    const text = buildSymbolText(sym);
    expect(text).toBe("function getUserById");
  });

  it("truncates body to 200 chars", () => {
    const longBody = "x".repeat(500);
    const sym = makeSymbol({ source: longBody });
    const text = buildSymbolText(sym);
    // body contribution should be at most 200 chars
    const bodyPart = text.split("\n").find((l) => l.includes("x"));
    expect(bodyPart?.length).toBeLessThanOrEqual(200);
  });

  it("uses only first line of docstring", () => {
    const sym = makeSymbol({ docstring: "First line\nSecond line\nThird line" });
    const text = buildSymbolText(sym);
    expect(text).toContain("First line");
    expect(text).not.toContain("Second line");
  });
});

// ---------------------------------------------------------------------------
// searchSemantic
// ---------------------------------------------------------------------------

function makeEmbedding(dims: number, values: number[]): Float32Array {
  const vec = new Float32Array(dims);
  for (let i = 0; i < Math.min(values.length, dims); i++) {
    vec[i] = values[i]!;
  }
  return vec;
}

describe("searchSemantic", () => {
  const sym1 = makeSymbol({ id: "sym1", name: "getUserById" });
  const sym2 = makeSymbol({ id: "sym2", name: "createUser" });
  const sym3 = makeSymbol({ id: "sym3", name: "deleteUser" });

  const symbolMap = new Map([
    ["sym1", sym1],
    ["sym2", sym2],
    ["sym3", sym3],
  ]);

  // Query vector: points mostly in dim 0
  const queryVec = makeEmbedding(3, [1, 0, 0]);

  // sym1: very similar (dim 0 dominant)
  const emb1 = makeEmbedding(3, [0.9, 0.1, 0.1]);
  // sym2: somewhat similar
  const emb2 = makeEmbedding(3, [0.5, 0.5, 0]);
  // sym3: dissimilar (dim 2 dominant)
  const emb3 = makeEmbedding(3, [0.1, 0.1, 0.9]);

  const embeddings = new Map([
    ["sym1", emb1],
    ["sym2", emb2],
    ["sym3", emb3],
  ]);

  it("returns results sorted by cosine similarity", () => {
    const results = searchSemantic(queryVec, embeddings, symbolMap, 3);
    expect(results).toHaveLength(3);
    expect(results[0]!.symbol.name).toBe("getUserById"); // sym1 most similar
    expect(results[1]!.symbol.name).toBe("createUser");  // sym2 next
    expect(results[2]!.symbol.name).toBe("deleteUser");  // sym3 least
  });

  it("respects topK limit", () => {
    const results = searchSemantic(queryVec, embeddings, symbolMap, 1);
    expect(results).toHaveLength(1);
    expect(results[0]!.symbol.name).toBe("getUserById");
  });

  it("returns empty array when embeddings map is empty", () => {
    const results = searchSemantic(queryVec, new Map(), symbolMap, 10);
    expect(results).toHaveLength(0);
  });

  it("skips embeddings with no matching symbol", () => {
    const embeddingsWithOrphan = new Map([...embeddings, ["orphan-id", emb1]]);
    const results = searchSemantic(queryVec, embeddingsWithOrphan, symbolMap, 10);
    // orphan-id has no symbol → not in results
    expect(results.every((r) => r.symbol.id !== "orphan-id")).toBe(true);
  });

  it("scores are in [0, 1] range for normalized vectors", () => {
    // Normalized vectors → cosine similarity in [-1, 1]
    const results = searchSemantic(queryVec, embeddings, symbolMap, 3);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(-1);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// createEmbeddingProvider
// ---------------------------------------------------------------------------

describe("createEmbeddingProvider", () => {
  it("creates VoyageProvider when provider=voyage", () => {
    const provider = createEmbeddingProvider("voyage", { voyageApiKey: "test-key" });
    expect(provider).toBeInstanceOf(VoyageProvider);
    expect(provider.model).toBe("voyage-code-3");
    expect(provider.dimensions).toBe(1024);
  });

  it("creates OpenAIProvider when provider=openai", () => {
    const provider = createEmbeddingProvider("openai", { openaiApiKey: "sk-test" });
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.model).toBe("text-embedding-3-small");
    expect(provider.dimensions).toBe(1536);
  });

  it("creates OllamaProvider when provider=ollama", () => {
    const provider = createEmbeddingProvider("ollama", { ollamaUrl: "http://localhost:11434" });
    expect(provider).toBeInstanceOf(OllamaProvider);
    expect(provider.model).toBe("nomic-embed-text");
    expect(provider.dimensions).toBe(768);
  });

  it("throws when voyage key is missing", () => {
    expect(() => createEmbeddingProvider("voyage", {})).toThrow("CODESIFT_VOYAGE_API_KEY not set");
  });

  it("throws when openai key is missing", () => {
    expect(() => createEmbeddingProvider("openai", {})).toThrow("CODESIFT_OPENAI_API_KEY not set");
  });

  it("throws when ollama url is missing", () => {
    expect(() => createEmbeddingProvider("ollama", {})).toThrow("CODESIFT_OLLAMA_URL not set");
  });
});
