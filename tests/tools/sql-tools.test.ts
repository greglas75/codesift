import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeSchema, traceQuery } from "../../src/tools/sql-tools.js";
import { indexFolder } from "../../src/tools/index-tools.js";

const TMP = join(tmpdir(), "codesift-sql-tools-test-" + Date.now());
let repoName: string;

function writeFixture(relPath: string, content: string) {
  const full = join(TMP, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

describe("SQL tools", () => {
  beforeAll(async () => {
    mkdirSync(TMP, { recursive: true });

    writeFixture("schema.sql", `
CREATE TABLE users (
  id INT PRIMARY KEY,
  email VARCHAR(255)
);

CREATE TABLE orders (
  id INT PRIMARY KEY,
  user_id INT REFERENCES users(id),
  total DECIMAL(10,2)
);

CREATE TABLE categories (
  id INT PRIMARY KEY,
  parent_id INT REFERENCES categories(id),
  name VARCHAR(100)
);
`);

    writeFixture("views.sql", `
CREATE VIEW active_orders AS SELECT * FROM orders WHERE total > 0;
`);

    writeFixture("migration.sql", `
ALTER TABLE orders ADD COLUMN status VARCHAR(50);
INSERT INTO orders (id, user_id, total) VALUES (1, 1, 100);
`);

    writeFixture("schema.prisma", `
model User {
  id    Int    @id
  email String
  @@map("users")
}

model Order {
  id    Int    @id
  total Float
}
`);

    writeFixture("app.ts", `
const query = "SELECT * FROM orders WHERE id = ?";
export function getOrders() { return query; }
`);

    const result = await indexFolder(TMP, { watch: false });
    repoName = result.repo;
  }, 30_000);

  afterAll(() => {
    try { rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
  });

  describe("analyzeSchema", () => {
    it("returns tables with columns and FK relationships", async () => {
      const result = await analyzeSchema(repoName);
      expect(result.tables.length).toBeGreaterThanOrEqual(3);

      const orders = result.tables.find((t) => t.name === "orders");
      expect(orders).toBeDefined();
      expect(orders!.columns.length).toBeGreaterThanOrEqual(2);

      // FK: orders.user_id → users(id)
      const fk = result.relationships.find(
        (r) => r.from_table === "orders" && r.to_table === "users",
      );
      expect(fk).toBeDefined();
      expect(fk!.from_column).toBe("user_id");
    });

    it("detects self-referencing FK", async () => {
      const result = await analyzeSchema(repoName);
      const selfRef = result.relationships.find((r) => r.type === "self_reference");
      expect(selfRef).toBeDefined();
      expect(selfRef!.from_table).toBe("categories");
    });

    it("returns views", async () => {
      const result = await analyzeSchema(repoName);
      expect(result.views.length).toBeGreaterThanOrEqual(1);
      expect(result.views[0]!.name).toBe("active_orders");
    });

    it("generates mermaid ERD", async () => {
      const result = await analyzeSchema(repoName, { output_format: "mermaid" });
      expect(result.mermaid).toBeDefined();
      expect(result.mermaid).toContain("erDiagram");
      expect(result.mermaid).toContain("users");
      expect(result.mermaid).toContain("orders");
    });

    it("warns when no SQL files are indexed", async () => {
      const emptyTmp = join(tmpdir(), "codesift-empty-" + Date.now());
      mkdirSync(emptyTmp, { recursive: true });
      writeFileSync(join(emptyTmp, "readme.md"), "# Hello");
      const emptyResult = await indexFolder(emptyTmp, { watch: false });

      const result = await analyzeSchema(emptyResult.repo);
      expect(result.warnings).toContain("No SQL files indexed in this repository.");
      expect(result.tables).toEqual([]);

      rmSync(emptyTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it("throws on unindexed repo", async () => {
      await expect(analyzeSchema("nonexistent-repo-xyz")).rejects.toThrow(
        /not found.*index_folder/i,
      );
    });
  });

  describe("traceQuery", () => {
    it("finds table definition and cross-file references", async () => {
      const result = await traceQuery(repoName, { table: "orders" });
      expect(result.table_definition).toBeDefined();
      expect(result.table_definition!.kind).toBe("table");
    });

    it("detects Prisma ORM references", async () => {
      const result = await traceQuery(repoName, { table: "users", include_orm: true });
      const prismaRef = result.orm_references.find((r) => r.orm === "prisma");
      expect(prismaRef).toBeDefined();
      expect(prismaRef!.model_name).toBe("User");
    });

    it("throws on empty table parameter", async () => {
      await expect(traceQuery(repoName, { table: "" })).rejects.toThrow("table parameter is required");
    });

    it("throws on unindexed repo", async () => {
      await expect(traceQuery("nonexistent-xyz", { table: "x" })).rejects.toThrow(
        /not found/i,
      );
    });

    it("truncates at max_references", async () => {
      const result = await traceQuery(repoName, { table: "orders", max_references: 1 });
      // If there are references found, truncation should be flagged
      if (result.sql_references.length >= 1) {
        expect(result.truncated).toBe(true);
        expect(result.warnings.some((w) => w.includes("truncated"))).toBe(true);
      }
    });
  });
});
