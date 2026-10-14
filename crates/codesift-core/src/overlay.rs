//! A linked worktree's index as an overlay on a shared, read-only base (see
//! `src/storage/sqlite/overlay.ts` for the design and the measurements behind it).
//!
//! Every connection the store opens goes through `store::open`, which calls `attach`: the base is
//! ATTACHed as `ovbase` and TEMP views named `symbols` / `files` merge it with the overlay's own
//! rows, so the SELECTs, the call graph and the writer read and write through them unchanged.
//! `OVERLAY_ATTACH_SQL` is byte-identical to the TypeScript constant; a test there reads this file.

use rusqlite::Connection;

use crate::store::{Result, StoreError};

/// meta key holding the absolute path of the base database. Present exactly on an overlay.
pub const OVERLAY_BASE_KEY: &str = "overlay_base";
/// meta key holding the id prefix of the base rows.
pub const OVERLAY_BASE_PREFIX_KEY: &str = "overlay_base_prefix";

/// SQLITE_CANTOPEN: a missing base is a database that cannot be opened, not an empty index.
const SQLITE_CANTOPEN: i32 = 14;

pub const OVERLAY_ATTACH_SQL: &str = r#"
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
"#;

/// A file row without the upsert clause SQLite refuses on a view; the trigger replaces in place.
pub const INSERT_FILE_OVERLAY_SQL: &str =
    "INSERT INTO files (path, language, symbol_count, last_modified, mtime_ms, stale) VALUES (?,?,?,?,?,?)";

fn base_of(conn: &Connection) -> Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM main.meta WHERE key = ?")?;
    let mut rows = stmt.query([OVERLAY_BASE_KEY])?;
    match rows.next()? {
        Some(row) => Ok(Some(row.get::<_, String>(0)?)),
        None => Ok(None),
    }
}

/// Attach the base and install the views when this database is an overlay; returns whether it is.
/// A database without a `meta` table (not an index at all) is left alone, as before.
pub fn attach(conn: &Connection, db_path: &std::path::Path) -> Result<bool> {
    let has_meta: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = 'meta')",
        [],
        |r| r.get(0),
    )?;
    if !has_meta {
        return Ok(false);
    }
    let Some(base) = base_of(conn)? else {
        return Ok(false);
    };
    let missing = |why: String| StoreError {
        sqlite_code: Some(SQLITE_CANTOPEN),
        message: format!(
            "index at {} is an overlay on {}, which {}; run index_folder on the worktree",
            db_path.display(),
            base,
            why
        ),
    };
    // Read-only, so a base that vanished is never re-created empty (`readOnlyUri` in overlay.ts).
    if let Err(e) = conn.execute("ATTACH DATABASE ?1 AS ovbase", [read_only_uri(&base)]) {
        return Err(missing(format!("cannot be opened ({e})")));
    }
    if let Err(e) = check_base_and_install(conn) {
        let _ = conn.execute_batch(
            "DROP VIEW IF EXISTS temp.symbols; DROP VIEW IF EXISTS temp.files; DETACH DATABASE ovbase;",
        );
        return Err(match e {
            BaseFault::Shape(why) => missing(why.to_string()),
            BaseFault::Sql(e) => e,
        });
    }
    Ok(true)
}

enum BaseFault {
    Shape(&'static str),
    Sql(StoreError),
}

impl From<rusqlite::Error> for BaseFault {
    fn from(e: rusqlite::Error) -> Self {
        BaseFault::Sql(e.into())
    }
}

/// The base must be a plain index; a base that is itself an overlay would merge past its masks.
fn check_base_and_install(conn: &Connection) -> std::result::Result<(), BaseFault> {
    let mut stmt = conn.prepare("SELECT name FROM ovbase.sqlite_master WHERE type = 'table'")?;
    let tables: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<_>>()?;
    let has = |name: &str| tables.iter().any(|t| t == name);
    if !has("symbols") || !has("files") {
        return Err(BaseFault::Shape("is not an index"));
    }
    if has("meta") {
        let nested: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM ovbase.meta WHERE key = ?1)",
            [OVERLAY_BASE_KEY],
            |r| r.get(0),
        )?;
        if nested {
            return Err(BaseFault::Shape("is itself an overlay"));
        }
    }
    conn.execute_batch(OVERLAY_ATTACH_SQL)?;
    Ok(())
}

/// `file:` URI with `mode=ro`, percent-escaping what a URI would otherwise read as syntax.
fn read_only_uri(path: &str) -> String {
    let escaped = path
        .replace('%', "%25")
        .replace('?', "%3f")
        .replace('#', "%23");
    format!("file:{escaped}?mode=ro")
}

/// Whether this connection reads through the overlay views (attached, and not yet made plain).
pub fn is_overlay(conn: &Connection) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM temp.sqlite_master WHERE type = 'view' AND name = 'symbols')",
        [],
        |r| r.get(0),
    )?)
}

