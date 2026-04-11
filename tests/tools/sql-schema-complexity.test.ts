import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeSchemaComplexity } from "../../src/tools/sql-tools.js";
import { indexFolder } from "../../src/tools/index-tools.js";

describe("analyzeSchemaComplexity", () => {
  let DATA_DIR: string;
  let TMP: string;
  let repoName: string;

  beforeEach(async () => {
    DATA_DIR = join(tmpdir(), "codesift-schcx-data-" + process.hrtime.bigint());
    process.env["CODESIFT_DATA_DIR"] = DATA_DIR;
    TMP = join(tmpdir(), "codesift-schcx-" + process.hrtime.bigint());
    mkdirSync(TMP, { recursive: true });

    writeFileSync(join(TMP, "schema.sql"), `
CREATE TABLE simple_table (
  id INT PRIMARY KEY,
  name TEXT
);

CREATE TABLE medium_table (
  id INT PRIMARY KEY,
  a TEXT,
  b TEXT,
  c TEXT,
  d TEXT,
  e TEXT,
  f TEXT,
  g TEXT,
  h TEXT,
  i TEXT,
  j TEXT
);

CREATE TABLE god_table (
  id INT PRIMARY KEY,
  a1 TEXT,
  a2 TEXT,
  a3 TEXT,
  a4 TEXT,
  a5 TEXT,
  a6 TEXT,
  a7 TEXT,
  a8 TEXT,
  a9 TEXT,
  a10 TEXT,
  a11 TEXT,
  a12 TEXT,
  a13 TEXT,
  a14 TEXT,
  a15 TEXT,
  a16 TEXT,
  a17 TEXT,
  a18 TEXT,
  a19 TEXT,
  a20 TEXT,
  user_id INT REFERENCES medium_table(id),
  parent_id INT REFERENCES god_table(id)
);

CREATE INDEX idx_god_a1 ON god_table(a1);
CREATE INDEX idx_god_a2 ON god_table(a2);
CREATE INDEX idx_god_a3 ON god_table(a3);
`);

    const r = await indexFolder(TMP, { watch: false });
    repoName = r.repo;
  }, 30_000);

  afterEach(() => {
    delete process.env["CODESIFT_DATA_DIR"];
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("computes per-table complexity score", async () => {
    const result = await analyzeSchemaComplexity(repoName);
    expect(result.tables.length).toBe(3);
    // god_table should have highest score
    expect(result.tables[0]!.name).toBe("god_table");
    expect(result.tables[0]!.score).toBeGreaterThan(result.tables[2]!.score);
  });

  it("includes column_count, fk_count, index_count per table", async () => {
    const result = await analyzeSchemaComplexity(repoName);
    const god = result.tables.find((t) => t.name === "god_table")!;
    // id + a1..a20 + user_id + parent_id = 23
    expect(god.column_count).toBe(23);
  });

  it("detects FK relationships for complexity score", async () => {
    const result = await analyzeSchemaComplexity(repoName);
    const god = result.tables.find((t) => t.name === "god_table")!;
    expect(god.fk_count).toBeGreaterThanOrEqual(1); // parent_id self-ref
    expect(god.index_count).toBe(3); // idx_god_a1/a2/a3
  });

  it("sorts by score descending (most complex first)", async () => {
    const result = await analyzeSchemaComplexity(repoName);
    for (let i = 1; i < result.tables.length; i++) {
      expect(result.tables[i - 1]!.score).toBeGreaterThanOrEqual(result.tables[i]!.score);
    }
  });

  it("respects top_n parameter", async () => {
    const result = await analyzeSchemaComplexity(repoName, { top_n: 1 });
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.name).toBe("god_table");
  });

  it("throws on unindexed repo", async () => {
    await expect(analyzeSchemaComplexity("nonexistent-xyz")).rejects.toThrow(/not found/i);
  });
});
