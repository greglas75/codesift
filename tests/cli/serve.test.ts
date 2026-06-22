import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
    delete process.env.CODESIFT_DATA_DIR;
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("isProcessAlive: true for self, false for an impossible pid", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2147480000)).toBe(false);
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
  });

  it("refuses a second start while a live daemon holds the lock", async () => {
    const h = await startDaemon({ dataDir: dir, port: 0 });
    handles.push(h);
    await expect(startDaemon({ dataDir: dir, port: 0 })).rejects.toThrow(/already running/i);
  });

  it("reclaims a STALE pidfile (process not alive — kill -9 / OOM recovery)", async () => {
    const { pidPath, portPath } = daemonLockPaths(dir);
    writeFileSync(pidPath, "2147480000"); // impossible/dead pid
    writeFileSync(portPath, "1");
    const h = await startDaemon({ dataDir: dir, port: 0 }); // must NOT refuse — reclaim
    handles.push(h);
    expect(readDaemonLock(dir)!.pid).toBe(process.pid);
  });
});
