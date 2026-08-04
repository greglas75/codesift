import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { CodeIndex, CodeSymbol, FileEntry, Workspace } from "../types.js";
import { recordIndexFootprint } from "./index-footprint.js";

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
// Operational failures
// ---------------------------------------------------------------------------

/**
 * A storage fault, as distinct from "this repo has no index".
 *
 * Both used to arrive at callers as `null`, so a locked or corrupt database was indistinguishable
 * from an unindexed repo: tools reported "not indexed" (prompting a pointless full reindex over a
 * database that was merely busy) or returned empty results that read as an authoritative "no
 * matches". Empty-because-broken is the worst answer an index can give, because nothing about it
 * looks wrong.
 */
export class IndexStorageError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions);
    this.name = "IndexStorageError";
  }
}

/**
 * Codes that mean "the store is there but unusable right now", never "there is nothing here".
 *
 * Deliberately a tight allowlist. Classifying too broadly would convert ordinary absence into a
 * thrown error on a hot path used by ~every tool, which is a worse failure than the one being
 * fixed — so anything unrecognised keeps the previous null-ish behaviour.
 */
const OPERATIONAL_CODES = new Set([
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_CORRUPT",
  "SQLITE_NOTADB",
  "SQLITE_CANTOPEN",
  "SQLITE_IOERR",
  "SQLITE_READONLY",
  "SQLITE_PERM",
  "SQLITE_FULL",
  "EACCES",
  "EPERM",
  "EIO",
  "EBUSY",
  "ENOSPC",
  "EMFILE",
]);

/**
 * Structural check, not `instanceof`.
 *
 * A duplicated module instance (bundler, worker/thread boundary, a test importing through a
 * different specifier) makes `instanceof` false for an object that is in every observable way
 * the right error — and the failure mode is silent: the fault falls into the "unexpected error"
 * branch and gets reported as an unindexed repo, which is the exact bug this file exists to
 * prevent.
 */
export function isIndexStorageError(err: unknown): err is IndexStorageError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "IndexStorageError" &&
    typeof (err as { code?: unknown }).code === "string"
  );
}

/** The operational code for `err`, or null when it is not an operational failure. */
export function classifyStorageError(err: unknown): string | null {
  if (err instanceof IndexStorageError) return err.code;
  if (typeof err !== "object" || err === null) return null;

  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    if (OPERATIONAL_CODES.has(code)) return code;
    // node:sqlite surfaces extended result codes (SQLITE_IOERR_READ, SQLITE_BUSY_SNAPSHOT...).
    for (const known of OPERATIONAL_CODES) {
      if (known.startsWith("SQLITE_") && code.startsWith(`${known}_`)) return code;
    }
  }

  // Some node:sqlite builds only carry the reason in the message.
  const message = (err as { message?: unknown }).message;
  if (typeof message === "string") {
    if (/database disk image is malformed|file is not a database/i.test(message)) {
      return "SQLITE_CORRUPT";
    }
    if (/database is locked|database table is locked/i.test(message)) return "SQLITE_BUSY";
    if (/unable to open database/i.test(message)) return "SQLITE_CANTOPEN";
    if (/disk I\/O error/i.test(message)) return "SQLITE_IOERR";
  }
  return null;
}

