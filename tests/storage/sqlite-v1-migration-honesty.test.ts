import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  loadIndexSqlite,
  saveIndexSqlite,
  wasLossilyMigrated,
  closeAllIndexDbs,
} from "../../src/storage/sqlite-index-store.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

/**
 * v1 made `symbols.id` a PRIMARY KEY, but `repo:file:name:line` is not unique — so colliding
 * rows were silently discarded. The v2 rebuild keeps everything still stored; it cannot bring
 * back what was already gone. These pin that the upgraded database says so.
 */

let dir: string;
let dbPath: string;

function sym(name: string, line: number, file = "bundle.min.js"): CodeSymbol {
  return {
    id: `test:${file}:${name}:${line}`,
    repo: "test/repo",
    name,
    kind: "function",
    file,
    start_line: line,
    end_line: line,
  };
}

function makeIndex(symbols: CodeSymbol[]): CodeIndex {
  return {
    repo: "test/repo",
    root: "/tmp/root",
    symbols,
    files: [{ path: "bundle.min.js", language: "javascript", symbol_count: symbols.length, last_modified: 1 }],
    created_at: 1,
    updated_at: 2,
    symbol_count: symbols.length,
    file_count: 1,
  };
}

/** Build a database in the v1 shape: symbols.id as PRIMARY KEY. */
function writeV1Database(path: string, rows: Array<{ id: string; name: string }>): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE files (path TEXT PRIMARY KEY, language TEXT NOT NULL, symbol_count INTEGER NOT NULL,
                        last_modified INTEGER NOT NULL, mtime_ms INTEGER, stale INTEGER);
    CREATE TABLE symbols (
      id TEXT PRIMARY KEY, file TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
      start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, start_col INTEGER, end_col INTEGER,
      start_byte INTEGER, end_byte INTEGER, signature TEXT, docstring TEXT, source TEXT,
      parent TEXT, is_async INTEGER, is_exported INTEGER, extras TEXT
    );
  `);
  const meta = db.prepare("INSERT INTO meta(key,value) VALUES(?,?)");
  meta.run("schema_version", "1");
  meta.run("repo", "test/repo");
  meta.run("root", "/tmp/root");
  meta.run("created_at", "1");
  meta.run("updated_at", "2");
  const ins = db.prepare(
    "INSERT INTO symbols (id,file,name,kind,start_line,end_line) VALUES (?,?,?,?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET name=excluded.name",
  );
  // The v1 collision: same id, different symbols. The second overwrites the first.
  for (const r of rows) ins.run(r.id, "bundle.min.js", r.name, "function", 1, 1);
  db.prepare("INSERT INTO files(path,language,symbol_count,last_modified) VALUES(?,?,?,?)")
    .run("bundle.min.js", "javascript", rows.length, 1);
  db.close();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codesift-v1mig-"));
  dbPath = join(dir, "legacy.index.db");
});

afterEach(async () => {
  closeAllIndexDbs();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("v1 -> v2 migration is honest about what it could not recover", () => {
  it("marks a migrated index as lossy", async () => {
    // Two DISTINCT symbols on line 1 of a minified bundle share an id; v1 kept only one.
    writeV1Database(dbPath, [
      { id: "test:bundle.min.js:a:1", name: "a" },
      { id: "test:bundle.min.js:a:1", name: "b" }, // overwrote the first under v1
    ]);

    const loaded = await loadIndexSqlite(dbPath);
    expect(loaded).not.toBeNull();
    // The rebuild kept the single surviving row — it cannot resurrect the other.
    expect(loaded!.symbols).toHaveLength(1);
    expect(await wasLossilyMigrated(dbPath)).toBe(true);
  });

  it("a full reindex clears the marker, because it restores from source", async () => {
    writeV1Database(dbPath, [{ id: "test:bundle.min.js:a:1", name: "a" }]);
    await loadIndexSqlite(dbPath);
    expect(await wasLossilyMigrated(dbPath)).toBe(true);

    await saveIndexSqlite(dbPath, makeIndex([sym("a", 1), sym("b", 1)]));
    expect(await wasLossilyMigrated(dbPath)).toBe(false);

    // And both colliding symbols survive now that the PRIMARY KEY is gone.
    const reloaded = await loadIndexSqlite(dbPath);
    expect(reloaded!.symbols).toHaveLength(2);
  });

  it("a fresh v2 index is never marked lossy", async () => {
    await saveIndexSqlite(dbPath, makeIndex([sym("a", 1)]));
    expect(await wasLossilyMigrated(dbPath)).toBe(false);
  });
});
