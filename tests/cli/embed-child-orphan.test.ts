import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { exitWhenOrphaned } from "../../src/cli/orphan-guard.js";

/**
 * A detached worker that outlives its parent does work nobody will read, and
 * nothing used to stop it. Measured on this machine: two orphaned
 * `embed-child` processes, left by indexing runs killed five hours earlier,
 * were still burning 360% and 340% CPU and holding 5.2 GB and 4.4 GB — 700% CPU
 * and 9.7 GB between them, which drove the load average past 600.
 *
 * The process case is driven through a real spawn/kill, because the bug was
 * that a PROCESS survived and only a process can show that. A first cut pointed
 * the child at a nonexistent index, so it exited immediately for its own
 * reasons and passed with the guard REMOVED — proving nothing. The subject is
 * now a script that would otherwise run forever.
 */
const GUARD = join(process.cwd(), "dist", "cli", "orphan-guard.js");
const CHILD = join(process.cwd(), "dist", "cli", "embed-child.js");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("orphan guard", () => {
  it("reports an orphan once the parent pid changes", async () => {
    // In-process: the decision itself, without killing the test runner.
    let seen: [number, number] | null = null;
    const stop = exitWhenOrphaned({
      pollMs: 10,
      onOrphaned: (from, now) => { seen = [from, now]; },
    });
    await sleep(60);
    stop();
    // The test runner's parent is alive and unchanged, so it must stay quiet.
    expect(seen).toBeNull();
  });

  it("kills a detached worker whose parent died", async () => {
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `const {spawn} = require("node:child_process");
         const script = "import(" + JSON.stringify(${JSON.stringify(`file://${GUARD}`)}) + ")" +
           ".then(m => { m.exitWhenOrphaned({ pollMs: 200 }); setInterval(() => {}, 1000); });";
         const c = spawn(process.execPath, ["--input-type=module", "-e", script],
           { detached: true, stdio: "ignore" });
         c.unref();
         process.stdout.write(String(c.pid));
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );

    const childPid = await new Promise<number>((resolve) => {
      parent.stdout.on("data", (d: Buffer) => resolve(Number(d.toString().trim())));
    });
    expect(Number.isInteger(childPid)).toBe(true);
    await sleep(500);
    // Without the guard this worker runs forever — that is the leak.
    expect(alive(childPid)).toBe(true);

    parent.kill("SIGKILL");

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && alive(childPid)) await sleep(200);
    expect(alive(childPid)).toBe(false);
  }, 40_000);

  it("is wired into the built embed-child entry point", () => {
    // Asserting on the identifier alone was not enough: a first cut passed with
    // the wiring commented OUT, because the comment still contained the name.
    // The import cannot be produced by a leftover comment, and the call is
    // checked on lines that are not comments.
    const built = readFileSync(CHILD, "utf-8");
    expect(built).toMatch(/import\s*\{[^}]*exitWhenOrphaned[^}]*\}\s*from\s*["'][^"']*orphan-guard/);
    const callsIt = built
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .some((line) => /(?<!\.)\bexitWhenOrphaned\s*\(/.test(line));
    expect(callsIt).toBe(true);
  });
});
