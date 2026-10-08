/**
 * Writes another PROCESS is making to an index, so this process's own writes can queue behind them.
 *
 * Out-of-process indexing (tools/index-tools/out-of-process.ts) moved the whole-index rewrite into
 * a child that holds SQLite's write lock from its first DELETE to its COMMIT. An `index_file` (or a
 * watcher event) on the same repo then waited up to `busy_timeout` — 5 s — INSIDE a synchronous
 * `node:sqlite` call, freezing the daemon's only thread, and failed with SQLITE_BUSY; and an edit
 * that did get in before the child's commit was overwritten by it. In-process the two were never
 * concurrent: the incremental write queued behind the full save. This restores that order for
 * writes made BY THIS PROCESS (the daemon's index_file and watcher), and the wait is an `await`, not
 * a lock spin, so nothing else on the thread stops.
 *
 * What it does not cover: a writer in another process — the CLI's `postindex-file` hook is a fresh
 * process per edit — still meets the child's lock through busy_timeout, as it did against an
 * in-process daemon write before; and a daemon write already in flight when a child spawns finishes
 * first, so the child is the one that waits (in its own process, starving nobody).
 *
 * Lives in storage, not beside the spawner, because the writers that must wait are storage calls
 * and storage must not import the tools layer.
 */
const pending = new Map<string, Promise<unknown>>();

/** Register `work` as an external writer of `indexPath` until it settles. */
export function trackExternalWriter(indexPath: string, work: Promise<unknown>): void {
  pending.set(indexPath, work);
  void work
    .finally(() => {
      if (pending.get(indexPath) === work) pending.delete(indexPath);
    })
    .catch(() => undefined);
}

/** Resolve once no external writer of `indexPath` is in flight. Never rejects. */
export async function awaitExternalWriter(indexPath: string): Promise<void> {
  for (let current = pending.get(indexPath); current; current = pending.get(indexPath)) {
    await current.catch(() => undefined);
    if (pending.get(indexPath) === current) return;
  }
}
