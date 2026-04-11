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
