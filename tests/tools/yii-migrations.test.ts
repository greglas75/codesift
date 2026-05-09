/**
 * Tests for analyzeYiiMigrations (N2).
 *
 * Fixture covers: a clean reversible migration, an irreversible one,
 * a destructive alter without ALGORITHM hint, an FK without index,
 * and a destructive alter WITH the hint (negative test).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { join, resolve } from "node:path";
import { indexFolder } from "../../src/tools/index-tools.js";
import { analyzeYiiMigrations } from "../../src/tools/yii-migrations-tools.js";

const FIXTURE_ROOT = resolve(
  join(__dirname, "..", "fixtures", "php-yii-migrations"),
);
const REPO = "local/php-yii-migrations";

describe("analyzeYiiMigrations", () => {
  beforeAll(async () => {
    await indexFolder(FIXTURE_ROOT);
  });

  it("returns structured per-migration breakdown", async () => {
    const r = await analyzeYiiMigrations(REPO);
    expect(r.repo).toBe(REPO);
    expect(r.scanned_files).toBeGreaterThan(0);
    expect(r.total_migrations).toBeGreaterThanOrEqual(5);
    expect(Array.isArray(r.migrations)).toBe(true);
  });

  it("parses createTable + createIndex into structured ops", async () => {
    const r = await analyzeYiiMigrations(REPO);
    const m = r.migrations.find((x) => x.file.includes("m180504_110045_users.php"));
    expect(m).toBeDefined();
    expect(m!.up_ops.find((o) => o.kind === "create_table" && o.table === "users"))
      .toBeDefined();
    expect(m!.up_ops.find((o) => o.kind === "create_index" && o.index_name === "idx_users_email"))
      .toBeDefined();
    expect(m!.down_ops.find((o) => o.kind === "drop_table" && o.table === "users"))
      .toBeDefined();
  });

  it("flags missing-safe-down on an irreversible migration", async () => {
    const r = await analyzeYiiMigrations(REPO);
    const m = r.migrations.find((x) => x.file.includes("irreversible"));
    expect(m).toBeDefined();
    const finding = m!.findings.find((f) => f.rule_id === "missing-safe-down");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("medium");
  });

  it("flags alter-without-online-ddl when destructive ops have no hint", async () => {
    const r = await analyzeYiiMigrations(REPO);
    const m = r.migrations.find((x) => x.file.includes("drop_column"));
    expect(m).toBeDefined();
    const finding = m!.findings.find((f) => f.rule_id === "alter-without-online-ddl");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("high");
  });

  it("does NOT flag alter-without-online-ddl when ALGORITHM=INPLACE is present", async () => {
    const r = await analyzeYiiMigrations(REPO);
    const m = r.migrations.find((x) => x.file.includes("safe_alter"));
    expect(m).toBeDefined();
    const finding = m!.findings.find((f) => f.rule_id === "alter-without-online-ddl");
    expect(finding).toBeUndefined();
  });

  it("flags fk-without-index when addForeignKey lacks a preceding createIndex", async () => {
    const r = await analyzeYiiMigrations(REPO);
    const m = r.migrations.find((x) => x.file.includes("fk_no_index"));
    expect(m).toBeDefined();
    const finding = m!.findings.find((f) => f.rule_id === "fk-without-index");
    expect(finding).toBeDefined();
  });

  it("detects safeUp/safeDown as transactional", async () => {
    const r = await analyzeYiiMigrations(REPO);
    const safeMig = r.migrations.find((x) => x.file.includes("fk_no_index"));
    const plainMig = r.migrations.find((x) => x.file.includes("users.php"));
    expect(safeMig!.is_safe_transactional).toBe(true);
    expect(plainMig!.is_safe_transactional).toBe(false);
  });

  it("builds by_table back-index", async () => {
    const r = await analyzeYiiMigrations(REPO);
    expect(r.by_table["users"]).toBeDefined();
    expect(r.by_table["users"]!.length).toBeGreaterThanOrEqual(2);
    expect(r.by_table["orders"]).toBeDefined();
  });

  it("aggregates findings_summary by rule", async () => {
    const r = await analyzeYiiMigrations(REPO);
    expect(r.findings_summary["missing-safe-down"]).toBeGreaterThanOrEqual(1);
    expect(r.findings_summary["alter-without-online-ddl"]).toBeGreaterThanOrEqual(1);
    expect(r.findings_summary["fk-without-index"]).toBeGreaterThanOrEqual(1);
  });

  it("respects rules filter", async () => {
    const r = await analyzeYiiMigrations(REPO, {
      rules: ["missing-safe-down"],
    });
    for (const m of r.migrations) {
      for (const f of m.findings) {
        expect(f.rule_id).toBe("missing-safe-down");
      }
    }
  });

  it("returns migrations sorted chronologically by filename", async () => {
    const r = await analyzeYiiMigrations(REPO);
    const files = r.migrations.map((m) => m.file);
    const sorted = [...files].sort();
    expect(files).toEqual(sorted);
  });

  it("captures table touched by each migration", async () => {
    const r = await analyzeYiiMigrations(REPO);
    const usersMig = r.migrations.find((x) => x.file.includes("m180504_110045_users.php"));
    expect(usersMig!.tables).toContain("users");
  });
});
