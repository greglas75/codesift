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
 * Cache budget in MB, scaled to total RAM.
 *
 * The tiers used to STOP at 1024 MB for anything above 32 GB, so a 33 GB laptop
 * and a 128 GB workstation running a hundred projects got the identical budget.
 * On the big machine that is the latency bug, not a memory saving: indexes are
 * ~350 MB each, three fit, everything else is evicted, and the next call into an
 * evicted repo pays a COLD load. Measured 2026-08-28 — a first call into
 * QuotasMobi (2685 files / 51k symbols) took **70.4 s**, while Claude Code gives
 * up at 30 s. The client reports "failed to connect"; nothing is broken, the
 * answer simply arrives after nobody is listening.
 *
 * Small machines keep their exact previous values — the floors below 32 GB are
 * unchanged deliberately, because there the budget really is protecting RAM. Above
 * that it scales with the machine, and the `max(1024, …)` keeps the old value as a
 * floor so no configuration gets smaller than before.
 */
function scaledCacheBudgetMb(divisor: number, cap: number): number {
  const total = totalmem();
  if (total <= 16 * GIB) return 256;
  if (total <= 32 * GIB) return 512;
  const totalMb = total / (1024 * 1024);
  return Math.min(cap, Math.max(1024, Math.floor(totalMb / divisor)));
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
  // Inclusive boundaries: a 16 GB machine reports ~16·GiB, and it must get the
  // small budget, not the next tier up.
  return scaledCacheBudgetMb(64, 4096) * 1024 * 1024;
}

/**
 * Resident index-CACHE RAM budget in bytes.
 *
 * The cache used to be bounded by index COUNT, which treats a 411 MB index and a 2 MB one as
 * equal — so the ceiling was really "three times the largest repo you happen to touch", and on
 * the measured tgm-survey-platform index that is 1.2 GB of long-lived heap. Profiling attributed
 * the remaining stalls to GC (`Heap::Scavenge`) rather than to SQLite, and this is the resident
 * object graph doing the pressuring.
 *
 * Budgeting bytes rather than entries is what the neighbouring embedding cache already does; the
 * two now agree. A repo evicted here is re-read, not lost.
 */
export function indexCacheMemBudgetBytes(): number {
  const raw = process.env["CODESIFT_MAX_INDEX_CACHE_MB"];
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isNaN(n) && n > 0) return n * 1024 * 1024;
  // A larger share than embeddings: this is the cache whose miss costs a cold
  // index load, i.e. the one a client can time out on.
  return scaledCacheBudgetMb(32, 8192) * 1024 * 1024;
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
  ollamaModel: string | null;
  ollamaDimensions: number | null;
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
  const ollamaModel = process.env["CODESIFT_OLLAMA_MODEL"] ?? null;
  const ollamaDimsRaw = process.env["CODESIFT_OLLAMA_DIMENSIONS"];
  const ollamaDimensions = ollamaDimsRaw ? Number.parseInt(ollamaDimsRaw, 10) : null;
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
    ollamaModel,
    ollamaDimensions: ollamaDimensions && Number.isFinite(ollamaDimensions) ? ollamaDimensions : null,
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
