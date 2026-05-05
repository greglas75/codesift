/**
 * Direct unit tests for phpSecurityScan.
 *
 * phpSecurityScan fans out 8 pattern checks in parallel against the index.
 * We use a real fixture with known vulnerabilities so the pattern matcher
 * sees real source, not mocked strings.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { join, resolve } from "node:path";
import { indexFolder } from "../../src/tools/index-tools.js";
import { phpSecurityScan } from "../../src/tools/php-tools.js";

const FIXTURE_ROOT = resolve(join(__dirname, "..", "fixtures", "php-security"));
const REPO = "local/php-security";

describe("phpSecurityScan", () => {
  beforeAll(async () => {
    await indexFolder(FIXTURE_ROOT);
  });

  it("runs all PHP/Yii2 security patterns in parallel and returns a result shape", async () => {
    const r = await phpSecurityScan(REPO);
    // Sprint 2 expanded the catalog from 8 to 20 patterns. The original 8
    // are kept first; assert their presence rather than total count, so
    // future additions don't break this contract test.
    expect(r.checks_run.length).toBeGreaterThanOrEqual(20);
    expect(r.checks_run).toEqual(
      expect.arrayContaining([
        // Original 8
        "sql-injection-php",
        "xss-php",
        "eval-php",
        "exec-php",
        "unserialize-php",
        "file-include-var",
        "unescaped-yii-view",
        "raw-query-yii",
        // Sprint 2 additions
        "yii-csrf-disabled",
        "yii-debug-mode-prod",
        "yii-cookie-no-validation",
        "yii-mass-assignment-unsafe",
        "yii-raw-sql-where",
        "php-md5-password",
        "php-rand-token",
        "php-loose-comparison-secret",
        "yii-rbac-cached-permission",
        "yii-no-row-level-locking",
        "yii-config-hardcoded-secret",
        "yii-unbounded-all",
      ]),
    );
    expect(r.summary).toEqual(
      expect.objectContaining({
        critical: expect.any(Number),
        high: expect.any(Number),
        medium: expect.any(Number),
        low: expect.any(Number),
        total: expect.any(Number),
      }),
    );
  });

  describe("Sprint 2 — new Yii2/PHP security patterns", () => {
    it("flags CSRF disabled in controller", async () => {
      const r = await phpSecurityScan(REPO);
      const csrf = r.findings.filter((f) => f.pattern === "yii-csrf-disabled");
      expect(csrf.length).toBeGreaterThanOrEqual(1);
      expect(csrf[0].severity).toBe("high");
    });

    it("flags YII_DEBUG enabled in entry-point file", async () => {
      const r = await phpSecurityScan(REPO);
      const debug = r.findings.filter((f) => f.pattern === "yii-debug-mode-prod");
      expect(debug.length).toBeGreaterThanOrEqual(1);
      expect(debug[0].severity).toBe("critical");
    });

    it("flags placeholder cookieValidationKey", async () => {
      const r = await phpSecurityScan(REPO);
      const cookie = r.findings.filter(
        (f) => f.pattern === "yii-cookie-no-validation",
      );
      expect(cookie.length).toBeGreaterThanOrEqual(1);
    });

    it("flags setAttributes() with raw $_POST", async () => {
      const r = await phpSecurityScan(REPO);
      const ma = r.findings.filter(
        (f) => f.pattern === "yii-mass-assignment-unsafe",
      );
      expect(ma.length).toBeGreaterThanOrEqual(1);
    });

    it("flags ->where() with string interpolation", async () => {
      const r = await phpSecurityScan(REPO);
      const sql = r.findings.filter((f) => f.pattern === "yii-raw-sql-where");
      expect(sql.length).toBeGreaterThanOrEqual(1);
    });

    it("flags md5/sha1 on password variables", async () => {
      const r = await phpSecurityScan(REPO);
      const md5 = r.findings.filter((f) => f.pattern === "php-md5-password");
      expect(md5.length).toBeGreaterThanOrEqual(2);
    });

    it("flags rand/uniqid for token-named variables", async () => {
      const r = await phpSecurityScan(REPO);
      const tok = r.findings.filter((f) => f.pattern === "php-rand-token");
      expect(tok.length).toBeGreaterThanOrEqual(2);
    });

    it("flags loose == comparison on hash-named variable", async () => {
      const r = await phpSecurityScan(REPO);
      const cmp = r.findings.filter(
        (f) => f.pattern === "php-loose-comparison-secret",
      );
      expect(cmp.length).toBeGreaterThanOrEqual(1);
    });

    it("flags ->can() inside foreach (RBAC perf)", async () => {
      const r = await phpSecurityScan(REPO);
      const rbac = r.findings.filter(
        (f) => f.pattern === "yii-rbac-cached-permission",
      );
      expect(rbac.length).toBeGreaterThanOrEqual(1);
    });

    it("flags transaction without forUpdate row-locking", async () => {
      const r = await phpSecurityScan(REPO);
      const lock = r.findings.filter(
        (f) => f.pattern === "yii-no-row-level-locking",
      );
      expect(lock.length).toBeGreaterThanOrEqual(1);
    });

    it("flags hardcoded secret literal in config", async () => {
      const r = await phpSecurityScan(REPO);
      const sec = r.findings.filter(
        (f) => f.pattern === "yii-config-hardcoded-secret",
      );
      expect(sec.length).toBeGreaterThanOrEqual(1);
    });

    it("flags unbounded ->all() in commands/*Controller", async () => {
      const r = await phpSecurityScan(REPO);
      const all = r.findings.filter((f) => f.pattern === "yii-unbounded-all");
      expect(all.length).toBeGreaterThanOrEqual(1);
      expect(all[0].file).toContain("commands/");
    });
  });

  it("detects eval() in VulnerableController as critical", async () => {
    const r = await phpSecurityScan(REPO);
    const evals = r.findings.filter((f) => f.pattern === "eval-php");
    expect(evals.length).toBeGreaterThanOrEqual(1);
    expect(evals.every((f) => f.severity === "critical")).toBe(true);
    expect(evals.some((f) => f.file.includes("BadCode.php"))).toBe(true);
  });

  it("detects exec/system calls as critical exec-php findings", async () => {
    const r = await phpSecurityScan(REPO);
    const execs = r.findings.filter((f) => f.pattern === "exec-php");
    expect(execs.length).toBeGreaterThanOrEqual(1);
    expect(execs.every((f) => f.severity === "critical")).toBe(true);
  });

  it("respects the checks subset option", async () => {
    const r = await phpSecurityScan(REPO, { checks: ["eval-php", "exec-php"] });
    expect(r.checks_run).toEqual(["eval-php", "exec-php"]);
    // Every finding must belong to one of the two requested patterns
    for (const f of r.findings) {
      expect(["eval-php", "exec-php"]).toContain(f.pattern);
    }
  });

  it("reports zero findings for a pattern that does not match the fixture", async () => {
    // unserialize() is not used in the fixture at all
    const r = await phpSecurityScan(REPO, { checks: ["unserialize-php"] });
    expect(r.summary.total).toBe(0);
    expect(r.findings).toHaveLength(0);
  });

  it("summary totals match findings array length", async () => {
    const r = await phpSecurityScan(REPO);
    const recount =
      r.summary.critical + r.summary.high + r.summary.medium + r.summary.low;
    expect(recount).toBe(r.summary.total);
    expect(r.findings).toHaveLength(r.summary.total);
  });
});
