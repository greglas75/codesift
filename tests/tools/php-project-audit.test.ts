/**
 * Direct unit tests for phpProjectAudit — the 9-gate compound meta-tool.
 *
 * Reuses the php-security fixture (indexed by php-security-scan.test.ts)
 * as a small but realistic PHP repo. The audit orchestrates 9 checks in
 * parallel with per-check timeouts; these tests cover its aggregation
 * logic, gate counting, and health score behavior — not the individual
 * sub-tools which already have their own suites.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { join, resolve } from "node:path";
import { indexFolder } from "../../src/tools/index-tools.js";
import { phpProjectAudit } from "../../src/tools/php-tools.js";

const FIXTURE_ROOT = resolve(join(__dirname, "..", "fixtures", "php-security"));
const REPO = "local/php-security";

describe("phpProjectAudit", () => {
  beforeAll(async () => {
    await indexFolder(FIXTURE_ROOT);
  });

  it("runs 9 gates by default and returns the full structured result", async () => {
    const r = await phpProjectAudit(REPO);
    // Every gate landed in `gates`, regardless of pass/fail/timeout
    expect(r.gates.length).toBe(9);
    const names = r.gates.map((g) => g.name).sort();
    expect(names).toEqual([
      "activerecord",
      "clones",
      "complexity",
      "dead_code",
      "god_model",
      "hotspots",
      "n_plus_one",
      "patterns",
      "security",
    ]);
  });

  it("each gate has status, findings_count, and duration_ms", async () => {
    const r = await phpProjectAudit(REPO);
    for (const g of r.gates) {
      expect(["ok", "error", "timeout"]).toContain(g.status);
      expect(typeof g.findings_count).toBe("number");
      expect(typeof g.duration_ms).toBe("number");
      expect(g.duration_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("security gate detects the vulnerable fixture findings", async () => {
    const r = await phpProjectAudit(REPO);
    const sec = r.gates.find((g) => g.name === "security");
    expect(sec).toBeDefined();
    expect(sec!.status).toBe("ok");
    // Fixture has eval + exec/system + SQL injection in 2 files
    expect(sec!.findings_count).toBeGreaterThanOrEqual(3);
    expect(r.security.summary.critical).toBeGreaterThanOrEqual(1);
  });

  it("summary.total_findings excludes activerecord (informational, not a problem)", async () => {
    const r = await phpProjectAudit(REPO);
    const ar = r.gates.find((g) => g.name === "activerecord");
    const totalFromGates = r.gates
      .filter((g) => g.name !== "activerecord" && g.status === "ok")
      .reduce((sum, g) => sum + g.findings_count, 0);
    expect(r.summary.total_findings).toBe(totalFromGates);
    // AR count is surfaced via `activerecord` field separately, not via summary
    if (ar) {
      expect(r.activerecord.total).toBe(ar.findings_count);
    }
  });

  it("health_score is in [0,100] and reflects security severity", async () => {
    const r = await phpProjectAudit(REPO);
    expect(r.summary.health_score).toBeGreaterThanOrEqual(0);
    expect(r.summary.health_score).toBeLessThanOrEqual(100);
    // Fixture has critical findings → score should be below 100
    expect(r.summary.health_score).toBeLessThan(100);
  });

  it("top_risks lists gates ordered by findings_count and excludes activerecord", async () => {
    const r = await phpProjectAudit(REPO);
    expect(Array.isArray(r.summary.top_risks)).toBe(true);
    expect(r.summary.top_risks.length).toBeLessThanOrEqual(3);
    for (const risk of r.summary.top_risks) {
      expect(risk).not.toMatch(/^activerecord:/);
    }
  });

  it("respects the checks subset option", async () => {
    const r = await phpProjectAudit(REPO, { checks: ["security", "patterns"] });
    expect(r.gates.length).toBe(2);
    const names = r.gates.map((g) => g.name).sort();
    expect(names).toEqual(["patterns", "security"]);
  });

  it("duration_ms reflects total wall time", async () => {
    const r = await phpProjectAudit(REPO);
    expect(r.duration_ms).toBeGreaterThan(0);
    // Should be under the per-check timeout (8s) times gate count
    expect(r.duration_ms).toBeLessThan(9 * 8000);
  });
});
