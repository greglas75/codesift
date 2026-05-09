/**
 * Tests for analyzeYiiModules (N1).
 *
 * Fixture mirrors the canonical Yii2 advanced template layout:
 *   modules/api/Module.php           with controllerNamespace + 1 controller + 3 actions
 *                  /modules/v2/Module.php   nested submodule
 *                  /views/...               1 view file
 *                  /migrations/...          1 migration
 *   modules/manage/Module.php        without controllerNamespace + 1 controller + 1 action
 *   config/web.php                   urlManager with rules referencing both modules
 */
import { describe, it, expect, beforeAll } from "vitest";
import { join, resolve } from "node:path";
import { indexFolder } from "../../src/tools/index-tools.js";
import { analyzeYiiModules } from "../../src/tools/yii-modules-tools.js";

const FIXTURE_ROOT = resolve(
  join(__dirname, "..", "fixtures", "php-yii-modules"),
);
const REPO = "local/php-yii-modules";

describe("analyzeYiiModules", () => {
  beforeAll(async () => {
    await indexFolder(FIXTURE_ROOT);
  });

  it("returns structured per-module summary", async () => {
    const r = await analyzeYiiModules(REPO);
    expect(r.repo).toBe(REPO);
    expect(r.total_modules).toBeGreaterThanOrEqual(2);
    expect(r.modules.map((m) => m.id).sort()).toEqual(
      expect.arrayContaining(["api", "manage"]),
    );
  });

  it("captures controllerNamespace when explicitly declared", async () => {
    const r = await analyzeYiiModules(REPO);
    const api = r.modules.find((m) => m.id === "api");
    expect(api).toBeDefined();
    expect(api!.controllerNamespace).toBe("app\\modules\\api\\controllers");
  });

  it("returns null controllerNamespace when not explicitly declared", async () => {
    const r = await analyzeYiiModules(REPO);
    const manage = r.modules.find((m) => m.id === "manage");
    expect(manage).toBeDefined();
    expect(manage!.controllerNamespace).toBeNull();
  });

  it("lists controllers under each module's controllers/ dir with actions", async () => {
    const r = await analyzeYiiModules(REPO);
    const api = r.modules.find((m) => m.id === "api");
    expect(api!.controllers.length).toBe(1);
    const ctrl = api!.controllers[0]!;
    expect(ctrl.file).toBe("modules/api/controllers/UserController.php");
    expect(ctrl.actions.sort()).toEqual([
      "actionCreate",
      "actionIndex",
      "actionView",
    ]);
  });

  it("counts views_count per module", async () => {
    const r = await analyzeYiiModules(REPO);
    const api = r.modules.find((m) => m.id === "api");
    expect(api!.views_count).toBeGreaterThanOrEqual(1);
  });

  it("captures migrations_path + count when migrations dir exists", async () => {
    const r = await analyzeYiiModules(REPO);
    const api = r.modules.find((m) => m.id === "api");
    expect(api!.migrations_path).toBe("modules/api/migrations");
    expect(api!.migrations_count).toBe(1);
  });

  it("returns null migrations_path when no migrations dir", async () => {
    const r = await analyzeYiiModules(REPO);
    const manage = r.modules.find((m) => m.id === "manage");
    expect(manage!.migrations_path).toBeNull();
    expect(manage!.migrations_count).toBe(0);
  });

  it("detects nested sub-modules", async () => {
    const r = await analyzeYiiModules(REPO);
    const api = r.modules.find((m) => m.id === "api");
    expect(api!.submodules).toContain("v2");
    // The v2 sub-module should also appear as its own top-level module entry
    // (since it has its own Module.php).
    expect(r.modules.some((m) => m.id === "v2")).toBe(true);
  });

  it("captures URL prefixes from urlManager config", async () => {
    const r = await analyzeYiiModules(REPO);
    const api = r.modules.find((m) => m.id === "api");
    const manage = r.modules.find((m) => m.id === "manage");
    expect(api!.url_prefixes).toContain("api");
    expect(manage!.url_prefixes).toContain("manage");
  });

  it("respects module_id filter", async () => {
    const r = await analyzeYiiModules(REPO, { module_id: "api" });
    expect(r.modules.length).toBe(1);
    expect(r.modules[0]!.id).toBe("api");
  });

  it("returns modules sorted by id", async () => {
    const r = await analyzeYiiModules(REPO);
    const ids = r.modules.map((m) => m.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});
