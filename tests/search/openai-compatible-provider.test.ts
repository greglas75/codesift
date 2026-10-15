// The OpenAI provider is also the way to reach any OpenAI-compatible gateway (OpenRouter). A setting
// that silently fell back to api.openai.com or text-embedding-3-small would embed with the wrong model,
// and every stored vector would then be judged stale against the configured one.
import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createEmbeddingProvider, expectedEmbeddingModel } from "../../src/search/semantic.js";

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

function captureRequests(width: number): Array<{ url: string; body: Record<string, unknown> }> {
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { input: string[] };
    seen.push({ url, body });
    return { ok: true, json: async () => ({ data: body.input.map(() => ({ embedding: new Array<number>(width).fill(0.5) })) }) };
  }) as unknown as typeof fetch;
  return seen;
}

describe("OpenAI-compatible embedding provider", () => {
  it("sends the configured model to the configured endpoint, marking the query side for voyage", async () => {
    const seen = captureRequests(1024);
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
    const seen = captureRequests(1536);
    const provider = createEmbeddingProvider("openai", { openaiApiKey: "k" });

    await provider.embed(["x"], "query");

    expect(seen).toEqual([{
      url: "https://api.openai.com/v1/embeddings", body: { input: ["x"], model: "text-embedding-3-small" },
    }]);
  });

  // Node's 250 ms per-address default cut off every connect to openrouter.ai on a loaded Mac (280 ms).
  it("gives a remote host more than 250 ms per address to connect", async () => {
    setDefaultAutoSelectFamilyAttemptTimeout(250);
    captureRequests(1536);

    await createEmbeddingProvider("openai", { openaiApiKey: "k" }).embed(["x"]);

    expect(getDefaultAutoSelectFamilyAttemptTimeout()).toBeGreaterThanOrEqual(2_000);
  });

  // A mistyped CODESIFT_OPENAI_DIMENSIONS would be written into the meta beside vectors of another width.
  it("refuses vectors whose width is not the configured one", async () => {
    captureRequests(1536);
    const provider = createEmbeddingProvider("openai", { openaiApiKey: "k", openaiDimensions: 1024 });

    await expect(provider.embed(["x"])).rejects.toThrow(/1536-dimensional.*configured 1024/);
  });
});
