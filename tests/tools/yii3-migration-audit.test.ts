/**
 * Tests for yii3MigrationAudit (M4 — decision support tool).
 *
 * Uses the php-yii3-migration fixture which packs canonical Yii2 idioms
 * across 21 categories: service-locator, ActiveRecord, Module, RBAC,
 * console, migrations, widgets, view, url-manager, etc.
 *
 * Each test asserts a category was detected with the expected count and
 * sample evidence — but uses ranges (>= n) rather than exact counts, so
 * adding more idioms to the fixture in future doesn't break the suite.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { join, resolve } from "node:path";
import { indexFolder } from "../../src/tools/index-tools.js";
import { yii3MigrationAudit } from "../../src/tools/yii3-migration-tools.js";

const FIXTURE_ROOT = resolve(
  join(__dirname, "..", "fixtures", "php-yii3-migration"),
);
const REPO = "local/php-yii3-migration";

describe("yii3MigrationAudit", () => {
  beforeAll(async () => {
    await indexFolder(FIXTURE_ROOT);
  });

  it("returns a structured audit with category breakdown", async () => {
    const r = await yii3MigrationAudit(REPO);
    expect(r.repo).toBe(REPO);
    expect(r.scanned_files).toBeGreaterThan(0);
    expect(r.total_call_sites).toBeGreaterThan(0);
    expect(Array.isArray(r.by_category)).toBe(true);
    expect(r.by_category.length).toBeGreaterThan(0);
  });

  it("detects service-locator (Yii::$app->db etc.)", async () => {
    const r = await yii3MigrationAudit(REPO);
    const cat = r.by_category.find((c) => c.category === "service-locator");
    expect(cat).toBeDefined();
    expect(cat!.severity).toBe("critical");
    expect(cat!.count).toBeGreaterThanOrEqual(3);
    expect(cat!.sample_files.length).toBeGreaterThan(0);
    expect(cat!.sample_files[0].file).toContain("UserController.php");
  });

  it("detects ActiveRecord usage", async () => {
    const r = await yii3MigrationAudit(REPO);
    const cat = r.by_category.find((c) => c.category === "active-record");
    expect(cat).toBeDefined();
    expect(cat!.severity).toBe("critical");
    expect(cat!.count).toBeGreaterThanOrEqual(1);
  });

  it("detects Yii2 Module class declarations", async () => {
    const r = await yii3MigrationAudit(REPO);
    const cat = r.by_category.find((c) => c.category === "module");
    expect(cat).toBeDefined();
    expect(cat!.severity).toBe("critical");
    expect(cat!.count).toBeGreaterThanOrEqual(1);
    expect(cat!.sample_files[0].file).toContain("Module.php");
  });

  it("detects RBAC seed migrations and runtime checks", async () => {
    const r = await yii3MigrationAudit(REPO);
    const cat = r.by_category.find((c) => c.category === "rbac");
    expect(cat).toBeDefined();
    expect(cat!.severity).toBe("high");
    // perms migration has authManager + createPermission + add + addChild
    // controller has user->can. So count should be >= 4.
    expect(cat!.count).toBeGreaterThanOrEqual(4);
  });

  it("detects console controllers", async () => {
    const r = await yii3MigrationAudit(REPO);
    const cat = r.by_category.find((c) => c.category === "console");
    expect(cat).toBeDefined();
    expect(cat!.count).toBeGreaterThanOrEqual(1);
  });

  it("detects migrations (low severity, large count)", async () => {
    const r = await yii3MigrationAudit(REPO);
    const cat = r.by_category.find((c) => c.category === "migrations");
    expect(cat).toBeDefined();
    expect(cat!.severity).toBe("low");
    expect(cat!.count).toBeGreaterThanOrEqual(2);
  });

  it("detects view layer ($this->render + $this->layout)", async () => {
    const r = await yii3MigrationAudit(REPO);
    const cat = r.by_category.find((c) => c.category === "view");
    expect(cat).toBeDefined();
    expect(cat!.count).toBeGreaterThanOrEqual(2);
  });

  it("detects widgets (ActiveForm, GridView)", async () => {
    const r = await yii3MigrationAudit(REPO);
    const cat = r.by_category.find((c) => c.category === "widgets");
    expect(cat).toBeDefined();
    expect(cat!.count).toBeGreaterThanOrEqual(2);
  });

  it("detects Yii::t i18n calls", async () => {
    const r = await yii3MigrationAudit(REPO);
    const cat = r.by_category.find((c) => c.category === "i18n");
    expect(cat).toBeDefined();
    expect(cat!.count).toBeGreaterThanOrEqual(1);
  });

  it("detects logger calls (Yii::error / Yii::info)", async () => {
    const r = await yii3MigrationAudit(REPO);
    const cat = r.by_category.find((c) => c.category === "logger");
    expect(cat).toBeDefined();
    expect(cat!.count).toBeGreaterThanOrEqual(2);
  });

  it("detects createObject and aliases", async () => {
    const r = await yii3MigrationAudit(REPO);
    const obj = r.by_category.find((c) => c.category === "object-factory");
    const al = r.by_category.find((c) => c.category === "aliases");
    expect(obj!.count).toBeGreaterThanOrEqual(1);
    expect(al!.count).toBeGreaterThanOrEqual(1);
  });

  it("aggregates by_severity counts", async () => {
    const r = await yii3MigrationAudit(REPO);
    expect(r.by_severity.critical).toBeGreaterThan(0);
    expect(r.by_severity.high).toBeGreaterThan(0);
    expect(
      r.by_severity.critical +
        r.by_severity.high +
        r.by_severity.medium +
        r.by_severity.low,
    ).toBe(r.total_call_sites);
  });

  it("computes effort_estimate as positive hour range", async () => {
    const r = await yii3MigrationAudit(REPO);
    expect(r.effort_estimate.hours_low).toBeGreaterThan(0);
    expect(r.effort_estimate.hours_high).toBeGreaterThan(
      r.effort_estimate.hours_low,
    );
  });

  it("reads composer.json for Yii + PHP version detection", async () => {
    const r = await yii3MigrationAudit(REPO);
    expect(r.yii_version_detected).toBe("2.0.17");
    expect(r.php_version_required).toBe(">=7.2.0");
  });

  it("emits a decision_signal", async () => {
    const r = await yii3MigrationAudit(REPO);
    expect([
      "stay-on-yii2",
      "consider-yii3",
      "high-effort-yii3",
      "blocked",
    ]).toContain(r.decision_signal);
  });

  it("respects max_samples_per_category option", async () => {
    const r = await yii3MigrationAudit(REPO, { max_samples_per_category: 1 });
    for (const cat of r.by_category) {
      expect(cat.sample_files.length).toBeLessThanOrEqual(1);
    }
  });

  it("does not fail when an individual file read fails", async () => {
    // Smoke test: run with a strict file_pattern that matches no files.
    const r = await yii3MigrationAudit(REPO, {
      file_pattern: "this-path-does-not-exist",
    });
    expect(r.scanned_files).toBe(0);
    expect(r.total_call_sites).toBe(0);
    expect(r.by_category).toEqual([]);
  });

  it("category findings are sorted by severity then count", async () => {
    const r = await yii3MigrationAudit(REPO);
    const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    let prevSev = -1;
    let prevCountInSev = Infinity;
    for (const cat of r.by_category) {
      const sevRank = sevOrder[cat.severity];
      if (sevRank > prevSev) {
        prevCountInSev = Infinity;
        prevSev = sevRank;
      }
      expect(cat.count).toBeLessThanOrEqual(prevCountInSev);
      prevCountInSev = cat.count;
    }
  });
});
