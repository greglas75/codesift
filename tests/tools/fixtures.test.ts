import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { parseFile } from "../../src/parser/parser-manager.js";

const FIXTURE_DIR = join(__dirname, "../fixtures/nextjs-app-router");

async function walkFixture(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFixture(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

describe("App Router fixture", () => {
  it("fixture invariant: all App Router fixture files have valid structure", async () => {
    const files = await walkFixture(FIXTURE_DIR);

    // At least 20 files
    expect(files.length).toBeGreaterThanOrEqual(20);

    // Each .tsx file should be parseable by tree-sitter without error
    const tsxFiles = files.filter((f) => extname(f) === ".tsx");
    expect(tsxFiles.length).toBeGreaterThan(0);

    for (const file of tsxFiles) {
      const source = await readFile(file, "utf8");
      const tree = await parseFile(file, source);
      expect(tree, `Failed to parse ${file}`).not.toBeNull();
      // Check no ERROR nodes in the root
      const hasError = tree!.rootNode.descendantsOfType("ERROR").length > 0;
      expect(hasError, `Parse error in ${file}`).toBe(false);
    }
  });
});

describe("Pages Router + hybrid fixtures", () => {
  const PAGES_DIR = join(__dirname, "../fixtures/nextjs-pages-router");
  const HYBRID_DIR = join(__dirname, "../fixtures/nextjs-hybrid");

  it("nextjs-pages-router has >=13 files and an expected.json", async () => {
    const files = await walkFixture(PAGES_DIR);
    expect(files.length).toBeGreaterThanOrEqual(13);
    const expectedPath = join(PAGES_DIR, "expected.json");
    const expectedContent = await readFile(expectedPath, "utf8");
    const expected = JSON.parse(expectedContent);
    expect(expected.routes).toBeDefined();
    expect(Object.keys(expected.routes).length).toBeGreaterThan(0);
  });

  it("nextjs-hybrid has apps/web-app and apps/web-pages workspaces with expected.json", async () => {
    const files = await walkFixture(HYBRID_DIR);
    const paths = files.map((f) => f.replace(HYBRID_DIR + "/", ""));
    expect(paths.some((p) => p.startsWith("apps/web-app/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("apps/web-pages/"))).toBe(true);

    const expectedPath = join(HYBRID_DIR, "expected.json");
    const expectedContent = await readFile(expectedPath, "utf8");
    const expected = JSON.parse(expectedContent);
    expect(Array.isArray(expected.conflicts)).toBe(true);
    expect(expected.conflicts.length).toBeGreaterThanOrEqual(1);
    expect(typeof expected.routes_count).toBe("number");
  });
});