/** Rethrow operational faults as IndexStorageError; leave everything else untouched. */
function rethrowOperational(err: unknown, path: string): never {
  const code = classifyStorageError(err);
  if (code === null) throw err;
  if (err instanceof IndexStorageError) throw err;
  const detail = err instanceof Error ? err.message : String(err);
  throw new IndexStorageError(
    `index storage at ${path} is unreadable (${code}): ${detail}`,
    code,
    path,
    { cause: err },
  );
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * v2 dropped the PRIMARY KEY on `symbols.id`.
 *
 * `id` is `repo:file:name:line`, which is NOT unique: a minified bundle puts hundreds of
 * distinct symbols on line 1 of one file, and PHPDoc `@method` synthesis emits a `field`
 * and a `method` at the same line. As a PRIMARY KEY with `ON CONFLICT DO UPDATE`, every
 * such collision silently overwrote the previous row — so the store quietly held fewer
 * symbols than it was given, and re-indexing reproduced the loss instead of repairing it.
 *
 * Measured over the 16 indexes that failed the migration's count check: 73,165 dropped
 * rows, every one carrying content different from the row that survived, and 7,514 of them
 * in real source rather than minified or vendored output.
 *
 * JSON never enforced uniqueness here, so this is parity, not a new tolerance. Lookups by
 * id return the first match exactly as the array scan did.
 */
export const SCHEMA_VERSION = 2;

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
  id          TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_symbols_id ON symbols(id);
`;

/**
 * v1 -> v2: rebuild `symbols` without the PRIMARY KEY, keeping every row already stored.
 *
 * Rebuilt in place rather than by re-importing: for most repos the JSON source is gone, so
 * the db IS the index — dropping it to force a reindex would trade a store that is merely
 * incomplete for no store at all. This recovers nothing on its own; rows lost under v1 come
 * back when the repo is next indexed from source, which now keeps them.
 */
const MIGRATE_V1_TO_V2_SQL = `
ALTER TABLE symbols RENAME TO symbols_v1;
CREATE TABLE symbols (
  id          TEXT NOT NULL,
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
INSERT INTO symbols SELECT * FROM symbols_v1;
DROP TABLE symbols_v1;
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_id ON symbols(id);
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

  let db: DatabaseSyncType | undefined;
  try {
    db = new Ctor(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA_SQL);
  } catch (err) {
    // Close before rethrowing: the constructor can succeed and a PRAGMA still fail, and this
    // handle never reaches the `connections` cache, so nothing else would ever close it. On a
    // retry loop against a sick database that leaks a descriptor and a lock per attempt —
    // which makes the very BUSY/EMFILE conditions being reported worse.
    try {
      db?.close();
    } catch {
      /* already dead — the original fault is the one worth reporting */
    }
    // A corrupt or unopenable file fails here, before any row is read — the one place where
    // "cannot open" would otherwise look exactly like "nothing indexed yet".
    rethrowOperational(err, dbPath);
  }

  const stored = readMetaValue(db, "schema_version");
  if (stored === undefined) {
    writeMetaValue(db, "schema_version", String(SCHEMA_VERSION));
  } else if (Number(stored) > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `Index at ${dbPath} was written by a newer CodeSift (schema v${stored} > v${SCHEMA_VERSION}). Upgrade codesift-mcp.`,
    );
  } else if (Number(stored) < SCHEMA_VERSION) {
    // One transaction: a half-applied table swap would leave `symbols_v1` as the only copy
    // of the rows, under a name nothing reads.
    try {
      db.exec("BEGIN IMMEDIATE");
      if (Number(stored) < 2) {
        db.exec(MIGRATE_V1_TO_V2_SQL);
        // The rebuild keeps every row the v1 table still HELD — it cannot bring back the ones
        // v1 already discarded on id collision (73,165 across 16 indexes when this was found).
        // Without this marker the upgraded database looks like any other complete v2 index, so
        // a caller would read a short symbol list as a fact about the code. Only a full reindex
        // from source can restore them, and `saveIndexSqlite` clears the flag when it does.
        writeMetaValue(db, "lossy_v1_migration", "1");
      }
      writeMetaValue(db, "schema_version", String(SCHEMA_VERSION));
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* nothing left to roll back */ }
      try { db.close(); } catch { /* already dead */ }
      rethrowOperational(err, dbPath);
    }
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
`;
// No upsert: both writers (`writeIndexRows`, `saveIncrementalSqlite`) DELETE the rows they
// are about to replace, so the only thing an ON CONFLICT clause ever resolved was a
// collision WITHIN one payload — two distinct symbols sharing a non-unique id — by throwing
// one of them away. See SCHEMA_VERSION.

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

/**
 * Replace the entire index. Used by full (re)indexing and by JSON->SQLite migration.
 *
 * `sourceComplete` means every symbol in `index` came from parsing the file it belongs to during
 * THIS run — the only condition under which the `lossy_v1_migration` marker can honestly be
 * cleared. It defaults to false, and the default is the point: rewriting every row is NOT the
 * same as re-reading every file. `index_folder` reuses cached symbols for files whose mtime has
 * not moved, and `enqueueIndexMutation` folds a single-file edit into a whole-index rewrite that
 * arrives here indistinguishable from a real reindex. An earlier version cleared the marker on
 * any call and so erased the warning on the next keystroke after an upgrade.
 *
 * Defaulting to "still lossy" errs toward over-warning, which a reindex clears, rather than
 * toward silence, which nothing does.
 */
export async function saveIndexSqlite(
  dbPath: string,
  index: CodeIndex,
  opts?: { sourceComplete?: boolean },
): Promise<void> {
  const db = await openIndexDb(dbPath);

  db.exec("BEGIN");
  try {
    writeIndexRows(db, index);
    if (opts?.sourceComplete === true) {
      db.prepare("DELETE FROM meta WHERE key = ?").run("lossy_v1_migration");
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * True when this database was upgraded from the v1 schema, whose PRIMARY KEY on a non-unique
 * `symbols.id` silently discarded colliding rows. The rebuild preserved everything still stored,
 * but cannot recover what was already gone — so a short symbol list here is a fact about the
 * migration, not about the code. Cleared by a full reindex.
 */
export async function wasLossilyMigrated(dbPath: string): Promise<boolean> {
  const db = await openIndexDb(dbPath);
  return readMetaValue(db, "lossy_v1_migration") !== undefined;
}

/**
 * Replace all rows + meta. Caller owns the transaction.
 *
 * `repo` is written here, inside that transaction, and `loadIndexSqlite` treats its absence
 * as "no index" — so a write killed midway rolls back and the db reads as empty rather than
 * as a partially-populated index that later looks complete.
 */
function writeIndexRows(db: DatabaseSyncType, index: CodeIndex): void {
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
}

/**
 * Import a legacy JSON index, but only if this db is still empty — decided and written
 * inside ONE `BEGIN IMMEDIATE` transaction.
 *
 * The check-then-act cannot be done in JS: `codesift postindex-file` is a fresh process per
 * edit, so two of them (or one plus the server) can both observe an empty db, both read the
 * same legacy JSON, and the slower writer then overwrites an incremental update the faster
 * one already committed. An in-process guard cannot see the other process at all.
 *
 * `BEGIN IMMEDIATE` takes the write lock before the emptiness check, so the second writer
 * either waits and then sees the committed import (returns false), or fails on busy_timeout —
 * never silently clobbers. Returns true when this call performed the import.
 */
export async function importLegacyIndexIfEmpty(
  dbPath: string,
  index: CodeIndex,
): Promise<boolean> {
  const db = await openIndexDb(dbPath);

  db.exec("BEGIN IMMEDIATE");
  try {
    if (readMetaValue(db, "repo") !== undefined) {
      db.exec("ROLLBACK");
      return false; // another process got there first
    }
    writeIndexRows(db, index);
    db.exec("COMMIT");
    return true;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Materialise the whole index. Returns null when the db has never been written to. */
/**
 * Rows -> objects, handing the event loop back every `YIELD_EVERY` items.
 *
 * Materializing an index is the single longest CPU burst in the process, and under the
 * shared daemon it is not the caller's own time being spent — every other client's request
 * is stalled behind it. Measured on this machine's largest index (240,133 symbols): a plain
 * `.map()` blocked the loop for 4.8 s with ZERO timer ticks in that window, so `/health`
 * stopped answering and one client's first cold request looked to everyone else like the
 * daemon had died.
 *
 * `setImmediate` rather than a microtask: a promise continuation would run before I/O and
 * timers, which is exactly the work being starved. The chunk size is what keeps the yield
 * itself cheap — per-item yielding turned the same load into minutes.
 */
/**
 * Read a whole table into objects a page at a time, yielding between pages.
 *
 * The block to remove is `.all()`, not the `.map()` after it: it materializes every row
 * into JS before any of our code runs, so chunking only the mapping still leaves one
 * unbroken stall.
 *
 * A/B'd in one process, alternating, 3 runs each, on the largest index here (240,133
 * symbols) — separate processes are useless for this, the page cache moved the same
 * measurement by 2x:
 *
 *     .all() + map    median 5609 ms   0 timer ticks — the loop never ran at all
 *     paged           median 4635 ms   12 ticks/run
 *
 * So this is not the usual responsiveness-for-throughput trade: paging is BOTH faster and
 * interruptible, because a page is one bulk `.all()` over a rowid range and SQLite never
 * has to hold the whole result set. `iterate()` also fixes the stall but gives up the bulk
 * fetch per row.
 *
 * The page is sized by TIME, not rows, because yielding is not sufficient on its own — an
 * HTTP server only answers between pages, so the page length is the latency floor. Measured
 * against a live server polled every 50 ms while pages of a given length ran:
 *
 *     page 400 ms   6 answered, 8 timed out, worst latency 2182 ms
 *     page 200 ms  19 answered, 0 timed out, worst latency  489 ms
 *     page  50 ms  78 answered, 0 timed out, worst latency  226 ms
 *
 * and the row count that lands on 50 ms is not a constant: profiling the daemon mid-freeze
 * put 8,016 of 10,113 samples in `StatementSync::All` with GC on the rest, because the same
 * page that costs milliseconds on a fresh heap costs seconds on a daemon already holding
 * several indexes. Hence the feedback loop rather than a tuned constant.
 *
 * Keyset pagination on rowid, never OFFSET: OFFSET re-scans the skipped rows on every page,
 * turning a linear read into a quadratic one exactly on the biggest indexes this exists for.
 */
const PAGE_TARGET_MS = 50;
const PAGE_MIN_ROWS = 500;
const PAGE_MAX_ROWS = 20_000;

/**
 * Open a second connection for reading only.
 *
 * The paged read below yields to the event loop between pages, and the cached connection is
 * shared by every request in this process — so a write landing mid-traversal would let one
 * `CodeIndex` be assembled out of two different database states. Holding a read transaction on
 * the SHARED connection cannot fix that: any write arriving during the yield would hit
 * "cannot start a transaction within a transaction".
 *
 * A private connection in WAL mode sees a stable snapshot from `BEGIN` to `COMMIT` regardless of
 * what other connections commit meanwhile. It costs one open per cold load, which happens once
 * per process per repo.
 */
async function openReadConnection(dbPath: string): Promise<DatabaseSyncType> {
  const Ctor = await loadSqliteCtor();
  if (!Ctor) throw new Error("node:sqlite is unavailable (requires Node >= 22.5)");
  const db = new Ctor(dbPath);
  // The constructor can succeed and the PRAGMA still fail — corruption and I/O faults often
  // surface on the first statement, not at open. This handle never reaches the `connections`
  // cache, and the caller's `finally` only closes what it managed to assign, so an unguarded
  // throw here leaks a descriptor on every attempt. Same guard as `openIndexDb`, same reason;
  // it was missing here only because this connection is deliberately not cached.
  try {
    db.exec("PRAGMA busy_timeout = 5000");
  } catch (err) {
    try { db.close(); } catch { /* already unusable — the leak is what we came to prevent */ }
    throw err;
  }
  return db;
}

async function readTablePaged<T, R>(
  db: DatabaseSyncType,
  table: string,
  fn: (row: T) => R,
): Promise<R[]> {
  const stmt = db.prepare(
    `SELECT rowid AS _rid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  );
  const out: R[] = [];
  let cursor = 0;
  let rows = 4_000;
  for (;;) {
    const started = Date.now();
    const page = stmt.all(cursor, rows) as unknown as Array<T & { _rid: number }>;
    if (page.length === 0) return out;
    for (const row of page) out.push(fn(row));
    const elapsed = Date.now() - started;
    cursor = page[page.length - 1]!._rid;
    if (page.length < rows) return out;
    // Aim the NEXT page at the time budget rather than a row count. Per-row cost is not a
    // property of the data: the same page costs milliseconds on a fresh heap and seconds
    // under a daemon already holding several indexes, because allocating a few thousand
    // objects there lands in incremental marking. A fixed row count is therefore tuned for
    // one heap and wrong for the other; a fixed time budget holds in both.
    rows = Math.max(PAGE_MIN_ROWS, Math.min(PAGE_MAX_ROWS,
      Math.round(rows * (PAGE_TARGET_MS / Math.max(elapsed, 1)))));
    await new Promise<void>((r) => setImmediate(r));
  }
}

