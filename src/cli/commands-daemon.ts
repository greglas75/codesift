import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import type { Flags } from "./args.js";
import type { HttpServerHandle } from "../server.js";
import { getFlag, getNumFlag, output, die } from "./args.js";

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

/**
 * Acquire the daemon lock and start the shared HTTP server.
 *
 * Refuses if a LIVE daemon already holds the lock (single-instance). A STALE
 * lock (pid no longer alive — kill -9, OOM, crash) is reclaimed so the daemon
 * can always restart; without this, a crashed daemon would wedge the lock and
 * coworkers would fall back to per-window stdio = the original OOM incident.
 *
 * `close()` removes the lockfiles, so a graceful SIGTERM leaves a clean slate.
 */
export async function startDaemon(
  opts: { dataDir?: string; port?: number; host?: string; token?: string } = {},
): Promise<DaemonHandle> {
  const { loadConfig } = await import("../config.js");
  const dataDir = opts.dataDir ?? loadConfig().dataDir;
  const { pidPath, portPath } = daemonLockPaths(dataDir);

  const existing = readDaemonLock(dataDir);
  if (existing && isProcessAlive(existing.pid)) {
    throw new Error(
      `codesift serve already running (pid ${existing.pid}, port ${existing.port}). Stop it first.`,
    );
  }

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(pidPath, String(process.pid));

  const { startHttpServer } = await import("../server.js");
  const httpOpts: { port?: number; host?: string; token?: string } = {};
  if (opts.port !== undefined) httpOpts.port = opts.port;
  if (opts.host !== undefined) httpOpts.host = opts.host;
  if (opts.token !== undefined) httpOpts.token = opts.token;
  const handle = await startHttpServer(httpOpts);
  writeFileSync(portPath, String(handle.port));

  const release = (): void => {
    try { unlinkSync(pidPath); } catch { /* already gone */ }
    try { unlinkSync(portPath); } catch { /* already gone */ }
  };
  const origClose = handle.close;
  return {
    ...handle,
    close: async () => {
      release();
      await origClose();
    },
  };
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
  const shutdown = (): void => {
    void handle.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export { handleServe };
