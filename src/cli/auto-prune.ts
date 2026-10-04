import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Retention for indexes whose repository is gone.
 *
 * Nothing was reclaiming them. `prune` exists, and it is a command a person has to type — no timer,
 * no cron, nothing in the daemon called it. Measured 2026-09-02: 267 orphaned registry entries had
 * accumulated holding **58.7 GB**, and the data directory had gone 65 GB → 98 GB in sixteen days,
 * about 2 GB a day. Every worktree gets its own index by design (answering from a sibling's tree is
 * the H19 failure this prevents), so a workflow that creates ten worktrees at a time and deletes
 * them leaves ten indexes behind each round.
 *
 * Run in a DETACHED CHILD, never in-process. `handlePrune` reaches `die()` on each of its safety
 * guards — unreadable registry, zero repos, every entry stale — and `die` ends the process. In the
 * daemon that would turn a refused prune into a dead server for every client on the machine.
 *
 * The child is also why this needs no LaunchAgent: the maintenance lives in the product, is
 * versioned with it and is covered by its tests, rather than in a plist nobody edits again.
 */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Long enough that the first clients are served before any maintenance competes with them. */
const PRUNE_START_DELAY_MS = 5 * 60 * 1000;

/**
 * How often the daemon ASKS whether a sweep is due — not how often it sweeps. `pruneIsDue` owns the
 * 24 h throttle, so this only has to be fine enough that "due" is noticed promptly.
 *
 * It exists because the schedule used to be a single `setTimeout`, fired once per daemon start, and
 * that is not a daily sweep whatever the comment said. Two consequences, both measured on this Mac
 * 2026-10-04 (data dir 99 GB, 69 indexes for directories that no longer existed, holding 37.26 GB —
 * 38% of the directory):
 *
 *   - **A long-lived daemon swept once.** `prune` is two-pass by construction: pass 1 unregisters a
 *     repo whose root is gone, pass 2 collects its artifacts. With one sweep per process start, pass
 *     2 needed a SECOND start a day later — so 61 of those 69 sat already-unregistered and still on
 *     disk, waiting for a run that only a restart could bring. Reclaimed in two passes minutes
 *     apart: 35.42 GB then 4.6 GB.
 *   - **A daemon that started while the stamp was fresh never swept at all.** The one attempt
 *     returned `throttled`, nothing re-armed, and that process was done with retention for its
 *     entire life — days, on this machine.
 *
 * Hourly, so the 24 h boundary is crossed within the hour rather than at the mercy of a restart.
 */
const PRUNE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

function stampPath(dataDir: string): string {
  return join(dataDir, "last-prune.json");
}

/** Where a sweep's own `--json` result lands, so "did it run" is a `tail`, not an investigation. */
export function pruneLogPath(dataDir: string): string {
  return join(dataDir, "auto-prune.log");
}

export async function pruneIsDue(
  dataDir: string,
  now: number,
  intervalMs: number = PRUNE_INTERVAL_MS,
): Promise<boolean> {
  try {
    const raw = await readFile(stampPath(dataDir), "utf-8");
    const at = (JSON.parse(raw) as { at?: unknown }).at;
    if (typeof at !== "number" || !Number.isFinite(at)) return true;
    // A stamp in the FUTURE means a clock change, not a prune five hours from now. Treating it as
    // "not due" would park retention until the clock caught up, which on a laptop can be never.
    if (at > now) return true;
    return now - at >= intervalMs;
  } catch {
    // No stamp yet, or unreadable — due. Erring towards running is right: the failure this exists
    // to prevent is 58 GB of dead indexes, and prune's own guards refuse anything ambiguous.
    return true;
  }
}

export async function recordPruneRun(dataDir: string, now: number): Promise<void> {
  try {
    await writeFile(stampPath(dataDir), JSON.stringify({ at: now }), "utf-8");
  } catch {
    // A stamp that cannot be written means the next start prunes again. Wasteful, not harmful —
    // and far better than failing a daemon start over a maintenance bookkeeping file.
  }
}

