import { describe, it, expect, beforeAll } from "vitest";
import { join, resolve } from "node:path";
import { indexFolder, getCodeIndex } from "../../src/tools/index-tools.js";
import { collectImportEdges } from "../../src/utils/import-graph.js";
import { resolvePhpNamespace } from "../../src/tools/php-tools.js";

const FIXTURE_ROOT = resolve(join(__dirname, "..", "fixtures", "php-psr4"));

describe("collectImportEdges — PHP PSR-4 resolution", () => {
  beforeAll(async () => {
    // Index the fixture so resolvePhpNamespace can find it via getCodeIndex.
    await indexFolder(FIXTURE_ROOT);
  });

  it("resolvePhpNamespace finds User.php via composer PSR-4 map", async () => {
    const index = await getCodeIndex("local/php-psr4");
    expect(index).not.toBeNull();
    const r = await resolvePhpNamespace("local/php-psr4", "App\\Models\\User");
    expect(r.exists).toBe(true);
    expect(r.file_path).toContain("src/Models/User.php");
  });

  it("creates a cross-file edge from PostController to User via `use App\\Models\\User`", async () => {
    const index = await getCodeIndex("local/php-psr4");
    expect(index).not.toBeNull();
    const edges = await collectImportEdges(index!);
    const edge = edges.find(
      (e) =>
        e.from.includes("PostController.php") &&
        e.to.includes("User.php"),
    );
    expect(edge).toBeDefined();
  });
});

describe("collectImportEdges — PHP edge cases", () => {
  it("gracefully handles vendor FQCN not in PSR-4 map (no edge, no crash)", async () => {
    const r = await resolvePhpNamespace("local/php-psr4", "Vendor\\Package\\Missing");
    expect(r.exists).toBe(false);
    expect(r.psr4_prefix).toBeNull();
  });

  it("does not create self-edges or duplicates for PHP files", async () => {
    const index = await getCodeIndex("local/php-psr4");
    expect(index).not.toBeNull();
    const edges = await collectImportEdges(index!);
    // No self-edges
    for (const e of edges) {
      expect(e.from).not.toBe(e.to);
    }
    // No duplicate from→to pairs
    const seen = new Set<string>();
    for (const e of edges) {
      const key = `${e.from}->${e.to}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});
