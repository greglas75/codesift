import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  saveIndexSqlite,
  loadIndexSqlite,
  saveIncrementalSqlite,
  removeFileFromIndexSqlite,
  getFileMtimeSqlite,
  getSymbolsForFileSqlite,
  getDataVersion,
  openIndexDb,
  closeIndexDb,
  closeAllIndexDbs,
  isSqliteAvailable,
  SCHEMA_VERSION,
} from "../../src/storage/sqlite-index-store.js";
import type { CodeIndex, CodeSymbol, FileEntry } from "../../src/types.js";

function makeFile(path: string, language: string, mtime = 1000): FileEntry {
  return {
    path,
    language,
    symbol_count: 1,
    last_modified: mtime,
    mtime_ms: mtime,
  };
}

function makeSymbol(file: string, name: string, line: number): CodeSymbol {
  return {
    id: `test:${file}:${name}:${line}`,
    repo: "test/repo",
    name,
    kind: "function",
    file,
    start_line: line,
    end_line: line + 5,
  };
}

function makeIndex(overrides?: Partial<CodeIndex>): CodeIndex {
  return {
    repo: "test/repo",
    root: "/tmp/test-root",
    symbols: [],
    files: [],
    created_at: 111,
    updated_at: 222,
    symbol_count: 0,
    file_count: 0,
    ...overrides,
  };
}

let dir: string;
let dbPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codesift-sqlite-"));
  dbPath = join(dir, "index.db");
});

afterEach(async () => {
  closeAllIndexDbs();
  await rm(dir, { recursive: true, force: true });
});

describe("sqlite availability", () => {
  it("reports availability on this runtime", async () => {
    // Node >= 22.5 in CI and locally; the JSON fallback covers the negative case.
    expect(await isSqliteAvailable()).toBe(true);
  });
});

