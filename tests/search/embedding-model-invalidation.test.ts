import { expectedEmbeddingModel } from "../../src/search/semantic.js";

describe("expectedEmbeddingModel — resolve model without constructing a provider", () => {
  it("names each provider's model", () => {
    expect(expectedEmbeddingModel("voyage")).toBe("voyage-code-3");
    expect(expectedEmbeddingModel("openai")).toBe("text-embedding-3-small");
    expect(expectedEmbeddingModel("ollama")).toBe("nomic-embed-text");
    expect(expectedEmbeddingModel("local")).toBe("nomic-ai/nomic-embed-text-v1.5");
  });

  it("honours an explicit local model override", () => {
    expect(expectedEmbeddingModel("local", "Xenova/all-MiniLM-L6-v2")).toBe("Xenova/all-MiniLM-L6-v2");
    expect(expectedEmbeddingModel("local", null)).toBe("nomic-ai/nomic-embed-text-v1.5");
  });

  it("detects the real-world invalidation case: openai-built index, local provider active", () => {
    // Exactly the state 266 of 336 indexes on this machine were left in.
    const storedModel = "text-embedding-3-small";
    expect(expectedEmbeddingModel("local")).not.toBe(storedModel);
  });
});
