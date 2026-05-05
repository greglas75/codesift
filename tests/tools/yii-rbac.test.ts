/**
 * Tests for analyzeYiiRbac (N3).
 *
 * Fixture covers:
 *   - migration with 3 permission defs (viewUser, editUser, unusedSeed) +
 *     2 role defs (admin, editor) + 2 dynamic creates
 *   - UserController with AccessControl listing ['viewUser', 'orphanedCheck']
 *     and a code can('editUser') call — produces:
 *       * orphan_check: orphanedCheck
 *       * unused_definition: unusedSeed
 *       * editUser is checked AND defined — clean
 *   - PublicController without behaviors() — flagged
 *   - MaintenanceController with behaviors() but no AccessControl + no can() — flagged
 */
import { describe, it, expect, beforeAll } from "vitest";
import { join, resolve } from "node:path";
import { indexFolder } from "../../src/tools/index-tools.js";
import { analyzeYiiRbac } from "../../src/tools/yii-rbac-tools.js";

const FIXTURE_ROOT = resolve(
  join(__dirname, "..", "fixtures", "php-yii-rbac"),
);
const REPO = "local/php-yii-rbac";

describe("analyzeYiiRbac", () => {
  beforeAll(async () => {
    await indexFolder(FIXTURE_ROOT);
  });

  it("returns a structured RBAC audit", async () => {
    const r = await analyzeYiiRbac(REPO);
    expect(r.repo).toBe(REPO);
    expect(r.summary.total_permissions).toBeGreaterThanOrEqual(3);
    expect(r.summary.total_roles).toBeGreaterThanOrEqual(2);
    expect(r.summary.total_checks).toBeGreaterThanOrEqual(3);
  });

  it("captures permission definitions from createPermission(...) calls", async () => {
    const r = await analyzeYiiRbac(REPO);
    const names = r.definitions
      .filter((d) => d.kind === "permission")
      .map((d) => d.name);
    expect(names).toContain("viewUser");
    expect(names).toContain("editUser");
    expect(names).toContain("unusedSeed");
  });

  it("captures role definitions from createRole(...) calls", async () => {
    const r = await analyzeYiiRbac(REPO);
    const names = r.definitions
      .filter((d) => d.kind === "role")
      .map((d) => d.name);
    expect(names).toContain("admin");
    expect(names).toContain("editor");
  });

  it("surfaces dynamic createPermission($var) calls separately", async () => {
    const r = await analyzeYiiRbac(REPO);
    expect(r.dynamic_creates.length).toBeGreaterThanOrEqual(1);
    expect(r.dynamic_creates[0]!.file).toContain("init_rbac.php");
  });

  it("captures Yii::$app->user->can() calls as code-source checks", async () => {
    const r = await analyzeYiiRbac(REPO);
    const codeChecks = r.checks.filter((c) => c.source === "code");
    expect(codeChecks.map((c) => c.name)).toContain("editUser");
    expect(codeChecks[0]!.file).toContain("UserController.php");
  });

  it("captures AccessControl 'permissions' => [...] entries as access-control checks", async () => {
    const r = await analyzeYiiRbac(REPO);
    const acChecks = r.checks.filter((c) => c.source === "access-control");
    const names = acChecks.map((c) => c.name);
    expect(names).toContain("viewUser");
    expect(names).toContain("orphanedCheck");
  });

  it("computes orphan_checks for permissions checked but never defined", async () => {
    const r = await analyzeYiiRbac(REPO);
    expect(r.orphan_checks).toContain("orphanedCheck");
    // editUser is defined, so it should NOT be in orphan_checks.
    expect(r.orphan_checks).not.toContain("editUser");
    // viewUser is defined.
    expect(r.orphan_checks).not.toContain("viewUser");
  });

  it("computes unused_definitions for permissions defined but never checked", async () => {
    const r = await analyzeYiiRbac(REPO);
    expect(r.unused_definitions).toContain("unusedSeed");
    // viewUser appears in AccessControl — used.
    expect(r.unused_definitions).not.toContain("viewUser");
    // editUser is checked via can() — used.
    expect(r.unused_definitions).not.toContain("editUser");
  });

  it("flags PublicController as no-behaviors (no behaviors() method)", async () => {
    const r = await analyzeYiiRbac(REPO);
    const found = r.controllers_without_access_control.find(
      (c) => c.class === "PublicController",
    );
    expect(found).toBeDefined();
    expect(found!.reason).toBe("no-behaviors");
  });

  it("flags MaintenanceController as no-access-control-in-behaviors", async () => {
    const r = await analyzeYiiRbac(REPO);
    const found = r.controllers_without_access_control.find(
      (c) => c.class === "MaintenanceController",
    );
    expect(found).toBeDefined();
    expect(found!.reason).toBe("no-access-control-in-behaviors");
  });

  it("does NOT flag UserController (has AccessControl)", async () => {
    const r = await analyzeYiiRbac(REPO);
    const found = r.controllers_without_access_control.find(
      (c) => c.class === "UserController",
    );
    expect(found).toBeUndefined();
  });

  it("aggregates summary counts", async () => {
    const r = await analyzeYiiRbac(REPO);
    expect(r.summary.orphan_check_count).toBe(r.orphan_checks.length);
    expect(r.summary.unused_definition_count).toBe(r.unused_definitions.length);
    expect(r.summary.unsafe_controller_count).toBe(
      r.controllers_without_access_control.length,
    );
  });
});
