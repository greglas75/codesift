import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { indexFolder } from "../../src/tools/index-tools.js";
import { reactQuickstart } from "../../src/tools/react-tools.js";
import { searchPatterns } from "../../src/tools/pattern-tools.js";
import { resetConfigCache } from "../../src/config.js";

/**
 * Tier 5 — Vendored corpus baseline integration test (Task 14 of plan-revision 5).
 *
 * Runs reactQuickstart on the committed fixture corpus at tests/fixtures/react-tier5/
 * and asserts:
 *   - critical_issues.length === baseline.count (committed snapshot)
 *   - style_issues.length > 0 (Success-5: at least one style-bucket entry)
 *   - warnings.length > 0 (derived-state + context-provider-value-inline fire)
 *   - per-pattern hit counts match expectation
 *
 * The baseline JSON is committed alongside the fixtures and re-running this command
 * on a clean worktree must produce the same count value (deterministic — fixtures are
 * committed and indexer behavior is reproducible).
 *
 * Pre-RED bootstrap: the test file is created with a placeholder count of -1 so the
 * RED phase fails on assertion mismatch (not ENOENT). The GREEN step overwrites with
 * the real captured value.
 */

const FIXTURE_DIR = "tests/fixtures/react-tier5";
const BASELINE_PATH = join(FIXTURE_DIR, "baseline-critical-count.json");
const REPO_ID = "local/react-tier5";

interface Baseline {
  count: number;
  captured_at: string;
  fixture_dir: string;
  plan_revision: number;
  per_pattern?: Record<string, number>;
}

