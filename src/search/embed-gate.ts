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

/*
 * The same cap, MACHINE-wide (2026-10-11).
 *
 * The counter above is per process, and the daemon embeds each repo in its own child process. With
 * Ollama back after an outage it started eight children at once — every rdesigner worktree that had
 * never finished — so eight processes × four slots put ~30 requests in front of a server that
 * embeds one text at a time. Measured: p50 14.7 s and p90 31 s per request, timeouts, halving, and
 * a 463k-symbol pass that stopped at 18,688 vectors. Each process obeyed the cap; the machine did
 * not have one.
 *
 * So a slot is also a lock FILE in `<dataDir>/embed-slots/` (file-lock.ts: pid-named, taken over
 * from a dead owner), and a request runs only while holding one of `limit` of them. Waiting happens
 * here, before `fn` starts its own timeout, so queueing never counts against a request.
 * `CODESIFT_EMBED_MACHINE_GATE=0` turns this layer off.
 */
const MACHINE_SLOT_POLL_MS = { first: 50, max: 1_000 };

async function acquireMachineSlot(limit: number, slotDir: string): Promise<string> {
  const { mkdir } = await import("node:fs/promises");
  const { acquireLock } = await import("../storage/file-lock.js");
  await mkdir(slotDir, { recursive: true });
  let delay = MACHINE_SLOT_POLL_MS.first;
  for (;;) {
    for (let i = 0; i < limit; i++) {
      const path = `${slotDir}/slot-${i}.lock`;
      if ((await acquireLock(path)).held) return path;
    }
    // Jittered so waiting processes do not retry in lockstep.
    await new Promise((resolve) => setTimeout(resolve, delay * (0.5 + Math.random())));
    delay = Math.min(delay * 2, MACHINE_SLOT_POLL_MS.max);
  }
}

async function defaultSlotDir(): Promise<string | null> {
  try {
    const { loadConfig } = await import("../config.js");
    return `${loadConfig().dataDir}/embed-slots`;
  } catch (err) {
    gateUnavailable(err);
    return null;
  }
}

let gateUnavailableReported = false;
/** Said once per process: without it a gate that never engages looks exactly like one that works. */
function gateUnavailable(err: unknown): null {
  if (!gateUnavailableReported) {
    gateUnavailableReported = true;
    console.error(
      `[codesift] machine-wide embedding gate unavailable (${err instanceof Error ? err.message : String(err)}) — ` +
      "only this process's cap applies",
    );
  }
  return null;
}

/**
 * Run `fn` with at most `limit` others — in this process, and across every process on the machine.
 *
 * FIFO within a process, so a batch that has waited longest goes next — a stack would starve the
 * first arrival under sustained load, which is exactly the caller whose timeout is closest to firing.
 */
export async function withEmbedSlot<T>(
  fn: () => Promise<T>,
  options?: { env?: NodeJS.ProcessEnv; slotDir?: string },
): Promise<T> {
  const env = options?.env ?? process.env;
  const limit = configuredLimit(env);
  if (limit <= 0) return fn();

  if (active >= limit) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active++;
  let machineSlot: string | null = null;
  try {
    if (env["CODESIFT_EMBED_MACHINE_GATE"] !== "0") {
      // A gate that cannot be set up (no data dir, unwritable) must not stop embedding: the
      // in-process cap still holds.
      const slotDir = options?.slotDir ?? (await defaultSlotDir());
      if (slotDir) machineSlot = await acquireMachineSlot(limit, slotDir).catch(gateUnavailable);
    }
    return await fn();
  } finally {
    try {
      if (machineSlot) {
        const { releaseLock } = await import("../storage/file-lock.js");
        await releaseLock(machineSlot).catch(() => undefined);
      }
    } finally {
      // Unconditionally: a release that threw must not leak this process's slot, or every later
      // request waits forever behind one that is gone.
      active--;
      // Release in arrival order. `shift()` on an array this short costs nothing, and the ordering
      // is the property that matters.
      const next = waiting.shift();
      if (next) next();
    }
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
