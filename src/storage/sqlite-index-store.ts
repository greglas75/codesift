import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { CodeIndex, CodeSymbol, FileEntry, Workspace } from "../types.js";

/**
 * SQLite backend for the per-repo index. See docs/adr/ADR-003-index-storage-format.md.
 *
 * The point of this module is NOT that SQL is nicer than JSON. It is that the JSON blob
 * forced every write to cost the size of the whole repo: `saveIncremental` re-parsed and
 * re-serialised 262 MB to record one edited file, and the PostToolUse hook — a fresh process
 * per edit, so it can never batch — paid that on every single Write/Edit an agent made.
 * Here a one-file re-index touches one row.
 *
 * Fidelity over elegance: hot fields get real columns (so a full load builds objects without
 * parsing anything), and the rarely-populated tail (`tokens`, `decorators`, `extends`,
 * `implements`, `meta`) is kept as one JSON `extras` column. That keeps the round-trip
 * lossless for language-specific fields nobody here should have to know about, while the
 * common symbol costs zero JSON.parse calls.
 */

// ---------------------------------------------------------------------------
// Runtime availability
// ---------------------------------------------------------------------------

/** `node:sqlite` landed in Node 22.5. The engines floor is still >=20, so its absence is a
 *  supported state, not an error — callers fall back to the JSON backend. */
let sqliteCtor: typeof DatabaseSyncType | null | undefined;

export async function loadSqliteCtor(): Promise<typeof DatabaseSyncType | null> {
  if (sqliteCtor !== undefined) return sqliteCtor;
  try {
    const mod = await import("node:sqlite");
    sqliteCtor = mod.DatabaseSync;
  } catch {
    sqliteCtor = null;
  }
  return sqliteCtor;
}

export async function isSqliteAvailable(): Promise<boolean> {
  return (await loadSqliteCtor()) !== null;
}

/** Tests need to prove the JSON fallback still works on a runtime that has sqlite. */
export function setSqliteCtorForTesting(ctor: typeof DatabaseSyncType | null | undefined): void {
  sqliteCtor = ctor;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path          TEXT PRIMARY KEY,
  language      TEXT NOT NULL,
  symbol_count  INTEGER NOT NULL,
  last_modified INTEGER NOT NULL,
  mtime_ms      INTEGER,
  stale         INTEGER
);

CREATE TABLE IF NOT EXISTS symbols (
  id          TEXT PRIMARY KEY,
  file        TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  start_col   INTEGER,
  end_col     INTEGER,
  start_byte  INTEGER,
  end_byte    INTEGER,
  signature   TEXT,
  docstring   TEXT,
  source      TEXT,
  parent      TEXT,
  is_async    INTEGER,
  is_exported INTEGER,
  extras      TEXT
);

CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
`;

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

const connections = new Map<string, DatabaseSyncType>();

/**
 * Open (and cache) a connection, creating the schema on first use.
 *
 * WAL is the reason this migration solves a problem a sharded JSON layout would not: the MCP
 * server and the `codesift postindex-file` hook are separate processes writing the same
 * index, and WAL gives them concurrent readers with a single writer instead of a corruption
 * window. `busy_timeout` makes a writer wait its turn rather than throwing SQLITE_BUSY when
 * an agent edits files faster than the previous write settles.
 */
export async function openIndexDb(dbPath: string): Promise<DatabaseSyncType> {
  const cached = connections.get(dbPath);
  if (cached) return cached;

  const Ctor = await loadSqliteCtor();
  if (!Ctor) throw new Error("node:sqlite is unavailable (requires Node >= 22.5)");

  if (dbPath !== ":memory:") await mkdir(dirname(dbPath), { recursive: true });

  const db = new Ctor(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  const stored = readMetaValue(db, "schema_version");
  if (stored === undefined) {
    writeMetaValue(db, "schema_version", String(SCHEMA_VERSION));
  } else if (Number(stored) > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `Index at ${dbPath} was written by a newer CodeSift (schema v${stored} > v${SCHEMA_VERSION}). Upgrade codesift-mcp.`,
    );
  }

  connections.set(dbPath, db);
  return db;
}

/** Close one cached connection (tests, and the shutdown path). */
export function closeIndexDb(dbPath: string): void {
  const db = connections.get(dbPath);
  if (!db) return;
  connections.delete(dbPath);
  try {
    db.close();
  } catch {
    /* already closed — nothing to protect here */
  }
}

export function closeAllIndexDbs(): void {
  for (const path of [...connections.keys()]) closeIndexDb(path);
}

// ---------------------------------------------------------------------------
// meta helpers
// ---------------------------------------------------------------------------

function readMetaValue(db: DatabaseSyncType, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function writeMetaValue(db: DatabaseSyncType, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

// ---------------------------------------------------------------------------
// Row <-> domain mapping
// ---------------------------------------------------------------------------

/** Fields that live in `extras` rather than getting their own column: present on a minority
 *  of symbols, and language-specific enough that hard-coding them as columns would mean a
 *  schema migration every time an extractor learns a new trick. */
interface SymbolExtras {
  tokens?: string[];
  decorators?: string[];
  extends?: string[];
  implements?: string[];
  meta?: Record<string, unknown>;
}

type SymbolRow = {
  id: string;
  file: string;
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
  start_col: number | null;
  end_col: number | null;
  start_byte: number | null;
  end_byte: number | null;
  signature: string | null;
  docstring: string | null;
  source: string | null;
  parent: string | null;
  is_async: number | null;
  is_exported: number | null;
  extras: string | null;
};

function symbolToRow(sym: CodeSymbol): unknown[] {
  const extras: SymbolExtras = {};
  if (sym.tokens !== undefined) extras.tokens = sym.tokens;
  if (sym.decorators !== undefined) extras.decorators = sym.decorators;
  if (sym.extends !== undefined) extras.extends = sym.extends;
  if (sym.implements !== undefined) extras.implements = sym.implements;
  if (sym.meta !== undefined) extras.meta = sym.meta;
  const hasExtras = Object.keys(extras).length > 0;

  return [
    sym.id,
    sym.file,
    sym.name,
    sym.kind,
    sym.start_line,
    sym.end_line,
    sym.start_col ?? null,
    sym.end_col ?? null,
    sym.start_byte ?? null,
    sym.end_byte ?? null,
    sym.signature ?? null,
    sym.docstring ?? null,
    sym.source ?? null,
    sym.parent ?? null,
    sym.is_async === undefined ? null : sym.is_async ? 1 : 0,
    sym.is_exported === undefined ? null : sym.is_exported ? 1 : 0,
    hasExtras ? JSON.stringify(extras) : null,
  ];
}

/** `repo` is identical for every symbol in an index, so it lives in `meta` and is stamped
 *  back on here instead of being written 100k times. */
function rowToSymbol(row: SymbolRow, repo: string): CodeSymbol {
  const sym: CodeSymbol = {
    id: row.id,
    repo,
    name: row.name,
    kind: row.kind as CodeSymbol["kind"],
    file: row.file,
    start_line: row.start_line,
    end_line: row.end_line,
  };

  if (row.start_col !== null) sym.start_col = row.start_col;
  if (row.end_col !== null) sym.end_col = row.end_col;
  if (row.start_byte !== null) sym.start_byte = row.start_byte;
  if (row.end_byte !== null) sym.end_byte = row.end_byte;
  if (row.signature !== null) sym.signature = row.signature;
  if (row.docstring !== null) sym.docstring = row.docstring;
  if (row.source !== null) sym.source = row.source;
  if (row.parent !== null) sym.parent = row.parent;
  if (row.is_async !== null) sym.is_async = row.is_async === 1;
  if (row.is_exported !== null) sym.is_exported = row.is_exported === 1;

  if (row.extras !== null) {
    const extras = JSON.parse(row.extras) as SymbolExtras;
    if (extras.tokens !== undefined) sym.tokens = extras.tokens;
    if (extras.decorators !== undefined) sym.decorators = extras.decorators;
    if (extras.extends !== undefined) sym.extends = extras.extends;
    if (extras.implements !== undefined) sym.implements = extras.implements;
    if (extras.meta !== undefined) sym.meta = extras.meta;
  }

  return sym;
}

type FileRow = {
  path: string;
  language: string;
  symbol_count: number;
  last_modified: number;
  mtime_ms: number | null;
  stale: number | null;
};

function rowToFileEntry(row: FileRow): FileEntry {
  const entry: FileEntry = {
    path: row.path,
    language: row.language,
    symbol_count: row.symbol_count,
    last_modified: row.last_modified,
  };
  if (row.mtime_ms !== null) entry.mtime_ms = row.mtime_ms;
  if (row.stale !== null) entry.stale = row.stale === 1;
  return entry;
}

function fileEntryToRow(entry: FileEntry): unknown[] {
  return [
    entry.path,
    entry.language,
    entry.symbol_count,
    entry.last_modified,
    entry.mtime_ms ?? null,
    entry.stale === undefined ? null : entry.stale ? 1 : 0,
  ];
}

const INSERT_SYMBOL_SQL = `
INSERT INTO symbols (
  id, file, name, kind, start_line, end_line, start_col, end_col,
  start_byte, end_byte, signature, docstring, source, parent,
  is_async, is_exported, extras
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  file=excluded.file, name=excluded.name, kind=excluded.kind,
  start_line=excluded.start_line, end_line=excluded.end_line,
  start_col=excluded.start_col, end_col=excluded.end_col,
  start_byte=excluded.start_byte, end_byte=excluded.end_byte,
  signature=excluded.signature, docstring=excluded.docstring,
  source=excluded.source, parent=excluded.parent,
  is_async=excluded.is_async, is_exported=excluded.is_exported,
  extras=excluded.extras
`;

const INSERT_FILE_SQL = `
INSERT INTO files (path, language, symbol_count, last_modified, mtime_ms, stale)
VALUES (?,?,?,?,?,?)
ON CONFLICT(path) DO UPDATE SET
  language=excluded.language, symbol_count=excluded.symbol_count,
  last_modified=excluded.last_modified, mtime_ms=excluded.mtime_ms,
  stale=excluded.stale
`;

// ---------------------------------------------------------------------------
// Whole-index read / write
// ---------------------------------------------------------------------------

/** Replace the entire index. Used by full (re)indexing and by JSON->SQLite migration. */
export async function saveIndexSqlite(dbPath: string, index: CodeIndex): Promise<void> {
  const db = await openIndexDb(dbPath);

  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM symbols");
    db.exec("DELETE FROM files");

    const insSym = db.prepare(INSERT_SYMBOL_SQL);
    for (const sym of index.symbols) insSym.run(...(symbolToRow(sym) as never[]));

    const insFile = db.prepare(INSERT_FILE_SQL);
    for (const file of index.files) insFile.run(...(fileEntryToRow(file) as never[]));

    writeMetaValue(db, "repo", index.repo);
    writeMetaValue(db, "root", index.root);
    writeMetaValue(db, "created_at", String(index.created_at));
    writeMetaValue(db, "updated_at", String(index.updated_at));
    writeMetaValue(db, "extractor_version", JSON.stringify(index.extractor_version ?? null));
    writeMetaValue(db, "workspaces", JSON.stringify(index.workspaces ?? null));
    writeMetaValue(db, "schema_version", String(SCHEMA_VERSION));

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Materialise the whole index. Returns null when the db has never been written to. */
export async function loadIndexSqlite(dbPath: string): Promise<CodeIndex | null> {
  const db = await openIndexDb(dbPath);

  const repo = readMetaValue(db, "repo");
  const root = readMetaValue(db, "root");
  if (repo === undefined || root === undefined) return null;

  const symbolRows = db.prepare("SELECT * FROM symbols").all() as unknown as SymbolRow[];
  const fileRows = db.prepare("SELECT * FROM files").all() as unknown as FileRow[];

  const symbols = symbolRows.map((row) => rowToSymbol(row, repo));
  const files = fileRows.map(rowToFileEntry);

  const index: CodeIndex = {
    repo,
    root,
    symbols,
    files,
    created_at: Number(readMetaValue(db, "created_at") ?? 0),
    updated_at: Number(readMetaValue(db, "updated_at") ?? 0),
    symbol_count: symbols.length,
    file_count: files.length,
  };

  const extractorRaw = readMetaValue(db, "extractor_version");
  if (extractorRaw !== undefined) {
    const parsed = JSON.parse(extractorRaw) as Record<string, string> | null;
    if (parsed !== null) index.extractor_version = parsed;
  }

  const workspacesRaw = readMetaValue(db, "workspaces");
  if (workspacesRaw !== undefined) {
    const parsed = JSON.parse(workspacesRaw) as Workspace[] | null;
    if (parsed !== null) index.workspaces = parsed;
  }

  return index;
}

// ---------------------------------------------------------------------------
// Narrow accessors — the reason this backend exists
// ---------------------------------------------------------------------------

/**
 * One file's `mtime_ms`, without materialising the index.
 *
 * `file-indexer.ts` used to parse the whole blob for exactly this value and then
 * `saveIncremental` parsed it a second time — two full parses of 262 MB to decide whether a
 * 40-line file had changed.
 */
export async function getFileMtimeSqlite(
  dbPath: string,
  filePath: string,
): Promise<number | undefined> {
  const db = await openIndexDb(dbPath);
  const row = db.prepare("SELECT mtime_ms FROM files WHERE path = ?").get(filePath) as
    | { mtime_ms: number | null }
    | undefined;
  return row?.mtime_ms ?? undefined;
}

/** One file's `files[]` entry, without materialising the index. */
export async function getFileEntrySqlite(
  dbPath: string,
  filePath: string,
): Promise<FileEntry | undefined> {
  const db = await openIndexDb(dbPath);
  const row = db.prepare("SELECT * FROM files WHERE path = ?").get(filePath) as unknown as
    | FileRow
    | undefined;
  return row ? rowToFileEntry(row) : undefined;
}

/** Replace one file's symbols (and optionally its files[] entry) in a single transaction. */
export async function saveIncrementalSqlite(
  dbPath: string,
  updatedFile: string,
  newSymbols: CodeSymbol[],
  fileEntry?: FileEntry,
): Promise<void> {
  const db = await openIndexDb(dbPath);

  if (readMetaValue(db, "repo") === undefined) {
    throw new Error(`Cannot incrementally update: index not found at ${dbPath}`);
  }

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM symbols WHERE file = ?").run(updatedFile);

    const insSym = db.prepare(INSERT_SYMBOL_SQL);
    for (const sym of newSymbols) insSym.run(...(symbolToRow(sym) as never[]));

    if (fileEntry) db.prepare(INSERT_FILE_SQL).run(...(fileEntryToRow(fileEntry) as never[]));

    writeMetaValue(db, "updated_at", String(Date.now()));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Drop a deleted file's symbols and its files[] entry. */
export async function removeFileFromIndexSqlite(
  dbPath: string,
  deletedFile: string,
): Promise<void> {
  const db = await openIndexDb(dbPath);
  if (readMetaValue(db, "repo") === undefined) return; // nothing to remove

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM symbols WHERE file = ?").run(deletedFile);
    db.prepare("DELETE FROM files WHERE path = ?").run(deletedFile);
    writeMetaValue(db, "updated_at", String(Date.now()));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** All symbols for one file — lets per-file tools skip the whole-index load. */
export async function getSymbolsForFileSqlite(
  dbPath: string,
  filePath: string,
): Promise<CodeSymbol[]> {
  const db = await openIndexDb(dbPath);
  const repo = readMetaValue(db, "repo");
  if (repo === undefined) return [];
  const rows = db
    .prepare("SELECT * FROM symbols WHERE file = ?")
    .all(filePath) as unknown as SymbolRow[];
  return rows.map((row) => rowToSymbol(row, repo));
}

/**
 * Cross-process change counter. SQLite bumps `data_version` when *another* connection
 * commits, which is the invalidation signal a plain JSON file never had — and the reason an
 * in-memory index cache becomes safe here despite the hook writing from its own process.
 */
export async function getDataVersion(dbPath: string): Promise<number> {
  const db = await openIndexDb(dbPath);
  const row = db.prepare("PRAGMA data_version").get() as { data_version: number };
  return row.data_version;
}