describe("whole-index round trip", () => {
  it("returns null before anything is written", async () => {
    expect(await loadIndexSqlite(dbPath)).toBeNull();
  });

  it("round-trips a minimal index", async () => {
    const index = makeIndex({
      symbols: [makeSymbol("a.ts", "foo", 1)],
      files: [makeFile("a.ts", "typescript")],
      symbol_count: 1,
      file_count: 1,
    });
    await saveIndexSqlite(dbPath, index);

    const loaded = await loadIndexSqlite(dbPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.repo).toBe("test/repo");
    expect(loaded!.root).toBe("/tmp/test-root");
    expect(loaded!.created_at).toBe(111);
    expect(loaded!.symbols).toEqual(index.symbols);
    expect(loaded!.files).toEqual(index.files);
    expect(loaded!.symbol_count).toBe(1);
    expect(loaded!.file_count).toBe(1);
  });

  it("preserves every optional symbol field, including language-specific extras", async () => {
    const rich: CodeSymbol = {
      id: "test:x.py:Thing:3",
      repo: "test/repo",
      name: "Thing",
      kind: "class",
      file: "x.py",
      start_line: 3,
      end_line: 40,
      start_col: 2,
      end_col: 9,
      start_byte: 55,
      end_byte: 900,
      signature: "(a: int, b: str) -> None",
      docstring: "Does a thing.",
      source: "class Thing:\n    pass",
      parent: "test:x.py:Outer:1",
      is_async: true,
      is_exported: false,
      tokens: ["thing", "does"],
      decorators: ["@dataclass"],
      extends: ["Base"],
      implements: ["Proto"],
      meta: { nested: { deep: [1, 2, 3] }, flag: true },
    };

    await saveIndexSqlite(
      dbPath,
      makeIndex({ symbols: [rich], files: [makeFile("x.py", "python")] }),
    );

    const loaded = await loadIndexSqlite(dbPath);
    expect(loaded!.symbols[0]).toEqual(rich);
  });

  it("does not invent optional fields that were absent", async () => {
    const bare = makeSymbol("a.ts", "foo", 1);
    await saveIndexSqlite(dbPath, makeIndex({ symbols: [bare] }));

    const loaded = await loadIndexSqlite(dbPath);
    const got = loaded!.symbols[0]!;
    // exactOptionalPropertyTypes is on: an absent field must stay absent, not become
    // undefined/null, or deep-equality against a freshly built index breaks.
    expect(Object.hasOwn(got, "signature")).toBe(false);
    expect(Object.hasOwn(got, "meta")).toBe(false);
    expect(Object.hasOwn(got, "is_async")).toBe(false);
    expect(got).toEqual(bare);
  });

  it("preserves false and 0 rather than dropping them as falsy", async () => {
    const sym: CodeSymbol = {
      ...makeSymbol("a.ts", "foo", 1),
      is_async: false,
      is_exported: false,
      start_col: 0,
      start_byte: 0,
    };
    await saveIndexSqlite(dbPath, makeIndex({ symbols: [sym] }));

    const got = (await loadIndexSqlite(dbPath))!.symbols[0]!;
    expect(got.is_async).toBe(false);
    expect(got.is_exported).toBe(false);
    expect(got.start_col).toBe(0);
    expect(got.start_byte).toBe(0);
  });

  it("round-trips extractor_version and workspaces", async () => {
    await saveIndexSqlite(
      dbPath,
      makeIndex({ extractor_version: { typescript: "2.1.0", python: "1.4.0" } }),
    );
    const loaded = await loadIndexSqlite(dbPath);
    expect(loaded!.extractor_version).toEqual({ typescript: "2.1.0", python: "1.4.0" });
    expect(Object.hasOwn(loaded!, "workspaces")).toBe(false);
  });

  it("replaces prior contents instead of appending on re-save", async () => {
    await saveIndexSqlite(
      dbPath,
      makeIndex({ symbols: [makeSymbol("a.ts", "foo", 1)], files: [makeFile("a.ts", "typescript")] }),
    );
    await saveIndexSqlite(
      dbPath,
      makeIndex({ symbols: [makeSymbol("b.ts", "bar", 1)], files: [makeFile("b.ts", "typescript")] }),
    );

    const loaded = await loadIndexSqlite(dbPath);
    expect(loaded!.symbols).toHaveLength(1);
    expect(loaded!.symbols[0]!.name).toBe("bar");
    expect(loaded!.files).toHaveLength(1);
    expect(loaded!.files[0]!.path).toBe("b.ts");
  });

  it("preserves a file entry whose stale flag is set", async () => {
    const entry: FileEntry = { ...makeFile("a.ts", "typescript"), stale: true };
    await saveIndexSqlite(dbPath, makeIndex({ files: [entry] }));
    expect((await loadIndexSqlite(dbPath))!.files[0]).toEqual(entry);
  });
});

describe("incremental update", () => {
  beforeEach(async () => {
    await saveIndexSqlite(
      dbPath,
      makeIndex({
        symbols: [
          makeSymbol("a.ts", "aOne", 1),
          makeSymbol("a.ts", "aTwo", 10),
          makeSymbol("b.ts", "bOne", 1),
        ],
        files: [makeFile("a.ts", "typescript"), makeFile("b.ts", "typescript")],
        symbol_count: 3,
        file_count: 2,
      }),
    );
  });

  it("replaces only the touched file's symbols", async () => {
    await saveIncrementalSqlite(dbPath, "a.ts", [makeSymbol("a.ts", "aRenamed", 2)]);

    const loaded = await loadIndexSqlite(dbPath);
    const names = loaded!.symbols.map((s) => s.name).sort();
    expect(names).toEqual(["aRenamed", "bOne"]);
    expect(loaded!.symbol_count).toBe(2);
  });

  it("updates the file entry when one is supplied", async () => {
    const entry = makeFile("a.ts", "typescript", 9999);
    await saveIncrementalSqlite(dbPath, "a.ts", [makeSymbol("a.ts", "x", 1)], entry);

    const loaded = await loadIndexSqlite(dbPath);
    expect(loaded!.files.find((f) => f.path === "a.ts")!.mtime_ms).toBe(9999);
    expect(loaded!.files).toHaveLength(2);
  });

  it("can empty a file's symbols without removing the file", async () => {
    await saveIncrementalSqlite(dbPath, "a.ts", []);
    const loaded = await loadIndexSqlite(dbPath);
    expect(loaded!.symbols.map((s) => s.name)).toEqual(["bOne"]);
    expect(loaded!.files).toHaveLength(2);
  });

  it("throws when the index does not exist yet", async () => {
    const missing = join(dir, "absent.db");
    await expect(
      saveIncrementalSqlite(missing, "a.ts", [makeSymbol("a.ts", "x", 1)]),
    ).rejects.toThrow(/index not found/i);
  });

  it("bumps updated_at", async () => {
    const before = (await loadIndexSqlite(dbPath))!.updated_at;
    await saveIncrementalSqlite(dbPath, "a.ts", [makeSymbol("a.ts", "x", 1)]);
    const after = (await loadIndexSqlite(dbPath))!.updated_at;
    expect(after).toBeGreaterThan(before);
  });
});