export interface AutoPruneOptions {
  dataDir: string;
  cliEntry: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Injected in tests; production spawns a detached child. */
  spawnChild?: (cliEntry: string) => void;
}

export async function runAutoPruneOnce(options: AutoPruneOptions): Promise<
  "ran" | "throttled" | "disabled"
> {
  const env = options.env ?? process.env;
  if (env["CODESIFT_AUTO_PRUNE"] === "0" || env["CODESIFT_AUTO_PRUNE"] === "false") {
    return "disabled";
  }
  const now = (options.now ?? Date.now)();
  if (!(await pruneIsDue(options.dataDir, now))) return "throttled";

  // Stamp BEFORE spawning, still. A prune that crashes must not re-run on every restart of a
  // crash-looping daemon — that is how a maintenance task becomes the outage. The cost is that a
  // failed sweep consumes its day; with the schedule below actually recurring, the next day's tick
  // retries, which is why this stays as it is rather than moving to an outcome stamp.
  await recordPruneRun(options.dataDir, now);

  if (options.spawnChild) {
    options.spawnChild(options.cliEntry);
    return "ran";
  }
  // The child's output goes to a LOG, not to `stdio: "ignore"`.
  //
  // Ignoring it made the outcome unobservable: a sweep that collected 35 GB and a sweep that died on
  // one of `handlePrune`'s `die()` guards left exactly the same trace, which is none. On 2026-10-04
  // the stamp said a sweep had run nine hours earlier while 35.42 GB of collectable orphans sat in
  // the directory, and there was no way to tell which of the two had happened — the question had to
  // be answered by re-running prune by hand. One `--json` object per run answers it for free.
  let out: number | undefined;
  try {
    out = openSync(pruneLogPath(options.dataDir), "a");
  } catch {
    // A log that cannot be opened must not cost the sweep. Fall back to the old behaviour.
    out = undefined;
  }
  try {
    const child = spawn(process.execPath, [options.cliEntry, "prune", "--json"], {
      detached: true,
      stdio: out === undefined ? "ignore" : ["ignore", out, out],
    });
    child.unref();
  } finally {
    // The child holds its own duplicate of the descriptor; ours would otherwise leak once per sweep.
    if (out !== undefined) {
      try { closeSync(out); } catch { /* already closed */ }
    }
  }
  return "ran";
}

/**
 * Schedule the sweep after the daemon is serving, and KEEP asking. Never awaited, never blocks a
 * request.
 *
 * Returns a handle with `stop()`, because the schedule outlives any single timer: the opening delay
 * is one timer and the recurring check is another. Returning the first one — which is what this did
 * while it was a lone `setTimeout` — would hand back a handle that stops nothing once the first tick
 * has replaced it. The daemon ignores the handle; both timers are unref'd, so a process told to exit
 * exits regardless.
 */
export function scheduleAutoPrune(
  options: AutoPruneOptions & { delayMs?: number; checkIntervalMs?: number },
): { stop: () => void } {
  const check = (): void => {
    void runAutoPruneOnce(options).catch(() => {
      // Maintenance is best-effort by construction: the next tick tries again.
    });
  };
  let interval: NodeJS.Timeout | undefined;
  const opening = setTimeout(() => {
    check();
    // Re-arm from inside the first tick rather than alongside it, so the opening delay is not also
    // the phase of the recurring timer — otherwise a 5 min start delay would put every later check
    // 5 min after the hour for no reason.
    interval = setInterval(check, options.checkIntervalMs ?? PRUNE_CHECK_INTERVAL_MS);
    // Must not hold the process open — a daemon told to exit should exit.
    interval.unref();
  }, options.delayMs ?? PRUNE_START_DELAY_MS);
  opening.unref();
  return {
    stop: () => {
      clearTimeout(opening);
      if (interval !== undefined) clearInterval(interval);
    },
  };
}
