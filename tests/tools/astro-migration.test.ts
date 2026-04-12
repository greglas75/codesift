/**
 * Tests for astro_migration_check (AM01–AM10 detectors).
 *
 * Uses tmpdir-based fixture directories so every detector exercises real
 * file-system logic without touching the CodeSift index.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Mock index-tools so the tool resolves root from index when args.repo is set,
// but falls back gracefully for the tmpdir-based tests where we pass root directly.
// ---------------------------------------------------------------------------

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { astroMigrationCheck } from "../../src/tools/astro-migration.js";

const mockedGetCodeIndex = vi.mocked(getCodeIndex);

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface FixtureFile {
  path: string;   // relative to fixture root, e.g. "src/pages/index.astro"
  content: string;
}

/**
 * Create a temporary directory, write the given fixture files into it,
 * configure the mock index to return that root, then run the check.
 * Cleans up the directory automatically.
 */
async function withFixture(
  fixtures: FixtureFile[],
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "astro-mig-"));
  try {
    // Write all fixture files (creating subdirs as needed)
    for (const { path, content } of fixtures) {
      const fullPath = join(root, path);
      await mkdir(join(fullPath, ".."), { recursive: true });
      await writeFile(fullPath, content, "utf-8");
    }

    // Make getCodeIndex return a fake index pointing at our tmpdir
    mockedGetCodeIndex.mockResolvedValue({
      repo: "test",
      root,
      files: [],
      symbols: [],
      created_at: Date.now(),
      updated_at: Date.now(),
      symbol_count: 0,
      file_count: 0,
    });

    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/**
 * Run astroMigrationCheck with the mock repo resolved to tmpdir root.
 */
async function checkFixture() {
  return astroMigrationCheck({ repo: "test" });
}

// ---------------------------------------------------------------------------
// Minimal package.json helper
// ---------------------------------------------------------------------------

function makePackageJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      name: "test-astro-project",
      dependencies: { astro: "^5.0.0" },
      ...overrides,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("astroMigrationCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Clean project — no issues
  // -------------------------------------------------------------------------

  it("1. clean project returns empty breaking_changes", async () => {
    await withFixture(
      [
        {
          path: "package.json",
          content: makePackageJson({ engines: { node: ">=22" } }),
        },
        {
          path: "astro.config.mjs",
          content: `import { defineConfig } from "astro/config";\nexport default defineConfig({});`,
        },
        {
          path: "src/pages/index.astro",
          content: "---\n// clean file\n---\n<h1>Hello</h1>",
        },
      ],
      async () => {
        const result = await checkFixture();
        expect(result.breaking_changes).toHaveLength(0);
        expect(result.summary.total_issues).toBe(0);
      },
    );
  });

  // -------------------------------------------------------------------------
  // 2. AM01 — Astro.glob() usage
  // -------------------------------------------------------------------------

  it("2. Astro.glob() usage → AM01 fires", async () => {
    await withFixture(
      [
        { path: "package.json", content: makePackageJson({ engines: { node: ">=22" } }) },
        {
          path: "src/pages/blog.astro",
          content: "---\nconst posts = await Astro.glob('../posts/*.md');\n---\n",
        },
      ],
      async () => {
        const result = await checkFixture();
        const am01 = result.breaking_changes.find((c) => c.code === "AM01");
        expect(am01).toBeDefined();
        expect(am01?.severity).toBe("error");
        expect(am01?.effort).toBe("low");
        expect(am01?.files).toContain("src/pages/blog.astro");
      },
    );
  });

  // -------------------------------------------------------------------------
  // 3. AM03 — <ViewTransitions /> component rename
  // -------------------------------------------------------------------------

  it("3. <ViewTransitions /> usage → AM03 fires", async () => {
    await withFixture(
      [
        { path: "package.json", content: makePackageJson({ engines: { node: ">=22" } }) },
        {
          path: "src/layouts/Base.astro",
          content: `---
import { ViewTransitions } from "astro:transitions";
---
<head>
  <ViewTransitions />
</head>`,
        },
      ],
      async () => {
        const result = await checkFixture();
        const am03 = result.breaking_changes.find((c) => c.code === "AM03");
        expect(am03).toBeDefined();
        expect(am03?.severity).toBe("error");
        expect(am03?.effort).toBe("trivial");
        expect(am03?.files).toContain("src/layouts/Base.astro");
      },
    );
  });

  // -------------------------------------------------------------------------
  // 4. AM04 — legacy content config path
  // -------------------------------------------------------------------------

  it("4. src/content/config.ts exists → AM04 fires", async () => {
    await withFixture(
      [
        { path: "package.json", content: makePackageJson({ engines: { node: ">=22" } }) },
        {
          path: "src/content/config.ts",
          content: `import { defineCollection, z } from "astro:content";\nexport const collections = {};`,
        },
      ],
      async () => {
        const result = await checkFixture();
        const am04 = result.breaking_changes.find((c) => c.code === "AM04");
        expect(am04).toBeDefined();
        expect(am04?.severity).toBe("warning");
        expect(am04?.effort).toBe("medium");
        expect(am04?.files).toContain("src/content/config.ts");
      },
    );
  });

  // -------------------------------------------------------------------------
  // 5. AM06 — engines.node < 22
  // -------------------------------------------------------------------------

  it("5. engines.node '>=18' → AM06 fires", async () => {
    await withFixture(
      [
        {
          path: "package.json",
          content: makePackageJson({ engines: { node: ">=18" } }),
        },
      ],
      async () => {
        const result = await checkFixture();
        const am06 = result.breaking_changes.find((c) => c.code === "AM06");
        expect(am06).toBeDefined();
        expect(am06?.severity).toBe("error");
        expect(am06?.effort).toBe("low");
        expect(am06?.message).toContain(">=18");
      },
    );
  });

  // -------------------------------------------------------------------------
  // 6. AM09 — output: "hybrid" in astro.config.mjs
  // -------------------------------------------------------------------------

  it("6. output: 'hybrid' in config → AM09 fires", async () => {
    await withFixture(
      [
        { path: "package.json", content: makePackageJson({ engines: { node: ">=22" } }) },
        {
          path: "astro.config.mjs",
          content: `import { defineConfig } from "astro/config";\nexport default defineConfig({ output: "hybrid" });`,
        },
      ],
      async () => {
        const result = await checkFixture();
        const am09 = result.breaking_changes.find((c) => c.code === "AM09");
        expect(am09).toBeDefined();
        expect(am09?.severity).toBe("info");
        expect(am09?.effort).toBe("low");
      },
    );
  });

  // -------------------------------------------------------------------------
  // 7. Multiple issues → correct summary totals
  // -------------------------------------------------------------------------

  it("7. multiple issues → summary totals are correct", async () => {
    await withFixture(
      [
        {
          path: "package.json",
          content: makePackageJson({
            engines: { node: ">=18" },          // AM06
            dependencies: {
              astro: "^5.0.0",
              "@astrojs/lit": "^3.0.0",          // AM10
            },
          }),
        },
        {
          path: "src/pages/blog.astro",
          content: "---\nconst x = await Astro.glob('../**/*.md');\n---\n", // AM01
        },
        {
          path: "src/layouts/Base.astro",
          content: "<ViewTransitions />",         // AM03
        },
        {
          path: "astro.config.mjs",
          content: `export default { output: "hybrid" };`, // AM09
        },
      ],
      async () => {
        const result = await checkFixture();
        // Should have at least AM01, AM03, AM06, AM09, AM10
        expect(result.summary.total_issues).toBeGreaterThanOrEqual(5);
        expect(result.breaking_changes.map((c) => c.code)).toEqual(
          expect.arrayContaining(["AM01", "AM03", "AM06", "AM09", "AM10"]),
        );
        // total_issues matches array length
        expect(result.summary.total_issues).toBe(result.breaking_changes.length);
        // by_effort sums to total
        const effortSum = Object.values(result.summary.by_effort).reduce((a, b) => a + b, 0);
        expect(effortSum).toBe(result.summary.total_issues);
      },
    );
  });

  // -------------------------------------------------------------------------
  // 8. Effort hours estimation
  // -------------------------------------------------------------------------

  it("8. effort hours estimation is correct", async () => {
    await withFixture(
      [
        {
          path: "package.json",
          content: makePackageJson({ engines: { node: ">=22" } }),
        },
        {
          // AM03: trivial (0.1h × 1 match)
          path: "src/layouts/Base.astro",
          content: "<ViewTransitions />",
        },
        {
          // AM01: low (0.5h × 1 match)
          path: "src/pages/index.astro",
          content: "---\nconst x = await Astro.glob('**/*.md');\n---\n",
        },
      ],
      async () => {
        const result = await checkFixture();
        const am01 = result.breaking_changes.find((c) => c.code === "AM01");
        const am03 = result.breaking_changes.find((c) => c.code === "AM03");
        expect(am01).toBeDefined();
        expect(am03).toBeDefined();

        // Estimated hours: trivial(0.1) + low(0.5) = 0.6h → "~0.6h"
        expect(result.summary.estimated_migration_hours).toMatch(/0\.6|0\.[5-9]/);
      },
    );
  });
});
