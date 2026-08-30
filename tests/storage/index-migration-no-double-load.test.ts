import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexDbIsPopulated } from "../../src/storage/sqlite/accessors.js";
import { saveIndexSqlite } from "../../src/storage/sqlite/index-io.js";
import { closeIndexDb } from "../../src/storage/sqlite/connection.js";
import type { CodeIndex } from "../../src/types.js";

/**
 * `ensureSqliteMigrated` used `loadIndexSqlite(dbPath)` as an emptiness test and threw the result
 * away, so every cold entry to a repository materialised the whole index TWICE — once to answer "is
 * it empty", once for real. Measured on the largest index here (372,949 symbols, 732 MB), three
 * runs each: 2.2 s before, 1.1 s after. Exactly double, which is what removing one of two identical
 * passes should look like.
 */
describe("indexDbIsPopulated", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function index(): CodeIndex {
    return {
      repo: "local/t", root: "/tmp/t", files: [], symbols: [],
      symbol_count: 0, created_at: Date.now(), updated_at: Date.now(),
    } as CodeIndex;
  }

  it("is false for a database with no index in it", async () => {
    dir = mkdtempSync(join(tmpdir(), "codesift-populated-"));
    const dbPath = join(dir, "t.index.db");
    expect(await indexDbIsPopulated(dbPath)).toBe(false);
    closeIndexDb(dbPath);
  });

  it("is true once an index has been written", async () => {
    dir = mkdtempSync(join(tmpdir(), "codesift-populated-"));
    const dbPath = join(dir, "t.index.db");
    await saveIndexSqlite(dbPath, index());
    expect(await indexDbIsPopulated(dbPath)).toBe(true);
    closeIndexDb(dbPath);
  });

  it("keeps the side effect the old call was relied on for", async () => {
    // The replaced `loadIndexSqlite` created the schema and ran the v1->v2 migration. Dropping that
    // would move the work to whoever touched the database next — a quiet reordering, not a saving.
    dir = mkdtempSync(join(tmpdir(), "codesift-populated-"));
    const dbPath = join(dir, "t.index.db");
    await indexDbIsPopulated(dbPath);

    // Schema exists, so a write succeeds without any other call having created it.
    await expect(saveIndexSqlite(dbPath, index())).resolves.toBeUndefined();
    expect(await indexDbIsPopulated(dbPath)).toBe(true);
    closeIndexDb(dbPath);
  });
});
