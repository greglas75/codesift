/**
 * The daemon's startup trace.
 *
 * Why it exists: on 2026-09-24 a `launchctl load` left the process alive with NO listening socket
 * for 9+ minutes, and the log held nothing between launch and the first served request. Locating it
 * took `sample <pid>` and reading V8 frames — for a service whose own log file was open the whole
 * time. These lines are the difference between "it hangs somewhere" and "it hangs after `config`".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startDaemon, type DaemonHandle } from "../../src/cli/commands-daemon.js";

let dir: string;
let handle: DaemonHandle | undefined;
let stderr: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codesift-boot-trace-"));
  stderr = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  if (handle) {
    try { await handle.close(); } catch { /* the test may already have closed it */ }
    handle = undefined;
  }
  vi.restoreAllMocks();
  delete process.env["CODESIFT_DAEMON_BOOT_TRACE"];
  await rm(dir, { recursive: true, force: true });
});

function traceLines(): string[] {
  return stderr.filter((l) => l.includes("[codesift] boot +"));
}

describe("daemon boot trace", () => {
  it("names each startup stage, in order, with an elapsed reading", async () => {
    // port 0 → the OS picks a free one, so this never collides with a real daemon on 7077.
    handle = await startDaemon({ dataDir: dir, port: 0, host: "127.0.0.1" });
    const lines = traceLines();
    const stages = lines.map((l) => l.replace(/^.*boot \+\d+ms /, ""));

    expect(stages[0]).toBe("config");
    expect(stages[1]).toBe("lock acquired");
    expect(stages[2]).toBe("server module imported");
    // The one that proves the port is open — its absence is the signature of the outage.
    expect(stages[3]).toBe(`listening on ${handle.port}`);
    for (const l of lines) expect(l).toMatch(/boot \+\d+ms /);
  });

  it("measures from process start, not from entry to startDaemon", async () => {
    // A clock started inside startDaemon reported a healthy few hundred ms while the real delay —
    // minutes of ESM module evaluation — had already happened before it ran.
    const before = Math.round(process.uptime() * 1000);
    handle = await startDaemon({ dataDir: dir, port: 0, host: "127.0.0.1" });
    const first = traceLines()[0];
    const elapsed = Number(/boot \+(\d+)ms/.exec(first ?? "")?.[1]);
    expect(elapsed).toBeGreaterThanOrEqual(before);
  });

  it("can be switched off", async () => {
    process.env["CODESIFT_DAEMON_BOOT_TRACE"] = "0";
    handle = await startDaemon({ dataDir: dir, port: 0, host: "127.0.0.1" });
    expect(traceLines()).toEqual([]);
  });
});
