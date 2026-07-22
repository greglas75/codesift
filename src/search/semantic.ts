import type { CodeSymbol, SearchResult } from "../types.js";
import { StaticEmbeddingProvider } from "./static-embedding-provider.js";

const MAX_SYMBOL_SOURCE_CHARS = 200;
const MAX_ERROR_DETAIL_CHARS = 200;
const EMBEDDING_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Provider abstraction
// ---------------------------------------------------------------------------

/**
 * `mode` lets local instruction-tuned models (Nomic, E5) prepend the right task
 * prefix. Remote APIs (Voyage/OpenAI/Ollama) accept the parameter and ignore it.
 */
export type EmbeddingMode = "document" | "query";

export interface EmbeddingProvider {
  embed(texts: string[], mode?: EmbeddingMode): Promise<number[][]>;
  readonly dimensions: number;
  readonly model: string;
}

/**
 * Build a searchable text string from a symbol for embedding.
 * Format: "{kind} {name}\n{signature}\n{docstring first line}\n{body first N chars}"
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
    parts.push(symbol.source.slice(0, MAX_SYMBOL_SOURCE_CHARS));
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

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
/**
 * Detect stored embeddings that cannot be compared against the current query
 * vector because they were produced by a different model.
 *
 * Both comparison paths drop mismatched vectors WITHOUT a signal —
 * `searchSemantic` does `continue`, `cosineSimilarity` returns 0 — so a repo
 * whose embeddings were built by one provider and queried under another returns
 * "no results" that is indistinguishable from "nothing matched". This repo hit
 * exactly that: 30,010 symbols / 886 MB embedded with OpenAI
 * text-embedding-3-small (1536d), then queried with the local nomic model
 * (768d) after the API key went away. Every vector was skipped, every semantic
 * query came back empty, and nothing anywhere said why.
 *
 * Returns the stored dimensionality when it disagrees with the query, else null.
 */
export function detectDimensionMismatch(
  queryDim: number,
  embeddings: Map<string, Float32Array>,
): { storedDim: number } | null {
  for (const vec of embeddings.values()) {
    // Embeddings in one file are uniform — the first entry is representative.
    return vec.length === queryDim ? null : { storedDim: vec.length };
  }
  return null; // empty map is "no embeddings", a different condition
}

/** Actionable message for a detected mismatch. */
export function dimensionMismatchMessage(queryDim: number, storedDim: number): string {
  return (
    `Semantic search unavailable: stored embeddings are ${storedDim}-dimensional but the ` +
    `active embedding provider produces ${queryDim}-dimensional vectors, so none of them are ` +
    `comparable. The index was embedded with a different model than is configured now.\n` +
    `Fix: re-embed with the current provider (index_folder with force_embeddings), or restore ` +
    `the original provider's API key (e.g. CODESIFT_OPENAI_API_KEY).\n` +
    `Falling back to BM25 keyword search (search_text) is a reasonable workaround meanwhile.`
  );
}

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
// Response shape guard for OpenAI / Voyage embedding APIs
// ---------------------------------------------------------------------------

function isEmbeddingResponse(data: unknown): data is { data: Array<{ embedding: number[] }> } {
  if (!data || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj["data"])) return false;
  return obj["data"].every(
    (item: unknown) =>
      typeof item === "object" && item !== null && Array.isArray((item as Record<string, unknown>)["embedding"]),
  );
}

/**
 * Shared fetch+validate logic for OpenAI-compatible embedding APIs.
 * Handles: POST -> check response.ok -> parse JSON -> guard shape -> extract embeddings.
 */
