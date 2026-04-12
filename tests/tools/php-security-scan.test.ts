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

  it("runs all 8 PHP security patterns in parallel and returns a result shape", async () => {
    const r = await phpSecurityScan(REPO);
    expect(r.checks_run).toHaveLength(8);
    expect(r.checks_run).toEqual(
      expect.arrayContaining([
        "sql-injection-php",
        "xss-php",
        "eval-php",
        "exec-php",
        "unserialize-php",
        "file-include-var",
        "unescaped-yii-view",
        "raw-query-yii",
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
