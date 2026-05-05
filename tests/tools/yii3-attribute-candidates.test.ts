/**
 * Tests for findYii3AttributeCandidates (M2).
 *
 * Fixture: Post.php with both behaviors() (TimestampBehavior +
 * BlameableBehavior) and rules() with 4 entries (mix of single+list field,
 * multiple validators), plus config/web.php with 4 urlManager rules.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { join, resolve } from "node:path";
import { indexFolder } from "../../src/tools/index-tools.js";
import { findYii3AttributeCandidates } from "../../src/tools/yii3-attribute-candidates-tools.js";

const FIXTURE_ROOT = resolve(
  join(__dirname, "..", "fixtures", "php-m2-attributes"),
);
const REPO = "local/php-m2-attributes";

describe("findYii3AttributeCandidates", () => {
  beforeAll(async () => {
    await indexFolder(FIXTURE_ROOT);
  });

  it("returns structured shape", async () => {
    const r = await findYii3AttributeCandidates(REPO);
    expect(r.repo).toBe(REPO);
    expect(r.scanned_files).toBeGreaterThan(0);
    expect(r.total_candidates).toBeGreaterThan(0);
  });

  it("flags behaviors() with TimestampBehavior + BlameableBehavior", async () => {
    const r = await findYii3AttributeCandidates(REPO);
    const hits = r.candidates.filter((c) => c.rule_id === "behaviors-to-attributes");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.suggested_replacement).toContain("Behavior(TimestampBehavior::class)");
    expect(hits[0]!.suggested_replacement).toContain("Behavior(BlameableBehavior::class)");
  });

  it("flags rules() entries with their target fields", async () => {
    const r = await findYii3AttributeCandidates(REPO);
    const hits = r.candidates.filter((c) => c.rule_id === "rules-to-attributes");
    // 4 rule rows × distinct fields: title, body, author_email
    expect(hits.length).toBeGreaterThanOrEqual(3);
    const fields = hits.map((h) => h.current_form);
    expect(fields.some((f) => /title/.test(f))).toBe(true);
    expect(fields.some((f) => /body/.test(f))).toBe(true);
    expect(fields.some((f) => /author_email/.test(f))).toBe(true);
  });

  it("maps known validators to canonical attribute names", async () => {
    const r = await findYii3AttributeCandidates(REPO);
    const emailHit = r.candidates.find(
      (c) =>
        c.rule_id === "rules-to-attributes" &&
        c.current_form.includes("author_email") &&
        c.current_form.includes("email"),
    );
    expect(emailHit).toBeDefined();
    expect(emailHit!.suggested_replacement).toContain("Email");
  });

  it("flags urlManager rules and converts <id:\\d+> to {id}", async () => {
    const r = await findYii3AttributeCandidates(REPO);
    const routes = r.candidates.filter(
      (c) => c.rule_id === "urlmanager-rule-to-route",
    );
    expect(routes.length).toBeGreaterThanOrEqual(3);
    const idRoute = routes.find((r) => r.current_form.includes("posts/<id"));
    expect(idRoute).toBeDefined();
    expect(idRoute!.suggested_replacement).toContain("/api/posts/{id}");
    expect(idRoute!.blockers).toContain(
      "rule has inline regex constraint — re-encode with Yii3 typed route",
    );
  });

  it("includes HTTP method in route attribute when present", async () => {
    const r = await findYii3AttributeCandidates(REPO);
    const postRoute = r.candidates.find(
      (c) =>
        c.rule_id === "urlmanager-rule-to-route" &&
        c.current_form.includes("POST"),
    );
    expect(postRoute).toBeDefined();
    expect(postRoute!.suggested_replacement).toContain("method: 'POST'");
  });

  it("groups by_rule with sample cap", async () => {
    const r = await findYii3AttributeCandidates(REPO, { max_samples_per_rule: 1 });
    for (const g of r.by_rule) {
      expect(g.samples.length).toBeLessThanOrEqual(1);
    }
  });

  it("respects rules filter", async () => {
    const r = await findYii3AttributeCandidates(REPO, {
      rules: ["urlmanager-rule-to-route"],
    });
    for (const c of r.candidates) {
      expect(c.rule_id).toBe("urlmanager-rule-to-route");
    }
  });

  it("by_rule sorted by count descending", async () => {
    const r = await findYii3AttributeCandidates(REPO);
    let prev = Infinity;
    for (const g of r.by_rule) {
      expect(g.count).toBeLessThanOrEqual(prev);
      prev = g.count;
    }
  });
});