async function fetchEmbeddings(
  url: string,
  apiKey: string,
  requestBody: Record<string, unknown>,
  providerName: string,
): Promise<number[][]> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
  });

  if (!response.ok) {
    // SEC-004: Log raw body to stderr only — don't forward to MCP client
    const body = await response.text();
    console.error(`${providerName} API error ${response.status}:`, body);
    throw new Error(`${providerName} API error: ${response.status}`);
  }

  const data: unknown = await response.json();
  if (!isEmbeddingResponse(data)) {
    throw new Error(`Unexpected ${providerName} API response shape: ${JSON.stringify(data).slice(0, MAX_ERROR_DETAIL_CHARS)}`);
  }
  return data.data.map((d) => d.embedding);
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

  async embed(texts: string[], mode: EmbeddingMode = "document"): Promise<number[][]> {
    return fetchEmbeddings(
      "https://api.voyageai.com/v1/embeddings",
      this.apiKey,
      { input: texts, model: this.model, input_type: mode === "query" ? "query" : "document" },
      "Voyage",
    );
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

  async embed(texts: string[], _mode: EmbeddingMode = "document"): Promise<number[][]> {
    return fetchEmbeddings(
      "https://api.openai.com/v1/embeddings",
      this.apiKey,
      { input: texts, model: this.model },
      "OpenAI",
    );
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

  async embed(texts: string[], _mode: EmbeddingMode = "document"): Promise<number[][]> {
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
        signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
      });

      if (!response.ok) {
        // SEC-004: Log raw body to stderr only — don't forward to MCP client
        const body = await response.text();
        console.error(`Ollama API error ${response.status}:`, body);
        throw new Error(`Ollama API error: ${response.status}`);
      }

      const data: unknown = await response.json();
      if (!data || typeof data !== "object" || !("embedding" in data) || !Array.isArray((data as Record<string, unknown>)["embedding"])) {
        throw new Error(`Unexpected Ollama API response shape: ${JSON.stringify(data).slice(0, MAX_ERROR_DETAIL_CHARS)}`);
      }
      results.push((data as { embedding: number[] }).embedding);
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// Local provider (Xenova/transformers — zero-config, no API key)
// ---------------------------------------------------------------------------

const DEFAULT_LOCAL_MODEL = "nomic-ai/nomic-embed-text-v1.5";

/** Hard per-input sequence cap handed to the tokenizer. */
const MAX_EMBED_TOKENS = 2048;
/** ~4 chars per token — enough to bucket batches without tokenizing twice. */
const CHARS_PER_TOKEN = 4;
/** Total padded tokens allowed in one forward pass (batch × longest member). */
const BATCH_TOKEN_BUDGET = 8192;

/**
 * Split texts into forward passes bounded by TOTAL padded tokens.
 *
 * A transformer batch is padded to its longest member and attention costs
 * O(seq²), so batching by ITEM COUNT makes cost depend on the worst input in
 * the group. Measured on this repo: median chunk 88 chars, p99 4 KB, max 45 KB
 * (~11 K tokens). One such chunk in a 96-item batch padded all 96 rows to 11 K
 * tokens — tens of GB of activations for 10 MB of text, which is how a single
 * indexing run jumped from 9 GB to 31 GB in one step.
 *
 * Budgeting on `count × longest` instead keeps every pass the same size: short
 * chunks still batch by the hundred, an oversized one runs nearly alone.
 * Order is preserved — callers map results back positionally.
 */
export function groupByTokenBudget(
  texts: string[],
  budget = BATCH_TOKEN_BUDGET,
  maxTokens = MAX_EMBED_TOKENS,
): Array<{ texts: string[] }> {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const groups: Array<{ texts: string[] }> = [];
  let current: string[] = [];
  let longest = 0;

  for (const raw of texts) {
    // Hard cap per input. The pipeline ignores tokenizer options, so this slice
    // is the only thing standing between a 45 KB chunk and an 11 K-token row.
    const text = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
    const tokens = Math.ceil(text.length / CHARS_PER_TOKEN);
    const nextLongest = Math.max(longest, tokens);
    if (current.length > 0 && nextLongest * (current.length + 1) > budget) {
      groups.push({ texts: current });
      current = [text];
      longest = tokens;
      continue;
    }
    current.push(text);
    longest = nextLongest;
  }
  if (current.length > 0) groups.push({ texts: current });
  return groups;
}

/**
 * Model name the resolved provider WOULD produce — without constructing it.
 *
 * Constructing a provider to learn its model is not free (the local one loads a
 * ~140 MB ONNX model), and the caller needs this answer on the cheap path,
 * before deciding whether to read a possibly-GB embedding file at all.
 */
export function expectedEmbeddingModel(
  provider: "voyage" | "openai" | "ollama" | "local",
  localModel?: string | null,
): string {
  switch (provider) {
    case "voyage": return "voyage-code-3";
    case "openai": return "text-embedding-3-small";
    case "ollama": return "nomic-embed-text";
    case "local": return localModel ?? DEFAULT_LOCAL_MODEL;
  }
}
const DEFAULT_LOCAL_DIMS = 768;
const STATIC_EMBEDDING_MODEL_PREFIX = "minishlab/potion";
const STATIC_EMBEDDING_MODEL_SUBSTRING = "model2vec";

/**
 * Some open-weights instruction-tuned models require task-specific prefixes for
 * the embeddings to be high quality (Nomic, intfloat/E5). Without these, MTEB
 * drops 5–10 points and our semantic-search results regress vs OpenAI/Voyage.
 *
 * Keys are checked as substrings against the model id, so "Xenova/nomic-embed-*"
 * and "Xenova/multilingual-e5-*" all match without enumerating every variant.
 */
const LOCAL_PREFIX_RULES: ReadonlyArray<{ match: string; document: string; query: string }> = [
  { match: "nomic-embed-text", document: "search_document: ", query: "search_query: " },
  { match: "multilingual-e5", document: "passage: ", query: "query: " },
  { match: "/e5-", document: "passage: ", query: "query: " },
];

/** Exported for unit tests. Returns "" when the model needs no task prefix. */
export function getPrefix(model: string, mode: EmbeddingMode): string {
  for (const rule of LOCAL_PREFIX_RULES) {
    if (model.includes(rule.match)) return mode === "query" ? rule.query : rule.document;
  }
  return "";
}

/**
 * Known dimensions for popular Xenova/HuggingFace embedding models. Keeps
 * `LocalProvider.dimensions` honest when callers swap `CODESIFT_LOCAL_MODEL`.
 * Falls back to {@link DEFAULT_LOCAL_DIMS} for unknown models.
 */
const KNOWN_LOCAL_DIMS: Readonly<Record<string, number>> = {
  "minishlab/potion-code-16M": 256,
  "nomic-ai/nomic-embed-text-v1.5": 768,
  "nomic-ai/nomic-embed-text-v1": 768,
  "Xenova/all-MiniLM-L6-v2": 384,
  "Xenova/all-MiniLM-L12-v2": 384,
  "Xenova/bge-small-en-v1.5": 384,
  "Xenova/bge-base-en-v1.5": 768,
  "Xenova/bge-large-en-v1.5": 1024,
  "Xenova/multilingual-e5-small": 384,
  "Xenova/multilingual-e5-base": 768,
  "Xenova/multilingual-e5-large": 1024,
};

function lookupDimensions(model: string): number {
  return KNOWN_LOCAL_DIMS[model] ?? DEFAULT_LOCAL_DIMS;
}

type FeatureExtractor = (
  texts: string | string[],
  opts?: { pooling?: "mean" | "cls" | "none"; normalize?: boolean },
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

const localPipelineCache = new Map<string, FeatureExtractor>();
const localPipelineDisposers = new Map<string, () => Promise<void>>();

/**
 * Release loaded ONNX sessions.
 *
 * One-shot processes must call this before exiting. `main()` force-exits via
 * process.exit(), and tearing the process down while onnxruntime's background
 * threads are still live aborts the whole process:
 *   libc++abi: terminating ... system_error: mutex lock failed: Invalid argument
 * exit code 134. That abort predates the arena change (it reproduces with
 * CODESIFT_ONNX_MEM_ARENA=1 and =0 alike) and could land mid-write, which is
 * how a full `codesift index` run finished with no embeddings on disk and no
 * error printed.
 */
export async function disposeLocalPipelines(): Promise<void> {
  const disposers = [...localPipelineDisposers.values()];
  localPipelineDisposers.clear();
  localPipelineCache.clear();
  await Promise.allSettled(disposers.map((d) => d()));
}
const failedLocalModels = new Set<string>();
let localLoadWarned = false;
let firstLoadAnnounced = false;

async function loadLocalPipeline(model: string): Promise<FeatureExtractor | null> {
  const cached = localPipelineCache.get(model);
  if (cached) return cached;
  if (failedLocalModels.has(model)) return null;

  try {
    if (!firstLoadAnnounced) {
      firstLoadAnnounced = true;
      console.error(`[codesift] Loading local embedding model ${model} (first-run download ~140MB, cached after).`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transformers = await import("@huggingface/transformers") as any;
    const pipelineFn = transformers.pipeline ?? transformers.default?.pipeline;
    if (!pipelineFn) { failedLocalModels.add(model); return null; }

    // `dtype: "q8"` is the @huggingface/transformers v3 way to request the
    // INT8-quantized ONNX weights (the v2 `{ quantized: true }` flag is gone).
    //
    // `enableCpuMemArena: false` is the difference between bounded and unbounded
    // memory. onnxruntime's CPU arena caches every allocation it ever makes and
    // never returns it, so RSS grew ~1.5 MB per embedded text and no amount of
    // GC or tensor .dispose() reclaimed it — the JS heap stayed at 16-42 MB
    // while RSS climbed into the gigabytes. Measured over 10,000 texts:
    //   arena on  →  2,000 texts = 3,681 MB, still climbing
    //   arena off → 10,000 texts =   777 MB, flat (peaks ~1.2 GB, then returns)
    // At this repo's ~57K symbol+chunk texts that is the difference between
    // ~85 GB and under 1 GB. It is the root cause behind an indexing process
    // that reached 163 GB RSS.
    // Escape hatch: CODESIFT_ONNX_MEM_ARENA=1 restores the old arena behaviour
    // if a runtime/platform turns out to need it.
    const memArena = process.env["CODESIFT_ONNX_MEM_ARENA"] === "1";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extractor = await pipelineFn("feature-extraction", model, {
      dtype: "q8",
      session_options: { enableCpuMemArena: memArena },
    }) as any;

    const fn: FeatureExtractor = (texts, opts) => extractor(texts, opts);
    localPipelineCache.set(model, fn);
    localPipelineDisposers.set(model, async () => {
      if (typeof extractor?.dispose === "function") await extractor.dispose();
    });
    return fn;
  } catch (err) {
    failedLocalModels.add(model);
    if (!localLoadWarned) {
      localLoadWarned = true;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[codesift] Local embedding model ${model} unavailable: ${message}. Install @huggingface/transformers or set CODESIFT_VOYAGE_API_KEY/CODESIFT_OPENAI_API_KEY.`);
    }
    return null;
  }
}

export class LocalProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;

  constructor(model: string = DEFAULT_LOCAL_MODEL, dimensions?: number) {
    this.model = model;
    this.dimensions = dimensions ?? lookupDimensions(model);
  }

  async embed(texts: string[], mode: EmbeddingMode = "document"): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await loadLocalPipeline(this.model);
    if (!extractor) {
      throw new Error(`Local embedding model unavailable. Install @huggingface/transformers or configure another provider.`);
    }

    const prefix = getPrefix(this.model, mode);
    const prefixed = prefix ? texts.map((t) => prefix + t) : texts;

    const results: number[][] = [];
    for (const group of groupByTokenBudget(prefixed)) {
      // Truncation happens on the TEXT (groupByTokenBudget already sliced it):
      // the feature-extraction pipeline accepts only pooling/normalize, so a
      // `truncation: true` option here would be silently ignored — the cap has
      // to be applied before the tokenizer ever sees the string.
      const output = await extractor(group.texts, { pooling: "mean", normalize: true });
      const data = output.data instanceof Float32Array ? output.data : Float32Array.from(output.data);
      const dims = output.dims;
      const dim = dims[dims.length - 1] ?? this.dimensions;
      for (let i = 0; i < group.texts.length; i++) {
        const start = i * dim;
        results.push(Array.from(data.subarray(start, start + dim)));
      }
    }
    return results;
  }
}

/** Reset local pipeline caches — for testing only. */
export function _resetLocalProvider(): void {
  localPipelineCache.clear();
  failedLocalModels.clear();
  localLoadWarned = false;
  firstLoadAnnounced = false;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEmbeddingProvider(
  provider: "voyage" | "openai" | "ollama" | "local",
  config: {
    voyageApiKey?: string | null;
    openaiApiKey?: string | null;
    ollamaUrl?: string | null;
    localModel?: string | null;
  },
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
    case "local": {
      const model = config.localModel ?? DEFAULT_LOCAL_MODEL;
      if (model.startsWith(STATIC_EMBEDDING_MODEL_PREFIX) || model.includes(STATIC_EMBEDDING_MODEL_SUBSTRING)) {
        return new StaticEmbeddingProvider(model);
      }
      return new LocalProvider(model);
    }
  }
}
