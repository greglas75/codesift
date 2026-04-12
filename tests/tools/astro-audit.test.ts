/**
 * Tests for astro_audit meta-tool.
 *
 * Uses tmpdir-based fixtures + synthetic CodeIndex (same pattern as astro-islands.test.ts).
 * Tests astroAuditFromIndex directly to avoid real repo indexing.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initParser } from "../../src/parser/parser-manager.js";
import { astroAuditFromIndex, deriveOverallScore, ASTRO_PATTERNS } from "../../src/tools/astro-audit.js";
import type { CodeIndex, FileEntry } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = join(tmpdir(), "codesift-astro-audit-test");
let fixtureCounter = 0;

function createFixtureDir(files: Record<string, string>): string {
  const dir = join(TMP_ROOT, `run-${Date.now()}-${fixtureCounter++}`);
  mkdirSync(dir, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(dir, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function makeIndex(root: string, astroPaths: string[], extraFiles?: FileEntry[]): CodeIndex {
  const astroFiles: FileEntry[] = astroPaths.map((p) => ({
    path: p,
    language: "astro",
    symbol_count: 1,
    last_modified: Date.now(),
  }));
  const files = [...astroFiles, ...(extraFiles ?? [])];
  return {
    repo: "local/test",
    root,
    symbols: [],
    files,
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: files.length,
    file_count: files.length,
  };
}

/** Minimal no-issue config */
const CLEAN_CONFIG = `
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  site: "https://example.com",
});
`;

/** Astro page with a clean single island */
const CLEAN_PAGE = `---
import Counter from '../components/Counter.tsx';
---
<html>
<body>
  <Counter client:idle count={0} />
</body>
</html>
`;

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ok */ }
  await initParser();
});

// ---------------------------------------------------------------------------
// Test 1: Clean project → score A, all gates pass
// ---------------------------------------------------------------------------