describe("removal", () => {
  beforeEach(async () => {
    await saveIndexSqlite(
      dbPath,
      makeIndex({
        symbols: [makeSymbol("a.ts", "aOne", 1), makeSymbol("b.ts", "bOne", 1)],
        files: [makeFile("a.ts", "typescript"), makeFile("b.ts", "typescript")],
      }),
    );
  });

  it("drops the file's symbols and its files[] entry", async () => {
    await removeFileFromIndexSqlite(dbPath, "a.ts");
    const loaded = await loadIndexSqlite(dbPath);
    expect(loaded!.symbols.map((s) => s.name)).toEqual(["bOne"]);
    expect(loaded!.files.map((f) => f.path)).toEqual(["b.ts"]);
  });

  it("is a no-op for an unknown file", async () => {
    await removeFileFromIndexSqlite(dbPath, "never-existed.ts");
    const loaded = await loadIndexSqlite(dbPath);
    expect(loaded!.symbols).toHaveLength(2);
  });

  it("does not throw against a missing index", async () => {
    await expect(
      removeFileFromIndexSqlite(join(dir, "absent.db"), "a.ts"),
    ).resolves.toBeUndefined();
  });
});

describe("narrow accessors", () => {
  beforeEach(async () => {
    await saveIndexSqlite(
      dbPath,
      makeIndex({
        symbols: [makeSymbol("a.ts", "aOne", 1), makeSymbol("b.ts", "bOne", 1)],
        files: [makeFile("a.ts", "typescript", 4242), makeFile("b.ts", "typescript", 7)],
      }),
    );
  });

  it("getFileMtime returns the stored mtime", async () => {
    expect(await getFileMtimeSqlite(dbPath, "a.ts")).toBe(4242);
  });

  it("getFileMtime returns undefined for an unknown file", async () => {
    expect(await getFileMtimeSqlite(dbPath, "nope.ts")).toBeUndefined();
  });

  it("getSymbolsForFile returns only that file's symbols", async () => {
    const syms = await getSymbolsForFileSqlite(dbPath, "a.ts");
    expect(syms.map((s) => s.name)).toEqual(["aOne"]);
    expect(syms[0]!.repo).toBe("test/repo");
  });

  it("getSymbolsForFile is empty for an unknown file", async () => {
    expect(await getSymbolsForFileSqlite(dbPath, "nope.ts")).toEqual([]);
  });
});

describe("schema guard", () => {
  it("refuses an index written by a newer schema", async () => {
    await saveIndexSqlite(dbPath, makeIndex());
    const db = await openIndexDb(dbPath);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
      String(SCHEMA_VERSION + 1),
    );
    closeIndexDb(dbPath);

    await expect(openIndexDb(dbPath)).rejects.toThrow(/newer CodeSift/i);
  });
});

describe("cross-process change signal", () => {
  it("exposes a data_version that a second connection's commit advances", async () => {
    await saveIndexSqlite(dbPath, makeIndex({ symbols: [makeSymbol("a.ts", "foo", 1)] }));
    const before = await getDataVersion(dbPath);

    // A separate connection stands in for the postindex-file hook process, which is the
    // case a plain JSON file gave us no way to detect.
    const { DatabaseSync } = await import("node:sqlite");
    const other = new DatabaseSync(dbPath);
    other.exec("PRAGMA journal_mode = WAL");
    other.prepare("UPDATE meta SET value = ? WHERE key = 'updated_at'").run("999");
    other.close();

    expect(await getDataVersion(dbPath)).toBeGreaterThan(before);
  });
});
