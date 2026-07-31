import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";

import {
  findWorkingTree,
  isDifferentWorkingTree,
  isAnswerFromWrongTree,
  canonicalPath,
  mainCheckoutFromGitDir,
} from "../../src/utils/worktree.js";
import { resolveRepoFromCwd } from "../../src/server-helpers/repo-resolution.js";

/**
 * Built against a REAL git worktree rather than a hand-written `.git` file.
 * The bug this covers was a wrong belief about how git lays worktrees out, so a
 * fixture that encodes the same belief would have passed while the product
 * stayed broken.
 */
let base: string;
let main: string;
let linked: string;
let registryPath: string;
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
  base = realpathSync(await mkdtemp(join(tmpdir(), "codesift-wt-")));
  main = join(base, "repo");
  await mkdir(join(main, "src"), { recursive: true });
  try {
    git(main, "init", "-q", "-b", "main");
    await writeFile(join(main, "src", "a.ts"), "export const a = 1;\n");
    git(main, "add", "-A");
    git(main, "commit", "-qm", "init");
    // Exactly the layout that broke: the worktree lives UNDER the main checkout.
    linked = join(main, ".worktrees", "task-1");
    git(main, "worktree", "add", "-q", "-b", "task-1", linked);
  } catch {
    gitAvailable = false;
  }

  registryPath = join(base, "registry.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      repos: {
        "local/repo": { name: "local/repo", root: main, symbol_count: 100, file_count: 10 },
      },
      updated_at: Date.now(),
    }),
    "utf-8",
  );
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("findWorkingTree", () => {
  it("identifies the main checkout as an unlinked tree", () => {
    if (!gitAvailable) return;
    const t = findWorkingTree(join(main, "src"));
    expect(t?.root).toBe(main);
    expect(t?.linked).toBe(false);
  });

  it("identifies a linked worktree and the checkout it belongs to", () => {
    if (!gitAvailable) return;
    const t = findWorkingTree(linked);
    expect(t?.root).toBe(linked);
    expect(t?.linked).toBe(true);
    expect(t?.mainRoot).toBe(main);
  });

  it("finds the tree from a nested directory inside the worktree", async () => {
    if (!gitAvailable) return;
    const deep = join(linked, "src", "nested", "deeper");
    await mkdir(deep, { recursive: true });
    expect(findWorkingTree(deep)?.root).toBe(linked);
  });

  it("returns null outside any checkout", () => {
    expect(findWorkingTree(base)).toBeNull();
  });

  it("derives the main checkout from a gitdir path", () => {
    expect(mainCheckoutFromGitDir("/a/b/repo/.git/worktrees/task-1")).toBe("/a/b/repo");
    expect(mainCheckoutFromGitDir("/a/b/repo/.git")).toBeNull();
    expect(mainCheckoutFromGitDir("/nonsense")).toBeNull();
  });
});

describe("isDifferentWorkingTree", () => {
  it("flags a worktree answered from its parent checkout", () => {
    if (!gitAvailable) return;
    // The exact silent failure: <repo> is an ancestor of <repo>/.worktrees/task-1,
    // so ancestor matching answers with the main checkout's index.
    expect(isDifferentWorkingTree(linked, main)).toBe(true);
  });

  it("does NOT flag a subdirectory of the same checkout", () => {
    if (!gitAvailable) return;
    // A monorepo package is the same files — warning here would be pure noise
    // and would train agents to ignore the hint.
    expect(isDifferentWorkingTree(join(main, "src"), main)).toBe(false);
    expect(isDifferentWorkingTree(main, main)).toBe(false);
  });

  it("does not flag a repo root nested inside the caller's own tree", () => {
    if (!gitAvailable) return;
    expect(isDifferentWorkingTree(main, join(main, "src"))).toBe(false);
  });

  it("stays quiet for paths outside any checkout", () => {
    expect(isDifferentWorkingTree(base, main)).toBe(false);
  });
});

describe("resolveRepoFromCwd — worktree awareness", () => {
  it("still resolves the main checkout and its subdirectories", () => {
    if (!gitAvailable) return;
    expect(resolveRepoFromCwd(main, registryPath)).toBe("local/repo");
    expect(resolveRepoFromCwd(join(main, "src"), registryPath)).toBe("local/repo");
  });

  it("prefers the worktree's own index once it is registered", async () => {
    if (!gitAvailable) return;
    // Before: the ancestor rule returned local/repo even here, serving the main
    // checkout's files for a tree that has different ones.
    const withWorktree = join(base, "registry-wt.json");
    await writeFile(
      withWorktree,
      JSON.stringify({
        repos: {
          "local/repo": { name: "local/repo", root: main, symbol_count: 100, file_count: 10 },
          "local/task-1": { name: "local/task-1", root: linked, symbol_count: 90, file_count: 9 },
        },
        updated_at: Date.now(),
      }),
      "utf-8",
    );
    expect(resolveRepoFromCwd(linked, withWorktree)).toBe("local/task-1");
    expect(resolveRepoFromCwd(join(linked, "src"), withWorktree)).toBe("local/task-1");
    // The main checkout must not be dragged onto the worktree's index.
    expect(resolveRepoFromCwd(main, withWorktree)).toBe("local/repo");
  });

  it("falls back to the parent checkout when the worktree is not indexed", () => {
    if (!gitAvailable) return;
    // Kept working rather than erroring — H19 is what tells the caller the
    // answer describes another tree.
    expect(resolveRepoFromCwd(linked, registryPath)).toBe("local/repo");
    expect(isDifferentWorkingTree(linked, main)).toBe(true);
  });
});

describe("isAnswerFromWrongTree — what actually earns a warning", () => {
  it("warns for a worktree answered from its parent checkout", () => {
    if (!gitAvailable) return;
    expect(isAnswerFromWrongTree(linked, main)).toBe(true);
  });

  it("stays silent on deliberate cross-repo queries", async () => {
    if (!gitAvailable) return;
    // Asking about another project from this one is a different checkout by
    // definition. Warning there fires on every cross_repo_search and trains the
    // hint out of an agent's attention — the exact failure this narrowing
    // prevents. Caught reviewing the first cut, which warned here.
    const other = join(base, "other-repo");
    await mkdir(join(other, "src"), { recursive: true });
    git(other, "init", "-q", "-b", "main");
    expect(isDifferentWorkingTree(main, other)).toBe(true); // genuinely different
    expect(isAnswerFromWrongTree(main, other)).toBe(false); // but not a wrong-tree answer
  });

  it("stays silent for a subdirectory of the same checkout", () => {
    if (!gitAvailable) return;
    expect(isAnswerFromWrongTree(join(main, "src"), main)).toBe(false);
    expect(isAnswerFromWrongTree(main, main)).toBe(false);
  });
});

describe("canonicalPath", () => {
  it("resolves symlinked paths so both sides of a compare agree", () => {
    if (!gitAvailable) return;
    // On macOS /tmp is a symlink to /private/tmp, so a repo under a symlinked
    // path yields one spelling from the registry and another from a resolved
    // CWD — an indexed worktree would then fail to match itself.
    expect(canonicalPath("/tmp")).toBe(realpathSync("/tmp"));
    expect(canonicalPath(main)).toBe(main);
  });

  it("falls back to the resolved path for something that does not exist", () => {
    const missing = join(base, "no", "such", "dir");
    expect(canonicalPath(missing)).toBe(missing);
  });
});
