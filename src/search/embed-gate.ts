/**
 * Cap on how many embedding requests are in flight at once.
 *
 * Nothing limited them, and the remote does: `OLLAMA_NUM_PARALLEL=4` on the tailnet host this
 * machine embeds against. So the daemon fired unbounded concurrent batches at a server that serves
 * four, everything past the fourth queued until it exceeded the client's timeout, and
 * `embedBatchWithStallRetry` answered each timeout by splitting the batch in two — producing MORE
 * requests against the same queue. That is a congestion collapse we cause ourselves, and it is what
 * filled `daemon.err.log` with hundreds of `embed batch of N stalled … retrying as N/2+N/2` lines
 * and left the daemon unable to answer /health for fifteen minutes after a restart.
 *
 * A gate does not make embedding slower: the work was already serialised by the remote. It makes
 * the QUEUE visible to us instead of hidden behind timeouts, so a batch waits rather than failing
 * and multiplying.
 *
 * Default 4 to match the common Ollama setting. `CODESIFT_EMBED_CONCURRENCY` overrides it — a
 * bigger GPU host or a hosted provider can take more, and a value of 0 or less disables the gate
 * for callers who know their provider is unmetered.
 */
const DEFAULT_CONCURRENCY = 4;

function configuredLimit(env: NodeJS.ProcessEnv): number {
  const raw = Number(env["CODESIFT_EMBED_CONCURRENCY"]);
  if (Number.isFinite(raw)) return Math.floor(raw);
  return DEFAULT_CONCURRENCY;
}

let active = 0;
const waiting: Array<() => void> = [];

/**
 * Run `fn` with at most `limit` others.
 *
 * FIFO, so a batch that has waited longest goes next — a stack would starve the first arrival under
 * sustained load, which is exactly the caller whose timeout is closest to firing.
 */
export async function withEmbedSlot<T>(
  fn: () => Promise<T>,
  options?: { env?: NodeJS.ProcessEnv },
): Promise<T> {
  const limit = configuredLimit(options?.env ?? process.env);
  if (limit <= 0) return fn();

  if (active >= limit) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    // Release in arrival order. `shift()` on an array this short costs nothing, and the ordering is
    // the property that matters.
    const next = waiting.shift();
    if (next) next();
  }
}

/** Tests need to observe the gate rather than infer it from timing. */
export function embedGateStateForTesting(): { active: number; waiting: number } {
  return { active, waiting: waiting.length };
}

/** Tests need a clean slate between cases. */
export function resetEmbedGateForTesting(): void {
  active = 0;
  waiting.length = 0;
}
