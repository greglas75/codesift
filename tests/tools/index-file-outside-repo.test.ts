// index_file was the noisiest tool in the telemetry: 147 errors in 801 calls over three days
// (18.4%), every one with an empty `repo` field. Two very different situations shared one throw.
//
// The PostToolUse hook fires after EVERY Write/Edit an agent makes — scratchpads, notes under
// ~/.claude, anything in /tmp. Those are not in a repository and never should be, so a tool FAILURE
// is simply the wrong answer: nothing was asked for and nothing is broken. Reporting it as one
// teaches agents to distrust a tool that is working, which is what the CODESIFT UNAVAILABLE banners
// were partly built on.
//
// A file inside a real git checkout that nobody indexed is the opposite: the index is going stale
// under an agent that believes it is current. That stays an error, and now names the exact call.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { indexFile } from "../../src/tools/index-tools/file-indexer.js";
import { resetConfigCache } from "../../src/config.js";

let dataDir: string;
let prevData: string | undefined;
let plain: string;
let checkout: string;

beforeEach(() => {
  prevData = process.env["CODESIFT_DATA_DIR"];
  dataDir = mkdtempSync(join(tmpdir(), "cs-outside-data-"));
  process.env["CODESIFT_DATA_DIR"] = dataDir;
  resetConfigCache();

  plain = mkdtempSync(join(tmpdir(), "cs-plain-"));
  writeFileSync(join(plain, "scratch.ts"), "export const scratch = 1;\n");

  checkout = mkdtempSync(join(tmpdir(), "cs-checkout-"));
  mkdirSync(join(checkout, "src"), { recursive: true });
  writeFileSync(join(checkout, "src", "app.ts"), "export function app(): void {}\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: checkout, stdio: "pipe" });
});

afterEach(() => {
  if (prevData === undefined) delete process.env["CODESIFT_DATA_DIR"];
  else process.env["CODESIFT_DATA_DIR"] = prevData;
  resetConfigCache();
  for (const d of [dataDir, plain, checkout]) rmSync(d, { recursive: true, force: true });
});

describe("index_file on a path no repo contains", () => {
  it("is not a failure when the path is in no git checkout at all", async () => {
    const result = await indexFile(join(plain, "scratch.ts"));

    expect(result.skipped).toBe(true);
    expect(result.outside_indexed_repos).toBe(true);
    expect(result.symbol_count).toBe(0);
  });

  it("still fails, and names the exact call, inside an unindexed checkout", async () => {
    // Silence here would be the dangerous answer: the agent keeps editing, the index keeps not
    // updating, and searches answer from whatever tree IS indexed.
    await expect(indexFile(join(checkout, "src", "app.ts"))).rejects.toThrow(
      /index_folder\(path="/,
    );
    await expect(indexFile(join(checkout, "src", "app.ts"))).rejects.toThrow(/FIRST index/);
  });

  it("treats a linked worktree as a checkout — its .git is a FILE, not a directory", async () => {
    // This is the case the whole distinction exists for, and an isDirectory() test would miss it.
    // The file has to be COMMITTED, or the worktree checks out a tree without it and the test
    // fails on a missing fixture rather than on the behaviour it is about.
    execFileSync("git", ["add", "src/app.ts"], { cwd: checkout, stdio: "pipe" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q",
      "-m", "init"], { cwd: checkout, stdio: "pipe" });
    const wt = join(checkout, "..", `wt-${Date.now()}`);
    execFileSync("git", ["worktree", "add", "-q", "-b", "side", wt], { cwd: checkout, stdio: "pipe" });
    try {
      await expect(indexFile(join(wt, "src", "app.ts"))).rejects.toThrow(/not indexed/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
