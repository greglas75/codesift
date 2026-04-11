import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lintSchema } from "../../src/tools/sql-tools.js";
import { indexFolder } from "../../src/tools/index-tools.js";

describe("lintSchema", () => {
  let DATA_DIR: string;
  let TMP: string;
  let repoName: string;

  beforeEach(async () => {
    DATA_DIR = join(tmpdir(), "codesift-lint-data-" + process.hrtime.bigint());
    process.env["CODESIFT_DATA_DIR"] = DATA_DIR;

    TMP = join(tmpdir(), "codesift-lint-" + process.hrtime.bigint());
    mkdirSync(TMP, { recursive: true });

    writeFileSync(join(TMP, "schema.sql"), `
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

-- Missing PK: no PRIMARY KEY defined
CREATE TABLE log_entries (
  action TEXT,
  occurred_at TIMESTAMP
);

-- Wide table: too many columns
CREATE TABLE god_table (
  id INT PRIMARY KEY,
  a1 TEXT, a2 TEXT, a3 TEXT, a4 TEXT, a5 TEXT,
  b1 TEXT, b2 TEXT, b3 TEXT, b4 TEXT, b5 TEXT,
  c1 TEXT, c2 TEXT, c3 TEXT, c4 TEXT, c5 TEXT,
  d1 TEXT, d2 TEXT, d3 TEXT, d4 TEXT, d5 TEXT,
  e1 TEXT, e2 TEXT, e3 TEXT, e4 TEXT, e5 TEXT,
  f1 TEXT, f2 TEXT, f3 TEXT, f4 TEXT, f5 TEXT
);

-- Nullable column without default
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INT,
  total INT NOT NULL
);

-- Duplicate index name (same table)
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_email ON users(name);
`);

    const r = await indexFolder(TMP, { watch: false });
    repoName = r.repo;
  }, 30_000);

  afterEach(() => {
    delete process.env["CODESIFT_DATA_DIR"];
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("detects tables without PRIMARY KEY", async () => {
    const result = await lintSchema(repoName);
    const noPk = result.findings.find(
      (f) => f.rule === "no-primary-key" && f.table === "log_entries",
    );
    expect(noPk).toBeDefined();
    expect(noPk!.severity).toBe("warning");
  });

  it("detects wide tables (>20 columns)", async () => {
    const result = await lintSchema(repoName);
    const wide = result.findings.find(
      (f) => f.rule === "wide-table" && f.table === "god_table",
    );
    expect(wide).toBeDefined();
    expect(wide!.severity).toBe("warning");
  });

  it("detects duplicate index names", async () => {
    const result = await lintSchema(repoName);
    const dup = result.findings.find(
      (f) => f.rule === "duplicate-index-name",
    );
    expect(dup).toBeDefined();
  });

  it("does NOT flag well-structured tables", async () => {
    const result = await lintSchema(repoName);
    const userFindings = result.findings.filter((f) => f.table === "users");
    // users has PK, reasonable columns — should have no warnings
    expect(userFindings).toHaveLength(0);
  });

  it("returns summary with counts per rule", async () => {
    const result = await lintSchema(repoName);
    expect(result.summary.total).toBeGreaterThanOrEqual(3);
    expect(Object.keys(result.summary.by_rule).length).toBeGreaterThanOrEqual(2);
  });

  it("throws on unindexed repo", async () => {
    await expect(lintSchema("nonexistent-xyz")).rejects.toThrow(/not found/i);
  });

  it("warns when no SQL tables found", async () => {
    const emptyTmp = join(tmpdir(), "codesift-lint-empty-" + process.hrtime.bigint());
    mkdirSync(emptyTmp, { recursive: true });
    writeFileSync(join(emptyTmp, "readme.md"), "# hi");
    const emptyR = await indexFolder(emptyTmp, { watch: false });
    const result = await lintSchema(emptyR.repo);
    expect(result.warnings.some((w) => /no sql/i.test(w))).toBe(true);
    rmSync(emptyTmp, { recursive: true, force: true });
  });
});
