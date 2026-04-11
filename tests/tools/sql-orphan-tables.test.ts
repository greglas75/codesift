import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findOrphanTables } from "../../src/tools/sql-tools.js";
import { indexFolder } from "../../src/tools/index-tools.js";

describe("findOrphanTables", () => {
  let DATA_DIR: string;
  let TMP: string;
  let repoName: string;

  beforeEach(async () => {
    DATA_DIR = join(tmpdir(), "codesift-orphan-data-" + process.hrtime.bigint());
    process.env["CODESIFT_DATA_DIR"] = DATA_DIR;

    TMP = join(tmpdir(), "codesift-orphan-" + process.hrtime.bigint());
    mkdirSync(TMP, { recursive: true });

    // Users and orders are referenced in app.ts; audit_log and temp_data are not
    writeFileSync(join(TMP, "schema.sql"), `
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  total INT
);

CREATE TABLE audit_log (
  id SERIAL PRIMARY KEY,
  action TEXT,
  occurred_at TIMESTAMP
);

CREATE TABLE temp_data (
  id INT,
  payload TEXT
);
`);

    writeFileSync(join(TMP, "app.ts"), `
import { db } from "./db";

async function getUsers() {
  return db.query("SELECT * FROM users WHERE active = true");
}

async function createOrder(userId: number, total: number) {
  return db.query("INSERT INTO orders (user_id, total) VALUES ($1, $2)", [userId, total]);
}
`);

    const r = await indexFolder(TMP, { watch: false });
    repoName = r.repo;
  }, 30_000);

  afterEach(() => {
    delete process.env["CODESIFT_DATA_DIR"];
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("identifies tables with zero references as orphans", async () => {
    const result = await findOrphanTables(repoName);
    const orphanNames = result.orphans.map((o) => o.name).sort();
    expect(orphanNames).toContain("audit_log");
    expect(orphanNames).toContain("temp_data");
  });

  it("does NOT flag referenced tables as orphans", async () => {
    const result = await findOrphanTables(repoName);
    const orphanNames = result.orphans.map((o) => o.name);
    expect(orphanNames).not.toContain("users");
    expect(orphanNames).not.toContain("orders");
  });

  it("returns column count per orphan table", async () => {
    const result = await findOrphanTables(repoName);
    const auditLog = result.orphans.find((o) => o.name === "audit_log");
    expect(auditLog).toBeDefined();
    expect(auditLog!.column_count).toBe(3); // id, action, occurred_at
  });

  it("returns file and line for each orphan", async () => {
    const result = await findOrphanTables(repoName);
    for (const o of result.orphans) {
      expect(o.file).toBe("schema.sql");
      expect(o.line).toBeGreaterThan(0);
    }
  });

  it("includes summary with total tables and orphan count", async () => {
    const result = await findOrphanTables(repoName);
    expect(result.total_tables).toBe(4);
    expect(result.orphan_count).toBe(2);
  });

  it("throws on unindexed repo", async () => {
    await expect(findOrphanTables("nonexistent-xyz")).rejects.toThrow(/not found/i);
  });
});
