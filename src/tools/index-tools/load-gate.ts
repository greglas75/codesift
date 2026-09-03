/**
 * Cap on how many indexes are being read into memory at the same time.
 *
 * Nothing limited it. Each cold load materialises a whole index — 349 MB and hundreds of thousands
 * of objects for the largest repo here — so N concurrent first-touches allocate N times that, at
 * once, in a process with a fixed heap ceiling. Watched over a quarter of an hour on 2026-09-01 the
 * daemon's RSS moved 0.3 GB → 8 GB and then into the OOM crash-loop that left clients with no tools
 * for the rest of their sessions.
 *
 * The gate does not make loading slower in any real sense: the reads are synchronous SQLite against
 * one disk, so they were already contending — for the disk, for the heap, and for the single thread
 * that has to build the objects. Two at a time turns an invisible pile-up into a queue.
 *
 * The second thing it buys is free coalescing. A caller that waited for a slot re-checks the cache
 * before reading, so ten sessions touching the same repo at once produce ONE read and nine cache
 * hits instead of ten identical 349 MB allocations.
 */
const DEFAULT_CONCURRENCY = 2;

function configuredLimit(env: NodeJS.ProcessEnv): number {
  const raw = Number(env["CODESIFT_INDEX_LOAD_CONCURRENCY"]);
  if (Number.isFinite(raw)) return Math.floor(raw);
  return DEFAULT_CONCURRENCY;
}

let active = 0;
const waiting: Array<() => void> = [];

/**
 * Run `fn` with at most `limit` other loads in flight.
 *
 * FIFO, so the caller that has waited longest goes next: under sustained load a stack starves the
 * first arrival, which is precisely the request whose client timeout is closest to firing.
 */
export async function withIndexLoadSlot<T>(
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
    // Released in `finally` so a throwing load cannot leak the slot — a leaked slot is permanent,
    // and after `limit` of them nothing on this machine can ever load an index again.
    const next = waiting.shift();
    if (next) next();
  }
}

/** Exported for tests and for /health, which reports the queue rather than guessing at it. */
export function indexLoadGateState(): { active: number; waiting: number } {
  return { active, waiting: waiting.length };
}
