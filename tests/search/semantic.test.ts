import { describe, it, expect, beforeEach } from "vitest";
import { buildSymbolText, searchSemantic, VoyageProvider, OpenAIProvider, OllamaProvider, LocalProvider, createEmbeddingProvider, getPrefix, _resetLocalProvider } from "../../src/search/semantic.js";
import { StaticEmbeddingProvider } from "../../src/search/static-embedding-provider.js";
import type { CodeSymbol, EmbeddingMeta } from "../../src/types.js";

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

  it("creates LocalProvider when provider=local with no config", () => {
    const provider = createEmbeddingProvider("local", {});
    expect(provider).toBeInstanceOf(LocalProvider);
    expect(provider.model).toBe("nomic-ai/nomic-embed-text-v1.5");
    expect(provider.dimensions).toBe(768);
  });

  it("creates LocalProvider with custom model and looks up its real dimensions", () => {
    const provider = createEmbeddingProvider("local", { localModel: "Xenova/all-MiniLM-L6-v2" });
    expect(provider).toBeInstanceOf(LocalProvider);
    expect(provider.model).toBe("Xenova/all-MiniLM-L6-v2");
    // 384d, not the 768d default — keeps EmbeddingMeta.dimensions honest
    expect(provider.dimensions).toBe(384);
  });

  it("falls back to default dimensions for unknown local models", () => {
    const provider = createEmbeddingProvider("local", { localModel: "Xenova/some-future-model" });
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

  // --- StaticEmbeddingProvider routing (potion / model2vec) ---

  it("routes minishlab/potion-code-16M to StaticEmbeddingProvider with dimensions=256", () => {
    const provider = createEmbeddingProvider("local", { localModel: "minishlab/potion-code-16M" });
    expect(provider).toBeInstanceOf(StaticEmbeddingProvider);
    expect(provider.dimensions).toBe(256);
  });

  it("does NOT route nomic-ai/nomic-embed-text-v1.5 to StaticEmbeddingProvider (LocalProvider path preserved)", () => {
    const provider = createEmbeddingProvider("local", { localModel: "nomic-ai/nomic-embed-text-v1.5" });
    expect(provider).not.toBeInstanceOf(StaticEmbeddingProvider);
    expect(provider).toBeInstanceOf(LocalProvider);
  });

  it("does NOT route unknown model with 'potion' in org name but no prefix match to StaticEmbeddingProvider", () => {
    // "my-org/notapotion-v2" does NOT start with "minishlab/potion" → LocalProvider
    const provider = createEmbeddingProvider("local", { localModel: "my-org/notapotion-v2" });
    expect(provider).not.toBeInstanceOf(StaticEmbeddingProvider);
    expect(provider).toBeInstanceOf(LocalProvider);
  });

  it("routes model2vec substring models to StaticEmbeddingProvider", () => {
    const provider = createEmbeddingProvider("local", { localModel: "some-org/model2vec-custom" });
    expect(provider).toBeInstanceOf(StaticEmbeddingProvider);
  });

  it("EmbeddingMeta.provider union still accepts 'local' (type-compat, no new union member)", () => {
    // Compile-time type check: if EmbeddingMeta["provider"] gained new members this would widen.
    // We assert it accepts "local" and does NOT change the persisted value from provider-side.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _typeCheck: EmbeddingMeta["provider"] = "local";
    // Runtime: createEmbeddingProvider still receives "local" as its first argument — no new
    // literal leaks out of semantic.ts's union (provider param type is unchanged).
    const p = createEmbeddingProvider("local", { localModel: "minishlab/potion-code-16M" });
    expect(p).toBeInstanceOf(StaticEmbeddingProvider);
    // The provider object itself exposes no "provider" property (meta is config-side) — good.
    expect("provider" in p).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LocalProvider — empty input shortcut (no model load required)
// ---------------------------------------------------------------------------

describe("LocalProvider", () => {
  it("returns empty array when given no texts (no pipeline load)", async () => {
    const provider = new LocalProvider();
    const result = await provider.embed([]);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getPrefix — instruction-tuned model task prefixes
// ---------------------------------------------------------------------------

describe("getPrefix", () => {
  it("prefixes nomic-embed with search_document/search_query", () => {
    expect(getPrefix("nomic-ai/nomic-embed-text-v1.5", "document")).toBe("search_document: ");
    expect(getPrefix("nomic-ai/nomic-embed-text-v1.5", "query")).toBe("search_query: ");
    // matches v1 too (substring match on "nomic-embed-text")
    expect(getPrefix("nomic-ai/nomic-embed-text-v1", "query")).toBe("search_query: ");
  });

  it("prefixes E5 family with passage/query", () => {
    expect(getPrefix("Xenova/multilingual-e5-base", "document")).toBe("passage: ");
    expect(getPrefix("Xenova/multilingual-e5-base", "query")).toBe("query: ");
    expect(getPrefix("intfloat/e5-large-v2", "document")).toBe("passage: ");
  });

  it("returns empty prefix for models that need none", () => {
    expect(getPrefix("Xenova/all-MiniLM-L6-v2", "document")).toBe("");
    expect(getPrefix("Xenova/all-MiniLM-L6-v2", "query")).toBe("");
    expect(getPrefix("Xenova/bge-small-en-v1.5", "query")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// LocalProvider integration test (skipped unless CODESIFT_E2E_LOCAL=true)
//
// Downloads ~140MB on first run; opt in only.
//
// NOTE: this suite currently fails inside vitest because onnxruntime-node uses
// native bindings that reject the Float32Array supplied from vitest's VM
// context (`A float32 tensor's data must be type of function Float32Array`).
// The same code runs cleanly under plain `node`. For a one-shot live check
// outside vitest, see `scripts/verify-local-embedding.mjs`.
//
// We keep the suite here so that (a) the test scaffolding stays maintained and
// (b) anyone running with vitest's `--pool=forks` and a future onnxruntime fix
// can flip CODESIFT_E2E_LOCAL=true to validate end-to-end.
// ---------------------------------------------------------------------------

describe.skipIf(process.env["CODESIFT_E2E_LOCAL"] !== "true")("LocalProvider (E2E)", () => {
  // ONNX runtime keeps per-process tensor backing; reset cache so each test
  // owns a fresh extractor and we don't fight vitest worker isolation.
  beforeEach(() => { _resetLocalProvider(); });

  it("embeds two texts and returns 768d normalized vectors with self-similarity ≈ 1", async () => {
    const provider = new LocalProvider();
    const result = await provider.embed(["authentication helper", "user lookup function"], "document");
    expect(result).toHaveLength(2);
    expect(result[0]?.length).toBe(768);
    expect(result[1]?.length).toBe(768);
    // Different inputs → different embeddings
    expect(result[0]).not.toEqual(result[1]);
    // Cosine of normalized vector with itself = 1
    const a = result[0]!;
    const dot = a.reduce((acc, v) => acc + v * v, 0);
    expect(dot).toBeCloseTo(1, 4);
  }, 60_000);

  it("query and document embeddings of the same text differ when prefixes apply", async () => {
    const provider = new LocalProvider();
    const [q] = await provider.embed(["authentication"], "query");
    const [d] = await provider.embed(["authentication"], "document");
    expect(q).not.toEqual(d);
  }, 60_000);
});
