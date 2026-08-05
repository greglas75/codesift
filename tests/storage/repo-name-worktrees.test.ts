import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getRepoName } from "../../src/storage/registry.js";

/**
 * A repo's worktrees must not collapse onto one registry name.
 *
 * The registry is keyed by name, so two roots sharing a name means the second one indexed silently
 * evicts the first. Measured on this machine: `tgm-survey-platform` has 36 worktrees, every one of
 * them carrying the same TRACKED `.codesift.json` (`{"name":"tgm-survey-platform"}`) — so 35
 * entries were being overwritten and an agent resolving by name got whichever tree registered last.
 * That is hint H19 as a permanent condition rather than a transient one.
 *
 * All three name sources collapse worktrees, which is why the disambiguation is applied to the
 * RESULT rather than to any one of them: the override file is checked out into every worktree, the
 * git remote is shared by definition, and the basename fallback collides whenever two worktrees are
 * named alike under different parents.
 */

let dir: string;

async function mainCheckout(name: string, opts?: { override?: string; origin?: string }) {
  const root = join(dir, name);
  await mkdir(join(root, ".git"), { recursive: true });
  if (opts?.origin) {
    await writeFile(
      join(root, ".git", "config"),
      `[remote "origin"]\n\turl = ${opts.origin}\n`,
      "utf-8",
    );
  }
  if (opts?.override) {
    await writeFile(join(root, ".codesift.json"), JSON.stringify({ name: opts.override }), "utf-8");
  }
  return root;
}

async function linkedWorktree(mainRoot: string, name: string, opts?: { override?: string }) {
  const root = join(dir, `wt-${name}`);
  await mkdir(root, { recursive: true });
  // A linked worktree gets a .git FILE pointing into the main checkout's worktrees dir.
  await writeFile(join(root, ".git"), `gitdir: ${mainRoot}/.git/worktrees/${name}\n`, "utf-8");
  if (opts?.override) {
    // Checked out from git, exactly like the real one — this is the collision's source.
    await writeFile(join(root, ".codesift.json"), JSON.stringify({ name: opts.override }), "utf-8");
  }
  return root;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codesift-reponame-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("getRepoName disambiguates linked worktrees", () => {
  it("keeps the main checkout's name unchanged", async () => {
    const main = await mainCheckout("proj", { origin: "git@github.com:acme/proj.git" });
    expect(getRepoName(main)).toBe("local/proj");
  });

  it("suffixes a worktree even when a TRACKED .codesift.json pins the same name", async () => {
    // The real case: the override is committed, so git checks it into every worktree, and the
    // documented "escape hatch for collisions" becomes the cause of one.
    const main = await mainCheckout("proj", { override: "proj" });
    const wt = await linkedWorktree(main, "refactor-questions-service-716", { override: "proj" });

    expect(getRepoName(main)).toBe("local/proj");
    expect(getRepoName(wt)).toBe("local/proj@refactor-questions-service-716");
    expect(getRepoName(wt)).not.toBe(getRepoName(main));
  });

  it("suffixes a worktree that inherits the name from the shared git remote", async () => {
    const main = await mainCheckout("proj", { origin: "https://github.com/acme/proj" });
    const wt = await linkedWorktree(main, "ci-docker-cache");
    expect(getRepoName(wt)).toBe("local/proj@ci-docker-cache");
  });

  it("gives every worktree of one repo a distinct name", async () => {
    const main = await mainCheckout("proj", { override: "proj" });
    const names = new Set([getRepoName(main)]);
    for (const w of ["a", "b", "c"]) {
      names.add(getRepoName(await linkedWorktree(main, w, { override: "proj" })));
    }
    // Four roots, four keys. Under the old derivation this set had exactly one member.
    expect(names.size).toBe(4);
  });

  it("leaves a submodule alone — it is a different repository, not a worktree", async () => {
    // Submodules also use a `.git` FILE, but point at `.git/modules/<name>`. Suffixing one onto
    // its parent's name would invent a relationship that does not exist.
    const main = await mainCheckout("proj", { origin: "git@github.com:acme/proj.git" });
    const sub = join(dir, "vendor-lib");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, ".git"), `gitdir: ${main}/.git/modules/vendor-lib\n`, "utf-8");

    expect(getRepoName(sub)).toBe("local/vendor-lib");
  });

  it("does not throw on a malformed .git file", async () => {
    const odd = join(dir, "odd");
    await mkdir(odd, { recursive: true });
    await writeFile(join(odd, ".git"), "this is not a gitdir pointer", "utf-8");
    expect(getRepoName(odd)).toBe("local/odd");
  });
});
