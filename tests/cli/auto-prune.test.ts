// Who reclaims the index of a worktree that no longer exists.
//
// Until now: nobody. `prune` is a command a person types — no timer, no cron, and nothing in the
// daemon called it. Measured 2026-09-02: 267 orphaned registry entries holding 58.7 GB, and the
// data directory had gone 65 GB → 98 GB in sixteen days, about 2 GB a day. Every worktree gets its
// own index by design (answering from a sibling's tree is the failure that prevents), so a workflow
// that creates ten worktrees at a time and deletes them leaves ten indexes behind each round.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// Lets one test make the stamp's read slow, as it is on a loaded host; zero (no delay) for the rest.
const stampRead = vi.hoisted(() => ({ delayMs: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  // The delay comes AFTER the read: the race is the window between reading the stamp and writing it.
  const readFile = (async (...args: Parameters<typeof real.readFile>) => {
    const settled = real.readFile(...args).then(
      (content) => ({ content }),
      (error: unknown) => ({ error }),
    );
    const result = await settled;
    if (stampRead.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, stampRead.delayMs));
    if ("error" in result) throw result.error;
    return result.content;
  }) as typeof real.readFile;
  return { ...real, readFile };
});

import {
  runAutoPruneOnce,
  pruneIsDue,
  recordPruneRun,
  scheduleAutoPrune,
  pruneLogPath,
} from "../../src/cli/auto-prune.js";

let dir: string;
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cs-autoprune-")); });
afterEach(() => {
  stampRead.delayMs = 0;
  rmSync(dir, { recursive: true, force: true });
});

function spy() {
  const calls: string[] = [];
  return { calls, spawnChild: (cli: string) => { calls.push(cli); } };
}

describe("auto-prune", () => {
  it("runs when there is no stamp yet", async () => {
    const s = spy();
    const outcome = await runAutoPruneOnce({ dataDir: dir, cliEntry: "/cli.js", env: {}, spawnChild: s.spawnChild });
    expect(outcome).toBe("ran");
    expect(s.calls).toEqual(["/cli.js"]);
  });

  it("does not run twice within the interval", async () => {
    const s = spy();
    const now = 1_000_000_000_000;
    await runAutoPruneOnce({ dataDir: dir, cliEntry: "/cli.js", env: {}, now: () => now, spawnChild: s.spawnChild });
    const second = await runAutoPruneOnce({
      dataDir: dir, cliEntry: "/cli.js", env: {}, now: () => now + DAY / 2, spawnChild: s.spawnChild,
    });
    expect(second).toBe("throttled");
    expect(s.calls).toHaveLength(1);
  });

  it("runs again after the interval", async () => {
    const s = spy();
    const now = 1_000_000_000_000;
    await runAutoPruneOnce({ dataDir: dir, cliEntry: "/cli.js", env: {}, now: () => now, spawnChild: s.spawnChild });
    const later = await runAutoPruneOnce({
      dataDir: dir, cliEntry: "/cli.js", env: {}, now: () => now + DAY + 1, spawnChild: s.spawnChild,
    });
    expect(later).toBe("ran");
    expect(s.calls).toHaveLength(2);
  });

  it("stamps BEFORE spawning, so a crash-looping daemon cannot prune on every restart", async () => {
    const now = 1_000_000_000_000;
    await runAutoPruneOnce({
      dataDir: dir, cliEntry: "/cli.js", env: {}, now: () => now,
      spawnChild: () => { throw new Error("child died"); },
    }).catch(() => undefined);
    // The stamp must exist even though the spawn blew up — that is the whole point of the ordering.
    expect(existsSync(join(dir, "last-prune.json"))).toBe(true);
    expect(await pruneIsDue(dir, now)).toBe(false);
  });

  it("treats a stamp from the future as due", async () => {
    // A clock change must not park retention until the clock catches up, which on a laptop can be
    // never — and the cost of being wrong here is one extra prune, against 58 GB of dead indexes.
    await recordPruneRun(dir, 2_000_000_000_000);
    expect(await pruneIsDue(dir, 1_000_000_000_000)).toBe(true);
  });

  it("treats an unreadable stamp as due rather than failing", async () => {
    writeFileSync(join(dir, "last-prune.json"), "{ not json");
    expect(await pruneIsDue(dir, Date.now())).toBe(true);
  });

  it("can be turned off", async () => {
    const s = spy();
    for (const value of ["0", "false"]) {
      const outcome = await runAutoPruneOnce({
        dataDir: dir, cliEntry: "/cli.js", env: { CODESIFT_AUTO_PRUNE: value }, spawnChild: s.spawnChild,
      });
      expect(outcome).toBe("disabled");
    }
    expect(s.calls).toHaveLength(0);
    expect(existsSync(join(dir, "last-prune.json"))).toBe(false);
  });

  it("writes a stamp a later run can read", async () => {
    await recordPruneRun(dir, 123456);
    expect(JSON.parse(readFileSync(join(dir, "last-prune.json"), "utf-8"))).toEqual({ at: 123456 });
  });
});

