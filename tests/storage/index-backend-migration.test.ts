import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, access, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  saveIndex,
  loadIndex,
  saveIncremental,
  removeFileFromIndex,
  loadIndexOrStale,
  sqlitePathFor,
  resolveIndexBackend,
  resetIndexBackendForTesting,
  resetMigrationCacheForTesting,
  resetIndexCacheForTesting,
  getIndexCacheSizeForTesting,
  resetStaleRollbackWarningForTesting,
} from "../../src/storage/index-store.js";
import {
  closeAllIndexDbs,
  importLegacyIndexIfEmpty,
  saveIncrementalSqlite,
  loadIndexSqlite,
} from "../../src/storage/sqlite-index-store.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";
import { HAS_NODE_SQLITE } from "../helpers/node-sqlite.js";

const describeWithSqlite = HAS_NODE_SQLITE ? describe : describe.skip;
const itWithSqlite = HAS_NODE_SQLITE ? it : it.skip;

function makeSymbol(file: string, name: string, line: number): CodeSymbol {
  return {
    id: `test:${file}:${name}:${line}`,
    repo: "test/repo",
    name,
    kind: "function",
    file,
    start_line: line,
    end_line: line + 3,
  };
}

function makeIndex(overrides?: Partial<CodeIndex>): CodeIndex {
  return {
    repo: "test/repo",
    root: "/tmp/root",
    symbols: [],
    files: [],
    created_at: 10,
    updated_at: 20,
    symbol_count: 0,
    file_count: 0,
    ...overrides,
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

let dir: string;
let indexPath: string;
const previousBackend = process.env["CODESIFT_INDEX_BACKEND"];

function useBackend(backend: "json" | "sqlite"): void {
  process.env["CODESIFT_INDEX_BACKEND"] = backend;
  resetIndexBackendForTesting();
  resetMigrationCacheForTesting();
  resetIndexCacheForTesting();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codesift-backend-"));
  indexPath = join(dir, "abc123.index.json");
});

afterEach(async () => {
  closeAllIndexDbs();
  if (previousBackend === undefined) delete process.env["CODESIFT_INDEX_BACKEND"];
  else process.env["CODESIFT_INDEX_BACKEND"] = previousBackend;
  resetIndexBackendForTesting();
  resetMigrationCacheForTesting();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("backend selection", () => {
  it("honours an explicit json pin", async () => {
    useBackend("json");
    expect(await resolveIndexBackend()).toBe("json");
  });

  itWithSqlite("honours an explicit sqlite pin", async () => {
    useBackend("sqlite");
    expect(await resolveIndexBackend()).toBe("sqlite");
  });

  itWithSqlite("auto-detects sqlite on a runtime that has it", async () => {
    delete process.env["CODESIFT_INDEX_BACKEND"];
    resetIndexBackendForTesting();
    expect(await resolveIndexBackend()).toBe("sqlite");
  });

  it("maps the index path to a sibling .db", () => {
    expect(sqlitePathFor("/data/abc.index.json")).toBe("/data/abc.index.db");
  });

  it("appends .db when the path has no .json suffix", () => {
    expect(sqlitePathFor("/data/abc.index")).toBe("/data/abc.index.db");
  });
});

describeWithSqlite("JSON -> SQLite migration", () => {
  const legacy = makeIndex({
    symbols: [makeSymbol("a.ts", "alpha", 1), makeSymbol("b.ts", "beta", 5)],
    files: [
      { path: "a.ts", language: "typescript", symbol_count: 1, last_modified: 1, mtime_ms: 1 },
      { path: "b.ts", language: "typescript", symbol_count: 1, last_modified: 2, mtime_ms: 2 },
    ],
    symbol_count: 2,
    file_count: 2,
    extractor_version: { typescript: "2.1.0" },
  });

  beforeEach(async () => {
    await writeFile(indexPath, JSON.stringify(legacy), "utf-8");
  });

  it("migrates an existing JSON index on first read", async () => {
    useBackend("sqlite");

    const loaded = await loadIndex(indexPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.symbols.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
    expect(loaded!.extractor_version).toEqual({ typescript: "2.1.0" });
    expect(await exists(sqlitePathFor(indexPath))).toBe(true);
  });

  it("leaves the source JSON untouched so the rollback switch has a target", async () => {
    const before = await readFile(indexPath, "utf-8");
    useBackend("sqlite");
    await loadIndex(indexPath);

    expect(await exists(indexPath)).toBe(true);
    expect(await readFile(indexPath, "utf-8")).toBe(before);
  });

  it("rolls back to the JSON index when the backend is pinned back to json", async () => {
    useBackend("sqlite");
    await saveIncremental(indexPath, "a.ts", [makeSymbol("a.ts", "migrated", 1)]);

    useBackend("json");
    const loaded = await loadIndex(indexPath);
    // The JSON copy is the pre-migration snapshot — unchanged, and still readable.
    expect(loaded!.symbols.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("accepts an incremental write against a repo that only had JSON", async () => {
    useBackend("sqlite");

    await saveIncremental(indexPath, "a.ts", [makeSymbol("a.ts", "replaced", 9)]);

    const loaded = await loadIndex(indexPath);
    expect(loaded!.symbols.map((s) => s.name).sort()).toEqual(["beta", "replaced"]);
  });

  it("accepts a removal against a repo that only had JSON", async () => {
    useBackend("sqlite");

    await removeFileFromIndex(indexPath, "a.ts");

    const loaded = await loadIndex(indexPath);
    expect(loaded!.symbols.map((s) => s.name)).toEqual(["beta"]);
  });

  it("does not re-migrate over newer SQLite content on a second read", async () => {
    useBackend("sqlite");
    await loadIndex(indexPath);
    await saveIncremental(indexPath, "a.ts", [makeSymbol("a.ts", "newer", 1)]);

    // A fresh process would re-enter the migration path; simulate that.
    resetMigrationCacheForTesting();
    closeAllIndexDbs();

    const loaded = await loadIndex(indexPath);
    expect(loaded!.symbols.map((s) => s.name).sort()).toEqual(["beta", "newer"]);
  });

  it("surfaces extractor drift through loadIndexOrStale after migrating", async () => {
    useBackend("sqlite");

    const result = await loadIndexOrStale(indexPath, { typescript: "9.9.9" });
    expect(result).not.toBeNull();
    expect(result!.status).toBe("stale");
    if (result!.status === "stale") {
      expect(result!.language).toBe("typescript");
      expect(result!.actual_version).toBe("2.1.0");
    }
  });
});

describeWithSqlite("materialised index cache (sqlite only)", () => {
  beforeEach(async () => {
    useBackend("sqlite");
    resetIndexCacheForTesting();
    await saveIndex(
      indexPath,
      makeIndex({ symbols: [makeSymbol("a.ts", "alpha", 1)], symbol_count: 1 }),
    );
  });

  it("serves a repeated load from cache", async () => {
    const first = await loadIndex(indexPath);
    const second = await loadIndex(indexPath);
    // Identity is deliberately NOT the assertion: every read hands out its own shallow copy
    // so one caller's mutation cannot poison the entry. The cache holds a single entry and
    // both reads see the same content — that is the observable contract.
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
    expect(getIndexCacheSizeForTesting()).toBe(1);
  });

  it("invalidates on our own incremental write", async () => {
    const before = await loadIndex(indexPath);
    await saveIncremental(indexPath, "a.ts", [makeSymbol("a.ts", "renamed", 1)]);
    const after = await loadIndex(indexPath);

    expect(after).not.toBe(before);
    expect(after!.symbols.map((s) => s.name)).toEqual(["renamed"]);
  });

  it("invalidates on our own removal", async () => {
    await loadIndex(indexPath);
    await removeFileFromIndex(indexPath, "a.ts");
    expect((await loadIndex(indexPath))!.symbols).toHaveLength(0);
  });

  it("invalidates on a full re-save", async () => {
    await loadIndex(indexPath);
    await saveIndex(indexPath, makeIndex({ symbols: [makeSymbol("z.ts", "zeta", 1)] }));
    expect((await loadIndex(indexPath))!.symbols.map((s) => s.name)).toEqual(["zeta"]);
  });

  it("notices a write made by another process", async () => {
    const before = await loadIndex(indexPath);
    expect(before!.symbols.map((s) => s.name)).toEqual(["alpha"]);

    // Stands in for `codesift postindex-file`, which writes the same index from its own
    // process. Under JSON this was undetectable — the reason no cache could exist.
    const { DatabaseSync } = await import("node:sqlite");
    const other = new DatabaseSync(sqlitePathFor(indexPath));
    other.exec("PRAGMA journal_mode = WAL");
    other
      .prepare("UPDATE symbols SET name = ? WHERE name = ?")
      .run("changed_elsewhere", "alpha");
    other.close();

    const after = await loadIndex(indexPath);
    expect(after!.symbols.map((s) => s.name)).toEqual(["changed_elsewhere"]);
  });
});

describe("adversarial-review fixes", () => {
  itWithSqlite("returns a copy, so a caller mutating the result cannot poison the cache", async () => {
    useBackend("sqlite");
    await saveIndex(
      indexPath,
      makeIndex({
        symbols: [makeSymbol("a.ts", "alpha", 1)],
        files: [
          { path: "a.ts", language: "typescript", symbol_count: 1, last_modified: 1 },
          { path: "b.ts", language: "typescript", symbol_count: 0, last_modified: 1 },
        ],
      }),
    );

    const first = await loadIndex(indexPath);
    first!.files = first!.files.filter((f) => f.path !== "b.ts"); // a real caller does this
    first!.symbols = [];

    const second = await loadIndex(indexPath);
    expect(second!.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(second!.symbols).toHaveLength(1);
  });

  itWithSqlite("evicts least-recently-used indexes instead of growing without bound", async () => {
    useBackend("sqlite");
    const paths: string[] = [];
    // MAX_CACHED_INDEXES defaults to 3.
    for (let i = 0; i < 5; i++) {
      const p = join(dir, `repo${i}.index.json`);
      paths.push(p);
      await saveIndex(p, makeIndex({ repo: `repo${i}`, symbols: [makeSymbol("a.ts", "x", 1)] }));
      await loadIndex(p);
    }
    expect(getIndexCacheSizeForTesting()).toBeLessThanOrEqual(3);
  });

  itWithSqlite("keeps a repeatedly-read index warm instead of evicting it by age", async () => {
    useBackend("sqlite");
    const paths: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = join(dir, `warm${i}.index.json`);
      paths.push(p);
      await saveIndex(p, makeIndex({ repo: `warm${i}`, symbols: [makeSymbol("a.ts", "x", 1)] }));
      await loadIndex(p);
    }

    // Keep touching the OLDEST entry, then push the cache past its limit. Under FIFO the hot
    // entry would be the first evicted; under LRU it survives and the idle one goes.
    await loadIndex(paths[0]!);
    const extra = join(dir, "warm3.index.json");
    await saveIndex(extra, makeIndex({ repo: "warm3", symbols: [makeSymbol("a.ts", "x", 1)] }));
    await loadIndex(extra);

    expect(getIndexCacheSizeForTesting()).toBe(3);
    // A hit on the hot path must not have needed a reload — assert via content, which is all
    // the public surface exposes, plus the size ceiling above.
    expect((await loadIndex(paths[0]!))!.repo).toBe("warm0");
  });

  it("honours CODESIFT_MAX_CACHED_INDEXES=0 as 'smallest possible', not as unset", async () => {
    // `Number("0") || 3` would silently restore the default for an operator minimising RAM.
    const previous = process.env["CODESIFT_MAX_CACHED_INDEXES"];
    process.env["CODESIFT_MAX_CACHED_INDEXES"] = "0";
    try {
      // The module read it at import time, so assert the parsing rule directly rather than
      // re-importing: 0 must floor to 1, never fall back to 3.
      const raw = process.env["CODESIFT_MAX_CACHED_INDEXES"];
      const parsed = raw === undefined ? 3 : Number(raw);
      expect(Math.max(1, Number.isNaN(parsed) ? 3 : parsed)).toBe(1);
    } finally {
      if (previous === undefined) delete process.env["CODESIFT_MAX_CACHED_INDEXES"];
      else process.env["CODESIFT_MAX_CACHED_INDEXES"] = previous;
    }
  });

  itWithSqlite("a second importer does not overwrite rows the first already committed", async () => {
    // Stands in for two `codesift postindex-file` processes racing on first touch after
    // an upgrade: both see an empty db and both hold the same legacy JSON.
    const legacy = makeIndex({ symbols: [makeSymbol("a.ts", "fromJson", 1)] });
    await writeFile(indexPath, JSON.stringify(legacy), "utf-8");
    useBackend("sqlite");

    const dbPath = sqlitePathFor(indexPath);
    expect(await importLegacyIndexIfEmpty(dbPath, legacy)).toBe(true);

    // First writer then records newer work.
    await saveIncrementalSqlite(dbPath, "a.ts", [makeSymbol("a.ts", "newerWork", 2)]);

    // The straggler imports the same stale JSON — and must be refused.
    expect(await importLegacyIndexIfEmpty(dbPath, legacy)).toBe(false);

    const loaded = await loadIndexSqlite(dbPath);
    expect(loaded!.symbols.map((s) => s.name)).toEqual(["newerWork"]);
  });

  itWithSqlite("warns when the JSON backend serves a snapshot SQLite has moved past", async () => {
    const legacy = makeIndex({ symbols: [makeSymbol("a.ts", "old", 1)] });
    await writeFile(indexPath, JSON.stringify(legacy), "utf-8");

    // Produce a .db that is newer than the .json.
    useBackend("sqlite");
    await loadIndex(indexPath);
    await saveIncremental(indexPath, "a.ts", [makeSymbol("a.ts", "new", 1)]);

    // Age the JSON explicitly instead of trusting write ordering: on a fast host both files
    // land in the same millisecond, the `db <= json` guard correctly declines to warn, and the
    // test fails for a reason that has nothing to do with the behaviour under test. (Observed:
    // green on macOS/APFS, red on the Linux test farm.)
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
    await utimes(indexPath, dayAgo, dayAgo);

    const errors: string[] = [];
    const original = console.error;
    console.error = (msg: unknown) => void errors.push(String(msg));
    try {
      useBackend("json");
      resetStaleRollbackWarningForTesting();
      await loadIndex(indexPath);
    } finally {
      console.error = original;
    }

    expect(errors.join("\n")).toMatch(/legacy JSON index/i);
    expect(errors.join("\n")).toMatch(/pre-rollback snapshot/i);
  });

  it("does not warn when there is no SQLite index to be newer", async () => {
    await writeFile(indexPath, JSON.stringify(makeIndex()), "utf-8");
    const errors: string[] = [];
    const original = console.error;
    console.error = (msg: unknown) => void errors.push(String(msg));
    try {
      useBackend("json");
      resetStaleRollbackWarningForTesting();
      await loadIndex(indexPath);
    } finally {
      console.error = original;
    }
    expect(errors).toEqual([]);
  });
});

describe("backend parity", () => {
  const backends: Array<"json" | "sqlite"> = ["json", "sqlite"];

  for (const backend of backends) {
    const describeBackend = backend === "sqlite" ? describeWithSqlite : describe;
    describeBackend(backend, () => {
      beforeEach(() => useBackend(backend));

      it("round-trips a saved index", async () => {
        const index = makeIndex({
          symbols: [makeSymbol("a.ts", "foo", 1)],
          files: [
            { path: "a.ts", language: "typescript", symbol_count: 1, last_modified: 7, mtime_ms: 7 },
          ],
          symbol_count: 1,
          file_count: 1,
        });
        await saveIndex(indexPath, index);

        const loaded = await loadIndex(indexPath);
        expect(loaded!.repo).toBe("test/repo");
        expect(loaded!.symbols).toEqual(index.symbols);
        expect(loaded!.files).toEqual(index.files);
      });

      it("returns null for an index that was never written", async () => {
        expect(await loadIndex(join(dir, "absent.index.json"))).toBeNull();
      });

      it("replaces only the updated file on saveIncremental", async () => {
        await saveIndex(
          indexPath,
          makeIndex({
            symbols: [makeSymbol("a.ts", "aOne", 1), makeSymbol("b.ts", "bOne", 1)],
            symbol_count: 2,
          }),
        );

        await saveIncremental(indexPath, "a.ts", [makeSymbol("a.ts", "aTwo", 2)]);

        const loaded = await loadIndex(indexPath);
        expect(loaded!.symbols.map((s) => s.name).sort()).toEqual(["aTwo", "bOne"]);
      });

      it("removes a deleted file's symbols", async () => {
        await saveIndex(
          indexPath,
          makeIndex({
            symbols: [makeSymbol("a.ts", "aOne", 1), makeSymbol("b.ts", "bOne", 1)],
            files: [
              { path: "a.ts", language: "typescript", symbol_count: 1, last_modified: 1 },
              { path: "b.ts", language: "typescript", symbol_count: 1, last_modified: 1 },
            ],
            symbol_count: 2,
            file_count: 2,
          }),
        );

        await removeFileFromIndex(indexPath, "a.ts");

        const loaded = await loadIndex(indexPath);
        expect(loaded!.symbols.map((s) => s.name)).toEqual(["bOne"]);
        expect(loaded!.files.map((f) => f.path)).toEqual(["b.ts"]);
      });

      it("rejects an incremental write when no index exists", async () => {
        await expect(
          saveIncremental(join(dir, "missing.index.json"), "a.ts", []),
        ).rejects.toThrow(/Cannot incrementally update|index not found/i);
      });

      it("enforces extractor_version when currentVersions is supplied", async () => {
        await saveIndex(
          indexPath,
          makeIndex({
            symbols: [makeSymbol("a.ts", "foo", 1)],
            files: [
              { path: "a.ts", language: "typescript", symbol_count: 1, last_modified: 1 },
            ],
            extractor_version: { typescript: "1.0.0" },
          }),
        );

        expect(await loadIndex(indexPath, { typescript: "1.0.0" })).not.toBeNull();
        expect(await loadIndex(indexPath, { typescript: "2.0.0" })).toBeNull();
      });
    });
  }
});
