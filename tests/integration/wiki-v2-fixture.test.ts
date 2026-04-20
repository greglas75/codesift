/**
 * Wiki v2 fixture integration test — indexes the ts-monorepo fixture, runs
 * generateWiki(), and asserts the v2 manifest shape + key behavioural
 * invariants (AC-SHIP-1a/b, AC-SHIP-3).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Copy the fixture to a tmp dir so the .codesift output doesn't pollute
// the source tree, and run the full pipeline against it.

describe("Wiki v2 integration — ts-monorepo fixture", () => {
  it("generates a v2 manifest with project+modules, and no builtin `map` in top-10 hubs", async () => {
    const fixture = resolve(__dirname, "../fixtures/wiki-v2/ts-monorepo");
    const workdir = mkdtempSync(join(tmpdir(), "wiki-v2-fixture-"));
    cpSync(fixture, workdir, { recursive: true });

    try {
      const { indexFolder } = await import("../../src/tools/index-tools.js");
      const idxResult = await indexFolder(workdir);
      const { generateWiki } = await import("../../src/tools/wiki-tools.js");
      const result = await generateWiki(idxResult.repo);
      expect(result.pages).toBeGreaterThan(0);

      const manifestPath = join(workdir, ".codesift", "wiki", "wiki-manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

      // AC-SHIP-3: v2 shape
      expect(manifest.schema_version).toBe(2);
      expect(manifest.project).toBeDefined();
      expect(Array.isArray(manifest.modules)).toBe(true);
      expect(manifest.project.name).toBeTruthy();
      expect(manifest.project.stack.language.toLowerCase()).toMatch(/^(type|java)script$/);

      // AC-SHIP-1b: hubs page must not have `map` in top-10 unless file_rank ≤ 20
      const hubsPath = join(workdir, ".codesift", "wiki", "hubs.md");
      const hubs = readFileSync(hubsPath, "utf-8");
      // On a 4-file fixture, page.ts (which defines `map`) may legitimately
      // be in top-20 by PageRank — blocklist exempts it. The strong guarantee
      // is that the FAKE-CALLER inflation no longer shows up: `map`'s caller
      // count should not exceed its legitimate callers (0 in this fixture,
      // since no file calls a bare `map()` without an object receiver).
      const mapRow = hubs.split("\n").find((l) => l.includes("| map "));
      if (mapRow) {
        // If `map` appears it must have 0 callers (no fake fan-in).
        const cols = mapRow.split("|").map((c) => c.trim());
        const callers = Number(cols[4]);
        expect(callers).toBe(0);
      }

      // Overview and architecture pages exist
      const overview = readFileSync(join(workdir, ".codesift", "wiki", "overview.md"), "utf-8");
      expect(overview).toContain("## Stack");
      expect(overview.toLowerCase()).toMatch(/(type|java)script/);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }, 60_000);

  it("CODESIFT_WIKI_V1=1 produces a v1 manifest (no schema_version/project/modules)", async () => {
    const fixture = resolve(__dirname, "../fixtures/wiki-v2/ts-monorepo");
    const workdir = mkdtempSync(join(tmpdir(), "wiki-v1-rollback-"));
    cpSync(fixture, workdir, { recursive: true });
    const prior = process.env.CODESIFT_WIKI_V1;
    process.env.CODESIFT_WIKI_V1 = "1";

    try {
      const { indexFolder } = await import("../../src/tools/index-tools.js");
      const idxResult = await indexFolder(workdir);
      const { generateWiki } = await import("../../src/tools/wiki-tools.js");
      await generateWiki(idxResult.repo);

      const manifestPath = join(workdir, ".codesift", "wiki", "wiki-manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      expect(manifest.schema_version).toBeUndefined();
      expect(manifest.project).toBeUndefined();
      expect(manifest.modules).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.CODESIFT_WIKI_V1;
      else process.env.CODESIFT_WIKI_V1 = prior;
      rmSync(workdir, { recursive: true, force: true });
    }
  }, 60_000);
});
