import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { searchColumns } from "../../src/tools/sql-tools.js";
import { indexFolder } from "../../src/tools/index-tools.js";

describe("searchColumns", () => {
  let DATA_DIR: string;
  let TMP: string;
  let repoName: string;

  beforeEach(async () => {
    DATA_DIR = join(tmpdir(), "codesift-searchcol-data-" + process.hrtime.bigint());
    process.env["CODESIFT_DATA_DIR"] = DATA_DIR;

    TMP = join(tmpdir(), "codesift-searchcol-" + process.hrtime.bigint());
    mkdirSync(TMP, { recursive: true });

    writeFileSync(
      join(TMP, "schema.sql"),
      `CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  user_name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  total_cents INT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  price_cents INT NOT NULL
);
`,
    );

    const r = await indexFolder(TMP, { watch: false });
    repoName = r.repo;
  }, 30_000);

  afterEach(() => {
    delete process.env["CODESIFT_DATA_DIR"];
    try { rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
    try { rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
  });

  it("finds exact column name across tables", async () => {
    const result = await searchColumns(repoName, { query: "id" });
    // "id" appears in all 3 tables (exact) + user_id in orders (substring)
    const exactIds = result.columns.filter((c) => c.name === "id");
    expect(exactIds.length).toBeGreaterThanOrEqual(3);
    expect(exactIds.map((c) => c.table).sort()).toEqual(["orders", "products", "users"]);
  });

  it("supports substring matching (case-insensitive)", async () => {
    const result = await searchColumns(repoName, { query: "name" });
    // Should match user_name, name (products)
    const names = result.columns.map((c) => `${c.table}.${c.name}`);
    expect(names).toContain("users.user_name");
    expect(names).toContain("products.name");
  });

  it("returns column type and location", async () => {
    const result = await searchColumns(repoName, { query: "email" });
    expect(result.columns).toHaveLength(1);
    const col = result.columns[0]!;
    expect(col.table).toBe("users");
    expect(col.name).toBe("email");
    expect(col.type).toMatch(/text/i);
    expect(col.file).toBe("schema.sql");
    expect(col.line).toBeGreaterThan(0);
  });

  it("filters by type pattern", async () => {
    const result = await searchColumns(repoName, { query: "", type: "int" });
    // Should find all INT columns (user_id, total_cents, price_cents, id SERIAL...)
    // SERIAL normalizes to int
    const intCols = result.columns.filter((c) => /int|serial/i.test(c.type));
    expect(intCols.length).toBeGreaterThanOrEqual(3);
  });

  it("filters by table pattern", async () => {
    const result = await searchColumns(repoName, { query: "", table: "users" });
    // All columns in users table only
    expect(result.columns.every((c) => c.table === "users")).toBe(true);
    expect(result.columns.length).toBe(4); // id, email, user_name, created_at
  });

  it("combines query + table filter", async () => {
    const result = await searchColumns(repoName, { query: "created", table: "orders" });
    expect(result.columns).toHaveLength(1);
    expect(result.columns[0]!.table).toBe("orders");
    expect(result.columns[0]!.name).toBe("created_at");
  });

  it("respects max_results", async () => {
    const result = await searchColumns(repoName, { query: "", max_results: 2 });
    expect(result.columns).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("returns zero columns + summary when nothing matches", async () => {
    const result = await searchColumns(repoName, { query: "nonexistent_column_xyz" });
    expect(result.columns).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("empty query returns all columns (no filter)", async () => {
    const result = await searchColumns(repoName, { query: "" });
    // 4 + 5 + 4 = 13 columns total
    expect(result.total).toBe(13);
  });

  it("throws on unindexed repo", async () => {
    await expect(searchColumns("nonexistent-xyz", { query: "id" })).rejects.toThrow(/not found/i);
  });
});
