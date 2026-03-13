import type { CodeSymbol, SearchResult } from "../types.js";

// ---------------------------------------------------------------------------
// Provider abstraction
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly model: string;
}

/**
 * Build a searchable text string from a symbol for embedding.
 * Format: "{kind} {name}\n{signature}\n{docstring first line}\n{body first 200 chars}"
 */
export function buildSymbolText(symbol: CodeSymbol): string {
  const parts: string[] = [`${symbol.kind} ${symbol.name}`];

  if (symbol.signature) {
    parts.push(symbol.signature);
  }

  if (symbol.docstring) {
    const firstLine = symbol.docstring.split("\n")[0]?.trim();
    if (firstLine) parts.push(firstLine);
  }

  if (symbol.source) {
    parts.push(symbol.source.slice(0, 200));
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Search embeddings by cosine similarity (linear scan).
 * Returns top-k results sorted by similarity descending.
 */
export function searchSemantic(
  queryEmbedding: Float32Array,
  embeddings: Map<string, Float32Array>,
  symbols: Map<string, CodeSymbol>,
  topK: number,
): SearchResult[] {
  const scored: Array<{ id: string; score: number }> = [];

  for (const [id, vec] of embeddings) {
    if (vec.length !== queryEmbedding.length) continue;
    const score = cosineSimilarity(queryEmbedding, vec);
    scored.push({ id, score });
  }

  scored.sort((a, b) => b.score - a.score);

  const results: SearchResult[] = [];
  for (const { id, score } of scored.slice(0, topK)) {
    const symbol = symbols.get(id);
    if (symbol) {
      results.push({ symbol, score });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Voyage AI provider
// ---------------------------------------------------------------------------

export class VoyageProvider implements EmbeddingProvider {
  readonly model = "voyage-code-3";
  readonly dimensions = 1024;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
        input_type: "document",
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Voyage API error ${response.status}: ${body}`);
    }

    const data: unknown = await response.json();
    const result = data as { data: Array<{ embedding: number[] }> };
    return result.data.map((d) => d.embedding);
  }
}

// ---------------------------------------------------------------------------
// OpenAI provider
// ---------------------------------------------------------------------------

export class OpenAIProvider implements EmbeddingProvider {
  readonly model = "text-embedding-3-small";
  readonly dimensions = 1536;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${body}`);
    }

    const data: unknown = await response.json();
    const result = data as { data: Array<{ embedding: number[] }> };
    return result.data.map((d) => d.embedding);
  }
}

// ---------------------------------------------------------------------------
// Ollama provider (local)
// ---------------------------------------------------------------------------

export class OllamaProvider implements EmbeddingProvider {
  readonly model = "nomic-embed-text";
  readonly dimensions = 768;
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Ollama doesn't support batch — call sequentially
    const results: number[][] = [];

    for (const text of texts) {
      const response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt: text,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Ollama API error ${response.status}: ${body}`);
      }

      const data: unknown = await response.json();
      const result = data as { embedding: number[] };
      results.push(result.embedding);
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEmbeddingProvider(
  provider: "voyage" | "openai" | "ollama",
  config: { voyageApiKey?: string | null; openaiApiKey?: string | null; ollamaUrl?: string | null },
): EmbeddingProvider {
  switch (provider) {
    case "voyage": {
      if (!config.voyageApiKey) throw new Error("CODESIFT_VOYAGE_API_KEY not set");
      return new VoyageProvider(config.voyageApiKey);
    }
    case "openai": {
      if (!config.openaiApiKey) throw new Error("CODESIFT_OPENAI_API_KEY not set");
      return new OpenAIProvider(config.openaiApiKey);
    }
    case "ollama": {
      if (!config.ollamaUrl) throw new Error("CODESIFT_OLLAMA_URL not set");
      return new OllamaProvider(config.ollamaUrl);
    }
  }
}
