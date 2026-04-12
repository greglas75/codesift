/**
 * Tests for git-based auto-refresh (ensureIndexFresh).
 *
 * Creates temp git repos, makes commits, and verifies that
 * the index is transparently refreshed on tool access.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { indexFolder, ensureIndexFresh, resetFreshnessCache, getCodeIndex } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";

let tmpDir: string;
let repoDir: string;
let repoName: string;

async function createGitRepo(): Promise<void> {
  repoDir = join(tmpDir, "test-repo");
  await mkdir(repoDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });

  // Initial file + commit
  await writeFile(join(repoDir, "hello.ts"), "export function hello(): string { return 'hi'; }\n");
  execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
}

function makeCommit(filename: string, content: string, message: string): void {
  const { writeFileSync } = require("node:fs");
  writeFileSync(join(repoDir, filename), content);
  execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", message], { cwd: repoDir, stdio: "pipe" });
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-refresh-"));
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();
  resetFreshnessCache();
});

afterEach(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  resetFreshnessCache();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("ensureIndexFresh", () => {
  it("returns 'fresh' when index matches current HEAD", async () => {
    await createGitRepo();
    const result = await indexFolder(repoDir, { watch: false });
    repoName = result.repo;

    const status = await ensureIndexFresh(repoName);
    expect(status.status).toBe("fresh");
  });

  it("returns 'refreshed' and reindexes when new commit exists", async () => {
    await createGitRepo();
    const result = await indexFolder(repoDir, { watch: false });
    repoName = result.repo;

    // Verify initial state — only hello.ts
    let index = await getCodeIndex(repoName);
    expect(index).not.toBeNull();
    const initialSymbols = index!.symbols.map(s => s.name);
    expect(initialSymbols).toContain("hello");
    expect(initialSymbols).not.toContain("goodbye");

    // Make a new commit with new function
    resetFreshnessCache();
    makeCommit("goodbye.ts", "export function goodbye(): string { return 'bye'; }\n", "add goodbye");

    // ensureIndexFresh should detect the change
    resetFreshnessCache();
    const status = await ensureIndexFresh(repoName);
    expect(status.status).toBe("refreshed");
    expect(status.files_updated).toBeGreaterThan(0);

    // Verify new symbol is in index
    index = await getCodeIndex(repoName);
    const updatedSymbols = index!.symbols.map(s => s.name);
    expect(updatedSymbols).toContain("goodbye");
  });

  it("throttles checks within FRESHNESS_INTERVAL_MS", async () => {
    await createGitRepo();
    const result = await indexFolder(repoDir, { watch: false });
    repoName = result.repo;

    // First check — runs git
    const status1 = await ensureIndexFresh(repoName);
    expect(status1.status).toBe("fresh");

    // Second check within 60s — throttled, returns fresh without git
    const status2 = await ensureIndexFresh(repoName);
    expect(status2.status).toBe("fresh");
  });

  it("returns 'skipped' for non-git directories", async () => {
    const plainDir = join(tmpDir, "plain-project");
    await mkdir(plainDir, { recursive: true });
    await writeFile(join(plainDir, "app.ts"), "export const x = 1;\n");

    const result = await indexFolder(plainDir, { watch: false });
    repoName = result.repo;

    resetFreshnessCache();
    const status = await ensureIndexFresh(repoName);
    expect(status.status).toBe("skipped");
  });

  it("returns 'skipped' for unknown repo", async () => {
    const status = await ensureIndexFresh("local/nonexistent");
    expect(status.status).toBe("skipped");
  });

  it("handles deleted files gracefully", async () => {
    await createGitRepo();
    const result = await indexFolder(repoDir, { watch: false });
    repoName = result.repo;

    // Commit a file then delete it in next commit
    makeCommit("temp.ts", "export const temp = 1;\n", "add temp");
    execFileSync("git", ["rm", "temp.ts"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "remove temp"], { cwd: repoDir, stdio: "pipe" });

    resetFreshnessCache();
    // Should not throw — deleted file is skipped
    const status = await ensureIndexFresh(repoName);
    expect(status.status).toBe("refreshed");
  });

  it("resets throttle with resetFreshnessCache", async () => {
    await createGitRepo();
    const result = await indexFolder(repoDir, { watch: false });
    repoName = result.repo;

    await ensureIndexFresh(repoName);

    // Make new commit
    makeCommit("new.ts", "export const n = 2;\n", "add new");

    // Without reset — throttled, won't detect change
    const throttled = await ensureIndexFresh(repoName);
    expect(throttled.status).toBe("fresh"); // still throttled

    // After reset — detects change
    resetFreshnessCache();
    const refreshed = await ensureIndexFresh(repoName);
    expect(refreshed.status).toBe("refreshed");
  });
});

describe("getCodeIndex with auto-refresh", () => {
  it("transparently refreshes index on query after new commit", async () => {
    await createGitRepo();
    const result = await indexFolder(repoDir, { watch: false });
    repoName = result.repo;

    // Add new file via commit
    makeCommit("world.ts", "export function world(): number { return 42; }\n", "add world");
    resetFreshnessCache();

    // getCodeIndex should auto-refresh and return updated index
    const index = await getCodeIndex(repoName);
    expect(index).not.toBeNull();
    const names = index!.symbols.map(s => s.name);
    expect(names).toContain("world");
  });
});
