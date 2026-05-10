import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  indexFolder,
  stopAllWatchersForTesting,
  resetIndexFolderRedundancyForTesting,
} from "../../src/tools/index-tools.js";

describe("indexFolder redundancy short-circuit", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    resetIndexFolderRedundancyForTesting();
    tmpRoot = await mkdtemp(join(tmpdir(), "idx-redundant-"));
    await mkdir(join(tmpRoot, "src"), { recursive: true });
    await writeFile(
      join(tmpRoot, "src/foo.ts"),
      "export function foo(): number { return 1; }\n",
    );
  });

  afterEach(async () => {
    await stopAllWatchersForTesting();
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("short-circuits a second indexFolder call while the watcher is active", async () => {
    const first = await indexFolder(tmpRoot);
    expect(first.status).toBeUndefined(); // first call ran the full scan
    expect(first.file_count).toBeGreaterThan(0);

    const second = await indexFolder(tmpRoot);
    expect(second.status).toBe("skipped");
    expect(second.reason).toMatch(/watcher active/);
    expect(second.last_indexed).toBeDefined();
    expect(second.hint).toMatch(/force=true/);
    // Skipped runs report zero work — they didn't walk the tree.
    expect(second.file_count).toBe(0);
    expect(second.symbol_count).toBe(0);
  });

  it("force=true bypasses the short-circuit", async () => {
    await indexFolder(tmpRoot);
    const forced = await indexFolder(tmpRoot, { force: true });
    expect(forced.status).toBeUndefined();
    expect(forced.file_count).toBeGreaterThan(0);
  });

  it("watch=false runs do not engage the short-circuit (no watcher to reuse)", async () => {
    const first = await indexFolder(tmpRoot, { watch: false });
    expect(first.status).toBeUndefined();
    // No active watcher, so subsequent call must do the work again.
    const second = await indexFolder(tmpRoot, { watch: false });
    expect(second.status).toBeUndefined();
    expect(second.file_count).toBeGreaterThan(0);
  });
});
