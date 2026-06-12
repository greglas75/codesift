import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  indexFolder,
  stopAllWatchersForTesting,
  resetIndexFolderRedundancyForTesting,
} from "../../src/tools/index-tools.js";

/** Write `count` parseable TS files under root/dir. */
async function writeTsFiles(root: string, dir: string, count: number): Promise<void> {
  await mkdir(join(root, dir), { recursive: true });
  for (let i = 0; i < count; i++) {
    await writeFile(
      join(root, dir, `mod${i}.ts`),
      `export function fn${i}(): number { return ${i}; }\n`,
    );
  }
}

describe("indexFolder sanity check (partial-index rejection + auto-heal)", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    resetIndexFolderRedundancyForTesting();
    tmpRoot = await mkdtemp(join(tmpdir(), "idx-sanity-"));
  });

  afterEach(async () => {
    await stopAllWatchersForTesting();
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("merge-persists an explicitly-scoped walk instead of rejecting the whole index", async () => {
    // T7 amended the pre-existing contract: a scoped (include_paths) walk no
    // longer rejects the whole index when it covers fewer files than before —
    // it MERGES (out-of-scope files preserved, in-scope refreshed). Rejection is
    // reserved for genuine in-scope under-enumeration (covered by the
    // index-folder-snapshot suite's (m)/(g) cases). [POST-CAP: SPEC-AMENDED]
    await writeTsFiles(tmpRoot, "src", 60);
    const first = await indexFolder(tmpRoot, { watch: false });
    expect(first.status).toBeUndefined();
    expect(first.file_count).toBe(60);

    // Scope the re-index to a new subdir holding 5 files (prefix match, mirrors
    // walkDirectory's startsWith semantics).
    await writeTsFiles(tmpRoot, "tiny", 5);
    const second = await indexFolder(tmpRoot, {
      watch: false,
      include_paths: ["tiny"],
    });

    // Not rejected — the 60 out-of-scope src/ files are preserved and the 5
    // in-scope tiny/ files are merged in (65 total), never clobbered.
    expect(second.status).toBeUndefined();
    expect(second.file_count).toBe(65);
  });

  it("auto-heals when most of the old index's files no longer exist on disk", async () => {
    // Baseline: 60 files in a tree that will be deleted (worktree-style junk).
    await writeTsFiles(tmpRoot, "old-worktrees/feature", 60);
    await writeTsFiles(tmpRoot, "src", 5);
    const first = await indexFolder(tmpRoot, { watch: false });
    expect(first.file_count).toBe(65);

    // The junk tree disappears — the honest walk now finds only src (5 < 50%
    // of 65). Pre-fix this deadlocked: every reindex was rejected forever.
    await rm(join(tmpRoot, "old-worktrees"), { recursive: true, force: true });
    const second = await indexFolder(tmpRoot, { watch: false });

    expect(second.status).toBeUndefined();
    expect(second.file_count).toBe(5);

    // And the healed index is now the baseline for subsequent runs.
    const third = await indexFolder(tmpRoot, { watch: false });
    expect(third.status).toBeUndefined();
    expect(third.file_count).toBe(5);
  });
});
