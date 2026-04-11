import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanDmlSafety } from "../../src/tools/sql-tools.js";
import { indexFolder } from "../../src/tools/index-tools.js";

describe("scanDmlSafety", () => {
  let DATA_DIR: string;
  let TMP: string;
  let repoName: string;

  beforeEach(async () => {
    DATA_DIR = join(tmpdir(), "codesift-dml-data-" + process.hrtime.bigint());
    process.env["CODESIFT_DATA_DIR"] = DATA_DIR;
    TMP = join(tmpdir(), "codesift-dml-" + process.hrtime.bigint());
    mkdirSync(TMP, { recursive: true });

    writeFileSync(join(TMP, "app.ts"), `
// Safe patterns
const safeQuery = "DELETE FROM sessions WHERE expired_at < NOW()";
const safeUpdate = "UPDATE users SET active = false WHERE id = $1";
const safeSelect = "SELECT id, name FROM users WHERE org_id = ?";

// Unsafe patterns
const unsafeDelete = "DELETE FROM users";
const unsafeUpdate = "UPDATE orders SET status = 'cancelled'";
const unsafeSelect = "SELECT * FROM large_table";
`);

    writeFileSync(join(TMP, "migration.sql"), `
-- Safe: migration context
DELETE FROM old_sessions;
UPDATE legacy_table SET migrated = true;
`);

    const r = await indexFolder(TMP, { watch: false });
    repoName = r.repo;
  }, 30_000);

  afterEach(() => {
    delete process.env["CODESIFT_DATA_DIR"];
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("flags DELETE without WHERE", async () => {
    const result = await scanDmlSafety(repoName);
    const found = result.findings.find(
      (f) => f.rule === "delete-without-where",
    );
    expect(found).toBeDefined();
    expect(found!.severity).toBe("high");
  });

  it("flags UPDATE without WHERE", async () => {
    const result = await scanDmlSafety(repoName);
    const found = result.findings.find(
      (f) => f.rule === "update-without-where",
    );
    expect(found).toBeDefined();
    expect(found!.severity).toBe("high");
  });

  it("flags SELECT * (unbounded)", async () => {
    const result = await scanDmlSafety(repoName);
    const found = result.findings.find(
      (f) => f.rule === "select-star",
    );
    expect(found).toBeDefined();
    expect(found!.severity).toBe("info");
  });

  it("does NOT flag safe queries (with WHERE)", async () => {
    const result = await scanDmlSafety(repoName);
    // Safe patterns shouldn't trigger findings for the same rule+line
    const safeDel = result.findings.filter(
      (f) => f.rule === "delete-without-where" && f.context?.includes("expired_at"),
    );
    expect(safeDel).toHaveLength(0);
  });

  it("throws on unindexed repo", async () => {
    await expect(scanDmlSafety("nonexistent-xyz")).rejects.toThrow(/not found/i);
  });
});
