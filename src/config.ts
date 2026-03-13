import { homedir } from "node:os";
import { join } from "node:path";

export type EmbeddingProvider = "voyage" | "openai" | "ollama" | null;

export interface Config {
  // Storage
  dataDir: string;          // ~/.codesift by default
  registryPath: string;     // ~/.codesift/registry.json

  // File watcher
  watchDebounceMs: number;  // 500

  // BM25
  bm25FieldWeights: {
    name: number;
    signature: number;
    docstring: number;
    body: number;
  };

  // Semantic search (optional)
  embeddingProvider: EmbeddingProvider;
  voyageApiKey: string | null;
  openaiApiKey: string | null;
  ollamaUrl: string | null;
  embeddingBatchSize: number; // 128

  // Retrieval
  defaultTokenBudget: number;  // 8000
  defaultTopK: number;         // 20
}

let cachedConfig: Config | null = null;

export function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;
  const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");

  const voyageApiKey = process.env["CODESIFT_VOYAGE_API_KEY"] ?? null;
  const openaiApiKey = process.env["CODESIFT_OPENAI_API_KEY"] ?? null;
  const ollamaUrl = process.env["CODESIFT_OLLAMA_URL"] ?? null;

  let embeddingProvider: EmbeddingProvider = null;
  if (voyageApiKey) embeddingProvider = "voyage";
  else if (openaiApiKey) embeddingProvider = "openai";
  else if (ollamaUrl) embeddingProvider = "ollama";

  cachedConfig = {
    dataDir,
    registryPath: join(dataDir, "registry.json"),

    watchDebounceMs: parseIntEnv("CODESIFT_WATCH_DEBOUNCE_MS", 500),

    bm25FieldWeights: {
      name: 3.0,
      signature: 2.0,
      docstring: 1.5,
      body: 1.0,
    },

    embeddingProvider,
    voyageApiKey,
    openaiApiKey,
    ollamaUrl,
    embeddingBatchSize: parseIntEnv("CODESIFT_EMBEDDING_BATCH_SIZE", 128),

    defaultTokenBudget: parseIntEnv("CODESIFT_DEFAULT_TOKEN_BUDGET", 8000),
    defaultTopK: parseIntEnv("CODESIFT_DEFAULT_TOP_K", 20),
  };
  return cachedConfig;
}

/** Reset cached config — for testing only. */
export function resetConfigCache(): void {
  cachedConfig = null;
}

function parseIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}
