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
  /** Consecutive failures across all repos since the last success anywhere — a provider outage. */
  failures_since_success: number;
  last_success_at?: string;
  last_success_repo?: string;
  last_failure_at?: string;
  last_failure_repo?: string;
  last_error?: string;
  /** Repos failing in a row while others succeed — a per-repo fault the global streak resets. */
  failing_repos: Record<string, { consecutive: number; last_error?: string }>;
}

const MAX_ERROR_CHARS = 300;
/** One failure is a blip (a provider restart, one oversized batch); three in a row is an outage. */
const FAILURES_BEFORE_ALERT = 3;
/** The daemon outlives every session; the per-repo map must not grow with every repo it ever saw. */
const MAX_FAILING_REPOS = 50;

function fresh(): EmbeddingHealth {
  return { runs: 0, failures: 0, failures_since_success: 0, failing_repos: {} };
}

let state: EmbeddingHealth = fresh();

/** One line, bounded: provider errors carry HTTP bodies and stack traces. */
function cleanError(error: string): string {
  const printable = Array.from(error, (c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? " " : c)).join("");
  return printable.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_CHARS);
}

export function recordEmbeddingRun(repo: string, ok: boolean, error?: string): void {
  const at = new Date().toISOString();
  state.runs++;
  if (ok) {
    state.failures_since_success = 0;
    state.last_success_at = at;
    state.last_success_repo = repo;
    delete state.failing_repos[repo];
    return;
  }
  const message = error === undefined ? undefined : cleanError(error);
  state.failures++;
  state.failures_since_success++;
  state.last_failure_at = at;
  state.last_failure_repo = repo;
  if (message !== undefined) state.last_error = message;

  const previous = state.failing_repos[repo];
  delete state.failing_repos[repo]; // re-insert last, so the oldest entry is the first key
  state.failing_repos[repo] = {
    consecutive: (previous?.consecutive ?? 0) + 1,
    ...(message !== undefined ? { last_error: message } : {}),
  };
  const repos = Object.keys(state.failing_repos);
  if (repos.length > MAX_FAILING_REPOS) delete state.failing_repos[repos[0]!];
}

export function embeddingHealthSnapshot(): EmbeddingHealth {
  const failing: EmbeddingHealth["failing_repos"] = {};
  for (const [repo, entry] of Object.entries(state.failing_repos)) failing[repo] = { ...entry };
  return { ...state, failing_repos: failing };
}

/**
 * What to alert on, or null: a provider outage (three failures in a row anywhere) or repos that keep
 * failing while others succeed. Reported inside the `embeddings` block, not in `/health`'s top-level
 * `reasons` — those mean "not ok", and BM25 and every tool still work.
 */
export function embeddingHealthAlert(health: EmbeddingHealth): string | null {
  if (health.failures_since_success >= FAILURES_BEFORE_ALERT) {
    return `${health.failures_since_success} consecutive failed runs (last: ${health.last_error ?? "unknown"})`;
  }
  const repos = Object.entries(health.failing_repos).filter(([, e]) => e.consecutive >= FAILURES_BEFORE_ALERT);
  if (repos.length === 0) return null;
  return `failing repeatedly: ${repos.map(([repo, e]) => `${repo} ×${e.consecutive}`).join(", ")}`;
}

export function resetEmbeddingHealthForTesting(): void {
  state = fresh();
}