/**
 * Fixed heap cost of one materialised symbol, on top of its text.
 *
 * Calibrated against the real tgm-survey-platform index (240,137 symbols): loading it moves
 * `heapUsed` by 349 MB, of which the summed string lengths account for ~221 MB, leaving ~560 B
 * per symbol for the object header, property slots and array pointers. Counting only the text
 * would therefore under-report the cache by more than a third.
 *
 * Rounded UP from the fitted 560, deliberately. The constant is fitted to one index and other
 * repos will differ, so the residual error should fall on the safe side: over-reporting evicts a
 * little sooner than strictly necessary, whereas under-reporting lets the cache quietly exceed
 * the budget it exists to enforce. Measured overshoot on the calibration index is ~11%.
 */
const SYMBOL_OBJECT_OVERHEAD_BYTES = 700;
const FILE_OBJECT_OVERHEAD_BYTES = 200;

/**
 * Byte cost of a string field that may hold prose.
 *
 * `String.length` counts UTF-16 code units, not bytes. V8 stores a string one byte per character
 * only while every character fits Latin1; one non-Latin1 character anywhere makes the whole string
 * two-byte. So `.length` under-reports CJK, Cyrillic and emoji-bearing text by about half — and
 * under-reporting is the one direction the calibration comment below rules out, because it lets
 * the cache exceed the budget it exists to enforce. `source` alone is 45% of the footprint
 * (ADR-004), so a repo commented in Chinese would quietly blow through the cap.
 *
 * `Buffer.byteLength` over-reports instead (3 UTF-8 bytes per CJK character against V8's 2), which
 * is the acceptable side.
 */
