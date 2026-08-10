import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  startDaemon,
  readDaemonLock,
  isProcessAlive,
  daemonLockPaths,
  type DaemonHandle,
} from "../../src/cli/commands.js";
import { resetConfigCache } from "../../src/config.js";

describe("codesift serve — daemon lock + health (Task 7)", () => {
  let dir: string;
  let handles: DaemonHandle[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "serve-"));
    handles = [];
    process.env.CODESIFT_DATA_DIR = dir;
    resetConfigCache();
  });
  afterEach(async () => {
    for (const h of handles) await h.close().catch(() => {});
    vi.restoreAllMocks();
    delete process.env.CODESIFT_DATA_DIR;
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("isProcessAlive: true for self, false for an impossible pid", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2147480000)).toBe(false);
  });

  it("isProcessAlive rejects non-positive PIDs and treats EPERM as alive", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);

    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    expect(isProcessAlive(4242)).toBe(true);
    expect(kill).toHaveBeenCalledWith(4242, 0);
  });

  it("readDaemonLock rejects a partially malformed lock", () => {
    const { pidPath, portPath } = daemonLockPaths(dir);
    writeFileSync(pidPath, "not-a-pid");
    writeFileSync(portPath, "7077");
    expect(readDaemonLock(dir)).toBeNull();
  });

  it("writes daemon.pid + daemon.port, serves /health, close removes the lock", async () => {
    const h = await startDaemon({ dataDir: dir, port: 0 });
    handles.push(h);
    const lock = readDaemonLock(dir);
    expect(lock).not.toBeNull();
    expect(lock!.pid).toBe(process.pid);
    expect(lock!.port).toBe(h.port);

    const res = await fetch(`http://127.0.0.1:${h.port}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");

    await h.close();
    handles.length = 0;
    expect(readDaemonLock(dir)).toBeNull();
    const { pidPath, portPath } = daemonLockPaths(dir);
    expect(existsSync(pidPath)).toBe(false);
    expect(existsSync(portPath)).toBe(false);
  });

  it("refuses a second start while a live daemon holds the lock", async () => {
    const h = await startDaemon({ dataDir: dir, port: 0 });
    handles.push(h);
    await expect(startDaemon({ dataDir: dir, port: 0 })).rejects.toThrow(/already running/i);
  });

  it("atomically rejects one of two concurrent starters", async () => {
    const [first, second] = await Promise.allSettled([
      startDaemon({ dataDir: dir, port: 0 }),
      startDaemon({ dataDir: dir, port: 0 }),
    ]);
    const fulfilled = [first, second].filter((r): r is PromiseFulfilledResult<DaemonHandle> => r.status === "fulfilled");
    const rejected = [first, second].filter((r) => r.status === "rejected");
    handles.push(...fulfilled.map((r) => r.value));

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it("allows only one winner when concurrent starters reclaim the same stale lock", async () => {
    const { pidPath, portPath } = daemonLockPaths(dir);
    writeFileSync(pidPath, "2147480000");
    writeFileSync(portPath, "1");

    const results = await Promise.allSettled([
      startDaemon({ dataDir: dir, port: 0 }),
      startDaemon({ dataDir: dir, port: 0 }),
    ]);
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<DaemonHandle> => r.status === "fulfilled");
    handles.push(...fulfilled.map((r) => r.value));

    expect(fulfilled).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("reclaims a STALE pidfile (process not alive — kill -9 / OOM recovery)", async () => {
    const { pidPath, portPath } = daemonLockPaths(dir);
    writeFileSync(pidPath, "2147480000"); // impossible/dead pid
    writeFileSync(portPath, "1");
    const h = await startDaemon({ dataDir: dir, port: 0 }); // must NOT refuse — reclaim
    handles.push(h);
    expect(readDaemonLock(dir)!.pid).toBe(process.pid);
  });

  it("releases the SQLite ownership lock so the daemon can restart cleanly", async () => {
    const first = await startDaemon({ dataDir: dir, port: 0 });
    await first.close();

    const second = await startDaemon({ dataDir: dir, port: 0 });
    handles.push(second);
    expect(readDaemonLock(dir)?.port).toBe(second.port);
  });
});
