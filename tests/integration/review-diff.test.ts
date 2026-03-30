/**
 * Integration smoke test for review_diff.
 *
 * Creates a real git repo in a tmpdir, indexes it, and runs reviewDiff
 * end-to-end without any mocks.
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { indexFolder } from "../../src/tools/index-tools.js";
import { reviewDiff } from "../../src/tools/review-diff-tools.js";
import { resetConfigCache } from "../../src/config.js";
import { resetSecretCache } from "../../src/tools/secret-tools.js";

let tmpDir: string;
let fixtureDir: string;
let repoName: string;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: fixtureDir,
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@test.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@test.com" },
  });
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-review-diff-"));
  fixtureDir = join(tmpDir, "review-project");
  await mkdir(join(fixtureDir, "src"), { recursive: true });

  // Isolate codesift data
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();
  resetSecretCache();

  // --- First commit: initial file ---
  git("init", "-b", "main");
  await writeFile(
    join(fixtureDir, "src", "example.ts"),
    `export function greet(name: string): string {
  console.log("greeting");
  return "Hello, " + name;
}
`,
  );
  git("add", ".");
  git("commit", "-m", "initial commit");

  // --- Second commit: modify the file ---
  await writeFile(
    join(fixtureDir, "src", "example.ts"),
    `export function greet(name: string): string {
  console.log("greeting");
  return "Hello, " + name;
}

export function farewell(name: string): string {
  console.log("farewell");
  return "Goodbye, " + name;
}
`,
  );
  git("add", ".");
  git("commit", "-m", "add farewell function");

  // Index the repo
  await indexFolder(fixtureDir, { watch: false });
  repoName = `local/${basename(fixtureDir)}`;
});

afterAll(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  resetSecretCache();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("review_diff integration", () => {
  it("returns valid structure for a real diff", async () => {
    const result = await reviewDiff(repoName, {
      repo: repoName,
      since: "HEAD~1",
    });

    // Core structure
    expect(result.verdict).toBeTypeOf("string");
    expect(["pass", "warn", "fail"]).toContain(result.verdict);
    expect(result.score).toBeTypeOf("number");
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.diff_stats.files_changed).toBe(1);
    expect(Array.isArray(result.checks)).toBe(true);
    expect(result.checks.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(result.findings)).toBe(true);
    expect(result.duration_ms).toBeTypeOf("number");
    expect(result.duration_ms).toBeGreaterThan(0);

    // No error field on success
    expect(result.error).toBeUndefined();

    // Serializes to valid JSON without truncation
    const json = JSON.stringify(result);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("returns pass with score 100 for empty diff", async () => {
    const result = await reviewDiff(repoName, {
      repo: repoName,
      since: "HEAD",
    });

    expect(result.verdict).toBe("pass");
    expect(result.score).toBe(100);
    expect(result.diff_stats.files_changed).toBe(0);
    expect(result.checks).toHaveLength(0);
    expect(result.findings).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });
});
