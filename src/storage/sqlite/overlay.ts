import { existsSync } from "node:fs";
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
 * recording a worktree's own mtimes does not copy its symbols. New rows get rowids from OVERLAY_ROWID_BASE up, above any base
 * rowid, so the two ranges never collide and `ORDER BY rowid` still puts new rows last.
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

/** First rowid an overlay assigns to a row of its own. Above every base rowid, below 2^53. */
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
    VALUES ((SELECT max(ifnull(max(rowid), 0), 1099511627776) FROM main.symbols) + 1, NEW.id, NEW.file, NEW.name, NEW.kind, NEW.start_line, NEW.end_line, NEW.start_col, NEW.end_col, NEW.start_byte, NEW.end_byte, NEW.signature, NEW.docstring, NEW.source, NEW.parent, NEW.is_async, NEW.is_exported, NEW.extras);
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
    VALUES (coalesce((SELECT rowid FROM main.files WHERE path = NEW.path), (SELECT max(ifnull(max(rowid), 0), 1099511627776) FROM main.files) + 1), NEW.path, NEW.language, NEW.symbol_count, NEW.last_modified, NEW.mtime_ms, NEW.stale);
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

const overlayConnections = new WeakSet<DatabaseSyncType>();

function metaValue(db: DatabaseSyncType, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM main.meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

/**
 * Attach the base and install the views, if this database is an overlay. Returns whether it is.
 *
 * Must run after the schema exists and outside any transaction (ATTACH refuses to run inside one).
 * A missing base is an error, not an empty index: the overlay alone holds a few files, and serving
 * it as the whole repository would answer every query confidently and wrongly.
 */
export function attachOverlay(db: DatabaseSyncType, dbPath: string): boolean {
  const base = metaValue(db, OVERLAY_BASE_KEY);
  if (base === undefined) return false;
  if (!existsSync(base)) {
    throw new IndexStorageError(
      `Index at ${dbPath} is an overlay on ${base}, which no longer exists. Run index_folder on the worktree to rebuild it.`,
      "OVERLAY_BASE_MISSING",
      dbPath,
    );
  }
  db.prepare("ATTACH DATABASE ? AS ovbase").run(base);
  try {
    db.exec(OVERLAY_ATTACH_SQL);
  } catch (err) {
    try { db.exec("DETACH DATABASE ovbase"); } catch { /* the original fault is the one worth reporting */ }
    throw err;
  }
  overlayConnections.add(db);
  return true;
}

export function isOverlayConnection(db: DatabaseSyncType): boolean {
  return overlayConnections.has(db);
}

/** The statement a writer uses for one file row on this connection. */
export function insertFileSqlFor(db: DatabaseSyncType): string {
  return overlayConnections.has(db) ? INSERT_FILE_OVERLAY_SQL : INSERT_FILE_SQL;
}

/**
 * `COUNT(*)` of `symbols` or `files` as the views see it, from the branches: the overlay's rows
 * plus the base's, minus the base rows the masks hide. Each part uses an index.
 */
export function countIndexRows(db: DatabaseSyncType, table: "symbols" | "files"): number {
  if (!overlayConnections.has(db)) {
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
 * On an overlay every base path is masked and the overlay's own rows go: the rows written next are
 * then the whole index, and a connection that attached the views earlier still sees exactly them.
 * The base reference is dropped too, so the database is a plain index from the next open on and
 * the base can be collected once nothing else points at it.
 */
export function clearIndexRows(db: DatabaseSyncType): void {
  if (!overlayConnections.has(db)) {
    db.exec("DELETE FROM symbols");
    db.exec("DELETE FROM files");
    return;
  }
  db.exec("INSERT OR IGNORE INTO main.overlay_masked(path) SELECT path FROM ovbase.files");
  db.exec("INSERT OR IGNORE INTO main.overlay_masked(path) SELECT DISTINCT file FROM ovbase.symbols");
  db.exec("DELETE FROM main.symbols");
  db.exec("DELETE FROM main.files");
  db.prepare("DELETE FROM main.meta WHERE key IN (?, ?)").run(OVERLAY_BASE_KEY, OVERLAY_BASE_PREFIX_KEY);
}

/**
 * Id prefixes the rows of this index may carry: the repo's own, and on an overlay also the base's.
 * A lookup by an id without its prefix tries each.
 */
export function indexIdPrefixes(db: DatabaseSyncType, repo: string): string[] {
  const own = `${repo}:`;
  if (!overlayConnections.has(db)) return [own];
  const base = metaValue(db, OVERLAY_BASE_PREFIX_KEY);
  return base === undefined || base === own ? [own] : [own, base];
}
