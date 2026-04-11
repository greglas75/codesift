/**
 * End-to-end integration test for the 4 Astro tools against the real fixture.
 *
 * Indexes tests/fixtures/astro-project, then runs the internal (sync/pure)
 * functions from astro-islands, astro-routes, and astro-config against the
 * resulting CodeIndex.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexFolder, getCodeIndex } from "../../src/tools/index-tools.js";
import { analyzeIslandsFromIndex, hydrationAuditFromIndex } from "../../src/tools/astro-islands.js";
import { buildRouteEntries, findAstroHandlers } from "../../src/tools/astro-routes.js";
import { extractAstroConventions } from "../../src/tools/astro-config.js";
import { resetConfigCache } from "../../src/config.js";
import { resetSecretCache } from "../../src/tools/secret-tools.js";
import type { CodeIndex } from "../../src/types.js";

const FIXTURE_DIR = resolve(__dirname, "../fixtures/astro-project");

let tmpDir: string;
let index: CodeIndex;

beforeAll(async () => {
  // Redirect data dir to temp so we don't pollute real ~/.codesift
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-astro-pipeline-"));
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();
  resetSecretCache();

  // Index the fixture project
  await indexFolder(FIXTURE_DIR, { watch: false });

  const repoName = `local/astro-project`;
  const loaded = await getCodeIndex(repoName);
  if (!loaded) throw new Error("Failed to load index after indexFolder");
  index = loaded;
}, 30_000);

afterAll(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  resetSecretCache();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("astro pipeline integration", () => {
  // -----------------------------------------------------------------------
  // 1. All expected .astro files are indexed
  // -----------------------------------------------------------------------
  it("indexes all expected .astro files", () => {
    const astroPaths = index.files
      .filter((f) => f.language === "astro")
      .map((f) => f.path);

    expect(astroPaths).toContain("src/pages/index.astro");
    expect(astroPaths).toContain("src/pages/blog/[slug].astro");
    expect(astroPaths).toContain("src/layouts/BaseLayout.astro");
    expect(astroPaths).toContain("src/components/Footer.astro");
    expect(astroPaths.length).toBeGreaterThanOrEqual(4);
  });

  // -----------------------------------------------------------------------
  // 2. analyzeIslandsFromIndex finds 1 island (Counter with client:visible)
  // -----------------------------------------------------------------------
  it("finds 1 island: Counter with client:visible", () => {
    const result = analyzeIslandsFromIndex(index);

    expect(result.summary.total_islands).toBe(1);
    expect(result.islands).toHaveLength(1);

    const island = result.islands[0]!;
    expect(island.component_name).toBe("Counter");
    expect(island.directive).toBe("client:visible");
    // The import path in the fixture is "../components/Counter" (no .tsx extension),
    // so framework_hint is not inferred from the extension. It resolves via import map.
    // The template parser only infers framework from the file extension of the import path.
    expect(island.target_kind).toBe("unknown");
  });

  // -----------------------------------------------------------------------
  // 3. hydrationAuditFromIndex returns score "A" (clean fixture)
  // -----------------------------------------------------------------------
  it("hydration audit returns score A with no errors", () => {
    const result = hydrationAuditFromIndex(index);

    expect(result.score).toBe("A");
    expect(result.anti_patterns_checked).toEqual(expect.arrayContaining([
      "AH01", "AH02", "AH03", "AH04", "AH05", "AH06",
      "AH07", "AH08", "AH09", "AH10", "AH11", "AH12",
    ]));
    // Clean fixture should have no errors
    const errors = result.issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 4. buildRouteEntries returns 3 routes (/, /blog/:slug, /api/data)
  // -----------------------------------------------------------------------
  it("builds 3 routes from fixture pages", () => {
    const { routes } = buildRouteEntries(index);

    expect(routes).toHaveLength(3);

    const paths = routes.map((r) => r.path);
    expect(paths).toContain("/");
    expect(paths).toContain("/blog/:slug");
    expect(paths).toContain("/api/data");

    // Verify route types
    const indexRoute = routes.find((r) => r.path === "/")!;
    expect(indexRoute.type).toBe("page");

    const blogRoute = routes.find((r) => r.path === "/blog/:slug")!;
    expect(blogRoute.type).toBe("page");
    expect(blogRoute.dynamic_params).toContain("slug");
    expect(blogRoute.has_getStaticPaths).toBe(true);

    const apiRoute = routes.find((r) => r.path === "/api/data")!;
    expect(apiRoute.type).toBe("endpoint");
    expect(apiRoute.methods).toContain("GET");
  });

  // -----------------------------------------------------------------------
  // 5. extractAstroConventions returns config_resolution "static",
  //    integrations include react
  // -----------------------------------------------------------------------
  it("extracts Astro conventions from config", async () => {
    // Pass empty array so extractAstroConventions falls back to reading
    // config files from disk (astro.config.mjs is not in the index because
    // .mjs is not a recognized extension in the parser).
    const result = await extractAstroConventions([], FIXTURE_DIR);

    expect(result.conventions.config_resolution).toBe("static");
    expect(result.conventions.output_mode).toBe("static");
    expect(result.conventions.integrations).toContain("@astrojs/react");
    expect(result.conventions.integrations).toContain("@astrojs/tailwind");
    expect(result.conventions.site).toBe("https://example.com");
  });

  // -----------------------------------------------------------------------
  // 6. Search for "Footer" in index symbols finds a component
  // -----------------------------------------------------------------------
  it("index contains Footer as a component symbol", () => {
    const footerSymbols = index.symbols.filter(
      (s) => s.name === "Footer" && s.kind === "component",
    );
    expect(footerSymbols.length).toBeGreaterThanOrEqual(1);
    expect(footerSymbols[0]!.file).toBe("src/components/Footer.astro");
  });

  // -----------------------------------------------------------------------
  // 7. findAstroHandlers for /api/data returns a handler
  // -----------------------------------------------------------------------
  it("findAstroHandlers returns handler for /api/data", () => {
    const handlers = findAstroHandlers(index, "/api/data");

    expect(handlers.length).toBeGreaterThanOrEqual(1);
    expect(handlers[0]!.framework).toBe("astro");
    expect(handlers[0]!.file).toBe("src/pages/api/data.ts");
    expect(handlers[0]!.method).toBe("GET");
  });

  // -----------------------------------------------------------------------
  // 8. The fixture has no AH01-AH12 anti-patterns (issues empty or info-only)
  // -----------------------------------------------------------------------
  it("fixture has no AH anti-pattern errors or warnings", () => {
    const result = hydrationAuditFromIndex(index);

    const errorsAndWarnings = result.issues.filter(
      (i) => i.severity === "error" || i.severity === "warning",
    );
    expect(errorsAndWarnings).toHaveLength(0);
  });
});