// The schedule has to RECUR, and that is a separate claim from "a sweep happens at startup".
//
// It was a lone `setTimeout`, armed once per daemon start, under a comment that said "once a day".
// `PRUNE_INTERVAL_MS` was only the throttle inside `pruneIsDue`, never a period. Measured on the
// owner's Mac 2026-10-04: data dir 99 GB, 69 indexes describing directories that no longer existed,
// holding 37.26 GB. `prune` is two-pass by construction — pass 1 unregisters a repo whose root is
// gone, pass 2 collects its artifacts — so with one sweep per process start, 61 of those 69 sat
// already-unregistered and still on disk, waiting for a pass only a restart could deliver. A manual
// two-pass run reclaimed 35.42 GB then 4.6 GB.
//
// TICK leaves the scheduler room to tick several times inside `settle()`. Overlapping ticks are
// guarded in `scheduleAutoPrune` itself, and pinned by their own test below.
const TICK = 40;
const settle = (ticks = 3): Promise<unknown> =>
  new Promise((resolve) => setTimeout(resolve, TICK * ticks));

describe("auto-prune schedule", () => {
  it("keeps checking after the first tick, so a long-lived daemon sweeps more than once", async () => {
    const s = spy();
    let clock = 1_000_000_000_000;
    const handle = scheduleAutoPrune({
      dataDir: dir, cliEntry: "/cli.js", env: {}, now: () => clock,
      spawnChild: s.spawnChild, delayMs: 1, checkIntervalMs: TICK,
    });
    try {
      await vi.waitFor(() => expect(s.calls.length).toBe(1), { timeout: 3000 });
      // Still inside the 24 h throttle: later ticks must NOT sweep again.
      clock += DAY / 2;
      await settle();
      expect(s.calls.length).toBe(1);
      // Past it: the recurring check is what notices, with no restart involved.
      clock += DAY;
      await vi.waitFor(() => expect(s.calls.length).toBe(2), { timeout: 3000 });
    } finally {
      handle.stop();
    }
  });

  it("recovers a daemon that started while the stamp was fresh", async () => {
    // The old shape returned "throttled" on its one attempt and never re-armed, so a process that
    // happened to start a few hours after a sweep did no retention for its whole life — days here.
    const s = spy();
    let clock = 1_000_000_000_000;
    await recordPruneRun(dir, clock - DAY / 4);
    const handle = scheduleAutoPrune({
      dataDir: dir, cliEntry: "/cli.js", env: {}, now: () => clock,
      spawnChild: s.spawnChild, delayMs: 1, checkIntervalMs: TICK,
    });
    try {
      await settle();
      expect(s.calls).toEqual([]); // throttled, exactly as before
      clock += DAY;
      await vi.waitFor(() => expect(s.calls.length).toBe(1), { timeout: 3000 });
    } finally {
      handle.stop();
    }
  });

  it("stop() ends the schedule, including the recurring timer that replaced the opening one", async () => {
    // Returning the opening `setTimeout` would hand back a handle that stops nothing once the first
    // tick has replaced it with the interval.
    const s = spy();
    let clock = 1_000_000_000_000;
    const handle = scheduleAutoPrune({
      dataDir: dir, cliEntry: "/cli.js", env: {}, now: () => clock,
      spawnChild: s.spawnChild, delayMs: 1, checkIntervalMs: TICK,
    });
    await vi.waitFor(() => expect(s.calls.length).toBe(1), { timeout: 3000 });
    handle.stop();
    clock += DAY * 3;
    await settle(4);
    expect(s.calls.length).toBe(1);
  });

  it("does not start a check while the previous one is still reading the stamp", async () => {
    // Bug caught: overlapping ticks. A tick that fires before the previous check has written its
    // stamp reads the OLD one, and both spawn. On a loaded host the stamp's round trip outlasts the
    // interval — the full suite on the farm failed with "expected 3 to be 2" — so here the read takes
    // 30 ticks.
    stampRead.delayMs = 30;
    const s = spy();
    const clock = 1_000_000_000_000;
    const handle = scheduleAutoPrune({
      dataDir: dir, cliEntry: "/cli.js", env: {}, now: () => clock,
      spawnChild: s.spawnChild, delayMs: 1, checkIntervalMs: 1,
    });
    try {
      await settle();
      expect(s.calls.length).toBe(1);
    } finally {
      handle.stop();
    }
  });

  it("names a log beside the stamp, so a sweep's outcome is a tail and not an investigation", () => {
    // `stdio: "ignore"` made a 35 GB reclaim and a death on one of handlePrune's die() guards leave
    // the same trace: none. On 2026-10-04 the stamp claimed a sweep nine hours earlier while 35.42 GB
    // of collectable orphans sat in the directory, and only re-running prune by hand could say which.
    expect(pruneLogPath(dir)).toBe(join(dir, "auto-prune.log"));
  });
});
