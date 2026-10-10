/**
 * How background embedding runs have gone in this process, for `/health`.
 *
 * Embedding is fire-and-forget by design, so a provider that stops answering fails into stderr and
 * nowhere else: on the Mac the configured Ollama was gone for nine days, every run failed, and
 * `/health` kept saying "ok" while semantic search quietly served stale vectors. This is the counter
 * that makes such a stretch visible in one curl.
 */
export interface EmbeddingHealth {
  runs: number;
  failures: number;
  /** Consecutive failures since the last success — the number that says "it is broken now". */
  failures_since_success: number;
  last_success_at?: string;
  last_success_repo?: string;
  last_failure_at?: string;
  last_failure_repo?: string;
  last_error?: string;
}

const MAX_ERROR_CHARS = 300;
/** One failure is a blip (a provider restart, one oversized batch); three in a row is an outage. */
const FAILURES_BEFORE_REASON = 3;

let state: EmbeddingHealth = { runs: 0, failures: 0, failures_since_success: 0 };

export function recordEmbeddingRun(repo: string, ok: boolean, error?: string): void {
  const at = new Date().toISOString();
  state.runs++;
  if (ok) {
    state.failures_since_success = 0;
    state.last_success_at = at;
    state.last_success_repo = repo;
    return;
  }
  state.failures++;
  state.failures_since_success++;
  state.last_failure_at = at;
  state.last_failure_repo = repo;
  if (error !== undefined) state.last_error = error.slice(0, MAX_ERROR_CHARS);
}

export function embeddingHealthSnapshot(): EmbeddingHealth {
  return { ...state };
}

/** A `/health` reason once embedding has failed often enough in a row to call it broken, else null. */
export function embeddingHealthReason(health: EmbeddingHealth): string | null {
  if (health.failures_since_success < FAILURES_BEFORE_REASON) return null;
  return `embeddings: ${health.failures_since_success} consecutive failed runs (last: ${health.last_error ?? "unknown"})`;
}

export function resetEmbeddingHealthForTesting(): void {
  state = { runs: 0, failures: 0, failures_since_success: 0 };
}
