import { homedir, totalmem } from "node:os";
import { join } from "node:path";

export type EmbeddingProvider = "voyage" | "openai" | "ollama" | "local" | null;

const GIB = 1024 ** 3;

/**
 * Below this much TOTAL system RAM, the on-device embedding model
 * (nomic-embed-text via onnxruntime, ~1-1.5 GB resident) is NOT loaded by
 * default — the exact "lite mode for 16-24 GB machines" the docs recommend,
 * made automatic so codesift stops OOM-ing small machines out of the box.
 * BM25 + tree-sitter symbols still work; only semantic embeddings go dark.
 * Fully overridable: `CODESIFT_DISABLE_LOCAL_EMBEDDINGS=0` forces the model on,
 * a remote provider (Voyage/OpenAI/Ollama) sidesteps it entirely.
 */
const AUTO_LITE_MAX_TOTAL_RAM = 24 * GIB;

let autoLiteLogged = false;

/**
 * Whether the LOCAL embedding model should be skipped. Explicit env wins in
 * both directions ("1"/"true" → skip, "0"/"false" → force load); when unset,
 * auto-skip on low-RAM machines. Only gates the local model — remote providers
 * are unaffected.
 */
export function localEmbeddingsDisabled(): boolean {
  const v = process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"];
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  const total = totalmem();
  if (total < AUTO_LITE_MAX_TOTAL_RAM) {
    if (!autoLiteLogged) {
      autoLiteLogged = true;
      console.error(
        `[codesift] lite mode: ${Math.round(total / GIB)} GB RAM < 24 GB — ` +
          `local embedding model not loaded (saves ~1.5 GB). BM25 + symbols still work. ` +
          `Set CODESIFT_DISABLE_LOCAL_EMBEDDINGS=0 to force it on.`,
      );
    }
    return true;
  }
  return false;
}

/**
 * Resident embedding-CACHE RAM budget in bytes. Explicit
 * `CODESIFT_MAX_EMBEDDING_MEM_MB` wins; otherwise scale to total RAM so a 16 GB
 * machine doesn't hold a full 1 GB of embedding vectors on top of everything
 * else. This is pure eviction pressure — semantic search still works, it just
 * keeps fewer repos resident.
 */
export function embeddingMemBudgetBytes(): number {
  const raw = process.env["CODESIFT_MAX_EMBEDDING_MEM_MB"];
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isNaN(n) && n > 0) return n * 1024 * 1024;
  const total = totalmem();
  // Inclusive boundaries: a 16 GB machine reports ~16·GiB, and it must get the
  // small budget, not the next tier up.
  const mb = total <= 16 * GIB ? 256 : total <= 32 * GIB ? 512 : 1024;
  return mb * 1024 * 1024;
}

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
    comments: number;
  };

  // Semantic search (defaults to local on-device embeddings — no API key needed)
  embeddingProvider: EmbeddingProvider;
  voyageApiKey: string | null;
  openaiApiKey: string | null;
  ollamaUrl: string | null;
  localModel: string | null;
  embeddingBatchSize: number; // 128

  // Retrieval
  defaultTokenBudget: number;  // 8000
  defaultTopK: number;         // 50

  // Secret scanning
  secretScanEnabled: boolean;  // true by default

  // PostgreSQL introspection (optional)
  pgConnStr: string | null;
}

let cachedConfig: Config | null = null;

export function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;
  const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");

  const voyageApiKey = process.env["CODESIFT_VOYAGE_API_KEY"] ?? null;
  const openaiApiKey = process.env["CODESIFT_OPENAI_API_KEY"] ?? null;
  const ollamaUrl = process.env["CODESIFT_OLLAMA_URL"] ?? null;
  const localModel = process.env["CODESIFT_LOCAL_MODEL"] ?? null;
  const localDisabled = localEmbeddingsDisabled();
  const explicitProvider = process.env["CODESIFT_EMBEDDING_PROVIDER"] ?? null;

  let embeddingProvider: EmbeddingProvider = null;
  if (explicitProvider === "voyage" || explicitProvider === "openai" || explicitProvider === "ollama" || explicitProvider === "local") {
    embeddingProvider = explicitProvider;
  } else if (voyageApiKey) embeddingProvider = "voyage";
  else if (openaiApiKey) embeddingProvider = "openai";
  else if (ollamaUrl) embeddingProvider = "ollama";
  else if (!localDisabled) embeddingProvider = "local";

  cachedConfig = {
    dataDir,
    registryPath: join(dataDir, "registry.json"),

    watchDebounceMs: parseIntEnv("CODESIFT_WATCH_DEBOUNCE_MS", 500),

    bm25FieldWeights: {
      name: 5.0,
      signature: 2.5,
      docstring: 1.5,
      body: 0.5,
      comments: 0.2,
    },

    embeddingProvider,
    voyageApiKey,
    openaiApiKey,
    ollamaUrl,
    localModel,
    embeddingBatchSize: parseIntEnv("CODESIFT_EMBEDDING_BATCH_SIZE", 128),

    defaultTokenBudget: parseIntEnv("CODESIFT_DEFAULT_TOKEN_BUDGET", 8000),
    defaultTopK: parseIntEnv("CODESIFT_DEFAULT_TOP_K", 50),

    secretScanEnabled: process.env["CODESIFT_SECRET_SCAN"] !== "false",

    pgConnStr: process.env["CODESIFT_PG_CONN_STR"] ?? null,
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
