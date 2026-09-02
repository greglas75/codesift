import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import type { Flags } from "./args.js";
import type { HttpServerHandle } from "../server.js";
import { getFlag, getNumFlag, output, die } from "./args.js";
import { scheduleAutoPrune } from "./auto-prune.js";
import { loadConfig } from "../config.js";
import { fileURLToPath } from "node:url";

/** Default daemon port — clients point here via `setup --http`. */
export const DEFAULT_DAEMON_PORT = 7077;

export type DaemonHandle = HttpServerHandle;

/** Lockfile paths for the daemon in a given data dir (~/.codesift). */
export function daemonLockPaths(dataDir: string): { pidPath: string; portPath: string } {
  return { pidPath: join(dataDir, "daemon.pid"), portPath: join(dataDir, "daemon.port") };
}

/**
 * True if a process with `pid` is alive. `process.kill(pid, 0)` sends no signal
 * but performs the permission/existence check: ESRCH = dead, EPERM = alive but
 * owned by another user (still alive).
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read the current daemon lock, or null if absent/unparseable. */
export function readDaemonLock(dataDir: string): { pid: number; port: number } | null {
  const { pidPath, portPath } = daemonLockPaths(dataDir);
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    const port = parseInt(readFileSync(portPath, "utf-8").trim(), 10);
    if (!Number.isInteger(pid) || !Number.isInteger(port)) return null;
    return { pid, port };
  } catch {
    return null;
  }
}

function readDaemonPid(pidPath: string): number | null {
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Acquire the daemon lock and start the shared HTTP server.
 *
 * Refuses if another daemon holds the dedicated SQLite transaction lock. The
 * OS releases that lock on kill -9/OOM/crash, so stale pid metadata can never
 * wedge restart and no read-then-unlink race can create two owners.
 *
 * `close()` removes the lockfiles, so a graceful SIGTERM leaves a clean slate.
 */
export async function startDaemon(
  opts: { dataDir?: string; port?: number; host?: string; token?: string } = {},
): Promise<DaemonHandle> {
  const { loadConfig } = await import("../config.js");
  const dataDir = opts.dataDir ?? loadConfig().dataDir;
  const { pidPath, portPath } = daemonLockPaths(dataDir);

  mkdirSync(dataDir, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const lockDb = new DatabaseSync(join(dataDir, "daemon-lock.db"));
  try {
    lockDb.exec("PRAGMA busy_timeout = 0; CREATE TABLE IF NOT EXISTS daemon_lock (id INTEGER PRIMARY KEY);");
    lockDb.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    try { lockDb.close(); } catch { /* preserve the lock error */ }
    const existing = readDaemonLock(dataDir);
    const detail = existing ? ` (pid ${existing.pid}, port ${existing.port})` : "";
    throw new Error(`codesift serve already running or starting${detail}. Stop it first.`, { cause: error });
  }

  const release = (): void => {
    if (readDaemonPid(pidPath) === process.pid) {
      try { unlinkSync(pidPath); } catch { /* already gone */ }
      try { unlinkSync(portPath); } catch { /* already gone */ }
    }
    try { lockDb.exec("ROLLBACK"); } catch { /* already released */ }
    try { lockDb.close(); } catch { /* already closed */ }
  };

  let handle: HttpServerHandle | undefined;
  try {
    // PID and port are metadata only. Holding the SQLite transaction is the
    // ownership proof, so stale or malformed files are safe to overwrite.
    writeFileSync(pidPath, String(process.pid));
    try { unlinkSync(portPath); } catch { /* stale or absent */ }

    const { startHttpServer } = await import("../server.js");
    const httpOpts: { port?: number; host?: string; token?: string } = {};
    if (opts.port !== undefined) httpOpts.port = opts.port;
    if (opts.host !== undefined) httpOpts.host = opts.host;
    if (opts.token !== undefined) httpOpts.token = opts.token;
    handle = await startHttpServer(httpOpts);
    writeFileSync(portPath, String(handle.port));

    const origClose = handle.close;
    return {
      ...handle,
      close: async () => {
        try {
          await origClose();
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* preserve the startup error */ }
    }
    release();
    throw error;
  }
}

/**
 * `codesift serve` — boot the shared daemon and stay alive until SIGTERM/SIGINT.
 */
async function handleServe(_args: string[], flags: Flags): Promise<void> {
  const port = getNumFlag(flags, "port") ?? DEFAULT_DAEMON_PORT;
  const host = getFlag(flags, "host");
  let handle: DaemonHandle;
  try {
    handle = await startDaemon({ port, ...(host ? { host } : {}) });
  } catch (e) {
    die(`serve: ${(e as Error).message}`);
    return;
  }
  output(
    { status: "serving", url: handle.url, port: handle.port, pid: process.pid },
    flags,
  );

  // Reclaim indexes whose repository is gone. Only the daemon does this — it is the one
  // long-lived process per machine, so a stdio server per session would run it N times over.
  scheduleAutoPrune({
    dataDir: loadConfig().dataDir,
    cliEntry: fileURLToPath(new URL("../cli.js", import.meta.url)),
  });
  const shutdown = (): void => {
    void handle.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export { handleServe };
