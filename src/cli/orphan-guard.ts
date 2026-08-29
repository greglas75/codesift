import { existsSync as existsSyncRef } from "node:fs";

/**
 * Exit when the process that spawned us goes away.
 *
 * A detached worker whose parent has died is doing work nobody will read.
 * Measured on this machine: two orphaned `embed-child` processes, left behind
 * by indexing runs killed five hours earlier, were still burning 360% and 340%
 * CPU and holding 5.2 GB and 4.4 GB — 700% CPU and 9.7 GB between them, which
 * is what drove the load average past 600. Nothing stopped them because nothing
 * was watching.
 *
 * `server.ts` guards its own process this way already; the CLI's workers did
 * not. This lives in its own module so the guard can be exercised as a real
 * process without importing a worker's side effects.
 *
 * Polls `process.ppid` rather than watching a pipe: these workers are spawned
 * DETACHED, so there is no pipe, and reparenting to launchd/init (ppid 1) is
 * the signal — the same on macOS and Linux.
 */

/** How often to check. Long enough to be free, short enough to bound the leak. */
export const PARENT_POLL_MS = 5_000;

export interface OrphanGuardOptions {
  /** Override for tests; production uses PARENT_POLL_MS. */
  pollMs?: number;
  /** Injected so a test can observe the decision instead of dying. */
  onOrphaned?: (startingPpid: number, currentPpid: number) => void;
}

/**
 * Start watching. Returns a stop function.
 *
 * The timer is `unref`'d: the point is fewer lingering processes, so the guard
 * must never be the thing that keeps one alive.
 */
export function exitWhenOrphaned(options: OrphanGuardOptions = {}): () => void {
  const startingPpid = process.ppid;
  const onOrphaned =
    options.onOrphaned ??
    ((from: number, now: number): void => {
      process.stderr.write(
        `[codesift] parent ${from} gone (now ${now}) — exiting rather than orphaning\n`,
      );
      process.exit(0);
    });

  const timer = setInterval(() => {
    const ppid = process.ppid;
    if (ppid === startingPpid && ppid > 1) return;
    onOrphaned(startingPpid, ppid);
  }, options.pollMs ?? PARENT_POLL_MS);
  timer.unref();

  const stopOnSignal = (): void => process.exit(0);
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, stopOnSignal);
  }

  return () => {
    clearInterval(timer);
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.off(sig, stopOnSignal);
    }
  };
}

/** How often to check the source tree. Same reasoning as PARENT_POLL_MS: free, and bounds the leak. */
export const ROOT_POLL_MS = 10_000;

export interface RootGuardOptions {
  pollMs?: number;
  /** Injected so a test can observe the decision instead of dying. */
  onGone?: (rootPath: string) => void;
  /** Injected for tests; production uses node:fs existsSync. */
  exists?: (path: string) => boolean;
}

/**
 * Exit when the tree being indexed disappears underneath us.
 *
 * The orphan guard above cannot catch this. Measured 2026-08-29: an agent created a worktree,
 * `codesift index .` started, the worktree was then removed — and embedding ran for **1 hour 10
 * minutes at 813% CPU and 4.9 GB**, producing a 365 MB index of a directory that no longer existed.
 * Its parent was alive the whole time, so the ppid check had nothing to report; the parent was
 * simply working on nothing.
 *
 * Deliberately checks only the ROOT, not individual files. A file vanishing mid-run is ordinary —
 * a build, a branch switch, a formatter. The root vanishing means the work has no subject left.
 */
export function exitWhenRootGone(
  rootPath: string,
  options: RootGuardOptions = {},
): () => void {
  const exists = options.exists ?? existsSyncRef;
  const onGone =
    options.onGone ??
    ((root: string): void => {
      process.stderr.write(
        `[codesift] ${root} no longer exists — stopping rather than embedding a tree that is gone\n`,
      );
      process.exit(0);
    });

  const timer = setInterval(() => {
    if (exists(rootPath)) return;
    onGone(rootPath);
  }, options.pollMs ?? ROOT_POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
