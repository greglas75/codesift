import { spawn } from "node:child_process";
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

function stampPath(dataDir: string): string {
  return join(dataDir, "last-prune.json");
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

  // Stamp BEFORE spawning. A prune that crashes must not re-run on every restart of a
  // crash-looping daemon — that is how a maintenance task becomes the outage.
  await recordPruneRun(options.dataDir, now);

  if (options.spawnChild) {
    options.spawnChild(options.cliEntry);
    return "ran";
  }
  const child = spawn(process.execPath, [options.cliEntry, "prune", "--json"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return "ran";
}

/** Schedule the sweep after the daemon is serving. Never awaited, never blocks a request. */
export function scheduleAutoPrune(options: AutoPruneOptions & { delayMs?: number }): NodeJS.Timeout {
  const timer = setTimeout(() => {
    void runAutoPruneOnce(options).catch(() => {
      // Maintenance is best-effort by construction: the next start tries again.
    });
  }, options.delayMs ?? PRUNE_START_DELAY_MS);
  // Must not hold the process open — a daemon told to exit should exit.
  timer.unref();
  return timer;
}
