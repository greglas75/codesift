// Bug it catches: the walker ignoring .gitignore. On rdesigner 80% of the index (1,147,279 of
// 1,429,034 symbols) came from gitignored copies of the source under zuvo/.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walkDirectory } from "../../src/utils/walk.js";
import { gitIgnoredFrom, resetGitIgnoredCacheForTesting } from "../../src/utils/walk/gitignore.js";

describe("gitIgnoredFrom", () => {
  const ignored = gitIgnoredFrom(["zuvo/", "a/b/", "notes.log", "deep/x.ts", ""]);
  it.each([
    ["a file under an ignored directory", "zuvo/recovery/src/app.ts", true],
    ["the ignored directory itself", "zuvo", true],
    ["a nested ignored directory", "a/b/c/d.ts", true],
    ["its unignored parent", "a/other.ts", false],
    ["an ignored file", "notes.log", true],
    ["a listed file only", "deep/x.ts", true],
    ["its sibling", "deep/y.ts", false],
    ["a name that only starts like an ignored directory", "zuvo-tools/x.ts", false],
    ["a Windows separator", "zuvo\\recovery\\x.ts", true],
  ])("%s", (_case, path, expected) => {
    expect(ignored.isIgnored(path)).toBe(expected);
  });
});

describe("walkDirectory and .gitignore", () => {
  let dir: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-walk-gi-"));
    resetGitIgnoredCacheForTesting();
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "zuvo", "recovery"), { recursive: true });
    writeFileSync(join(dir, "src", "app.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "src", "debug.log.ts"), "export const kept = 1;\n");
    writeFileSync(join(dir, "zuvo", "recovery", "copy.ts"), "export const copy = 1;\n");
    writeFileSync(join(dir, "src", "scratch.tmp.ts"), "export const tmp = 1;\n");
    writeFileSync(join(dir, ".gitignore"), "zuvo/\n*.tmp.ts\n*.log.ts\n");
  });
  afterEach(() => {
    delete process.env["CODESIFT_RESPECT_GITIGNORE"];
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips what git ignores, but not a tracked file that matches a pattern", async () => {
    git("init", "-q");
    git("add", "-f", "src/debug.log.ts", "src/app.ts", ".gitignore");
    const files = (await walkDirectory(dir, { relative: true })).sort();
    expect(files).toEqual([".gitignore", "src/app.ts", "src/debug.log.ts"]);
  });

  it("indexes everything when CODESIFT_RESPECT_GITIGNORE=0", async () => {
    git("init", "-q");
    process.env["CODESIFT_RESPECT_GITIGNORE"] = "0";
    const files = await walkDirectory(dir, { relative: true });
    expect(files).toContain("zuvo/recovery/copy.ts");
  });

  it("leaves a directory outside any git checkout alone", async () => {
    const files = await walkDirectory(dir, { relative: true });
    expect(files).toContain("zuvo/recovery/copy.ts");
  });
});
