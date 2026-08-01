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
