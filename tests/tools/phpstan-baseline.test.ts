/**
 * Tests for analyzePhpStanBaseline (N6).
 *
 * Fixture mirrors the format that PHPStan emits: parameters → ignoreErrors
 * with quoted message regexes, integer counts, and unquoted file paths.
 * Covers both single-file (8 entries across 4 files) and verifies
 * categorization, quick_wins, by_path ordering, and graceful fallback
 * when no baseline file exists.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { join, resolve } from "node:path";
import { indexFolder } from "../../src/tools/index-tools.js";
import { analyzePhpStanBaseline } from "../../src/tools/phpstan-baseline-tools.js";

const FIXTURE_ROOT = resolve(
  join(__dirname, "..", "fixtures", "php-phpstan-baseline"),
);
const REPO = "local/php-phpstan-baseline";

const NO_BASELINE_ROOT = resolve(
  join(__dirname, "..", "fixtures", "php-services"), // existing fixture without phpstan-baseline.neon
);
const NO_BASELINE_REPO = "local/php-services";

describe("analyzePhpStanBaseline", () => {
  beforeAll(async () => {
    await indexFolder(FIXTURE_ROOT);
    await indexFolder(NO_BASELINE_ROOT);
  });

  it("locates and parses phpstan-baseline.neon", async () => {
    const r = await analyzePhpStanBaseline(REPO);
    expect(r.repo).toBe(REPO);
    expect(r.baseline_file).toBe("phpstan-baseline.neon");
    expect(r.parse_warnings.length).toBe(0);
  });

  it("aggregates total_ignored from all entry counts", async () => {
    const r = await analyzePhpStanBaseline(REPO);
    // Fixture has counts: 1+1+1+1+1+5+2+1 = 13
    expect(r.total_ignored).toBe(13);
    expect(r.total_files).toBe(4);
  });

  it("ranks files by error count (by_path)", async () => {
    const r = await analyzePhpStanBaseline(REPO);
    const paths = r.by_path.map((p) => p.path);
    // UserService has 5+2 = 7; PublicAsset 3; BuildController 2; Survey 1.
    expect(paths[0]).toContain("UserService.php");
    expect(r.by_path[0]!.count).toBe(7);
    expect(paths[1]).toContain("PublicAsset.php");
    expect(r.by_path[1]!.count).toBe(3);
  });

  it("identifies quick_wins (files with ≤3 errors)", async () => {
    const r = await analyzePhpStanBaseline(REPO);
    const winPaths = r.quick_wins.map((q) => q.path);
    expect(winPaths).toContain("models/Survey.php");
    expect(winPaths).toContain("commands/BuildController.php");
    expect(winPaths).toContain("assets/PublicAsset.php");
    // UserService has 7 — not a quick win
    expect(winPaths).not.toContain("components/UserService.php");
    // Quick wins sorted ascending by count
    let prev = 0;
    for (const w of r.quick_wins) {
      expect(w.count).toBeGreaterThanOrEqual(prev);
      prev = w.count;
    }
  });

  it("classifies messages into categories", async () => {
    const r = await analyzePhpStanBaseline(REPO);
    expect(r.by_category["no-return-type"]).toBeGreaterThanOrEqual(4);
    expect(r.by_category["iterable-no-value-type"]).toBeGreaterThanOrEqual(2);
    expect(r.by_category["undefined-property"]).toBeGreaterThanOrEqual(5);
    expect(r.by_category["undefined-method"]).toBeGreaterThanOrEqual(2);
  });

  it("returns full entries list sorted by count descending", async () => {
    const r = await analyzePhpStanBaseline(REPO);
    let prev = Infinity;
    for (const e of r.entries) {
      expect(e.count).toBeLessThanOrEqual(prev);
      prev = e.count;
    }
  });

  it("attaches categories to each quick-win entry", async () => {
    const r = await analyzePhpStanBaseline(REPO);
    const survey = r.quick_wins.find((q) => q.path.includes("Survey.php"));
    expect(survey).toBeDefined();
    expect(survey!.categories).toContain("no-return-type");
  });

  it("falls back gracefully when baseline file is missing", async () => {
    const r = await analyzePhpStanBaseline(NO_BASELINE_REPO);
    expect(r.baseline_file).toBeNull();
    expect(r.total_ignored).toBe(0);
    expect(r.parse_warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("respects max_paths option", async () => {
    const r = await analyzePhpStanBaseline(REPO, { max_paths: 2 });
    expect(r.by_path.length).toBeLessThanOrEqual(2);
  });

  it("accepts explicit baseline_path override", async () => {
    const r = await analyzePhpStanBaseline(REPO, {
      baseline_path: "phpstan-baseline.neon",
    });
    expect(r.baseline_file).toBe("phpstan-baseline.neon");
    expect(r.total_ignored).toBe(13);
  });
});
