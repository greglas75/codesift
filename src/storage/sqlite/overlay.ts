import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { IndexStorageError } from "./errors.js";
import { INSERT_FILE_SQL } from "./rows.js";

/**
 * A linked worktree's index as an OVERLAY on a shared, read-only base instead of a full copy (see
 * CLAUDE.md, "A linked worktree's index is an overlay"). The overlay database holds only the rows of
 * the files the worktree touched; everything else is read from a base snapshot that every overlay of
 * that donor commit shares.
 *
 * How a connection sees one index: on open, the base is ATTACHed as `ovbase` and TEMP views named
 * `symbols` and `files` put the base rows (minus the masked paths) and the overlay's own rows into
 * one table each. SQLite resolves an unqualified name in `temp` first, so every query and every
 * writer in this codebase reads and writes through the views without knowing about them. The
 * writes go through INSTEAD OF triggers into `main`.
 *
 * Copy-on-touch: the first write to a path copies that path's base rows into `main` with the SAME
 * rowid and masks the path; after that every statement acts on `main` alone, so a DELETE, an INSERT
 * and the order of rows behave exactly as on a plain table (tests/storage/sqlite-overlay.test.ts). A
 * write of the file row alone copies and masks only the file row (`overlay_masked_files`), so
 * recording a worktree's own mtimes does not copy its symbols. New rows get rowids above both the
 * base's largest and OVERLAY_ROWID_BASE, so the ranges never collide and `ORDER BY rowid` still puts
 * new rows last.
 *
 * Constraints the views are shaped by (measurements in CLAUDE.md):
 *  - Every column is passed through raw. A computed column (the obvious way to rewrite `id`)
 *    stops SQLite from merging the two branches in rowid order, which made keyset paging and full
 *    streams many times slower. So ids are NOT rewritten: base rows keep the base's prefix and the
 *    worktree's own rows carry the worktree's name.
 *  - An aggregate over the view (`COUNT(*)`, `MIN(id)`) scans both branches. `countIndexRows`
 *    computes it from the branches instead.
 *  - SQLite refuses UPSERT on a view, so a file row goes in through `insertFileSqlFor`, and the
 *    trigger keeps the upsert's semantics (the existing rowid, the new values).
 *
 * The Rust store attaches the same SQL (`crates/codesift-core/src/overlay.rs`), and a test fails if
 * the two copies differ.
 */

/** Lowest rowid an overlay assigns to a row of its own. */
export const OVERLAY_ROWID_BASE = 1_099_511_627_776;

/** meta key holding the absolute path of the base database. Present exactly on an overlay. */
export const OVERLAY_BASE_KEY = "overlay_base";
/** meta key holding the id prefix of the base rows (`<repo>:`), which the overlay's own rows do not share. */
export const OVERLAY_BASE_PREFIX_KEY = "overlay_base_prefix";

/** `overlay_masked`: symbols and file row live in `main`. `overlay_masked_files`: the file row alone. */
export const OVERLAY_MASK_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS overlay_masked (path TEXT PRIMARY KEY);\n" +
  "CREATE TABLE IF NOT EXISTS overlay_masked_files (path TEXT PRIMARY KEY);";

