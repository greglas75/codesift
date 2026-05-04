import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeSchema, traceQuery, detectSqlDialect } from "../../src/tools/sql-tools.js";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";

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
    process.env["CODESIFT_DATA_DIR"] = join(TMP, ".codesift-data");
    resetConfigCache();

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
    delete process.env["CODESIFT_DATA_DIR"];
    resetConfigCache();
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

  // Independent fixture — proves analyzeSchema works on a realistic
  // mysqldump output with backtick identifiers, ENGINE=InnoDB, charset
  // declarations, and table-level FOREIGN KEY constraints. Closes the
  // pre-existing FK_RE backtick gap (sql-tools.ts FK_RE).
  describe("analyzeSchema — raw mysqldump (MySQL backticks)", () => {
    let mysqlRepo: string;
    const MYSQL_TMP = join(tmpdir(), "codesift-sql-mysql-test-" + Date.now());

    beforeAll(async () => {
      mkdirSync(MYSQL_TMP, { recursive: true });
      writeFileSync(join(MYSQL_TMP, "mysqldump.sql"), `
-- MySQL dump 10.13
-- Server version 8.0.34

DROP TABLE IF EXISTS \`accounts\`;
CREATE TABLE \`accounts\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`email\` varchar(255) CHARACTER SET utf8mb4 NOT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS \`sessions\`;
CREATE TABLE \`sessions\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`account_id\` int(11) NOT NULL,
  \`token\` varchar(64) NOT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`fk_sessions_account\` (\`account_id\`),
  CONSTRAINT \`fk_sessions_account\` FOREIGN KEY (\`account_id\`) REFERENCES \`accounts\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`, "utf-8");

      const r = await indexFolder(MYSQL_TMP, { watch: false });
      mysqlRepo = r.repo;
    }, 30_000);

    afterAll(() => {
      try { rmSync(MYSQL_TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
    });

    it("extracts both backticked tables", async () => {
      const result = await analyzeSchema(mysqlRepo);
      const names = result.tables.map((t) => t.name).sort();
      expect(names).toEqual(["accounts", "sessions"]);
    });

    it("resolves table-level FOREIGN KEY with backtick identifiers", async () => {
      const result = await analyzeSchema(mysqlRepo);
      const fk = result.relationships.find(
        (r) => r.from_table === "sessions" && r.to_table === "accounts",
      );
      expect(fk, "FK sessions.account_id → accounts.id should be detected from MySQL backtick syntax").toBeDefined();
      expect(fk!.from_column).toBe("account_id");
      expect(fk!.to_column).toBe("id");
    });

    it("auto-detects dialect=mysql from ENGINE=InnoDB / AUTO_INCREMENT", async () => {
      const result = await analyzeSchema(mysqlRepo);
      expect(result.detected_dialect).toBe("mysql");
    });

    it("respects forced dialect override", async () => {
      const result = await analyzeSchema(mysqlRepo, { dialect: "postgres" });
      expect(result.detected_dialect).toBe("postgres");
    });
  });

  describe("detectSqlDialect (unit)", () => {
    it("identifies MySQL via ENGINE=InnoDB", () => {
      expect(detectSqlDialect("CREATE TABLE x (id INT) ENGINE=InnoDB")).toBe("mysql");
    });
    it("identifies MySQL via AUTO_INCREMENT", () => {
      expect(detectSqlDialect("id INT NOT NULL AUTO_INCREMENT")).toBe("mysql");
    });
    it("identifies MySQL via utf8mb4 charset", () => {
      expect(detectSqlDialect("DEFAULT CHARSET=utf8mb4")).toBe("mysql");
    });
    it("identifies Postgres via SERIAL", () => {
      expect(detectSqlDialect("id SERIAL PRIMARY KEY")).toBe("postgres");
    });
    it("identifies Postgres via JSONB column type", () => {
      expect(detectSqlDialect("data JSONB NOT NULL")).toBe("postgres");
    });
    it("identifies SQLite via AUTOINCREMENT (single token)", () => {
      expect(detectSqlDialect("id INTEGER PRIMARY KEY AUTOINCREMENT")).toBe("sqlite");
    });
    it("identifies MS SQL via NVARCHAR + IDENTITY(seed, step)", () => {
      expect(detectSqlDialect("name NVARCHAR(50), id INT IDENTITY(1, 1)")).toBe("mssql");
    });
    it("returns 'unknown' for dialect-neutral DDL", () => {
      expect(detectSqlDialect("CREATE TABLE x (id INT, name VARCHAR(50))")).toBe("unknown");
    });
    it("returns 'unknown' for empty input", () => {
      expect(detectSqlDialect("")).toBe("unknown");
    });
    it("MySQL signal beats Postgres when both present (dump-from-postgres-into-MySQL is rare)", () => {
      // Mixed-content disambiguation — MySQL fingerprints take priority because
      // ENGINE=InnoDB never appears in pure Postgres DDL.
      expect(detectSqlDialect("id SERIAL, ENGINE=InnoDB")).toBe("mysql");
    });
  });
});
