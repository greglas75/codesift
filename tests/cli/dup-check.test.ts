/**
 * `codesift dup-check` end to end on a throwaway git repository with a real index: the exit codes
 * are what pre-push hooks act on, so each case asserts the code and the line a human would read.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetConfigCache } from "../../src/config.js";
import { indexFolder } from "../../src/tools/index-tools.js";
import { runDupCheckCommand } from "../../src/cli/commands-dup-check.js";

const ORIGINAL = `export function sumEvens(values: number[]): number {
  const items: number[] = [];
  for (const v of values) {
    if (v % 2 === 0) {
      items.push(v * 10);
    } else {
      items.push(v * 5);
    }
  }
  const filtered = items.filter((x) => x > 50);
  const mapped = filtered.map((x) => x + 1);
  const reduced = mapped.reduce((a, b) => a + b, 0);
  console.log("total", reduced);
  const capped = Math.min(reduced, 1000);
  return Math.round(capped);
}
`;
const COPY = ORIGINAL.replace("sumEvens", "sumOdds");
const UNRELATED = `export function greet(name: string): string {
  return "hello " + name;
}
`;

const dirs: string[] = [];

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
}

/** A repo on `main` with `src/a.ts` committed; indexed unless `index` is false. */
async function makeRepo(index = true): Promise<string> {
  // Its own basename per repo: the registry is keyed by a name derived from it, so a shared
  // basename would make an unindexed repo resolve to an earlier test's index.
  const repo = await mkdtemp(join(tmpdir(), "codesift-dup-check-"));
  dirs.push(repo);
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src/a.ts"), ORIGINAL);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "checkout", "-q", "-b", "feature");
  if (index) {
    resetConfigCache();
    await indexFolder(repo, { watch: false });
  }
  return repo;
}

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("codesift dup-check", () => {
  it("exits 0 when the branch adds no copy", async () => {
    // Bug caught: the original function itself (unchanged on the branch) was reported as a clone.
    const repo = await makeRepo();
    await writeFile(join(repo, "src/b.ts"), UNRELATED);
    git(repo, "add", "src/b.ts");
    git(repo, "commit", "-q", "-m", "unrelated");
    const out = await runDupCheckCommand({ base: "main" }, repo);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("0 duplicate(s)");
  });

  it("exits 1 and names both functions when a committed file copies existing code", async () => {
    // Bug caught: committed changes were missed because only the working tree was diffed against HEAD.
    const repo = await makeRepo();
    await writeFile(join(repo, "src/b.ts"), COPY);
    git(repo, "add", "src/b.ts");
    git(repo, "commit", "-q", "-m", "copy");
    const out = await runDupCheckCommand({ base: "main" }, repo);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toMatch(/NEW src\/b\.ts:1 sumOdds ≈ EXISTING src\/a\.ts:1 sumEvens \(similarity 0\.\d\d, \d+ shared lines\)/);
    expect(out.stdout).toContain("codesift-dup-ok: <reason>");
  });

  it("exits 1 for a copy in an untracked file", async () => {
    // Bug caught: `git diff` never lists untracked files, so a brand-new file escaped the gate.
    const repo = await makeRepo();
    await writeFile(join(repo, "src/c.ts"), COPY);
    const out = await runDupCheckCommand({ base: "main", json: true }, repo);
    expect(out.exitCode).toBe(1);
    const result = JSON.parse(out.stdout) as { findings: Array<{ new: { file: string }; existing: { file: string } }> };
    expect(result.findings.map((f) => [f.new.file, f.existing.file])).toEqual([["src/c.ts", "src/a.ts"]]);
  });

  it.each<{ name: string; strict: boolean; exitCode: number }>([
    // Bug caught: a hook on an unindexed repo blocked every push instead of warning.
    { name: "warns and exits 0 without --strict", strict: false, exitCode: 0 },
    // Bug caught: --strict let an unindexed repo pass a gate that was never run.
    { name: "exits 2 with --strict", strict: true, exitCode: 2 },
  ])("missing index: $name", async ({ strict, exitCode }) => {
    const repo = await makeRepo(false);
    const out = await runDupCheckCommand(strict ? { base: "main", strict: true } : { base: "main" }, repo);
    expect(out.exitCode).toBe(exitCode);
    expect(out.stderr).toContain("not indexed — run `codesift index <root>`");
  });

  it("exits 2 on an unknown base ref", async () => {
    // Bug caught: a typo in --base surfaced as an uncaught git error with exit 1, read as "duplicates".
    const repo = await makeRepo(false);
    const out = await runDupCheckCommand({ base: "no-such-ref" }, repo);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("unknown base ref: no-such-ref");
  });
});
