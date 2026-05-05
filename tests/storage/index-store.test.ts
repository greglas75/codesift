import {
  saveIndex,
  loadIndex,
  loadIndexOrStale,
  saveIncremental,
  removeFileFromIndex,
  getIndexPath,
  isExtractorVersionCurrent,
} from "../../src/storage/index-store.js";
import type { CodeIndex, CodeSymbol, FileEntry } from "../../src/types.js";
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

function makeFile(path: string, language: string): FileEntry {
  const now = Date.now();
  return {
    path,
    language,
    symbol_count: 0,
    last_modified: now,
    mtime_ms: now,
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
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

  describe("extractor_version invalidation", () => {
    const CURRENT = { kotlin: "2.0.0", python: "1.0.0" };

    it("loadIndex returns the index when stored extractor_version matches current", async () => {
      const indexPath = join(tmpDir, "versioned.index.json");
      const index = makeIndex({
        extractor_version: { kotlin: "2.0.0", python: "1.0.0" },
      });
      await saveIndex(indexPath, index);

      const loaded = await loadIndex(indexPath, CURRENT);
      expect(loaded).not.toBeNull();
      expect(loaded!.extractor_version).toEqual({ kotlin: "2.0.0", python: "1.0.0" });
    });

    it("loadIndex returns null when a stored language version is behind", async () => {
      const indexPath = join(tmpDir, "stale.index.json");
      const index = makeIndex({
        extractor_version: { kotlin: "1.0.0", python: "1.0.0" },
      });
      await saveIndex(indexPath, index);

      const loaded = await loadIndex(indexPath, CURRENT);
      expect(loaded).toBeNull();
    });

    it("loadIndex returns null for a legacy index without extractor_version", async () => {
      const indexPath = join(tmpDir, "legacy.index.json");
      const index = makeIndex(); // no extractor_version field
      await saveIndex(indexPath, index);

      const loaded = await loadIndex(indexPath, CURRENT);
      expect(loaded).toBeNull();
    });

    it("loadIndex skips the version check when currentVersions is omitted", async () => {
      const indexPath = join(tmpDir, "incremental.index.json");
      const index = makeIndex({
        extractor_version: { kotlin: "0.1.0" },
      });
      await saveIndex(indexPath, index);

      // Omitting currentVersions mirrors the saveIncremental read flow.
      const loaded = await loadIndex(indexPath);
      expect(loaded).not.toBeNull();
      expect(loaded!.extractor_version).toEqual({ kotlin: "0.1.0" });
    });

    it("isExtractorVersionCurrent returns true when every current language matches stored", () => {
      const index = makeIndex({
        extractor_version: { kotlin: "2.0.0", python: "1.0.0", extra: "9.9.9" },
      });
      expect(isExtractorVersionCurrent(index, CURRENT)).toBe(true);
    });

    it("isExtractorVersionCurrent returns false when a language version differs", () => {
      const index = makeIndex({
        extractor_version: { kotlin: "1.9.9", python: "1.0.0" },
      });
      expect(isExtractorVersionCurrent(index, CURRENT)).toBe(false);
    });

    it("isExtractorVersionCurrent flags missing language when files in that language exist", () => {
      const index = makeIndex({
        extractor_version: { python: "1.0.0" }, // kotlin missing
        files: [makeFile("Foo.kt", "kotlin")], // but kotlin files are present
      });
      expect(isExtractorVersionCurrent(index, CURRENT)).toBe(false);
    });

    it("isExtractorVersionCurrent returns false for empty extractor_version object with no files", () => {
      const index = makeIndex({
        extractor_version: {},
        files: [],
      });
      expect(isExtractorVersionCurrent(index, CURRENT)).toBe(false);
    });

    it("isExtractorVersionCurrent tolerates missing language when no files in that language", () => {
      // Regression: legacy indexes written before EXTRACTOR_VERSIONS gained a
      // language must not be invalidated when they have no symbols in that
      // language. Without this tolerance every fresh language addition turns
      // every existing index into "NOT INDEXED" until manual reindex.
      const index = makeIndex({
        extractor_version: { python: "1.0.0" }, // kotlin missing
        files: [makeFile("a.py", "python")], // no kotlin files
      });
      expect(isExtractorVersionCurrent(index, CURRENT)).toBe(true);
    });

    it("isExtractorVersionCurrent returns false when the stored snapshot is absent", () => {
      const index = makeIndex();
      expect(isExtractorVersionCurrent(index, CURRENT)).toBe(false);
    });

    it("EXTRACTOR_VERSIONS registers typescript (forces reindex after wiki-v2 bump)", async () => {
      const { EXTRACTOR_VERSIONS } = await import("../../src/tools/project-tools.js");
      // v3.0.0: Tasks 7-12 of TS extractor expansion — heritage, generics,
      // enum members, is_async, modifiers, namespace/ambient, anon defaults,
      // AST import-graph branch + tsconfig paths.
      expect(EXTRACTOR_VERSIONS.typescript).toBe("3.0.0");
      expect(EXTRACTOR_VERSIONS.javascript).toBe("1.0.0");
      // Index written by older code (no typescript field) WITH typescript
      // files must trigger cache miss — symbols were extracted by the old
      // extractor and are genuinely stale.
      const index = makeIndex({
        extractor_version: { kotlin: "2.0.0", python: "1.0.0" },
        files: [makeFile("src/a.ts", "typescript")],
      });
      expect(isExtractorVersionCurrent(index, { ...EXTRACTOR_VERSIONS })).toBe(false);
    });

    it("loadIndexOrStale flags stale when an indexed language drifts versions", async () => {
      const indexPath = join(tmpDir, "stale-with-files.index.json");
      const index = makeIndex({
        extractor_version: { kotlin: "2.0.0", python: "1.0.0" },
        files: [makeFile("src/a.ts", "typescript")],
      });
      await saveIndex(indexPath, index);

      const result = await loadIndexOrStale(indexPath, {
        kotlin: "2.0.0",
        python: "1.0.0",
        typescript: "3.0.0",
      });
      expect(result?.status).toBe("stale");
      if (result?.status === "stale") {
        expect(result.language).toBe("typescript");
        expect(result.expected_version).toBe("3.0.0");
        expect(result.actual_version).toBe("missing");
      }
    });

    it("loadIndexOrStale adds mismatch_detail when multiple indexed languages drift", async () => {
      const indexPath = join(tmpDir, "multi-lang-stale.index.json");
      const index = makeIndex({
        extractor_version: { kotlin: "2.0.0", python: "0.8.0", typescript: "2.0.0" },
        files: [
          makeFile("src/a.ts", "typescript"),
          makeFile("b.py", "python"),
        ],
      });
      await saveIndex(indexPath, index);

      const result = await loadIndexOrStale(indexPath, {
        kotlin: "2.0.0",
        python: "1.0.0",
        typescript: "3.0.0",
      });
      expect(result?.status).toBe("stale");
      if (result?.status === "stale") {
        expect(result.mismatch_detail).toBeDefined();
        expect(result.mismatch_detail).toContain("typescript");
        expect(result.mismatch_detail).toContain("python");
      }
    });

    it("loadIndexOrStale returns ok when newly added language has no files in the index", async () => {
      // Mirror of the translation-qa regression: legacy index lacks the
      // typescript entry but contains zero TS files, so its data is correct.
      const indexPath = join(tmpDir, "tolerated-legacy.index.json");
      const index = makeIndex({
        extractor_version: { kotlin: "2.0.0", python: "1.0.0" },
        files: [makeFile("a.py", "python")],
      });
      await saveIndex(indexPath, index);

      const result = await loadIndexOrStale(indexPath, {
        kotlin: "2.0.0",
        python: "1.0.0",
        typescript: "3.0.0",
      });
      expect(result?.status).toBe("ok");
    });

    it("saveIncremental via loadIndex-without-check preserves extractor_version round-trip", async () => {
      const indexPath = join(tmpDir, "round-trip.index.json");
      const initial = makeIndex({
        symbols: [makeSymbol("src/a.ts", "f", 1)],
        symbol_count: 1,
        extractor_version: { kotlin: "2.0.0" },
      });
      await saveIndex(indexPath, initial);

      await saveIncremental(indexPath, "src/a.ts", [makeSymbol("src/a.ts", "f2", 5)]);

      const loaded = await loadIndex(indexPath);
      expect(loaded!.extractor_version).toEqual({ kotlin: "2.0.0" });
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
