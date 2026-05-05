/**
 * Tests for findPhp8MigrationCandidates (M1).
 *
 * Fixture exercises one canonical case per rule, plus negative cases:
 *   - PromotableUser:      ctor body is pure self-assignments → flagged
 *   - DocblockProperty:    @var T (3 plain) + @var T|null (2 nullable)
 *   - ReadonlyCandidate:   2 props assigned only in ctor + 1 with setter
 *                          (only the 2 should be flagged readonly)
 *   - StatusEnum:          4 string-literal consts + getValues() → backed enum
 *   - SwitchToMatch:       3 case-return clauses, no break → match candidate
 */
import { describe, it, expect, beforeAll } from "vitest";
import { join, resolve } from "node:path";
import { indexFolder } from "../../src/tools/index-tools.js";
import { findPhp8MigrationCandidates } from "../../src/tools/php8-migration-candidates-tools.js";

const FIXTURE_ROOT = resolve(
  join(__dirname, "..", "fixtures", "php-m1-candidates"),
);
const REPO = "local/php-m1-candidates";

describe("findPhp8MigrationCandidates", () => {
  beforeAll(async () => {
    await indexFolder(FIXTURE_ROOT);
  });

  it("returns structured shape", async () => {
    const r = await findPhp8MigrationCandidates(REPO);
    expect(r.repo).toBe(REPO);
    expect(r.scanned_files).toBeGreaterThan(0);
    expect(r.total_candidates).toBeGreaterThan(0);
    expect(Array.isArray(r.by_rule)).toBe(true);
  });

  it("flags promotable-ctor on pure self-assignment ctor", async () => {
    const r = await findPhp8MigrationCandidates(REPO);
    const hits = r.candidates.filter((c) => c.rule_id === "promotable-ctor");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.file).toContain("PromotableUser.php");
    expect(hits[0]!.confidence).toBe("high");
  });

  it("flags docblock-to-typed-property for plain @var T (skipping nullable)", async () => {
    const r = await findPhp8MigrationCandidates(REPO);
    const hits = r.candidates.filter(
      (c) => c.rule_id === "docblock-to-typed-property",
    );
    // 3 plain @var (string, int, bool); the 2 |null land in nullable rule.
    expect(hits.length).toBeGreaterThanOrEqual(3);
    const types = hits.map((h) => h.suggested_replacement);
    expect(types.some((t) => t.includes("string"))).toBe(true);
    expect(types.some((t) => t.includes("int"))).toBe(true);
    expect(types.some((t) => t.includes("bool"))).toBe(true);
  });

  it("flags nullable-flag-to-syntax for @var T|null", async () => {
    const r = await findPhp8MigrationCandidates(REPO);
    const hits = r.candidates.filter(
      (c) => c.rule_id === "nullable-flag-to-syntax",
    );
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]!.suggested_replacement).toContain("?");
  });

  it("flags readonly-candidate for ctor-only assigned properties", async () => {
    const r = await findPhp8MigrationCandidates(REPO);
    const hits = r.candidates.filter((c) => c.rule_id === "readonly-candidate");
    // name + createdAt should be flagged, mutated should NOT.
    expect(hits.length).toBeGreaterThanOrEqual(2);
    const names = hits.map((h) => h.snippet);
    expect(names.some((s) => /\$name/.test(s))).toBe(true);
    expect(names.some((s) => /\$createdAt/.test(s))).toBe(true);
    expect(names.some((s) => /\$mutated/.test(s))).toBe(false);
  });

  it("flags enum-from-class-consts on bag-of-constants class", async () => {
    const r = await findPhp8MigrationCandidates(REPO);
    const hits = r.candidates.filter(
      (c) => c.rule_id === "enum-from-class-consts",
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.file).toContain("StatusEnum.php");
    expect(hits[0]!.confidence).toBe("high"); // has getValues() helper
  });

  it("flags match-from-switch on switch with all-return cases", async () => {
    const r = await findPhp8MigrationCandidates(REPO);
    const hits = r.candidates.filter((c) => c.rule_id === "match-from-switch");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.file).toContain("SwitchToMatch.php");
  });

  it("groups by_rule with sample cap", async () => {
    const r = await findPhp8MigrationCandidates(REPO, { max_samples_per_rule: 1 });
    for (const group of r.by_rule) {
      expect(group.samples.length).toBeLessThanOrEqual(1);
    }
  });

  it("respects rules filter", async () => {
    const r = await findPhp8MigrationCandidates(REPO, {
      rules: ["readonly-candidate"],
    });
    for (const c of r.candidates) {
      expect(c.rule_id).toBe("readonly-candidate");
    }
  });

  it("by_rule sorted by count descending", async () => {
    const r = await findPhp8MigrationCandidates(REPO);
    let prev = Infinity;
    for (const g of r.by_rule) {
      expect(g.count).toBeLessThanOrEqual(prev);
      prev = g.count;
    }
  });
});
