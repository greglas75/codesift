import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { runGit } from "../../src/tools/git-exec.js";

/**
 * Every git call on a tool request path used execFileSync, which stops the whole process until the
 * child exits. Harmless under stdio — one server per client — and not harmless at all in the shared
 * daemon, where it freezes every client on the machine. Sampled during a real stall: 10% of
 * main-thread time in SyncProcessRunner::Spawn, 9% parked in kevent waiting for the child.
 */
describe("runGit — git without blocking the event loop", () => {
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), "codesift-git-"));
    const opts = { cwd: dir, stdio: "pipe" as const };
    execFileSync("git", ["init", "-q"], opts);
    execFileSync("git", ["config", "user.email", "t@example.com"], opts);
    execFileSync("git", ["config", "user.name", "T"], opts);
    writeFileSync(join(dir, "a.txt"), "one\n");
    execFileSync("git", ["add", "."], opts);
    execFileSync("git", ["commit", "-qm", "first"], opts);
    return dir;
  }

  it("returns stdout as a string", async () => {
    const dir = repo();
    try {
      const out = await runGit(["log", "--pretty=format:%s"], { cwd: dir, timeout: 10_000 });
      expect(out.trim()).toBe("first");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("does NOT block the event loop while git runs", async () => {
    // The whole point. A timer scheduled before the call must fire while the child is still
    // running — under execFileSync it could not, because nothing else ran at all.
    const dir = repo();
    try {
      let timerFired = false;
      const timer = setTimeout(() => { timerFired = true; }, 1);
      const p = runGit(["log", "--pretty=format:%H"], { cwd: dir, timeout: 10_000 });
      await new Promise((r) => setImmediate(r));
      await p;
      clearTimeout(timer);
      expect(timerFired).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects with git's own message, which callers match on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codesift-git-"));
    try {
      await expect(runGit(["log"], { cwd: dir, timeout: 10_000 })).rejects.toThrow(/not a git repository/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("honours maxBuffer, so a caller can still tell 'too much history' from 'git failed'", async () => {
    const dir = repo();
    try {
      await expect(
        runGit(["log", "--pretty=format:%H %s"], { cwd: dir, timeout: 10_000, maxBuffer: 1 }),
      ).rejects.toThrow(/maxBuffer|ENOBUFS/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
