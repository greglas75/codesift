// The breaking-change check against a real git repository: what `git show` does with a large old
// file and with a ref that does not resolve cannot be reproduced through a mocked execFileSync.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkBreakingChanges } from "../../src/tools/review-diff/checks/breaking.js";
import type { ReviewIndex } from "../../src/tools/review-diff/review-index.js";
import type { CodeSymbol } from "../../src/types.js";

let repo: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf-8" });
const symbol = (name: string): CodeSymbol => ({
  id: `r:f.ts:${name}:1`, repo: "r", name, kind: "function", file: "f.ts", start_line: 1, end_line: 1,
});
const indexWith = (names: string[]): Pick<ReviewIndex, "symbolsInFile"> => ({
  symbolsInFile: async () => names.map(symbol),
});

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "breaking-git-"));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  // Independent of the machine's git config: no signing, no hooks.
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
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
    expect(result.summary).toContain("a.ts");
  });

  // Bug it catches: one file git cannot read discarded what the other files found.
  it("keeps the findings of readable files when another file cannot be read", async () => {
    writeFileSync(join(repo, "a.ts"), "export function kept() {}\nexport function removed() {}\n");
    git("add", ".");
    git("commit", "-qm", "one");
    git("tag", "base");
    git("rm", "-q", "a.ts");
    writeFileSync(join(repo, "a.ts"), "export function kept() {}\n");
    git("add", ".");
    git("commit", "-qm", "two");

    // A path outside the repository: git refuses it ("outside repository"), which is not "absent".
    const result = await checkBreakingChanges(indexWith(["kept"]), repo, ["a.ts", "../outside.ts"], "base", "HEAD");

    expect(result.findings.map((f) => f.symbol)).toEqual(["removed"]);
    expect(result.summary).toContain("outside.ts");
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
