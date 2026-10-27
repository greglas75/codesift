import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openIndexDb,
  closeIndexDb,
  closeStaleIndexDbs,
} from "../../src/storage/sqlite/connection.js";

/**
 * The connection cache is keyed by path, and the file under a path can be deleted (cc-cleanup
 * removes an idle worktree's index). The cached handle then held the deleted inode open for the
 * life of the process: 2026-10-27 one codesift-mcp held 782 deleted index descriptors (16 GB),
 * ~180 GB across the sessions host.
 */
describe("cached index connections let go of deleted files", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function removeIndex(dbPath: string): void {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
  }

  it("reopens instead of handing out the handle of a deleted file", async () => {
    // bug caught: writes after a cleanup landed in the deleted inode and its space was never freed
    dir = mkdtempSync(join(tmpdir(), "codesift-deleted-"));
    const dbPath = join(dir, "t.index.db");
    const before = await openIndexDb(dbPath);
    removeIndex(dbPath);

    const after = await openIndexDb(dbPath);

    expect(after).not.toBe(before);
    expect(before.isOpen).toBe(false);
    closeIndexDb(dbPath);
  });

  it("the sweep closes a deleted index that nobody opens again", async () => {
    // bug caught: an idle worktree's index is never opened again, so only a sweep can reach it
    dir = mkdtempSync(join(tmpdir(), "codesift-deleted-"));
    const gone = join(dir, "gone.index.db");
    const kept = join(dir, "kept.index.db");
    const goneDb = await openIndexDb(gone);
    const keptDb = await openIndexDb(kept);
    removeIndex(gone);

    expect(closeStaleIndexDbs()).toBe(1);
    expect(goneDb.isOpen).toBe(false);
    expect(keptDb.isOpen).toBe(true);
    closeIndexDb(kept);
  });

  it("leaves a deleted index alone while a transaction is open on it", async () => {
    // bug caught: closing under saveIndexSqlite, which awaits inside BEGIN, failed that write halfway
    dir = mkdtempSync(join(tmpdir(), "codesift-deleted-"));
    const dbPath = join(dir, "busy.index.db");
    const db = await openIndexDb(dbPath);
    db.exec("BEGIN");
    removeIndex(dbPath);

    expect(closeStaleIndexDbs()).toBe(0);
    expect(db.isOpen).toBe(true);
    db.exec("ROLLBACK");
    closeIndexDb(dbPath);
  });
});
