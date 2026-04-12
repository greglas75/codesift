import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sqlAudit } from "../../src/tools/sql-tools.js";
import { indexFolder } from "../../src/tools/index-tools.js";

describe("sqlAudit composite", () => {
  let DATA_DIR: string;
  let TMP: string;
  let repoName: string;

  beforeEach(async () => {
    DATA_DIR = join(tmpdir(), "codesift-sqlaudit-data-" + process.hrtime.bigint());
    process.env["CODESIFT_DATA_DIR"] = DATA_DIR;
    TMP = join(tmpdir(), "codesift-sqlaudit-" + process.hrtime.bigint());
    mkdirSync(TMP, { recursive: true });

    // Fixture designed to trigger multiple gates:
    // - drift: Prisma model has extra field vs SQL
    // - orphan: audit_log table has no refs
    // - lint: log_entries has no PK
    // - dml: app.ts has DELETE without WHERE
    // - complexity: god_table has >20 columns
    writeFileSync(join(TMP, "schema.prisma"), `
model User {
  id    Int    @id @default(autoincrement())
  email String @unique
  name  String
  avatarUrl String?
  @@map("users")
}
`);

    writeFileSync(join(TMP, "schema.sql"), `
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE log_entries (
  action TEXT,
  occurred_at TIMESTAMP
);

CREATE TABLE audit_log (
  id SERIAL PRIMARY KEY,
  action TEXT
);

CREATE TABLE god_table (
  id INT PRIMARY KEY,
  user_id INT REFERENCES users(id),
  parent_id INT REFERENCES god_table(id),
  c1 TEXT,
  c2 TEXT,
  c3 TEXT,
  c4 TEXT,
  c5 TEXT,
  c6 TEXT,
  c7 TEXT,
  c8 TEXT,
  c9 TEXT,
  c10 TEXT,
  c11 TEXT,
  c12 TEXT,
  c13 TEXT,
  c14 TEXT,
  c15 TEXT,
  c16 TEXT,
  c17 TEXT,
  c18 TEXT,
  c19 TEXT,
  c20 TEXT
);
`);

    writeFileSync(join(TMP, "app.ts"), `
const unsafe = "DELETE FROM users";
const safe = "SELECT id FROM users WHERE org_id = 1";
const queryUsers = "SELECT * FROM users";
`);

    const r = await indexFolder(TMP, { watch: false });
    repoName = r.repo;
  }, 30_000);

  afterEach(() => {
    delete process.env["CODESIFT_DATA_DIR"];
    try { rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
    try { rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
  });

  it("runs all 5 gates by default", async () => {
    const result = await sqlAudit(repoName);
    expect(result.summary.gates_run).toBe(5);
    const checkNames = result.gates.map((g) => g.check).sort();
    expect(checkNames).toEqual(["complexity", "dml", "drift", "lint", "orphan"]);
  });

  it("drift gate fails when Prisma and SQL differ", async () => {
    const result = await sqlAudit(repoName, { checks: ["drift"] });
    const drift = result.gates.find((g) => g.check === "drift")!;
    expect(drift.pass).toBe(false);
    expect(drift.finding_count).toBeGreaterThanOrEqual(1);
    expect(drift.summary).toMatch(/extra in ORM/);
  });

  it("orphan gate detects audit_log with no references", async () => {
    const result = await sqlAudit(repoName, { checks: ["orphan"] });
    const orphan = result.gates.find((g) => g.check === "orphan")!;
    expect(orphan.pass).toBe(false);
    expect(orphan.finding_count).toBeGreaterThanOrEqual(1);
  });

  it("lint gate detects log_entries without PK", async () => {
    const result = await sqlAudit(repoName, { checks: ["lint"] });
    const lint = result.gates.find((g) => g.check === "lint")!;
    expect(lint.pass).toBe(false);
    expect(lint.finding_count).toBeGreaterThanOrEqual(1);
  });

  it("dml gate flags DELETE without WHERE as critical", async () => {
    const result = await sqlAudit(repoName, { checks: ["dml"] });
    const dml = result.gates.find((g) => g.check === "dml")!;
    expect(dml.pass).toBe(false);
    expect(dml.critical).toBe(true); // high severity DELETE without WHERE
  });

  it("complexity gate identifies god_table", async () => {
    const result = await sqlAudit(repoName, { checks: ["complexity"] });
    const complexity = result.gates.find((g) => g.check === "complexity")!;
    expect(complexity.pass).toBe(false);
    expect(complexity.summary).toMatch(/god_table/);
  });

  it("selective checks parameter only runs requested gates", async () => {
    const result = await sqlAudit(repoName, { checks: ["lint", "orphan"] });
    expect(result.summary.gates_run).toBe(2);
    const names = result.gates.map((g) => g.check).sort();
    expect(names).toEqual(["lint", "orphan"]);
  });

  it("summary aggregates findings across gates", async () => {
    const result = await sqlAudit(repoName);
    expect(result.summary.total_findings).toBeGreaterThan(0);
    expect(result.summary.critical_findings).toBeGreaterThanOrEqual(1); // dml high severity
    expect(result.summary.gates_failed).toBeGreaterThanOrEqual(3);
  });

  it("throws on unindexed repo", async () => {
    await expect(sqlAudit("nonexistent-xyz")).rejects.toThrow(/not found/i);
  });
});
