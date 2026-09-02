// Which index the seed copies FROM.
//
// It used to be the parent checkout, unconditionally, and that is wrong for how these worktrees get
// made. Measured 2026-09-02 on tgm-survey-platform: the main checkout sat on
// `chore/stryker-native-mutation-setup`, 5,324 files away from develop. Every worktree cut from
// develop had to rewrite 5,044 files, blew the catch-up ceiling and fell back to a full index —
// 216 s median, 9,490 s at the tail.
//
// The workload is what makes it more than one bad choice: ten worktrees are created at once from
// the SAME develop commit. The first pays a full index; the other nine are byte-identical to it and
// each paid their own, because the only donor ever considered was on an unrelated branch.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pickSeedDonor } from "../../src/tools/index-tools/worktree-seed.js";
import { registerRepo } from "../../src/storage/registry.js";
import { sqlitePathFor } from "../../src/storage/index-store.js";

const HEAD = "a".repeat(40);
const PARENT_COMMIT = "b".repeat(40);

let dir: string;
let registryPath: string;

function indexPathFor(name: string): string {
  return join(dir, `${name}.index.json`);
}

/** A donor is only usable if its database actually exists, so the fixture creates one. */
async function register(name: string, commit: string | undefined, withDb = true): Promise<string> {
  const index_path = indexPathFor(name);
  if (withDb) writeFileSync(sqlitePathFor(index_path), "");
  await registerRepo(registryPath, {
    name,
    root: join(dir, name),
    index_path,
    ...(commit !== undefined ? { last_git_commit: commit } : {}),
  } as never);
  return index_path;
}

const parentEntry = () => ({
  root: join(dir, "parent"),
  index_path: indexPathFor("parent"),
  last_git_commit: PARENT_COMMIT,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cs-donor-"));
  registryPath = join(dir, "registry.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("pickSeedDonor", () => {
  it("prefers a sibling already indexed at the same commit", async () => {
    // The ten-at-once case: the first worktree indexed becomes a perfect donor for the rest.
    await register("parent", PARENT_COMMIT);
    await register("sibling", HEAD);

    const donor = await pickSeedDonor(registryPath, "parent", parentEntry(), HEAD);

    expect(donor.name).toBe("sibling");
    expect(donor.sameCommit).toBe(true);
    // The catch-up diffs from whatever commit is recorded here, so it must be the DONOR's — the
    // parent's would make the seed describe a state the copied content is not in.
    expect(donor.commit).toBe(HEAD);
  });

  it("uses the parent when the parent is itself at that commit", async () => {
    await register("parent", HEAD);
    const donor = await pickSeedDonor(
      registryPath, "parent", { ...parentEntry(), last_git_commit: HEAD }, HEAD,
    );
    expect(donor.name).toBe("parent");
    expect(donor.sameCommit).toBe(true);
  });

  it("falls back to the parent when no sibling matches", async () => {
    await register("parent", PARENT_COMMIT);
    await register("sibling", "c".repeat(40));

    const donor = await pickSeedDonor(registryPath, "parent", parentEntry(), HEAD);

    expect(donor.name).toBe("parent");
    expect(donor.sameCommit).toBe(false);
    expect(donor.commit).toBe(PARENT_COMMIT);
  });

  it("ignores a matching sibling whose database is missing", async () => {
    // A registry row is not an index. Copying from a path that is not there would fail after the
    // decision, where the parent was available all along.
    await register("parent", PARENT_COMMIT);
    await register("ghost", HEAD, false);

    const donor = await pickSeedDonor(registryPath, "parent", parentEntry(), HEAD);

    expect(donor.name).toBe("parent");
  });

  it("falls back to the parent when this tree's HEAD is unknown", async () => {
    await register("parent", PARENT_COMMIT);
    await register("sibling", HEAD);

    const donor = await pickSeedDonor(registryPath, "parent", parentEntry(), null);

    expect(donor.name).toBe("parent");
    expect(donor.sameCommit).toBe(false);
  });
});
