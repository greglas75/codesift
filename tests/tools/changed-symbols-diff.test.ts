// changed_symbols(include_diff) against a real repository: what git does with a large diff cannot be
// reproduced through a mock.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexFolder, stopAllWatchersForTesting } from "../../src/tools/index-tools.js";
import { changedSymbols } from "../../src/tools/diff-tools.js";
import { resetConfigCache } from "../../src/config.js";

const REPO = "local/changed-diff";
let tmpDir: string;
let root: string;

function git(...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    stdio: "ignore",
  });
}

const bigFile = (marker: string) =>
  `export function big(): string {\n  return "${marker}";\n}\n${`// ${marker.repeat(100)}\n`.repeat(1_000)}`;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-changed-diff-"));
  root = join(tmpDir, "changed-diff");
  await mkdir(root, { recursive: true });
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();

  await writeFile(join(root, "big.ts"), bigFile("a"));
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "one");
  // Every line changes: the per-file diff is ~200 KB, past the 50 KB buffer the read had.
  await writeFile(join(root, "big.ts"), bigFile("b"));
  git("add", ".");
  git("commit", "-q", "-m", "two");

  await indexFolder(root, { watch: false });
});

afterAll(async () => {
  stopAllWatchersForTesting();
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("changedSymbols include_diff", () => {
  // Bug it catches: git's output overflowed a 50 KB maxBuffer, the read threw, and a file with a
  // large diff came back as `diff: null` instead of its truncated diff.
  it("returns the truncated diff of a file whose diff exceeds 50 KB", async () => {
    const [entry] = await changedSymbols(REPO, "HEAD~1", "HEAD", { include_diff: true });

    expect(entry?.file).toBe("big.ts");
    expect(entry?.diff).toContain("diff --git a/big.ts b/big.ts");
    expect(entry?.diff).toMatch(/\.\.\. \(truncated\)$/);
  });
});