// Kept byte-identical to OVERLAY_ATTACH_SQL in overlay.rs (tests/storage/sqlite-overlay.test.ts).
export const OVERLAY_ATTACH_SQL = `
CREATE TEMP VIEW symbols AS
  SELECT rowid AS rowid, id, file, name, kind, start_line, end_line, start_col, end_col, start_byte, end_byte, signature, docstring, source, parent, is_async, is_exported, extras
    FROM ovbase.symbols WHERE file NOT IN (SELECT path FROM main.overlay_masked)
  UNION ALL
  SELECT rowid AS rowid, id, file, name, kind, start_line, end_line, start_col, end_col, start_byte, end_byte, signature, docstring, source, parent, is_async, is_exported, extras
    FROM main.symbols;
CREATE TEMP VIEW files AS
  SELECT rowid AS rowid, path, language, symbol_count, last_modified, mtime_ms, stale
    FROM ovbase.files WHERE path NOT IN (SELECT path FROM main.overlay_masked) AND path NOT IN (SELECT path FROM main.overlay_masked_files)
  UNION ALL
  SELECT rowid AS rowid, path, language, symbol_count, last_modified, mtime_ms, stale
    FROM main.files;
CREATE TEMP TRIGGER overlay_symbols_insert INSTEAD OF INSERT ON symbols BEGIN
  INSERT INTO main.symbols(rowid, id, file, name, kind, start_line, end_line, start_col, end_col, start_byte, end_byte, signature, docstring, source, parent, is_async, is_exported, extras)
    SELECT rowid, id, file, name, kind, start_line, end_line, start_col, end_col, start_byte, end_byte, signature, docstring, source, parent, is_async, is_exported, extras
    FROM ovbase.symbols WHERE file = NEW.file AND NOT EXISTS (SELECT 1 FROM main.overlay_masked WHERE path = NEW.file);
  INSERT INTO main.files(rowid, path, language, symbol_count, last_modified, mtime_ms, stale)
    SELECT rowid, path, language, symbol_count, last_modified, mtime_ms, stale
    FROM ovbase.files WHERE path = NEW.file AND NOT EXISTS (SELECT 1 FROM main.overlay_masked WHERE path = NEW.file) AND NOT EXISTS (SELECT 1 FROM main.overlay_masked_files WHERE path = NEW.file);
  INSERT OR IGNORE INTO main.overlay_masked(path) VALUES (NEW.file);
  INSERT INTO main.symbols(rowid, id, file, name, kind, start_line, end_line, start_col, end_col, start_byte, end_byte, signature, docstring, source, parent, is_async, is_exported, extras)
    VALUES (max((SELECT ifnull(max(rowid), 0) FROM main.symbols), (SELECT ifnull(max(rowid), 0) FROM ovbase.symbols), 1099511627776) + 1, NEW.id, NEW.file, NEW.name, NEW.kind, NEW.start_line, NEW.end_line, NEW.start_col, NEW.end_col, NEW.start_byte, NEW.end_byte, NEW.signature, NEW.docstring, NEW.source, NEW.parent, NEW.is_async, NEW.is_exported, NEW.extras);
END;
CREATE TEMP TRIGGER overlay_symbols_delete INSTEAD OF DELETE ON symbols BEGIN
  INSERT INTO main.symbols(rowid, id, file, name, kind, start_line, end_line, start_col, end_col, start_byte, end_byte, signature, docstring, source, parent, is_async, is_exported, extras)
    SELECT rowid, id, file, name, kind, start_line, end_line, start_col, end_col, start_byte, end_byte, signature, docstring, source, parent, is_async, is_exported, extras
    FROM ovbase.symbols WHERE file = OLD.file AND NOT EXISTS (SELECT 1 FROM main.overlay_masked WHERE path = OLD.file);
  INSERT INTO main.files(rowid, path, language, symbol_count, last_modified, mtime_ms, stale)
    SELECT rowid, path, language, symbol_count, last_modified, mtime_ms, stale
    FROM ovbase.files WHERE path = OLD.file AND NOT EXISTS (SELECT 1 FROM main.overlay_masked WHERE path = OLD.file) AND NOT EXISTS (SELECT 1 FROM main.overlay_masked_files WHERE path = OLD.file);
  INSERT OR IGNORE INTO main.overlay_masked(path) VALUES (OLD.file);
  DELETE FROM main.symbols WHERE rowid = OLD.rowid;
END;
CREATE TEMP TRIGGER overlay_files_insert INSTEAD OF INSERT ON files BEGIN
  INSERT INTO main.files(rowid, path, language, symbol_count, last_modified, mtime_ms, stale)
    SELECT rowid, path, language, symbol_count, last_modified, mtime_ms, stale
    FROM ovbase.files WHERE path = NEW.path AND NOT EXISTS (SELECT 1 FROM main.overlay_masked WHERE path = NEW.path) AND NOT EXISTS (SELECT 1 FROM main.overlay_masked_files WHERE path = NEW.path);
  INSERT OR IGNORE INTO main.overlay_masked_files(path) VALUES (NEW.path);
  INSERT OR REPLACE INTO main.files(rowid, path, language, symbol_count, last_modified, mtime_ms, stale)
    VALUES (coalesce((SELECT rowid FROM main.files WHERE path = NEW.path), max((SELECT ifnull(max(rowid), 0) FROM main.files), (SELECT ifnull(max(rowid), 0) FROM ovbase.files), 1099511627776) + 1), NEW.path, NEW.language, NEW.symbol_count, NEW.last_modified, NEW.mtime_ms, NEW.stale);
END;
CREATE TEMP TRIGGER overlay_files_delete INSTEAD OF DELETE ON files BEGIN
  INSERT INTO main.files(rowid, path, language, symbol_count, last_modified, mtime_ms, stale)
    SELECT rowid, path, language, symbol_count, last_modified, mtime_ms, stale
    FROM ovbase.files WHERE path = OLD.path AND NOT EXISTS (SELECT 1 FROM main.overlay_masked WHERE path = OLD.path) AND NOT EXISTS (SELECT 1 FROM main.overlay_masked_files WHERE path = OLD.path);
  INSERT OR IGNORE INTO main.overlay_masked_files(path) VALUES (OLD.path);
  DELETE FROM main.files WHERE rowid = OLD.rowid;
END;
`;

/** A file row without the upsert clause SQLite refuses on a view; the trigger replaces in place. */
const INSERT_FILE_OVERLAY_SQL =
  "INSERT INTO files (path, language, symbol_count, last_modified, mtime_ms, stale) VALUES (?,?,?,?,?,?)";