function textBytes(value: string | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  return Buffer.byteLength(value, "utf8");
}

function symbolRowBytes(row: SymbolRow): number {
  return (
    SYMBOL_OBJECT_OVERHEAD_BYTES +
    // Identifiers and paths: overwhelmingly ASCII, and there are 240k of them — `.length` is
    // exact for ASCII and skips a scan per row on the fields least likely to need one.
    row.id.length +
    row.file.length +
    row.name.length +
    row.kind.length +
    (row.parent?.length ?? 0) +
    // Prose and code text: the fields that actually carry non-Latin1 content.
    textBytes(row.signature) +
    textBytes(row.docstring) +
    textBytes(row.source) +
    textBytes(row.extras)
  );
}

export async function loadIndexSqlite(dbPath: string): Promise<CodeIndex | null> {
  // Called for its side effects, not its handle: this is what creates the schema and runs the
  // v1->v2 migration. The read below deliberately uses its own connection instead (see the
  // snapshot comment), so there is nothing here to bind.
  await openIndexDb(dbPath);

  let repo: string | undefined;
  let root: string | undefined;
  let symbols: CodeSymbol[] = [];
  let files: FileEntry[] = [];
  let meta: Record<string, string | undefined> = {};
  let reader: DatabaseSyncType | undefined;
  let footprint = 0;
  try {
    // EVERYTHING that goes into the returned index is read inside ONE transaction on a private
    // connection, so every field describes the same instant. The paged reader yields between
    // pages; without the snapshot a write arriving during a yield would be half-included, and
    // `symbols` could disagree with `files` in the very object callers treat as consistent.
    //
    // The meta reads belong inside it for the same reason and are easy to leave out — the first
    // version of this did exactly that, taking `repo`/`root` before the transaction opened and
    // `created_at`/`updated_at`/`extractor_version`/`workspaces` after it committed. That is a
    // narrower window, not a closed one: a concurrent `saveIndexSqlite` landing in either gap
    // yields metadata from one revision paired with rows from another, which is worse than an
    // obviously stale index because every field is individually valid.
    reader = await openReadConnection(dbPath);
    reader.exec("BEGIN");
    try {
      repo = readMetaValue(reader, "repo");
      root = readMetaValue(reader, "root");
      if (repo === undefined || root === undefined) {
        reader.exec("COMMIT");
        return null; // genuinely empty — not a fault
      }
      const owner = repo;
      for (const key of [
        "created_at",
        "updated_at",
        "extractor_version",
        "workspaces",
        "lossy_v1_migration",
      ]) {
        meta[key] = readMetaValue(reader, key);
      }
      symbols = await readTablePaged<SymbolRow, CodeSymbol>(reader, "symbols", (row) => {
        footprint += symbolRowBytes(row);
        return rowToSymbol(row, owner);
      });
      files = await readTablePaged<FileRow, FileEntry>(reader, "files", (row) => {
        footprint += FILE_OBJECT_OVERHEAD_BYTES + row.path.length;
        return rowToFileEntry(row);
      });
      reader.exec("COMMIT");
    } catch (err) {
      try { reader.exec("ROLLBACK"); } catch { /* snapshot already gone */ }
      throw err;
    }
  } catch (err) {
    // Corruption often only surfaces on the first page read, not at open time.
    rethrowOperational(err, dbPath);
  } finally {
    try { reader?.close(); } catch { /* best-effort; the snapshot is done with either way */ }
  }

  const index: CodeIndex = {
    repo,
    root,
    symbols,
    files,
    created_at: Number(meta["created_at"] ?? 0),
    updated_at: Number(meta["updated_at"] ?? 0),
    symbol_count: symbols.length,
    file_count: files.length,
  };

  const extractorRaw = meta["extractor_version"];
  if (extractorRaw !== undefined) {
    const parsed = JSON.parse(extractorRaw) as Record<string, string> | null;
    if (parsed !== null) index.extractor_version = parsed;
  }

  // Carried on the index itself, not left for callers to go and ask about. A flag that only a
  // dedicated accessor can reveal is one nothing in production ever reads — which is exactly what
  // happened to the first version of this marker: written on migration, exported, and consulted
  // by nobody, so a lossy index still answered like a complete one.
  if (meta["lossy_v1_migration"] !== undefined) index.lossy_migration = true;

  const workspacesRaw = meta["workspaces"];
  if (workspacesRaw !== undefined) {
    const parsed = JSON.parse(workspacesRaw) as Workspace[] | null;
    if (parsed !== null) index.workspaces = parsed;
  }

  recordIndexFootprint(index, footprint);
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
