import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openIndexDb,
  closeIndexDb,
  maybeCheckpointWal,
  WAL_CHECKPOINT_THRESHOLD_BYTES,
} from "../../src/storage/sqlite/connection.js";

/**
 * WAL mode was switched on (27a221f, 2026-08-04) with no checkpoint strategy at all, and the
 * automatic one could never run here: SQLite's auto-checkpoint is PASSIVE, PASSIVE cannot copy past
 * the oldest live reader snapshot, and `openReadConnection` holds exactly such a snapshot across a
 * paged read that yields to the event loop. In a daemon serving many repos one is almost always
 * open. Measured on a real machine 2026-08-28: **16.26 GB of WAL across 713 files**, largest single
 * file 1998 MB, against 27 GB of databases — every read replaying it, cold loads taking minutes.
 */
describe("sqlite WAL stays bounded", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function walBytes(dbPath: string): number {
    const p = `${dbPath}-wal`;
    return existsSync(p) ? statSync(p).size : 0;
  }

  async function seeded(): Promise<string> {
    dir = mkdtempSync(join(tmpdir(), "codesift-wal-"));
    const dbPath = join(dir, "t.index.db");
    const db = await openIndexDb(dbPath);
    db.exec("BEGIN");
    const ins = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
    for (let i = 0; i < 400; i++) ins.run(`k${i}`, "x".repeat(400));
    db.exec("COMMIT");
    return dbPath;
  }

  it("checkpoints once the WAL passes the threshold", async () => {
    const dbPath = await seeded();
    const db = await openIndexDb(dbPath);
    expect(walBytes(dbPath)).toBeGreaterThan(0);

    // Threshold of 1 byte stands in for a 64 MB WAL, which a test cannot cheaply produce.
    maybeCheckpointWal(db, dbPath, 1);
    expect(walBytes(dbPath)).toBe(0);

    closeIndexDb(dbPath);
  });

  it("leaves a small WAL alone — checkpointing every write would be its own cost", async () => {
    const dbPath = await seeded();
    const db = await openIndexDb(dbPath);
    const before = walBytes(dbPath);
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(WAL_CHECKPOINT_THRESHOLD_BYTES);

    maybeCheckpointWal(db, dbPath);
    expect(walBytes(dbPath)).toBe(before);

    closeIndexDb(dbPath);
  });

  it("truncates the WAL on close, so an idle repo does not keep one forever", async () => {
    const dbPath = await seeded();
    expect(walBytes(dbPath)).toBeGreaterThan(0);
    closeIndexDb(dbPath);
    expect(walBytes(dbPath)).toBe(0);
  });

  it("survives a missing WAL and an in-memory database without throwing", async () => {
    dir = mkdtempSync(join(tmpdir(), "codesift-wal-"));
    const dbPath = join(dir, "absent.index.db");
    const db = await openIndexDb(dbPath);
    // No WAL file yet, and the :memory: guard — neither may throw, because this runs after every
    // committed write and must never turn a successful save into a failure.
    expect(() => maybeCheckpointWal(db, `${dbPath}-does-not-exist`, 1)).not.toThrow();
    expect(() => maybeCheckpointWal(db, ":memory:", 1)).not.toThrow();
    closeIndexDb(dbPath);
  });

  it("bounds the file across many write cycles — the actual regression", async () => {
    const dbPath = await seeded();
    let peak = 0;
    for (let round = 0; round < 12; round++) {
      const db = await openIndexDb(dbPath);
      db.exec("BEGIN");
      const ins = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
      for (let i = 0; i < 300; i++) ins.run(`r${round}-${i}`, "y".repeat(600));
      db.exec("COMMIT");
      maybeCheckpointWal(db, dbPath, 64 * 1024);
      peak = Math.max(peak, walBytes(dbPath));
    }
    // Without a checkpoint the WAL only ever grows; the point is that it does not.
    expect(peak).toBeLessThan(2 * 1024 * 1024);
    closeIndexDb(dbPath);
  });
});
