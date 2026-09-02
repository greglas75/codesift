// Who reclaims the index of a worktree that no longer exists.
//
// Until now: nobody. `prune` is a command a person types — no timer, no cron, and nothing in the
// daemon called it. Measured 2026-09-02: 267 orphaned registry entries holding 58.7 GB, and the
// data directory had gone 65 GB → 98 GB in sixteen days, about 2 GB a day. Every worktree gets its
// own index by design (answering from a sibling's tree is the failure that prevents), so a workflow
// that creates ten worktrees at a time and deletes them leaves ten indexes behind each round.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAutoPruneOnce, pruneIsDue, recordPruneRun } from "../../src/cli/auto-prune.js";

let dir: string;
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cs-autoprune-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
