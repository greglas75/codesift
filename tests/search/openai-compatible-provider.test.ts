// The OpenAI provider is also the way to reach any OpenAI-compatible gateway (OpenRouter). A setting
// that silently fell back to api.openai.com or text-embedding-3-small would embed with the wrong model,
// and every stored vector would then be judged stale against the configured one.
import { afterEach, describe, expect, it } from "vitest";
import { createEmbeddingProvider, expectedEmbeddingModel } from "../../src/search/semantic.js";

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

function captureRequests(): Array<{ url: string; body: Record<string, unknown> }> {
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { input: string[] };
    seen.push({ url, body });
    return { ok: true, json: async () => ({ data: body.input.map(() => ({ embedding: [1, 0] })) }) };
  }) as unknown as typeof fetch;
  return seen;
}

describe("OpenAI-compatible embedding provider", () => {
  it("sends the configured model to the configured endpoint, marking the query side for voyage", async () => {
    const seen = captureRequests();
    const provider = createEmbeddingProvider("openai", {
      openaiApiKey: "k", openaiBaseUrl: "https://openrouter.ai/api/v1/", openaiModel: "voyageai/voyage-4-lite",
      openaiDimensions: 1024,
    });

    await provider.embed(["find the parser"], "query");

    expect(seen).toEqual([{
      url: "https://openrouter.ai/api/v1/embeddings",
      body: { input: ["find the parser"], model: "voyageai/voyage-4-lite", input_type: "query" },
    }]);
    expect(provider.dimensions).toBe(1024);
    expect(expectedEmbeddingModel("openai", null, null, "voyageai/voyage-4-lite")).toBe(provider.model);
  });

  // A model that does not know input_type could reject the request.
  it("keeps the plain OpenAI request for a model that is not voyage", async () => {
    const seen = captureRequests();
    const provider = createEmbeddingProvider("openai", { openaiApiKey: "k" });

    await provider.embed(["x"], "query");

    expect(seen).toEqual([{
      url: "https://api.openai.com/v1/embeddings", body: { input: ["x"], model: "text-embedding-3-small" },
    }]);
  });
});
