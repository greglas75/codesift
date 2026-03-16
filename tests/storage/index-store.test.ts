import {
  saveIndex,
  loadIndex,
  saveIncremental,
  removeFileFromIndex,
  getIndexPath,
} from "../../src/storage/index-store.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeIndex(overrides?: Partial<CodeIndex>): CodeIndex {
  return {
    repo: "test/repo",
    root: "/tmp/test",
    symbols: [],
    files: [],
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: 0,
    file_count: 0,
    ...overrides,
  };
}

function makeSymbol(file: string, name: string, line: number): CodeSymbol {
  return {
    id: `test:${file}:${name}:${line}`,
    repo: "test",
    name,
    kind: "function",
    file,
    start_line: line,
    end_line: line + 10,
  };
}

describe("index-store", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "codesift-index-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("saveIndex + loadIndex round-trip", () => {
    it("saves and loads an index preserving all fields", async () => {
      const symbols = [makeSymbol("src/a.ts", "hello", 1)];
      const index = makeIndex({
        repo: "local/myapp",
        symbols,
        symbol_count: symbols.length,
      });
      const indexPath = join(tmpDir, "test.index.json");

      await saveIndex(indexPath, index);
      const loaded = await loadIndex(indexPath);

      expect(loaded).not.toBeNull();
      expect(loaded!.repo).toBe("local/myapp");
      expect(loaded!.symbols).toHaveLength(1);
      expect(loaded!.symbols[0].name).toBe("hello");
      expect(loaded!.symbol_count).toBe(1);
    });
  });

  describe("loadIndex", () => {
    it("returns null for a non-existent file", async () => {
      const result = await loadIndex(join(tmpDir, "nope.index.json"));
      expect(result).toBeNull();
    });

    it("returns null for invalid JSON", async () => {
      const badPath = join(tmpDir, "bad.index.json");
      await writeFile(badPath, "not valid json {{{", "utf-8");

      const result = await loadIndex(badPath);
      expect(result).toBeNull();
    });

    it("returns null for valid JSON with wrong shape", async () => {
      const badPath = join(tmpDir, "wrong-shape.index.json");
      await writeFile(badPath, JSON.stringify({ foo: "bar" }), "utf-8");

      const result = await loadIndex(badPath);
      expect(result).toBeNull();
    });
  });

  describe("saveIncremental", () => {
    it("replaces symbols for the updated file and keeps others", async () => {
      const indexPath = join(tmpDir, "incremental.index.json");

      const symA1 = makeSymbol("src/a.ts", "funcA1", 1);
      const symA2 = makeSymbol("src/a.ts", "funcA2", 20);
      const symB1 = makeSymbol("src/b.ts", "funcB1", 1);

      const initial = makeIndex({
        symbols: [symA1, symA2, symB1],
        symbol_count: 3,
      });
      await saveIndex(indexPath, initial);

      const newSymA = makeSymbol("src/a.ts", "funcA_new", 5);
      await saveIncremental(indexPath, "src/a.ts", [newSymA]);

      const updated = await loadIndex(indexPath);
      expect(updated).not.toBeNull();
      expect(updated!.symbols).toHaveLength(2);
      expect(updated!.symbol_count).toBe(2);

      const names = updated!.symbols.map((s) => s.name).sort();
      expect(names).toEqual(["funcA_new", "funcB1"]);
    });

    it("throws when index file does not exist", async () => {
      const missingPath = join(tmpDir, "missing.index.json");

      await expect(
        saveIncremental(missingPath, "src/a.ts", []),
      ).rejects.toThrow("Cannot incrementally update");
    });
  });

  describe("removeFileFromIndex", () => {
    it("removes symbols and file entry for a deleted file", async () => {
      const indexPath = join(tmpDir, "remove.index.json");

      const symA = makeSymbol("src/a.ts", "funcA", 1);
      const symB = makeSymbol("src/b.ts", "funcB", 1);

      const initial = makeIndex({
        symbols: [symA, symB],
        symbol_count: 2,
        files: [
          { path: "src/a.ts", language: "typescript", symbol_count: 1, last_modified: Date.now() },
          { path: "src/b.ts", language: "typescript", symbol_count: 1, last_modified: Date.now() },
        ],
        file_count: 2,
      });
      await saveIndex(indexPath, initial);

      await removeFileFromIndex(indexPath, "src/a.ts");

      const updated = await loadIndex(indexPath);
      expect(updated).not.toBeNull();
      expect(updated!.symbols).toHaveLength(1);
      expect(updated!.symbols[0].name).toBe("funcB");
      expect(updated!.symbol_count).toBe(1);
      expect(updated!.files).toHaveLength(1);
      expect(updated!.files[0].path).toBe("src/b.ts");
      expect(updated!.file_count).toBe(1);
    });

    it("is a no-op when file is not in the index", async () => {
      const indexPath = join(tmpDir, "remove-noop.index.json");

      const sym = makeSymbol("src/a.ts", "funcA", 1);
      const initial = makeIndex({
        symbols: [sym],
        symbol_count: 1,
        files: [{ path: "src/a.ts", language: "typescript", symbol_count: 1, last_modified: Date.now() }],
        file_count: 1,
      });
      await saveIndex(indexPath, initial);

      await removeFileFromIndex(indexPath, "src/nonexistent.ts");

      const updated = await loadIndex(indexPath);
      expect(updated!.symbols).toHaveLength(1);
      expect(updated!.files).toHaveLength(1);
    });

    it("silently handles missing index file", async () => {
      const missingPath = join(tmpDir, "missing-remove.index.json");
      // Should not throw
      await removeFileFromIndex(missingPath, "src/a.ts");
    });
  });

  describe("getIndexPath", () => {
    it("returns a deterministic path for the same input", () => {
      const path1 = getIndexPath("/data", "/Users/me/project");
      const path2 = getIndexPath("/data", "/Users/me/project");

      expect(path1).toBe(path2);
    });

    it("returns different paths for different repo roots", () => {
      const path1 = getIndexPath("/data", "/Users/me/project-a");
      const path2 = getIndexPath("/data", "/Users/me/project-b");

      expect(path1).not.toBe(path2);
    });

    it("ends with .index.json", () => {
      const result = getIndexPath("/data", "/Users/me/project");
      expect(result).toMatch(/\.index\.json$/);
    });

    it("uses the provided data directory as prefix", () => {
      const result = getIndexPath("/my/data/dir", "/some/repo");
      expect(result.startsWith("/my/data/dir/")).toBe(true);
    });
  });
});
