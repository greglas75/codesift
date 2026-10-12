// The breaking-change check against a real git repository: what `git show` does with a large old
// file and with a ref that does not resolve cannot be reproduced through a mocked execFileSync.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkBreakingChanges } from "../../src/tools/review-diff/checks/breaking.js";

let repo: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf-8" });
const indexWith = (names: string[]) => ({
  symbolsInFile: async () => names.map((name) => ({ name, parent: undefined })) as never,
});

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "breaking-git-"));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("checkBreakingChanges on a real repository", () => {
  // Bug it catches: git show of a file over 1 MB overflowed Node's default buffer, the check read
  // that as "new file", and the removed export went unreported.
  it("reports an export removed from a file larger than 1 MB", async () => {
    const filler = `// ${"x".repeat(100)}\n`.repeat(12_000); // ~1.2 MB
    writeFileSync(join(repo, "big.ts"), `export function kept() {}\nexport function removed() {}\n${filler}`);
    git("add", ".");
    git("commit", "-qm", "one");

    const result = await checkBreakingChanges(indexWith(["kept"]), repo, ["big.ts"], "HEAD", "HEAD");

    expect(result.status).toBe("fail");
    expect(result.findings.map((f) => f.symbol)).toEqual(["removed"]);
  });

  // Bug it catches: any git failure (a bad ref, a timeout) was read as "new file" and passed.
  it("errors on a ref that does not resolve instead of passing", async () => {
    writeFileSync(join(repo, "a.ts"), "export function a() {}\n");
    git("add", ".");
    git("commit", "-qm", "one");

    const result = await checkBreakingChanges(indexWith([]), repo, ["a.ts"], "no-such-ref", "HEAD");

    expect(result.status).toBe("error");
  });

  it("still skips a file that did not exist at the base ref", async () => {
    writeFileSync(join(repo, "a.ts"), "export function a() {}\n");
    git("add", ".");
    git("commit", "-qm", "one");
    writeFileSync(join(repo, "b.ts"), "export function b() {}\n");
    git("add", ".");
    git("commit", "-qm", "two");

    const result = await checkBreakingChanges(indexWith(["b"]), repo, ["b.ts"], "HEAD~1", "HEAD");

    expect(result.status).toBe("pass");
  });
});
