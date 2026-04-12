import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { diffMigrations } from "../../src/tools/sql-tools.js";
import { indexFolder } from "../../src/tools/index-tools.js";

describe("diffMigrations", () => {
  let DATA_DIR: string;
  let TMP: string;
  let repoName: string;

  beforeEach(async () => {
    DATA_DIR = join(tmpdir(), "codesift-migdiff-data-" + process.hrtime.bigint());
    process.env["CODESIFT_DATA_DIR"] = DATA_DIR;

    TMP = join(tmpdir(), "codesift-migdiff-" + process.hrtime.bigint());
    mkdirSync(join(TMP, "migrations"), { recursive: true });

    writeFileSync(join(TMP, "migrations", "001_init.sql"), `
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id)
);
`);

    writeFileSync(join(TMP, "migrations", "002_add_columns.sql"), `
ALTER TABLE users ADD COLUMN name TEXT;
ALTER TABLE orders ADD COLUMN total INT;
CREATE INDEX idx_orders_user ON orders(user_id);
`);

    writeFileSync(join(TMP, "migrations", "003_destructive.sql"), `
DROP TABLE IF EXISTS temp_data;
ALTER TABLE users DROP COLUMN name;
DROP INDEX idx_orders_user;
`);

    const r = await indexFolder(TMP, { watch: false });
    repoName = r.repo;
  }, 30_000);

  afterEach(() => {
    delete process.env["CODESIFT_DATA_DIR"];
    try { rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
    try { rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
  });

  it("classifies operations as additive, destructive, or modifying", async () => {
    const result = await diffMigrations(repoName);
    expect(result.additive.length).toBeGreaterThanOrEqual(2);  // CREATE TABLE × 2
    expect(result.destructive.length).toBeGreaterThanOrEqual(2); // DROP TABLE + DROP COLUMN
    expect(result.modifying.length).toBeGreaterThanOrEqual(2);   // ALTER ADD × 2
  });

  it("flags DROP TABLE as destructive with severity high", async () => {
    const result = await diffMigrations(repoName);
    const dropTable = result.destructive.find((d) => d.operation === "DROP TABLE");
    expect(dropTable).toBeDefined();
    expect(dropTable!.severity).toBe("high");
  });

  it("flags DROP COLUMN as destructive with severity high", async () => {
    const result = await diffMigrations(repoName);
    const dropCol = result.destructive.find((d) => d.operation === "DROP COLUMN");
    expect(dropCol).toBeDefined();
    expect(dropCol!.severity).toBe("high");
  });

  it("flags CREATE TABLE as additive with severity low", async () => {
    const result = await diffMigrations(repoName);
    const createTable = result.additive.find((d) => d.operation === "CREATE TABLE");
    expect(createTable).toBeDefined();
    expect(createTable!.severity).toBe("low");
  });

  it("returns operations sorted by file (migration order)", async () => {
    const result = await diffMigrations(repoName);
    const allOps = [...result.additive, ...result.modifying, ...result.destructive];
    // All ops from 001_ should come before 002_ which should come before 003_
    const files = allOps.map((o) => o.file);
    const seen001 = files.indexOf(files.find((f) => f.includes("001"))!);
    const seen003 = files.indexOf(files.find((f) => f.includes("003"))!);
    expect(seen001).toBeLessThan(seen003);
  });

  it("includes summary counts", async () => {
    const result = await diffMigrations(repoName);
    expect(result.summary.additive).toBeGreaterThanOrEqual(2);
    expect(result.summary.destructive).toBeGreaterThanOrEqual(2);
    expect(result.summary.total_files).toBe(3);
  });

  it("scopes to file_pattern", async () => {
    const result = await diffMigrations(repoName, { file_pattern: "003" });
    expect(result.summary.total_files).toBe(1);
    expect(result.destructive.length).toBeGreaterThanOrEqual(2);
    expect(result.additive).toHaveLength(0);
  });

  it("throws on unindexed repo", async () => {
    await expect(diffMigrations("nonexistent-xyz")).rejects.toThrow(/not found/i);
  });
});