describe("react-tier5 baseline (Tier 5 — Task 14)", () => {
  // Per-test-run isolated data dir — process PID + timestamp prevents cross-worker race
  // (codex-5.3 + gemini Run finding: shared `.tmp-react-tier5-test` caused worker pollution).
  const TEST_DATA_DIR = join(process.cwd(), `.tmp-react-tier5-${process.pid}-${Date.now()}`);
  let prevDataDir: string | undefined;

  beforeAll(async () => {
    prevDataDir = process.env["CODESIFT_DATA_DIR"];
    process.env["CODESIFT_DATA_DIR"] = TEST_DATA_DIR;
    resetConfigCache();
    await indexFolder(FIXTURE_DIR, { watch: false });
  });

  afterAll(() => {
    // Restore env (gemini finding: leaks to subsequent suites otherwise)
    if (prevDataDir === undefined) {
      delete process.env["CODESIFT_DATA_DIR"];
    } else {
      process.env["CODESIFT_DATA_DIR"] = prevDataDir;
    }
    resetConfigCache();
    try {
      rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it("baseline JSON file exists at the documented path", () => {
    expect(existsSync(BASELINE_PATH)).toBe(true);
  });

  it("react_quickstart on vendored corpus matches baseline aggregate + per-pattern counts", async () => {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) as Baseline;
    const result = await reactQuickstart(REPO_ID);

    // Ship-5: aggregate count
    expect(result.critical_issues.length).toBe(baseline.count);

    // Success-5: at least one style-bucket entry
    expect(result.style_issues.length).toBeGreaterThan(0);
    // Tier 5 warnings bucket should also fire
    expect(result.warnings.length).toBeGreaterThan(0);

    // Per-pattern assertions (gemini Run 6 CRITICAL — aggregate count alone misses
    // partial regressions where one pattern degrades while another over-fires).
    if (baseline.per_pattern) {
      const allHits = [
        ...result.critical_issues,
        ...result.warnings,
        ...result.style_issues,
      ];
      const actualByPattern = new Map<string, number>();
      for (const h of allHits) {
        actualByPattern.set(h.pattern, (actualByPattern.get(h.pattern) ?? 0) + h.count);
      }
      for (const [pattern, expectedCount] of Object.entries(baseline.per_pattern)) {
        expect(actualByPattern.get(pattern) ?? 0).toBe(expectedCount);
      }
    }
  });

  // Helper for negative assertions: guards against silent truncation by max_results.
  // gemini Run 6 CRITICAL — if regex regression matched 100 files and only 20 returned,
  // the target file might be truncated out and `.some() === false` would falsely pass.
  // The MAX_RESULTS=50 here is comfortably above any reasonable fixture-corpus hit count.
  const MAX_RESULTS = 50;

  it("derived-state fires on canonical fixture, NOT on seed-only", async () => {
    const result = await searchPatterns(REPO_ID, "derived-state", { max_results: MAX_RESULTS });
    expect(result.matches.length).toBeLessThan(MAX_RESULTS); // truncation guard
    const files = result.matches.map((m) => m.file);
    expect(files.some((f) => f.includes("derived-state-canonical.tsx"))).toBe(true);
    expect(files.some((f) => f.includes("derived-state-seed-only.tsx"))).toBe(false);
  });

  it("context-provider-value-inline fires on inline form, NOT on memoized form", async () => {
    const result = await searchPatterns(REPO_ID, "context-provider-value-inline", { max_results: MAX_RESULTS });
    expect(result.matches.length).toBeLessThan(MAX_RESULTS);
    const files = result.matches.map((m) => m.file);
    expect(files.some((f) => f.includes("context-provider-inline.tsx"))).toBe(true);
    expect(files.some((f) => f.includes("context-provider-memoized.tsx"))).toBe(false);
  });

  it("jsx-no-target-blank postFilter drops match with rel=noopener noreferrer", async () => {
    const result = await searchPatterns(REPO_ID, "jsx-no-target-blank", { max_results: MAX_RESULTS });
    expect(result.matches.length).toBeLessThan(MAX_RESULTS);
    const files = result.matches.map((m) => m.file);
    expect(files.some((f) => f.includes("target-blank-no-rel.tsx"))).toBe(true);
    expect(files.some((f) => f.includes("target-blank-with-rel.tsx"))).toBe(false);
  });

  it("button-no-type fires on bare and attribute forms, NOT on type=\"button\"", async () => {
    const result = await searchPatterns(REPO_ID, "button-no-type", { max_results: MAX_RESULTS });
    expect(result.matches.length).toBeLessThan(MAX_RESULTS);
    const files = result.matches.map((m) => m.file);
    expect(files.some((f) => f.includes("button-no-type-bare.tsx"))).toBe(true);
    expect(files.some((f) => f.includes("button-no-type-with-attrs.tsx"))).toBe(true);
    expect(files.some((f) => f.includes("button-with-type.tsx"))).toBe(false);
  });
});

/**
 * Capture script — manually invoke when patterns change to refresh the baseline:
 *
 *   npx vitest run tests/integration/react-tier5-baseline.test.ts -t "CAPTURE"
 *
 * This re-writes baseline-critical-count.json with the current values. Skipped by
 * default (only runs when REACT_TIER5_CAPTURE_BASELINE=1 is set).
 */
describe.skipIf(process.env["REACT_TIER5_CAPTURE_BASELINE"] !== "1")("baseline capture (manual)", () => {
  it("CAPTURE: refreshes baseline-critical-count.json", async () => {
    const captureDataDir = join(process.cwd(), `.tmp-react-tier5-capture-${process.pid}-${Date.now()}`);
    process.env["CODESIFT_DATA_DIR"] = captureDataDir;
    resetConfigCache();
    try {
      await indexFolder(FIXTURE_DIR, { watch: false });
      const result = await reactQuickstart(REPO_ID);
      // Sum counts per pattern across buckets — Object.fromEntries silently overwrites
      // duplicate keys (cursor-agent Run 6 finding).
      const perPattern = new Map<string, number>();
      for (const h of [...result.critical_issues, ...result.warnings, ...result.style_issues]) {
        perPattern.set(h.pattern, (perPattern.get(h.pattern) ?? 0) + h.count);
      }
      const newBaseline: Baseline = {
        count: result.critical_issues.length,
        captured_at: new Date().toISOString(),
        fixture_dir: FIXTURE_DIR,
        plan_revision: 5,
        per_pattern: Object.fromEntries(perPattern),
      };
      writeFileSync(BASELINE_PATH, JSON.stringify(newBaseline, null, 2) + "\n");
      expect(existsSync(BASELINE_PATH)).toBe(true);
    } finally {
      try {
        rmSync(captureDataDir, { recursive: true, force: true });
      } catch { /* best effort */ }
    }
  });
});
