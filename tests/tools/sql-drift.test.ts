import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeSchemaDrift } from "../../src/tools/sql-tools.js";
import { indexFolder } from "../../src/tools/index-tools.js";

const FIXTURES = join(import.meta.dirname, "../fixtures/sql");

describe("analyzeSchemaDrift", () => {
  // Isolate CODESIFT_DATA_DIR per test so parallel files don't clobber each other's registry
  let DATA_DIR: string;
  beforeEach(() => {
    DATA_DIR = join(tmpdir(), "codesift-drift-data-" + process.hrtime.bigint());
    process.env["CODESIFT_DATA_DIR"] = DATA_DIR;
  });
  afterEach(() => {
    delete process.env["CODESIFT_DATA_DIR"];
    try { rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
  });

  describe("drift-prisma fixture (known drifts)", () => {
    let repoName: string;
    let TMP: string;

    beforeEach(async () => {
      TMP = join(tmpdir(), "codesift-drift-test-" + process.hrtime.bigint());
      mkdirSync(TMP, { recursive: true });
      cpSync(join(FIXTURES, "drift-prisma"), TMP, { recursive: true });
      const r = await indexFolder(TMP, { watch: false });
      repoName = r.repo;
    }, 30_000);

    afterEach(() => {
      try { rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
    });

    it("detects extra field in ORM not in SQL (User.avatarUrl)", async () => {
      const result = await analyzeSchemaDrift(repoName);
      const userDrifts = result.drifts.filter((d) => d.table === "users");
      const avatarDrift = userDrifts.find(
        (d) => d.kind === "extra_in_orm" && d.column === "avatarUrl",
      );
      expect(avatarDrift).toBeDefined();
      expect(avatarDrift!.orm).toBe("prisma");
    });

    it("detects extra table in SQL not in ORM (audit_log)", async () => {
      const result = await analyzeSchemaDrift(repoName);
      const orphan = result.drifts.find(
        (d) => d.kind === "extra_in_sql" && d.table === "audit_log",
      );
      expect(orphan).toBeDefined();
    });

    it("detects type mismatch (orders.total: Float vs INT)", async () => {
      const result = await analyzeSchemaDrift(repoName);
      const mismatch = result.drifts.find(
        (d) => d.kind === "type_mismatch" && d.table === "orders" && d.column === "total",
      );
      expect(mismatch).toBeDefined();
      expect(mismatch!.orm_type).toMatch(/float/i);
      expect(mismatch!.sql_type).toMatch(/int/i);
    });

    it("summary includes counts per drift kind", async () => {
      const result = await analyzeSchemaDrift(repoName);
      expect(result.summary.extra_in_orm).toBeGreaterThanOrEqual(1);
      expect(result.summary.extra_in_sql).toBeGreaterThanOrEqual(1);
      expect(result.summary.type_mismatches).toBeGreaterThanOrEqual(1);
    });

    it("reports ORM framework detected", async () => {
      const result = await analyzeSchemaDrift(repoName);
      expect(result.orms_detected).toContain("prisma");
    });
  });

  describe("drift-clean fixture (no drifts)", () => {
    let repoName: string;
    let TMP: string;

    beforeEach(async () => {
      TMP = join(tmpdir(), "codesift-drift-clean-" + process.hrtime.bigint());
      mkdirSync(TMP, { recursive: true });
      cpSync(join(FIXTURES, "drift-clean"), TMP, { recursive: true });
      const r = await indexFolder(TMP, { watch: false });
      repoName = r.repo;
    }, 30_000);

    afterEach(() => {
      try { rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
    });

    it("reports zero drifts when schemas match", async () => {
      const result = await analyzeSchemaDrift(repoName);
      expect(result.drifts).toHaveLength(0);
      expect(result.summary.extra_in_orm).toBe(0);
      expect(result.summary.extra_in_sql).toBe(0);
      expect(result.summary.type_mismatches).toBe(0);
    });
  });

  describe("error paths", () => {
    it("throws on unindexed repo", async () => {
      await expect(analyzeSchemaDrift("nonexistent-drift-xyz")).rejects.toThrow(/not found/i);
    });

    it("warns when no ORM models found (pure-SQL project)", async () => {
      const TMP = join(tmpdir(), "codesift-drift-sql-only-" + process.hrtime.bigint());
      mkdirSync(TMP, { recursive: true });
      writeFileSync(
        join(TMP, "schema.sql"),
        "CREATE TABLE users (id INT PRIMARY KEY, email TEXT);",
      );
      const r = await indexFolder(TMP, { watch: false });

      const result = await analyzeSchemaDrift(r.repo);
      expect(result.warnings.some((w) => /no orm models/i.test(w))).toBe(true);
      expect(result.orms_detected).toEqual([]);

      rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
  });
});