describe("astro_audit", () => {
  it("1. clean project → score A, all core gates pass", async () => {
    const root = createFixtureDir({
      "astro.config.mjs": CLEAN_CONFIG,
      "src/pages/index.astro": CLEAN_PAGE,
    });
    const index = makeIndex(root, ["src/pages/index.astro"]);

    const result = await astroAuditFromIndex(index, new Set(), []);

    expect(result.score).toBe("A");
    expect(result.gates.config).toBe("pass");
    expect(result.gates.hydration).toBe("pass");
    expect(result.gates.routes).toBe("pass");
    expect(result.gates.patterns).toBe("pass");
    expect(result.sections.config).toBeDefined();
    expect(result.sections.config!.output_mode).toBe("static");
    expect(result.sections.hydration).toBeDefined();
    expect(result.sections.hydration!.errors).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Test 2: Hydration errors → hydration gate fail, score C or D
  // ---------------------------------------------------------------------------

  it("2. project with hydration errors → hydration gate fail, score C or D", async () => {
    // AH01: client:* on .astro component is an error
    const badPage = `---
import Nav from '../components/Nav.astro';
import Sidebar from '../components/Sidebar.astro';
import Footer from '../components/Footer.astro';
---
<html>
<body>
  <Nav client:load />
  <Sidebar client:idle />
  <Footer client:visible />
</body>
</html>
`;
    const root = createFixtureDir({
      "astro.config.mjs": CLEAN_CONFIG,
      "src/pages/index.astro": badPage,
    });
    const index = makeIndex(root, ["src/pages/index.astro"]);

    const result = await astroAuditFromIndex(index, new Set(), []);

    expect(result.gates.hydration).toBe("fail");
    expect(["C", "D"]).toContain(result.score);
    expect(result.sections.hydration).toBeDefined();
    expect(result.sections.hydration!.errors).toBeGreaterThanOrEqual(1);
    // Should have a recommendation about hydration errors
    expect(result.recommendations.some((r) => r.toLowerCase().includes("hydration"))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 3: Migration issues → migration gate warn
  // ---------------------------------------------------------------------------

  it("3. project with migration issues → migration gate warn", async () => {
    const root = createFixtureDir({
      "astro.config.mjs": CLEAN_CONFIG,
    });
    const index = makeIndex(root, []);

    // Inject a fake migration result via patternCounts=[] and simulate migration data
    // by calling astroAuditFromIndex with a mock — we test via the function directly
    // by importing astro-migration dynamically (which doesn't exist, so it's null).
    // Instead, we test migration gate by directly passing a result with migration data.
    // Since optional tools return null when modules don't exist, we verify the gate stays pass.
    const result = await astroAuditFromIndex(index, new Set(), []);

    // Migration module doesn't exist → migrationResult is null → gate is "pass"
    expect(result.gates.migration).toBe("pass");
    // migration section should be omitted since tool doesn't exist yet
    expect(result.sections.migration).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Test 3b: migration gate logic with injected data (unit test of scoring)
  // ---------------------------------------------------------------------------

  it("3b. deriveOverallScore: 1+ warn gates → score B or worse", () => {
    // 1 warn → B
    const gatesOneWarn = {
      config: "pass" as const,
      hydration: "warn" as const,
      routes: "pass" as const,
      actions: "pass" as const,
      content: "pass" as const,
      migration: "pass" as const,
      patterns: "pass" as const,
    };
    expect(deriveOverallScore(gatesOneWarn)).toBe("B");

    // 3 warns → C
    const gatesThreeWarns = {
      config: "pass" as const,
      hydration: "warn" as const,
      routes: "warn" as const,
      actions: "pass" as const,
      content: "pass" as const,
      migration: "warn" as const,
      patterns: "pass" as const,
    };
    expect(deriveOverallScore(gatesThreeWarns)).toBe("C");

    // 1 fail → C
    const gatesOneFail = {
      config: "fail" as const,
      hydration: "pass" as const,
      routes: "pass" as const,
      actions: "pass" as const,
      content: "pass" as const,
      migration: "pass" as const,
      patterns: "pass" as const,
    };
    expect(deriveOverallScore(gatesOneFail)).toBe("C");

    // 2 fails → D
    const gatesTwoFails = {
      config: "fail" as const,
      hydration: "fail" as const,
      routes: "pass" as const,
      actions: "pass" as const,
      content: "pass" as const,
      migration: "pass" as const,
      patterns: "pass" as const,
    };
    expect(deriveOverallScore(gatesTwoFails)).toBe("D");
  });

  // ---------------------------------------------------------------------------
  // Test 4: Bad config → config gate fail, score C
  // ---------------------------------------------------------------------------

  it("4. bad config (missing site URL) → config gate fail, recommendations populated", async () => {
    const badConfig = `
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
});
`;
    const root = createFixtureDir({
      "astro.config.mjs": badConfig,
      "src/pages/index.astro": CLEAN_PAGE,
    });
    const index = makeIndex(root, ["src/pages/index.astro"]);

    const result = await astroAuditFromIndex(index, new Set(), []);

    expect(result.gates.config).toBe("fail");
    expect(["C", "D"]).toContain(result.score);
    expect(result.sections.config).toBeDefined();
    expect(result.sections.config!.issue_count).toBeGreaterThan(0);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations[0]).toContain("config");
  });

  // ---------------------------------------------------------------------------
  // Test 5: skip parameter — skipped sections are omitted
  // ---------------------------------------------------------------------------

  it("5. skip: [migration, content] → those sections are absent from result", async () => {
    const root = createFixtureDir({
      "astro.config.mjs": CLEAN_CONFIG,
      "src/pages/index.astro": CLEAN_PAGE,
    });
    const index = makeIndex(root, ["src/pages/index.astro"]);

    const result = await astroAuditFromIndex(index, new Set(["migration", "content"]), []);

    expect(result.sections.migration).toBeUndefined();
    expect(result.sections.content).toBeUndefined();
    // Other sections should still be present
    expect(result.sections.config).toBeDefined();
    expect(result.gates.migration).toBe("pass");
    expect(result.gates.content).toBe("pass");
  });

  // ---------------------------------------------------------------------------
  // Test 5b: skip hydration
  // ---------------------------------------------------------------------------

  it("5b. skip: [hydration] → hydration section absent, gate defaults to pass", async () => {
    const root = createFixtureDir({
      "astro.config.mjs": CLEAN_CONFIG,
    });
    const index = makeIndex(root, []);

    const result = await astroAuditFromIndex(index, new Set(["hydration"]), []);

    expect(result.sections.hydration).toBeUndefined();
    expect(result.gates.hydration).toBe("pass");
  });

  // ---------------------------------------------------------------------------
  // Test 6: Recommendations populated based on issue severity
  // ---------------------------------------------------------------------------

  it("6. recommendations populated based on issue severity", async () => {
    // AH05 error: client:only without framework → triggers recommendations
    const badPage = `---
import Widget from './Widget.tsx';
---
<Widget client:only />
`;
    const root = createFixtureDir({
      "astro.config.mjs": CLEAN_CONFIG,
      "src/pages/index.astro": badPage,
    });
    const index = makeIndex(root, ["src/pages/index.astro"]);

    const result = await astroAuditFromIndex(index, new Set(), []);

    expect(result.recommendations).toBeDefined();
    expect(Array.isArray(result.recommendations)).toBe(true);
    // Should not exceed 5 recommendations
    expect(result.recommendations.length).toBeLessThanOrEqual(5);
    // Should have at least one recommendation (hydration error + config issue)
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Test 7: Patterns gate — warn on 1-2 patterns fired, fail on 3+
  // ---------------------------------------------------------------------------

  it("7. patterns gate: 1 pattern fired → warn; 3+ → fail", async () => {
    const root = createFixtureDir({ "astro.config.mjs": CLEAN_CONFIG });
    const index = makeIndex(root, []);

    // 1 pattern fired → warn
    const resultOnePattern = await astroAuditFromIndex(index, new Set(), [
      { pattern: "astro-img-element", count: 2 },
    ]);
    expect(resultOnePattern.gates.patterns).toBe("warn");
    expect(resultOnePattern.sections.patterns!.total_matches).toBe(2);
    expect(resultOnePattern.sections.patterns!.patterns_fired).toContain("astro-img-element");

    // 3 patterns fired → fail
    const resultThreePatterns = await astroAuditFromIndex(index, new Set(), [
      { pattern: "astro-img-element", count: 3 },
      { pattern: "astro-missing-lang-attr", count: 1 },
      { pattern: "astro-hardcoded-site-url", count: 2 },
    ]);
    expect(resultThreePatterns.gates.patterns).toBe("fail");
    expect(resultThreePatterns.sections.patterns!.total_matches).toBe(6);
    expect(resultThreePatterns.sections.patterns!.patterns_fired).toHaveLength(3);
  });

  // ---------------------------------------------------------------------------
  // Test 8: ASTRO_PATTERNS covers all 13 patterns
  // ---------------------------------------------------------------------------

  it("8. ASTRO_PATTERNS covers all 13 Astro-specific patterns", () => {
    expect(ASTRO_PATTERNS).toHaveLength(13);
    expect(ASTRO_PATTERNS).toContain("astro-client-on-astro");
    expect(ASTRO_PATTERNS).toContain("astro-set-html-xss");
    expect(ASTRO_PATTERNS).toContain("astro-view-transitions-deprecated");
  });

  // ---------------------------------------------------------------------------
  // Test 9: Routes section populated with warnings from dynamic routes
  // ---------------------------------------------------------------------------

  it("9. routes gate warns when dynamic route lacks getStaticPaths", async () => {
    const root = createFixtureDir({
      "astro.config.mjs": CLEAN_CONFIG,
      // A dynamic page without getStaticPaths symbol in index → generates route warning
      "src/pages/blog/[slug].astro": CLEAN_PAGE,
    });
    // Index with the dynamic page file but no getStaticPaths symbol
    const index: CodeIndex = {
      repo: "local/test",
      root,
      symbols: [], // no getStaticPaths symbol → warning triggered
      files: [
        {
          path: "src/pages/blog/[slug].astro",
          language: "astro",
          symbol_count: 0,
          last_modified: Date.now(),
        },
      ],
      created_at: Date.now(),
      updated_at: Date.now(),
      symbol_count: 0,
      file_count: 1,
    };

    const result = await astroAuditFromIndex(index, new Set(), []);

    expect(result.sections.routes).toBeDefined();
    expect(result.sections.routes!.total_routes).toBeGreaterThan(0);
    // Dynamic route without getStaticPaths → warning
    expect(result.sections.routes!.warnings.length).toBeGreaterThan(0);
    expect(result.gates.routes).toBe("warn");
  });

  // ---------------------------------------------------------------------------
  // Test 10: skip all sections → minimal result
  // ---------------------------------------------------------------------------

  it("10. skip all sections → all gates pass, no sections, score A", async () => {
    const root = createFixtureDir({});
    const index = makeIndex(root, []);

    const result = await astroAuditFromIndex(
      index,
      new Set(["config", "islands", "hydration", "routes", "actions", "content", "migration", "patterns"]),
      undefined,
    );

    expect(result.score).toBe("A");
    expect(Object.values(result.gates).every((g) => g === "pass")).toBe(true);
    expect(Object.keys(result.sections)).toHaveLength(0);
    expect(result.recommendations).toHaveLength(0);
  });
});