function metaValue(db: DatabaseSyncType, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM main.meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

/** `mode=ro`: a missing file is an error, not a new empty database, and the base stays unwritable. */
export function readOnlyUri(path: string): string {
  return `file:${path.replace(/%/g, "%25").replace(/\?/g, "%3f").replace(/#/g, "%23")}?mode=ro`;
}

function baseMissing(dbPath: string, base: string, why: string): IndexStorageError {
  return new IndexStorageError(
    `Index at ${dbPath} is an overlay on ${base}, which ${why}. Run index_folder on the worktree to rebuild it.`,
    "OVERLAY_BASE_MISSING",
    dbPath,
  );
}

/**
 * Attach the base and install the views, if this database is an overlay. Returns whether it is.
 * Runs outside any transaction (ATTACH refuses one). A base that cannot be opened or is not a plain
 * index is an error: the overlay alone would answer every query confidently and wrongly.
 */
export function attachOverlay(db: DatabaseSyncType, dbPath: string): boolean {
  const base = metaValue(db, OVERLAY_BASE_KEY);
  if (base === undefined) return false;
  try {
    db.prepare("ATTACH DATABASE ? AS ovbase").run(readOnlyUri(base));
  } catch (err) {
    throw baseMissing(dbPath, base, `cannot be opened (${err instanceof Error ? err.message : String(err)})`);
  }
  try {
    const tables = new Set((db.prepare("SELECT name FROM ovbase.sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((r) => r.name));
    if (!tables.has("symbols") || !tables.has("files")) throw baseMissing(dbPath, base, "is not an index");
      if (tables.has("meta") && db.prepare("SELECT 1 AS x FROM ovbase.meta WHERE key = ?").get(OVERLAY_BASE_KEY)) {
      throw baseMissing(dbPath, base, "is itself an overlay");
    }
    db.exec(OVERLAY_ATTACH_SQL);
  } catch (err) {
    try { db.exec("DROP VIEW IF EXISTS temp.symbols; DROP VIEW IF EXISTS temp.files; DETACH DATABASE ovbase"); } catch { /* the original fault is the one worth reporting */ }
    throw err;
  }
  return true;
}

/** Whether this connection reads through the overlay views (attached, and not yet made plain). */
export function isOverlayConnection(db: DatabaseSyncType): boolean {
  return db.prepare("SELECT 1 AS x FROM temp.sqlite_master WHERE type = 'view' AND name = 'symbols'").get() !== undefined;
}

/** The statement a writer uses for one file row on this connection. */
export function insertFileSqlFor(db: DatabaseSyncType): string {
  return isOverlayConnection(db) ? INSERT_FILE_OVERLAY_SQL : INSERT_FILE_SQL;
}

/**
 * `COUNT(*)` of `symbols` or `files` as the views see it, from the branches: the overlay's rows
 * plus the base's, minus the base rows the masks hide. Each part uses an index.
 */
export function countIndexRows(db: DatabaseSyncType, table: "symbols" | "files"): number {
  if (!isOverlayConnection(db)) {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  const hidden = table === "symbols"
    ? "file IN (SELECT path FROM main.overlay_masked)"
    : "path IN (SELECT path FROM main.overlay_masked UNION SELECT path FROM main.overlay_masked_files)";
  const row = db.prepare(
    `SELECT (SELECT COUNT(*) FROM main.${table}) + (SELECT COUNT(*) FROM ovbase.${table}) - ` +
      `(SELECT COUNT(*) FROM ovbase.${table} WHERE ${hidden}) AS n`,
  ).get() as { n: number };
  return row.n;
}

/**
 * Empty the index before a whole-index write.
 *
 * On an overlay every base path is masked (other connections then see only the rows written next)
 * and the base reference goes, so the database opens plain from now on. This connection drops its
 * views, so the write runs on the plain tables; a rollback restores them.
 */
export function clearIndexRows(db: DatabaseSyncType): void {
  if (!isOverlayConnection(db)) {
    db.exec("DELETE FROM symbols");
    db.exec("DELETE FROM files");
    return;
  }
  db.exec("INSERT OR IGNORE INTO main.overlay_masked(path) SELECT path FROM ovbase.files");
  db.exec("INSERT OR IGNORE INTO main.overlay_masked(path) SELECT DISTINCT file FROM ovbase.symbols");
  db.exec("DELETE FROM main.symbols");
  db.exec("DELETE FROM main.files");
  db.prepare("DELETE FROM main.meta WHERE key IN (?, ?)").run(OVERLAY_BASE_KEY, OVERLAY_BASE_PREFIX_KEY);
  db.exec("DROP VIEW temp.symbols; DROP VIEW temp.files");
}

/**
 * Id prefixes the rows of this index may carry: the repo's own, and on an overlay also the base's.
 * A lookup by an id without its prefix tries each.
 */
export function indexIdPrefixes(db: DatabaseSyncType, repo: string): string[] {
  const own = `${repo}:`;
  if (!isOverlayConnection(db)) return [own];
  const base = metaValue(db, OVERLAY_BASE_PREFIX_KEY);
  return base === undefined || base === own ? [own] : [own, base];
}
