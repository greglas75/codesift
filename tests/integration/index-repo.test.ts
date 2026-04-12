import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { indexRepo, listAllRepos, invalidateCache } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-repo-test-"));
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();
});

afterEach(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/**
 * Creates a local bare git repo with a TypeScript file for testing.
 * Returns the file:// URL to the bare repo.
 */
async function createLocalBareRepo(): Promise<string> {
  const workDir = join(tmpDir, "work-repo");
  const bareDir = join(tmpDir, "bare-repo.git");

  await mkdir(workDir, { recursive: true });

  // Initialize a work repo and commit a file
  execSync("git init", { cwd: workDir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: workDir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: workDir, stdio: "pipe" });

  await mkdir(join(workDir, "src"), { recursive: true });
  await writeFile(
    join(workDir, "src", "hello.ts"),
    `export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

export class Greeter {
  greet(name: string): string {
    return greet(name);
  }
}
`,
  );

  execSync("git add -A", { cwd: workDir, stdio: "pipe" });
  execSync('git commit -m "initial"', { cwd: workDir, stdio: "pipe" });

  // Clone to a bare repo
  execSync(`git clone --bare "${workDir}" "${bareDir}"`, { stdio: "pipe" });

  return `file://${bareDir}`;
}

describe("index_repo integration", () => {
  it("rejects invalid git URLs", async () => {
    await expect(indexRepo("not a url")).rejects.toThrow("Invalid git URL");
    await expect(indexRepo("ftp://invalid.com/repo.git")).rejects.toThrow("Invalid git URL");
    await expect(indexRepo("")).rejects.toThrow("Invalid git URL");
  });

  it("rejects invalid branch names", async () => {
    const url = await createLocalBareRepo();
    await expect(
      indexRepo(url, { branch: "branch; rm -rf /" }),
    ).rejects.toThrow("Invalid git ref");
  });

  it("clones and indexes a local bare repo", async () => {
    const url = await createLocalBareRepo();

    const result = await indexRepo(url);

    expect(result.repo).toBe("local/bare-repo");
    expect(result.file_count).toBeGreaterThan(0);
    expect(result.symbol_count).toBeGreaterThan(0);
    expect(result.duration_ms).toBeGreaterThan(0);
  });

  it("registers the cloned repo in the registry", async () => {
    const url = await createLocalBareRepo();
    await indexRepo(url);

    const repos = await listAllRepos();
    expect(repos.some((r) => (typeof r === "string" ? r : r.name) === "local/bare-repo")).toBe(true);
  });

  it("re-indexes an already-cloned repo without error", async () => {
    const url = await createLocalBareRepo();

    // Clone + index first time
    const first = await indexRepo(url);
    // Re-clone (pulls) + re-index
    const second = await indexRepo(url);

    expect(second.symbol_count).toBe(first.symbol_count);
    expect(second.file_count).toBe(first.file_count);
  });

  it("invalidates cache for a cloned repo", async () => {
    const url = await createLocalBareRepo();
    await indexRepo(url);

    const removed = await invalidateCache("local/bare-repo");
    expect(removed).toBe(true);

    const repos = await listAllRepos();
    expect(repos.some((r) => r.name === "local/bare-repo")).toBe(false);
  });
});
