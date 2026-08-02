import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";

/**
 * A linked worktree has its OWN `.git`, so the auto-index walk stopped there and
 * every task branch looked like a brand-new repository: a full index and, far
 * more expensively, a full embedding pass over content that is usually
 * IDENTICAL to the checkout it came from.
 *
 * Measured on this machine: `backlog-wave-1-integration` had 1,799 files
 * indexed and differed from main by ZERO files; `backlog-vision-log-policy`
 * 1,792 files and 3. Across the registry, 1,585 of 1,895 entries pointed at
 * worktrees that no longer existed, holding gigabytes of embeddings for
 * directories that cannot be read.
 *
 * Driven through a real `git worktree add` rather than a fixture: the bug was a
 * wrong assumption about where `.git` lives, and a fixture encoding the same
 * assumption would pass while the product stayed broken.
 */
let base: string;
let main: string;
let linked: string;
let dataDir: string;
let gitAvailable = true;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@e",
    },
  });
}

beforeAll(async () => {
  base = realpathSync(await mkdtemp(join(tmpdir(), "cs-autoidx-")));
  dataDir = join(base, "data");
  await mkdir(dataDir, { recursive: true });
  main = join(base, "repo");
  await mkdir(join(main, "src"), { recursive: true });
  try {
    git(main, "init", "-q", "-b", "main");
    await writeFile(join(main, "src", "a.ts"), "export function alpha(): number { return 1; }\n");
    git(main, "add", "-A");
    git(main, "commit", "-qm", "init");
    linked = join(main, ".worktrees", "task-1");
    git(main, "worktree", "add", "-q", "-b", "task-1", linked);
  } catch {
    gitAvailable = false;
  }
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("auto-index and linked worktrees", () => {
  it("does not register a worktree as its own repo when the parent is indexed", async () => {
    if (!gitAvailable) return;
    vi.resetModules();
    process.env["CODESIFT_DATA_DIR"] = dataDir;

    const { indexFolder } = await import("../../src/register-tool-groups/deps.js");
    const { autoIndexCurrentRepo } = await import("../../src/tools/index-tools/registry.js");
    const { listRepos } = await import("../../src/storage/registry.js");
    const registryPath = join(dataDir, "registry.json");

    // Parent indexed the normal way.
    await indexFolder(main);
    const before = (await listRepos(registryPath)).map((r) => r.name);
    expect(before.length).toBe(1);

    // A server starting with its cwd inside the worktree.
    await autoIndexCurrentRepo(linked);

    const after = (await listRepos(registryPath)).map((r) => r.name);
    expect(after).toEqual(before); // nothing new — the parent's index covers it
  }, 120_000);

  it("indexes the PARENT when neither is indexed yet", async () => {
    if (!gitAvailable) return;
    vi.resetModules();
    const freshData = join(base, "data2");
    await mkdir(freshData, { recursive: true });
    process.env["CODESIFT_DATA_DIR"] = freshData;

    const { autoIndexCurrentRepo } = await import("../../src/tools/index-tools/registry.js");
    const { listRepos } = await import("../../src/storage/registry.js");

    // Starting cold inside the worktree: indexing the parent covers this tree
    // AND every sibling worktree, where indexing this one covers only itself.
    await autoIndexCurrentRepo(linked);

    const repos = (await listRepos(join(freshData, "registry.json"))).map((r) => r.root);
    expect(repos).toContain(main);
    expect(repos).not.toContain(linked);
  }, 120_000);

  it("still indexes an ordinary checkout", async () => {
    if (!gitAvailable) return;
    vi.resetModules();
    const freshData = join(base, "data3");
    await mkdir(freshData, { recursive: true });
    process.env["CODESIFT_DATA_DIR"] = freshData;

    const { autoIndexCurrentRepo } = await import("../../src/tools/index-tools/registry.js");
    const { listRepos } = await import("../../src/storage/registry.js");

    await autoIndexCurrentRepo(main);
    const repos = (await listRepos(join(freshData, "registry.json"))).map((r) => r.root);
    expect(repos).toContain(main);
  }, 120_000);
});
