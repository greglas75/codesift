import { createEmbeddingProvider, expectedEmbeddingModel } from "../../src/search/semantic.js";

/**
 * The Ollama provider used to be pinned to nomic-embed-text / 768d and embedded
 * one text per HTTP request. It is now model-configurable and uses the batch
 * /api/embed endpoint, so any Ollama embedding model (embeddinggemma,
 * mxbai-embed-large, bge-m3, …) can drive semantic search on the GPU.
 */
describe("OllamaProvider — configurable model + batch endpoint", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it("honours a configured model and dimensions", () => {
    const p = createEmbeddingProvider("ollama", {
      ollamaUrl: "http://localhost:11434",
      ollamaModel: "embeddinggemma",
      ollamaDimensions: 768,
    });
    expect(p.model).toBe("embeddinggemma");
    expect(p.dimensions).toBe(768);
  });

  it("defaults to nomic-embed-text/768 when unset", () => {
    const p = createEmbeddingProvider("ollama", { ollamaUrl: "http://localhost:11434" });
    expect(p.model).toBe("nomic-embed-text");
    expect(p.dimensions).toBe(768);
  });

  it("sends ONE batch request for many texts, not one per text", async () => {
    let calls = 0;
    let sentInput: unknown;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      calls++;
      sentInput = JSON.parse(init.body).input;
      const n = (sentInput as string[]).length;
      return {
        ok: true,
        json: async () => ({ embeddings: Array.from({ length: n }, () => [0.1, 0.2, 0.3]) }),
      };
    }) as unknown as typeof fetch;

    const p = createEmbeddingProvider("ollama", {
      ollamaUrl: "http://localhost:11434",
      ollamaModel: "embeddinggemma",
    });
    const out = await p.embed(["a", "b", "c", "d"], "document");

    expect(calls).toBe(1); // batched, not 4 requests
    expect(Array.isArray(sentInput)).toBe(true);
    expect((sentInput as string[]).length).toBe(4);
    expect(out.length).toBe(4);
  });

  it("truncates a pathologically large input before sending (dump.sql tokenize-EOF crash)", async () => {
    let sentInput: string[] = [];
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      sentInput = JSON.parse(init.body).input;
      return { ok: true, json: async () => ({ embeddings: sentInput.map(() => [0.1]) }) };
    }) as unknown as typeof fetch;

    const p = createEmbeddingProvider("ollama", {
      ollamaUrl: "http://localhost:11434", ollamaModel: "embeddinggemma",
    });
    const huge = "SELECT * FROM x; ".repeat(200_000); // ~3.4 MB, like tests/_data/dump.sql
    await p.embed([huge, "short"], "document");

    // Ollama tokenizes the full text before truncating to context, so an
    // oversized input crashes its runner ("/tokenize: EOF") and fails the whole
    // batch. Cap it before it ever reaches Ollama.
    expect(sentInput[0]!.length).toBeLessThanOrEqual(8192);
    expect(sentInput[1]).toBe("short"); // normal text untouched
  });

  it("expectedEmbeddingModel reflects the configured Ollama model (for cache invalidation)", () => {
    expect(expectedEmbeddingModel("ollama", null, "embeddinggemma")).toBe("embeddinggemma");
    expect(expectedEmbeddingModel("ollama")).toBe("nomic-embed-text");
  });
});
