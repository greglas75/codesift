// Model2Vec / "static" embedding provider.
//
// Model2Vec models (e.g. minishlab/potion-code-16M) are NOT neural networks at
// inference time — they are a frozen token→vector lookup table. Embedding a text
// is: tokenize → gather the matched rows → mean-pool → L2-normalize. No ONNX
// runtime, no task prefixes (unlike Nomic/E5 — see comment on `embed`).
//
// Files come from the HF hub via Task 2's ensureModelFile and are parsed with
// Task 1's pure safetensors loader. Load is lazy (first embed) and process-cached,
// mirroring LocalProvider's module-cache + failedModels + warned pattern.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureModelFile } from "../utils/hf-hub-download.js";
import { parseSafetensors, getTensor, type SafetensorEntry } from "../utils/safetensors-loader.js";
import { loadConfig } from "../config.js";
import type { EmbeddingProvider, EmbeddingMode } from "./semantic.js";
import { parseVocab, tokenize, embedOne } from "./model2vec-tokenize.js";

const SAFETENSORS_FILE = "model.safetensors";
const TOKENIZER_FILE = "tokenizer.json";

/**
 * Known output dimensions per static model id. Keeps `dimensions` honest BEFORE
 * the matrix is loaded; after the first embed it is reconciled to the real
 * loaded matrix column count (see {@link StaticEmbeddingProvider.dimensions}).
 */
const KNOWN_STATIC_DIMS: Readonly<Record<string, number>> = {
  "minishlab/potion-code-16M": 256,
  "minishlab/potion-base-8M": 256,
};
const DEFAULT_STATIC_DIMS = 256;

function lookupStaticDimensions(model: string): number {
  return KNOWN_STATIC_DIMS[model] ?? DEFAULT_STATIC_DIMS;
}

interface LoadedStaticModel {
  /** Flat row-major matrix: rows × cols of F32. */
  matrix: Float32Array;
  rows: number;
  cols: number;
  /** token string → row index. */
  vocab: Map<string, number>;
}

// Module-level cache: model weights are immutable, so one load per process per
// model is correct (no TTL needed — same lifecycle as LocalProvider's caches).
const staticModelCache = new Map<string, LoadedStaticModel>();
// Promise cache: memoize in-flight load promises to prevent concurrent stampede.
const staticLoadPromises = new Map<string, Promise<LoadedStaticModel>>();
// Failure timestamps: model → timestamp of last failure (epoch ms).
// Fast-fail only within STATIC_FAILURE_COOLDOWN_MS to allow retry after transient errors.
export const STATIC_FAILURE_COOLDOWN_MS = 60_000;
export const _failedStaticModels = new Map<string, number>();
let staticLoadWarned = false;

function defaultCacheDir(): string {
  return join(loadConfig().dataDir, "models");
}

async function _doLoadStaticModel(model: string, cacheDir: string): Promise<LoadedStaticModel> {
  try {
    const [safetensorsPath, tokenizerPath] = await Promise.all([
      ensureModelFile(model, SAFETENSORS_FILE, cacheDir),
      ensureModelFile(model, TOKENIZER_FILE, cacheDir),
    ]);

    const weightsBytes = await readFile(safetensorsPath);
    const parsed = parseSafetensors(weightsBytes);
    if (parsed.length === 0)
      throw new Error("static-embedding: model.safetensors contains no tensors");
    // Prefer a tensor named "embeddings"; fall back to the first entry.
    let entry: SafetensorEntry;
    try {
      entry = getTensor(parsed, "embeddings");
    } catch {
      entry = parsed[0]!;
    }
    const [rows, cols] = entry.shape;

    const tokenizerText = await readFile(tokenizerPath, "utf8");
    let tokenizerRaw: unknown;
    try {
      tokenizerRaw = JSON.parse(tokenizerText);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`static-embedding: malformed tokenizer.json — ${msg}`, { cause: err });
    }
    const vocab = parseVocab(tokenizerRaw);

    const loaded: LoadedStaticModel = { matrix: entry.data, rows, cols, vocab };
    staticModelCache.set(model, loaded);
    return loaded;
  } catch (err: unknown) {
    // Record failure timestamp for cooldown-based retry.
    _failedStaticModels.set(model, Date.now());
    // Remove the in-flight promise so a later retry (after cooldown) can re-attempt.
    staticLoadPromises.delete(model);
    if (!staticLoadWarned) {
      staticLoadWarned = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[codesift] Static embedding model ${model} unavailable: ${msg}.`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`static-embedding: failed to load model ${model}: ${msg}`, { cause: err });
  }
}

async function loadStaticModel(model: string, cacheDir: string): Promise<LoadedStaticModel> {
  const cached = staticModelCache.get(model);
  if (cached) return cached;

  // Fast-fail within cooldown window — prevents hammering a known-bad model.
  const failedAt = _failedStaticModels.get(model);
  if (failedAt !== undefined && Date.now() - failedAt < STATIC_FAILURE_COOLDOWN_MS) {
    throw new Error(`static-embedding: model ${model} previously failed to load`);
  }

  // Memoize the in-flight promise to prevent concurrent stampede:
  // register synchronously before awaiting so concurrent callers share one load.
  const existing = staticLoadPromises.get(model);
  if (existing) return existing;

  const promise = _doLoadStaticModel(model, cacheDir);
  staticLoadPromises.set(model, promise);
  return promise;
}

export class StaticEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly #cacheDir: string;
  #realDims: number | null = null;

  constructor(model: string, cacheDir?: string) {
    if (!model || !model.trim())
      throw new Error("static-embedding: model id must not be empty");
    this.model = model;
    this.#cacheDir = cacheDir ?? defaultCacheDir();
  }

  /**
   * Before load: the known dimension from {@link KNOWN_STATIC_DIMS}. After the
   * first successful embed: the real loaded matrix column count. They normally
   * agree; the reconciliation keeps `dimensions` truthful when a model ships
   * with a different width than the static table records.
   */
  get dimensions(): number {
    return this.#realDims ?? lookupStaticDimensions(this.model);
  }

  /**
   * `mode` is accepted to satisfy the EmbeddingProvider contract but IGNORED:
   * Model2Vec is a static lookup table, so query/document task prefixes (which
   * Nomic/E5 need) do not apply.
   */
  async embed(texts: string[], _mode: EmbeddingMode = "document"): Promise<number[][]> {
    if (texts.length === 0) return [];
    const loaded = await loadStaticModel(this.model, this.#cacheDir);
    this.#realDims = loaded.cols;
    return texts.map((text) => embedOne(tokenize(text, loaded.vocab, loaded.rows), loaded.matrix, loaded.cols));
  }
}

/** Reset static-provider module caches — for testing only. */
export function _resetStaticProviderForTesting(): void {
  staticModelCache.clear();
  staticLoadPromises.clear();
  _failedStaticModels.clear();
  staticLoadWarned = false;
}