/// `COUNT(*)` of `symbols` or `files` as the views see it, computed from the branches.
pub fn count_rows(conn: &Connection, table: &str) -> Result<i64> {
    let hidden = match table {
        "symbols" => "file IN (SELECT path FROM main.overlay_masked)",
        "files" => "path IN (SELECT path FROM main.overlay_masked UNION SELECT path FROM main.overlay_masked_files)",
        other => {
            return Err(StoreError {
                sqlite_code: None,
                message: format!("count_rows: not an index table: {other}"),
            })
        }
    };
    let sql = if is_overlay(conn)? {
        format!(
            "SELECT (SELECT COUNT(*) FROM main.{table}) + (SELECT COUNT(*) FROM ovbase.{table}) - \
             (SELECT COUNT(*) FROM ovbase.{table} WHERE {hidden})"
        )
    } else {
        format!("SELECT COUNT(*) FROM {table}")
    };
    Ok(conn.query_row(&sql, [], |r| r.get(0))?)
}

/// Empty the index before a whole-index write (`clearIndexRows` in overlay.ts, statement for
/// statement): on an overlay, mask every base path, drop the overlay's rows, the base reference and
/// this connection's views.
pub fn clear_rows(conn: &Connection) -> Result<()> {
    if !is_overlay(conn)? {
        conn.execute_batch("DELETE FROM symbols; DELETE FROM files;")?;
        return Ok(());
    }
    conn.execute_batch(
        "INSERT OR IGNORE INTO main.overlay_masked(path) SELECT path FROM ovbase.files;
         INSERT OR IGNORE INTO main.overlay_masked(path) SELECT DISTINCT file FROM ovbase.symbols;
         DELETE FROM main.symbols;
         DELETE FROM main.files;",
    )?;
    conn.execute(
        "DELETE FROM main.meta WHERE key IN (?1, ?2)",
        [OVERLAY_BASE_KEY, OVERLAY_BASE_PREFIX_KEY],
    )?;
    // The rest of this write runs on the plain tables, not through a trigger per row.
    conn.execute_batch("DROP VIEW temp.symbols; DROP VIEW temp.files;")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{
        find_symbols_json, index_meta, FileRowIn, Snapshot, SymbolQuery, SymbolRowIn, Writer,
    };
    use std::path::{Path, PathBuf};

    const SCHEMA: &str = "
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE files (path TEXT PRIMARY KEY, language TEXT NOT NULL, symbol_count INTEGER NOT NULL,
          last_modified INTEGER NOT NULL, mtime_ms INTEGER, stale INTEGER);
        CREATE TABLE symbols (id TEXT NOT NULL, file TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
          start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, start_col INTEGER, end_col INTEGER,
          start_byte INTEGER, end_byte INTEGER, signature TEXT, docstring TEXT, source TEXT, parent TEXT,
          is_async INTEGER, is_exported INTEGER, extras TEXT);
        CREATE INDEX idx_symbols_file ON symbols(file);
        CREATE INDEX idx_symbols_id ON symbols(id);";

    /// A base with a.ts (f, g) and b.ts (h), and an overlay that rewrote a.ts to hold only `f2`.
    fn overlay() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("base.db");
        let b = Connection::open(&base).unwrap();
        b.execute_batch(SCHEMA).unwrap();
        b.execute_batch(
            "INSERT INTO meta VALUES ('repo','fam'),('root','/main');
             INSERT INTO files VALUES ('a.ts','typescript',2,1,1,NULL),('b.ts','typescript',1,1,1,NULL);
             INSERT INTO symbols (id,file,name,kind,start_line,end_line) VALUES
               ('fam:a.ts:f:1','a.ts','f','function',1,1),
               ('fam:a.ts:g:2','a.ts','g','function',2,2),
               ('fam:b.ts:h:1','b.ts','h','function',1,1);",
        )
        .unwrap();
        drop(b);
        let ov = dir.path().join("wt.index.db");
        let o = Connection::open(&ov).unwrap();
        o.execute_batch("PRAGMA journal_mode = WAL").unwrap();
        o.execute_batch(SCHEMA).unwrap();
        o.execute_batch(
            "CREATE TABLE overlay_masked (path TEXT PRIMARY KEY);
             CREATE TABLE overlay_masked_files (path TEXT PRIMARY KEY);",
        )
        .unwrap();
        o.execute(
            "INSERT INTO meta VALUES ('repo','wt'),('root','/wt'),(?1,?2),(?3,'fam:')",
            [
                OVERLAY_BASE_KEY,
                base.to_str().unwrap(),
                OVERLAY_BASE_PREFIX_KEY,
            ],
        )
        .unwrap();
        drop(o);
        // The rewrite of a.ts goes through the views, as a real incremental save does.
        let c = crate::store::open(&ov).unwrap();
        c.execute_batch(
            "DELETE FROM symbols WHERE file = 'a.ts';
             INSERT INTO symbols (id,file,name,kind,start_line,end_line) VALUES ('wt:a.ts:f2:1','a.ts','f2','function',1,1);",
        )
        .unwrap();
        c.execute(
            INSERT_FILE_OVERLAY_SQL,
            rusqlite::params!["a.ts", "typescript", 1, 2, 2, Option::<i64>::None],
        )
        .unwrap();
        drop(c);
        (dir, base, ov)
    }

    fn names(p: &Path) -> Vec<String> {
        let json = find_symbols_json(p, &SymbolQuery::default())
            .unwrap()
            .concat();
        let v: Vec<serde_json::Value> = serde_json::from_str(&json.replace("][", ",")).unwrap();
        v.iter()
            .map(|s| s["name"].as_str().unwrap().to_string())
            .collect()
    }

    // Bug it catches: the views not attached (or a mask ignored) — the overlay alone answers, or the
    // rewritten file's old symbols come back next to its new ones.
    #[test]
    fn reads_merge_the_base_with_the_overlay_and_hide_rewritten_paths() {
        let (_d, _base, ov) = overlay();
        assert_eq!(names(&ov), vec!["h", "f2"]);
        let meta = index_meta(&ov).unwrap().unwrap();
        assert_eq!((meta.symbol_count, meta.file_count), (2, 2));
    }

    // Bug it catches: a file row written alone (a worktree's own mtime) copying the file's symbols
    // into the overlay, or hiding them — the overlay grows by a whole file, or the file goes empty.
    #[test]
    fn a_file_row_written_alone_keeps_the_base_symbols() {
        let (_d, _base, ov) = overlay();
        let c = crate::store::open(&ov).unwrap();
        c.execute(
            INSERT_FILE_OVERLAY_SQL,
            rusqlite::params!["b.ts", "typescript", 1, 1, 99, Option::<i64>::None],
        )
        .unwrap();
        drop(c);
        assert_eq!(names(&ov), vec!["h", "f2"]);
        let c = crate::store::open(&ov).unwrap();
        let own: i64 = c
            .query_row("SELECT COUNT(*) FROM main.symbols", [], |r| r.get(0))
            .unwrap();
        let mtime: i64 = c
            .query_row("SELECT mtime_ms FROM files WHERE path = 'b.ts'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!((own, mtime, count_rows(&c, "files").unwrap()), (1, 99, 2));
    }

    // Bug it catches: a keyset page that restarts or skips at the base/overlay boundary.
    #[test]
    fn snapshot_pages_walk_base_rows_then_overlay_rows() {
        let (_d, _base, ov) = overlay();
        let snap = Snapshot::open(&ov).unwrap();
        let first = snap.page(&SymbolQuery::default(), None, 0, 1).unwrap();
        assert_eq!(first.count, 1);
        let second = snap
            .page(&SymbolQuery::default(), None, first.last_rowid.unwrap(), 10)
            .unwrap();
        assert!(
            first.json.contains("\"h\"") && second.json.contains("\"f2\""),
            "{} {}",
            first.json,
            second.json
        );
        assert_eq!(second.count, 1);
    }

    // Bug it catches: a whole-index write that leaves base rows visible beside the new ones, or keeps
    // pinning a base nothing needs any more.
    #[test]
    fn a_whole_index_write_replaces_everything_and_drops_the_base_reference() {
        let (_d, _base, ov) = overlay();
        let w = Writer::begin(&ov).unwrap();
        w.insert_symbols(&[SymbolRowIn {
            id: "wt:z.ts:z:1".into(),
            file: "z.ts".into(),
            name: "z".into(),
            kind: "function".into(),
            start_line: 1.0,
            end_line: 1.0,
            ..SymbolRowIn::default()
        }])
        .unwrap();
        w.insert_files(&[FileRowIn {
            path: "z.ts".into(),
            language: "typescript".into(),
            symbol_count: 1.0,
            last_modified: 1.0,
            mtime_ms: None,
            stale: None,
        }])
        .unwrap();
        w.commit(&[("repo".into(), "wt".into())], true).unwrap();
        assert_eq!(names(&ov), vec!["z"]);
        let c = crate::store::open(&ov).unwrap();
        assert!(!is_overlay(&c).unwrap());
        assert_eq!(count_rows(&c, "files").unwrap(), 1);
        // Written to the plain tables, not through the triggers (which number rows from 2^40).
        let max_rowid: i64 = c
            .query_row("SELECT max(rowid) FROM symbols", [], |r| r.get(0))
            .unwrap();
        assert!(max_rowid < 1_099_511_627_776, "{max_rowid}");
    }

    // Bug it catches: a deleted base answered as an empty (or overlay-only) index, or re-created.
    #[test]
    fn a_missing_base_is_cantopen_not_a_smaller_index() {
        let (_d, base, ov) = overlay();
        std::fs::remove_file(&base).unwrap();
        let err = crate::store::open(&ov).unwrap_err();
        assert_eq!(err.sqlite_code, Some(SQLITE_CANTOPEN));
        assert!(err.message.contains("cannot be opened"), "{}", err.message);
        // A plain ATTACH would have created it empty, and every later open would take that for the base.
        assert!(!base.exists());
    }
}
