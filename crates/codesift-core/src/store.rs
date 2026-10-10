//! Read path of the SQLite index (ADR-006 stage 1).
//!
//! Mirrors `src/storage/sqlite/queries.ts` — same SQL, same predicates, same row-to-symbol mapping
//! as `rowToSymbol` in `rows.ts` — but produces the result as JSON arrays of symbols, built off the
//! Node main thread. The JS side parses them, which is the only part of a query that still runs on
//! the event loop.
//!
//! Why JSON and not napi objects: building 100k objects through N-API runs on the main thread and
//! costs more than V8 parsing the same data from text. JSON also expresses the contract the TS path
//! is careful about for free — an absent column becomes an absent KEY, never `undefined`.
//!
//! The emitted key order is `rowToSymbol`'s assignment order, so a tool that serialises a symbol
//! produces byte-identical output whichever implementation read it.
//!
//! Schema creation, the v1 -> v2 migration and the "written by a newer CodeSift" refusal stay in
//! the TypeScript `openIndexDb`, which the JS facade runs once per database before the first native
//! read. This module only ever issues SELECTs.

use std::collections::HashMap;
use std::fmt;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, OpenFlags, Statement};
use serde_json::value::RawValue;
use serde_json::Value;

/// Must match `MAX_BOUND_PARAMS` in queries.ts: chunk boundaries decide where `limit` cuts.
const MAX_BOUND_PARAMS: usize = 900;

/// Every column except `source`, in table order — `COLUMNS_WITHOUT_SOURCE` in queries.ts.
const COLUMNS_WITHOUT_SOURCE: &str =
    "id, file, name, kind, start_line, end_line, start_col, end_col, start_byte, end_byte, \
     signature, docstring, parent, is_async, is_exported, extras";

/// `SymbolQuery` in queries.ts. `with_source` has no default there on purpose, and none here.
#[derive(Debug, Clone, Default)]
pub struct SymbolQuery {
    pub with_source: bool,
    pub file: Option<String>,
    pub name: Option<String>,
    pub name_prefix: Option<String>,
    pub kind: Option<String>,
    pub parent: Option<String>,
    pub ids: Option<Vec<String>>,
    pub limit: Option<i64>,
    /// Scan predicates (queries.ts `kinds` / `sourceContainsAny` / `minLines`): exact, pushed into SQL
    /// so a whole-repo scan serialises only what matches.
    pub kinds: Option<Vec<String>>,
    /// `name IN (...)`: any of these exact names. Empty matches nothing.
    pub names: Option<Vec<String>>,
    pub source_contains_any: Option<Vec<String>>,
    pub min_lines: Option<i64>,
    pub file_suffix_any: Option<Vec<String>>,
    /// `Some(true)`: only symbols with `extends` or `implements` in `extras`.
    pub has_heritage: Option<bool>,
}

/// The fields `getIndexMetaSqlite` reads. `updated_at` stays a string: the JS side applies
/// `Number(...)` itself, so a malformed value degrades exactly as it does there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexMeta {
    pub repo: String,
    pub root: String,
    pub updated_at: Option<String>,
    pub symbol_count: i64,
    pub file_count: i64,
}

/// A failure, carrying SQLite's EXTENDED result code when there is one.
///
/// The JS side hands the code to the existing `classifyStorageError` (which masks `& 0xff`), so a
/// locked or corrupt database is classified by the same table whichever implementation hit it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreError {
    pub sqlite_code: Option<i32>,
    pub message: String,
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.sqlite_code {
            Some(code) => write!(f, "[sqlite:{code}] {}", self.message),
            None => write!(f, "{}", self.message),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(err: rusqlite::Error) -> Self {
        let sqlite_code = match &err {
            rusqlite::Error::SqliteFailure(e, _) => Some(e.extended_code),
            _ => None,
        };
        StoreError {
            sqlite_code,
            message: err.to_string(),
        }
    }
}

impl From<std::io::Error> for StoreError {
    fn from(err: std::io::Error) -> Self {
        StoreError {
            sqlite_code: None,
            message: err.to_string(),
        }
    }
}

pub(crate) type Result<T> = std::result::Result<T, StoreError>;

/// Open for reading. READ_WRITE without CREATE, not READ_ONLY: a read-only handle cannot create
/// the `-shm` file of a WAL database whose last writer closed cleanly, and fails with CANTOPEN on
/// a perfectly healthy index. Nothing here writes.
pub(crate) fn open(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    // Same wait as the TypeScript connections: a writer mid-commit is a reason to wait, not to fail.
    conn.busy_timeout(Duration::from_millis(5000))?;
    Ok(conn)
}

fn read_meta(conn: &Connection, key: &str) -> Result<Option<String>> {
    let mut stmt = conn.prepare_cached("SELECT value FROM meta WHERE key = ?")?;
    let mut rows = stmt.query([key])?;
    match rows.next()? {
        Some(row) => Ok(Some(row.get::<_, String>(0)?)),
        None => Ok(None),
    }
}

/// `buildPredicate` in queries.ts, clause for clause and in the same order.
fn build_predicate(q: &SymbolQuery, id_chunk: Option<&[String]>) -> (String, Vec<SqlValue>) {
    let mut clauses: Vec<String> = Vec::new();
    let mut binds: Vec<SqlValue> = Vec::new();
    if let Some(v) = &q.file {
        clauses.push("file = ?".into());
        binds.push(SqlValue::Text(v.clone()));
    }
    if let Some(v) = &q.name {
        clauses.push("name = ?".into());
        binds.push(SqlValue::Text(v.clone()));
    }
    if let Some(v) = &q.name_prefix {
        // GLOB, as queries.ts: case-sensitive like `startsWith` (LIKE is case-insensitive for
        // ASCII), and `*`, `?`, `[` escaped by wrapping each in a one-character bracket class.
        clauses.push("name GLOB ?".into());
        binds.push(SqlValue::Text(format!("{}*", escape_glob(v))));
    }
    if let Some(v) = &q.kind {
        clauses.push("kind = ?".into());
        binds.push(SqlValue::Text(v.clone()));
    }
    if let Some(v) = &q.parent {
        clauses.push("parent = ?".into());
        binds.push(SqlValue::Text(v.clone()));
    }
    // The same three clauses queries.ts builds — an empty list matches nothing (`IN ()` would be a
    // syntax error), instr is a case-sensitive substring test and NULL for a NULL source.
    if let Some(kinds) = &q.kinds {
        if kinds.is_empty() {
            clauses.push("0".into());
        } else {
            clauses.push(format!("kind IN ({})", vec!["?"; kinds.len()].join(",")));
            binds.extend(kinds.iter().cloned().map(SqlValue::Text));
        }
    }
    if let Some(names) = &q.names {
        if names.is_empty() {
            clauses.push("0".into());
        } else {
            clauses.push(format!("name IN ({})", vec!["?"; names.len()].join(",")));
            binds.extend(names.iter().cloned().map(SqlValue::Text));
        }
    }
    if let Some(needles) = &q.source_contains_any {
        if needles.is_empty() {
            clauses.push("0".into());
        } else {
            let any = vec!["instr(source, ?) > 0"; needles.len()].join(" OR ");
            clauses.push(format!("({any})"));
            binds.extend(needles.iter().cloned().map(SqlValue::Text));
        }
    }
    if let Some(n) = q.min_lines {
        clauses.push("end_line - start_line + 1 >= ?".into());
        binds.push(SqlValue::Integer(n));
    }
    if let Some(suffixes) = &q.file_suffix_any {
        if suffixes.is_empty() {
            clauses.push("0".into());
        } else {
            let any = vec!["file GLOB ?"; suffixes.len()].join(" OR ");
            clauses.push(format!("({any})"));
            binds.extend(
                suffixes
                    .iter()
                    .map(|s| SqlValue::Text(format!("*{}", escape_glob(s)))),
            );
        }
    }
    if q.has_heritage == Some(true) {
        clauses.push(
            "(json_extract(extras, '$.extends') IS NOT NULL OR json_extract(extras, '$.implements') IS NOT NULL)"
                .into(),
        );
    }
    if let Some(chunk) = id_chunk {
        let marks = vec!["?"; chunk.len()].join(",");
        clauses.push(format!("id IN ({marks})"));
        binds.extend(chunk.iter().cloned().map(SqlValue::Text));
    }
    let sql = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    (sql, binds)
}

/// `namePrefix.replace(/[*?[]/g, "[$&]")`.
fn escape_glob(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for ch in s.chars() {
        if ch == '*' || ch == '?' || ch == '[' {
            out.push('[');
            out.push(ch);
            out.push(']');
        } else {
            out.push(ch);
        }
    }
    out
}

/// `chunkIds`: `None` -> one unfiltered pass; `Some([])` -> no pass at all (an empty id list means
/// "none of them", never "all of them").
fn chunk_ids(ids: Option<&Vec<String>>) -> Vec<Option<&[String]>> {
    match ids {
        None => vec![None],
        Some(ids) => ids.chunks(MAX_BOUND_PARAMS).map(Some).collect(),
    }
}

/// Size at which a result is split into another JSON array.
///
/// Two limits meet here. V8 cannot hold a string longer than ~2^29 characters (~512 MB), and one
/// real conversation index here carries ~330 MB of raw text before escaping — a single-string result
/// would make the native path throw where the TypeScript one still answers. And each chunk is one
/// `JSON.parse` on the event loop, which the JS side yields between: at 32 MB a 98k-row result still
/// blocked the loop for 114 ms in one parse; 4 MB bounds a single block to a few milliseconds.
pub const CHUNK_BYTES: usize = 4 * 1024 * 1024;

/// A result written as a sequence of complete JSON arrays, each starting a new one once the current
/// passes the size limit. Always at least one chunk (`[]` for no rows).
struct Chunks {
    done: Vec<String>,
    cur: Vec<u8>,
    limit: usize,
    first_in_chunk: bool,
}

impl Chunks {
    fn new(limit: usize) -> Self {
        Chunks {
            done: Vec::new(),
            cur: vec![b'['],
            limit,
            first_in_chunk: true,
        }
    }

    /// The buffer to write the next element into, with the separator (or a chunk break) applied.
    fn begin_item(&mut self) -> Result<&mut Vec<u8>> {
        if !self.first_in_chunk {
            if self.cur.len() >= self.limit {
                self.close_current()?;
            } else {
                self.cur.push(b',');
            }
        }
        self.first_in_chunk = false;
        Ok(&mut self.cur)
    }

    fn close_current(&mut self) -> Result<()> {
        self.cur.push(b']');
        let bytes = std::mem::replace(&mut self.cur, vec![b'[']);
        // Every byte is ASCII punctuation, UTF-8 SQLite handed back (lossily decoded), or serde_json
        // output — valid UTF-8 by construction; the check is a guard, not a conversion.
        self.done
            .push(String::from_utf8(bytes).map_err(|e| StoreError {
                sqlite_code: None,
                message: e.to_string(),
            })?);
        self.first_in_chunk = true;
        Ok(())
    }

    fn finish(mut self) -> Result<Vec<String>> {
        self.close_current()?;
        Ok(self.done)
    }
}

/// Symbols matching `q` — the result of `findSymbolsSqlite` — as JSON arrays to be concatenated
/// in order (see `CHUNK_BYTES`).
///
/// The repo is read from `meta` and stamped onto every symbol, as `rowToSymbol` does; a database
/// with no `repo` key answers `[]`.
pub fn find_symbols_json(db_path: &Path, q: &SymbolQuery) -> Result<Vec<String>> {
    find_symbols_chunked(db_path, q, CHUNK_BYTES)
}

fn find_symbols_chunked(
    db_path: &Path,
    q: &SymbolQuery,
    chunk_bytes: usize,
) -> Result<Vec<String>> {
    let conn = open(db_path)?;
    // One snapshot across the id chunks. The TS path reads them from a shared connection without
    // a transaction; reading them from one snapshot is strictly no weaker.
    conn.execute_batch("BEGIN")?;
    let result = find_in_snapshot(&conn, q, chunk_bytes);
    let _ = conn.execute_batch("COMMIT");
    result
}

fn find_in_snapshot(conn: &Connection, q: &SymbolQuery, chunk_bytes: usize) -> Result<Vec<String>> {
    let Some(repo) = read_meta(conn, "repo")? else {
        return Ok(vec!["[]".to_string()]);
    };
    let columns = if q.with_source {
        "*"
    } else {
        COLUMNS_WITHOUT_SOURCE
    };
    let mut out = Chunks::new(chunk_bytes);
    let mut emitted: i64 = 0;
    for chunk in chunk_ids(q.ids.as_ref()) {
        if let Some(limit) = q.limit {
            if emitted >= limit {
                break;
            }
        }
        let (pred, binds) = build_predicate(q, chunk);
        let limit_sql = match q.limit {
            Some(limit) => format!(" LIMIT {}", (limit - emitted).max(0)),
            None => String::new(),
        };
        // ORDER BY rowid, as queries.ts: the order a full load hands back, so `limit` keeps choosing
        // the same rows.
        let sql = format!("SELECT {columns} FROM symbols {pred} ORDER BY rowid{limit_sql}");
        let mut stmt = conn.prepare(&sql)?;
        emitted += write_rows(&mut stmt, &binds, &repo, &mut out)?.0;
    }
    out.finish()
}

/// The symbols at `rowids`, in that order (repeats allowed), serialised exactly as `find_symbols_json`
/// serialises them — for callers that already know WHICH rows they want, i.e. the call graph's nodes
/// (stage 7). `expect_ids[i]`, when given, must be the id at `rowids[i]`: a row that changed under the
/// caller since it learned the rowid is an error, never a different symbol.
pub fn symbols_by_rowid_json(
    db_path: &Path,
    rowids: &[i64],
    expect_ids: Option<&[String]>,
    with_source: bool,
) -> Result<Vec<String>> {
    let conn = open(db_path)?;
    conn.execute_batch("BEGIN")?;
    let result = symbols_by_rowid_in(&conn, rowids, expect_ids, with_source);
    let _ = conn.execute_batch("COMMIT");
    result
}

fn symbols_by_rowid_in(
    conn: &Connection,
    rowids: &[i64],
    expect_ids: Option<&[String]>,
    with_source: bool,
) -> Result<Vec<String>> {
    let Some(repo) = read_meta(conn, "repo")? else {
        return Ok(vec!["[]".to_string()]);
    };
    let columns = if with_source {
        "*"
    } else {
        COLUMNS_WITHOUT_SOURCE
    };
    let mut unique: Vec<i64> = rowids.to_vec();
    unique.sort_unstable();
    unique.dedup();
    let mut by_rowid: HashMap<i64, (String, Vec<u8>)> = HashMap::with_capacity(unique.len());
    for chunk in unique.chunks(MAX_BOUND_PARAMS) {
        let marks = vec!["?"; chunk.len()].join(",");
        let sql = format!("SELECT rowid AS _rid, {columns} FROM symbols WHERE rowid IN ({marks})");
        let mut stmt = conn.prepare(&sql)?;
        let names: Vec<String> = stmt
            .column_names()
            .into_iter()
            .map(str::to_string)
            .collect();
        let col = |n: &str| names.iter().position(|c| c == n);
        let rid_col = col("_rid").expect("selected");
        let idx = ColumnIndex {
            id: col("id"),
            file: col("file"),
            name: col("name"),
            kind: col("kind"),
            start_line: col("start_line"),
            end_line: col("end_line"),
            start_col: col("start_col"),
            end_col: col("end_col"),
            start_byte: col("start_byte"),
            end_byte: col("end_byte"),
            signature: col("signature"),
            docstring: col("docstring"),
            source: col("source"),
            parent: col("parent"),
            is_async: col("is_async"),
            is_exported: col("is_exported"),
            extras: col("extras"),
        };
        let mut rows = stmt.query(rusqlite::params_from_iter(chunk.iter()))?;
        while let Some(row) = rows.next()? {
            let rid: i64 = row.get(rid_col)?;
            let id: String = row.get(idx.id.expect("selected"))?;
            let mut buf = Vec::new();
            write_symbol(row, &idx, &repo, &mut buf)?;
            by_rowid.insert(rid, (id, buf));
        }
    }
    let mut out = Chunks::new(CHUNK_BYTES);
    for (i, rid) in rowids.iter().enumerate() {
        let Some((id, buf)) = by_rowid.get(rid) else {
            return Err(StoreError {
                sqlite_code: None,
                message: format!("rowid {rid} is no longer in the index"),
            });
        };
        if let Some(expected) = expect_ids {
            if expected.get(i).map(String::as_str) != Some(id.as_str()) {
                return Err(StoreError {
                    sqlite_code: None,
                    message: format!("rowid {rid} now holds a different symbol"),
                });
            }
        }
        out.begin_item()?.extend_from_slice(buf);
    }
    out.finish()
}

/// Write each row of `stmt` as a symbol object; returns how many were written and, when the query
/// selected `rowid AS _rid`, the last row's rowid (the paged reader's cursor).
fn write_rows(
    stmt: &mut Statement<'_>,
    binds: &[SqlValue],
    repo: &str,
    out: &mut Chunks,
) -> Result<(i64, Option<i64>)> {
    let names: Vec<String> = stmt
        .column_names()
        .into_iter()
        .map(str::to_string)
        .collect();
    let col = |n: &str| names.iter().position(|c| c == n);
    let rid = col("_rid");
    let idx = ColumnIndex {
        id: col("id"),
        file: col("file"),
        name: col("name"),
        kind: col("kind"),
        start_line: col("start_line"),
        end_line: col("end_line"),
        start_col: col("start_col"),
        end_col: col("end_col"),
        start_byte: col("start_byte"),
        end_byte: col("end_byte"),
        signature: col("signature"),
        docstring: col("docstring"),
        source: col("source"),
        parent: col("parent"),
        is_async: col("is_async"),
        is_exported: col("is_exported"),
        extras: col("extras"),
    };
    let mut rows = stmt.query(rusqlite::params_from_iter(binds.iter()))?;
    let mut count = 0;
    let mut last_rid = None;
    while let Some(row) = rows.next()? {
        write_symbol(row, &idx, repo, out.begin_item()?)?;
        if let Some(r) = rid {
            last_rid = Some(row.get::<_, i64>(r)?);
        }
        count += 1;
    }
    Ok((count, last_rid))
}

struct ColumnIndex {
    id: Option<usize>,
    file: Option<usize>,
    name: Option<usize>,
    kind: Option<usize>,
    start_line: Option<usize>,
    end_line: Option<usize>,
    start_col: Option<usize>,
    end_col: Option<usize>,
    start_byte: Option<usize>,
    end_byte: Option<usize>,
    signature: Option<usize>,
    docstring: Option<usize>,
    source: Option<usize>,
    parent: Option<usize>,
    is_async: Option<usize>,
    is_exported: Option<usize>,
    extras: Option<usize>,
}

/// One symbol, in `rowToSymbol`'s key order:
/// id, repo, name, kind, file, start_line, end_line, then the optional columns, then the extras.
fn write_symbol(
    row: &rusqlite::Row<'_>,
    c: &ColumnIndex,
    repo: &str,
    out: &mut Vec<u8>,
) -> Result<()> {
    out.push(b'{');
    let mut first = true;
    // The required columns are emitted even when NULL would be impossible under the schema; the TS
    // mapper copies them unconditionally, so a NULL there would arrive as `null` on both paths.
    write_field(out, &mut first, "id", value(row, c.id)?)?;
    write_key(out, &mut first, "repo");
    write_json_str(out, repo)?;
    write_field(out, &mut first, "name", value(row, c.name)?)?;
    write_field(out, &mut first, "kind", value(row, c.kind)?)?;
    write_field(out, &mut first, "file", value(row, c.file)?)?;
    write_field(out, &mut first, "start_line", value(row, c.start_line)?)?;
    write_field(out, &mut first, "end_line", value(row, c.end_line)?)?;
    for (key, ix) in [
        ("start_col", c.start_col),
        ("end_col", c.end_col),
        ("start_byte", c.start_byte),
        ("end_byte", c.end_byte),
        ("signature", c.signature),
        ("docstring", c.docstring),
        ("source", c.source),
        ("parent", c.parent),
    ] {
        let v = value(row, ix)?;
        if !matches!(v, ValueRef::Null) {
            write_field(out, &mut first, key, v)?;
        }
    }
    for (key, ix) in [("is_async", c.is_async), ("is_exported", c.is_exported)] {
        let v = value(row, ix)?;
        // `row.is_async === 1` — strict equality with the number 1, whatever else is stored.
        let truthy = match v {
            ValueRef::Null => continue,
            ValueRef::Integer(i) => i == 1,
            ValueRef::Real(f) => f == 1.0,
            _ => false,
        };
        write_key(out, &mut first, key);
        out.extend_from_slice(if truthy { b"true" } else { b"false" });
    }
    if let ValueRef::Text(raw) = value(row, c.extras)? {
        write_extras(out, &mut first, raw)?;
    }
    out.push(b'}');
    Ok(())
}

/// A column that was not selected reads as NULL — `rowToSymbolNoSource` passes `source: null`.
fn value<'a>(row: &'a rusqlite::Row<'_>, ix: Option<usize>) -> Result<ValueRef<'a>> {
    match ix {
        Some(i) => Ok(row.get_ref(i)?),
        None => Ok(ValueRef::Null),
    }
}

fn write_key(out: &mut Vec<u8>, first: &mut bool, key: &str) {
    if !*first {
        out.push(b',');
    }
    *first = false;
    out.push(b'"');
    out.extend_from_slice(key.as_bytes());
    out.extend_from_slice(b"\":");
}

fn write_field(out: &mut Vec<u8>, first: &mut bool, key: &str, v: ValueRef<'_>) -> Result<()> {
    write_key(out, first, key);
    write_value(out, v)
}

/// Emit a column as the JS value node:sqlite would have produced for it.
fn write_value(out: &mut Vec<u8>, v: ValueRef<'_>) -> Result<()> {
    match v {
        ValueRef::Null => out.extend_from_slice(b"null"),
        ValueRef::Integer(i) => write!(out, "{i}")?,
        ValueRef::Real(f) => {
            if f.is_finite() {
                serde_json::to_writer(&mut *out, &f).map_err(json_err)?;
            } else {
                // JSON has no Infinity/NaN; the schema never stores them. Refuse rather than guess.
                return Err(StoreError {
                    sqlite_code: None,
                    message: format!("non-finite REAL {f} in index"),
                });
            }
        }
        ValueRef::Text(t) => write_json_str(out, &String::from_utf8_lossy(t))?,
        ValueRef::Blob(_) => {
            return Err(StoreError {
                sqlite_code: None,
                message: "BLOB in a symbols column — not a CodeSift index row".to_string(),
            })
        }
    }
    Ok(())
}

/// A JSON string literal. serde's escaper, deliberately: a hand-written run-copying escaper was
/// measured SLOWER here (60 -> 80 ms on a 38 MB source-heavy read) — serde's 256-entry lookup table
/// beats a per-byte `match`. `string_escaping_round_trips` holds whichever is used to round-tripping.
fn write_json_str(out: &mut Vec<u8>, s: &str) -> Result<()> {
    serde_json::to_writer(&mut *out, s).map_err(json_err)
}

fn json_err(e: serde_json::Error) -> StoreError {
    StoreError {
        sqlite_code: None,
        message: e.to_string(),
    }
}

/// The `extras` column: `JSON.parse` it, then copy tokens, decorators, extends, implements, meta —
/// in that order, each only if the key is PRESENT (a stored `null` is copied as `null`, exactly as
/// `extras.tokens !== undefined` lets it through).
///
/// The values are copied as RAW JSON text (`RawValue`), never rebuilt into a tree: the JS side
/// parses them anyway, and parsing + re-serialising every row's tokens and meta was the largest
/// single cost of a native read. Raw text also keeps every number and every key order exactly as
/// stored, and a duplicate key resolves to its LAST occurrence — the map insert overwrites, as
/// `JSON.parse` does.
///
/// Non-object JSON mirrors what the TS mapper does with `JSON.parse`'s result: an array, string,
/// number or boolean has no such properties (nothing copied); `null` makes `extras.tokens` throw,
/// so it fails here too; invalid JSON fails like `JSON.parse` does.
fn write_extras(out: &mut Vec<u8>, first: &mut bool, raw: &[u8]) -> Result<()> {
    let malformed = |detail: String| StoreError {
        sqlite_code: None,
        message: format!("malformed extras column: {detail}"),
    };
    let text = std::str::from_utf8(raw).map_err(|e| malformed(e.to_string()))?;
    match text.trim_start().as_bytes().first() {
        Some(b'{') => {}
        Some(b'n') => {
            let _: Value = serde_json::from_str(text).map_err(|e| malformed(e.to_string()))?;
            return Err(malformed("null".to_string()));
        }
        _ => {
            let _: &RawValue = serde_json::from_str(text).map_err(|e| malformed(e.to_string()))?;
            return Ok(());
        }
    }
    let map: HashMap<String, &RawValue> =
        serde_json::from_str(text).map_err(|e| malformed(e.to_string()))?;
    for key in ["tokens", "decorators", "extends", "implements", "meta"] {
        if let Some(v) = map.get(key) {
            write_key(out, first, key);
            out.extend_from_slice(v.get().as_bytes());
        }
    }
    Ok(())
}

/// One page of a paged read: the symbols as a JSON array, how many, and the rowid to resume after.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page {
    pub json: String,
    pub count: i64,
    pub last_rowid: Option<i64>,
}

/// A read transaction held open across pages — the native half of `streamSymbolsSqlite`.
///
/// The paging LOOP stays in TypeScript (page sizing by time budget, stop on an empty page, the
/// limit, the yields), so its semantics are the TypeScript ones by construction; only the fetch of
/// each page moves here. What this type owns is the property the TS reader gets from its private
/// connection: every page comes from ONE snapshot, so a commit landing between two pages can never
/// make one stream a mixture of two database states.
pub struct Snapshot {
    conn: Connection,
    repo: Option<String>,
}

impl Snapshot {
    pub fn open(db_path: &Path) -> Result<Snapshot> {
        let conn = open(db_path)?;
        conn.execute_batch("BEGIN")?;
        // A deferred BEGIN takes its snapshot at the first read; reading `repo` here pins it now,
        // before the caller has seen anything.
        let repo = read_meta(&conn, "repo")?;
        Ok(Snapshot { conn, repo })
    }

    /// `None` when the database holds no index — the stream then delivers nothing.
    pub fn repo(&self) -> Option<&str> {
        self.repo.as_deref()
    }

    /// Up to `rows` matches with rowid greater than `after_rowid`, in rowid order — the statement
    /// `streamSymbolsSqlite` prepares, with the same predicate.
    pub fn page(
        &self,
        q: &SymbolQuery,
        id_chunk: Option<&[String]>,
        after_rowid: i64,
        rows: i64,
    ) -> Result<Page> {
        let Some(repo) = self.repo.as_deref() else {
            return Ok(Page {
                json: "[]".to_string(),
                count: 0,
                last_rowid: None,
            });
        };
        let columns = if q.with_source {
            "*"
        } else {
            COLUMNS_WITHOUT_SOURCE
        };
        let (pred, mut binds) = build_predicate(q, id_chunk);
        let where_sql = if pred.is_empty() {
            "WHERE rowid > ?".to_string()
        } else {
            format!("{pred} AND rowid > ?")
        };
        binds.push(SqlValue::Integer(after_rowid));
        binds.push(SqlValue::Integer(rows));
        let sql = format!(
            "SELECT rowid AS _rid, {columns} FROM symbols {where_sql} ORDER BY rowid LIMIT ?"
        );
        let mut stmt = self.conn.prepare_cached(&sql)?;
        // A page is at most 20,000 rows (PAGE_MAX_ROWS in index-io.ts) — one string is safe.
        let mut out = Chunks::new(usize::MAX);
        let (count, last_rowid) = write_rows(&mut stmt, &binds, repo, &mut out)?;
        let json = out.finish()?.pop().unwrap_or_else(|| "[]".to_string());
        Ok(Page {
            json,
            count,
            last_rowid,
        })
    }
}

impl Drop for Snapshot {
    fn drop(&mut self) {
        // Ends the read transaction so the WAL checkpoint is no longer pinned behind it.
        let _ = self.conn.execute_batch("COMMIT");
    }
}

/// One symbol row as `symbolToRow` lays it out. Numbers are f64 because that is how `node:sqlite`
/// binds a JS number; the INTEGER columns' affinity then stores an integral value as INTEGER on both
/// paths, and a fractional one (an `mtime_ms`) as REAL on both.
#[derive(Debug, Clone, Default)]
pub struct SymbolRowIn {
    pub id: String,
    pub file: String,
    pub name: String,
    pub kind: String,
    pub start_line: f64,
    pub end_line: f64,
    pub start_col: Option<f64>,
    pub end_col: Option<f64>,
    pub start_byte: Option<f64>,
    pub end_byte: Option<f64>,
    pub signature: Option<String>,
    pub docstring: Option<String>,
    pub source: Option<String>,
    pub parent: Option<String>,
    pub is_async: Option<bool>,
    pub is_exported: Option<bool>,
    /// `JSON.stringify` of the extras, computed on the JS side so the stored bytes are the same.
    pub extras: Option<String>,
}

/// `fileEntryToRow`.
#[derive(Debug, Clone, Default)]
pub struct FileRowIn {
    pub path: String,
    pub language: String,
    pub symbol_count: f64,
    pub last_modified: f64,
    pub mtime_ms: Option<f64>,
    pub stale: Option<bool>,
}

/// `INSERT_SYMBOL_SQL` / `INSERT_FILE_SQL` of rows.ts — the same statements.
const INSERT_SYMBOL_SQL: &str = "INSERT INTO symbols (
  id, file, name, kind, start_line, end_line, start_col, end_col,
  start_byte, end_byte, signature, docstring, source, parent,
  is_async, is_exported, extras
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";

const INSERT_FILE_SQL: &str =
    "INSERT INTO files (path, language, symbol_count, last_modified, mtime_ms, stale)
VALUES (?,?,?,?,?,?)
ON CONFLICT(path) DO UPDATE SET
  language=excluded.language, symbol_count=excluded.symbol_count,
  last_modified=excluded.last_modified, mtime_ms=excluded.mtime_ms,
  stale=excluded.stale";

const UPSERT_META_SQL: &str =
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";

/// `WAL_CHECKPOINT_THRESHOLD_BYTES` of connection.ts.
const WAL_CHECKPOINT_THRESHOLD_BYTES: u64 = 64 * 1024 * 1024;

fn bool_int(b: Option<bool>) -> Option<i64> {
    b.map(|v| if v { 1 } else { 0 })
}

/// A whole-index replacement — `saveIndexSqlite` + `writeIndexRows` — on its own connection and its
/// own transaction. Dropped without `commit`, it rolls back, so a write abandoned midway leaves the
/// previous index exactly as it was (and `repo`, written last, never half-present).
pub struct Writer {
    conn: Option<Connection>,
    db_path: std::path::PathBuf,
}

impl Writer {
    pub fn begin(db_path: &Path) -> Result<Writer> {
        let conn = open(db_path)?;
        // IMMEDIATE takes the write lock up front: a deferred BEGIN that upgrades on its first write
        // can fail with BUSY without waiting, where this waits out busy_timeout like any writer.
        conn.execute_batch("BEGIN IMMEDIATE; DELETE FROM symbols; DELETE FROM files;")?;
        Ok(Writer {
            conn: Some(conn),
            db_path: db_path.to_path_buf(),
        })
    }

    fn conn(&self) -> Result<&Connection> {
        self.conn.as_ref().ok_or_else(|| StoreError {
            sqlite_code: None,
            message: "index writer already finished".to_string(),
        })
    }

    pub fn insert_symbols(&self, rows: &[SymbolRowIn]) -> Result<()> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(INSERT_SYMBOL_SQL)?;
        for r in rows {
            stmt.execute(rusqlite::params![
                r.id,
                r.file,
                r.name,
                r.kind,
                r.start_line,
                r.end_line,
                r.start_col,
                r.end_col,
                r.start_byte,
                r.end_byte,
                r.signature,
                r.docstring,
                r.source,
                r.parent,
                bool_int(r.is_async),
                bool_int(r.is_exported),
                r.extras,
            ])?;
        }
        Ok(())
    }

    pub fn insert_files(&self, rows: &[FileRowIn]) -> Result<()> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(INSERT_FILE_SQL)?;
        for r in rows {
            stmt.execute(rusqlite::params![
                r.path,
                r.language,
                r.symbol_count,
                r.last_modified,
                r.mtime_ms,
                bool_int(r.stale),
            ])?;
        }
        Ok(())
    }

    /// Meta in the order `writeIndexRows` writes it, the lossy-migration marker cleared when the rows
    /// came from source, then COMMIT and — after it, never inside — the WAL bound of
    /// `maybeCheckpointWal`.
    pub fn commit(mut self, meta: &[(String, String)], source_complete: bool) -> Result<()> {
        let conn = self.conn.take().ok_or_else(|| StoreError {
            sqlite_code: None,
            message: "index writer already finished".to_string(),
        })?;
        let result = (|| -> Result<()> {
            let mut up = conn.prepare_cached(UPSERT_META_SQL)?;
            for (k, v) in meta {
                up.execute([k, v])?;
            }
            drop(up);
            if source_complete {
                conn.execute("DELETE FROM meta WHERE key = ?", ["lossy_v1_migration"])?;
            }
            conn.execute_batch("COMMIT")?;
            Ok(())
        })();
        if let Err(e) = result {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
        let wal = self.db_path.with_file_name(format!(
            "{}-wal",
            self.db_path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        ));
        if std::fs::metadata(&wal)
            .map(|m| m.len() >= WAL_CHECKPOINT_THRESHOLD_BYTES)
            .unwrap_or(false)
        {
            // Best effort: BUSY under a live reader is retried by the next write.
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
        }
        Ok(())
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            let _ = conn.execute_batch("ROLLBACK");
        }
    }
}

/// `getIndexMetaSqlite`: `None` when the database holds no index (no `repo` or no `root`).
pub fn index_meta(db_path: &Path) -> Result<Option<IndexMeta>> {
    let conn = open(db_path)?;
    let (Some(repo), Some(root)) = (read_meta(&conn, "repo")?, read_meta(&conn, "root")?) else {
        return Ok(None);
    };
    let symbol_count: i64 = conn.query_row("SELECT COUNT(*) FROM symbols", [], |r| r.get(0))?;
    let file_count: i64 = conn.query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))?;
    Ok(Some(IndexMeta {
        repo,
        root,
        updated_at: read_meta(&conn, "updated_at")?,
        symbol_count,
        file_count,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCHEMA: &str = "
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE files (path TEXT PRIMARY KEY, language TEXT NOT NULL, symbol_count INTEGER NOT NULL,
          last_modified INTEGER NOT NULL, mtime_ms INTEGER, stale INTEGER);
        CREATE TABLE symbols (id TEXT NOT NULL, file TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
          start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, start_col INTEGER, end_col INTEGER,
          start_byte INTEGER, end_byte INTEGER, signature TEXT, docstring TEXT, source TEXT, parent TEXT,
          is_async INTEGER, is_exported INTEGER, extras TEXT);";

    fn db() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.index.db");
        let conn = Connection::open(&path).unwrap();
        // Every real index is WAL (openIndexDb sets it); in rollback-journal mode a held read
        // snapshot would block writers, which is not the condition the snapshot tests describe.
        conn.execute_batch("PRAGMA journal_mode = WAL").unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute_batch(
            "INSERT INTO meta VALUES ('repo','t'),('root','/r'),('updated_at','42');
             INSERT INTO symbols (id,file,name,kind,start_line,end_line,source,is_async,is_exported,extras)
               VALUES ('t:a.ts:f:1','a.ts','f','function',1,3,'function f(){}',1,0,
                       '{\"meta\":{\"b\":1,\"a\":[2]},\"tokens\":[\"f\"]}');
             INSERT INTO symbols (id,file,name,kind,start_line,end_line,parent)
               VALUES ('t:a.ts:a_b:5','a.ts','a_b','variable',5,5,'p');
             INSERT INTO symbols (id,file,name,kind,start_line,end_line)
               VALUES ('t:b.ts:axb:1','b.ts','axb','variable',1,1);",
        )
        .unwrap();
        (dir, path)
    }

    fn q() -> SymbolQuery {
        SymbolQuery::default()
    }

    /// The single-chunk answer of a small query.
    fn one(q: &SymbolQuery, p: &Path) -> String {
        let chunks = find_symbols_json(p, q).unwrap();
        assert_eq!(chunks.len(), 1, "{chunks:?}");
        chunks.into_iter().next().unwrap()
    }

    #[test]
    fn emits_rowtosymbol_key_order_and_omits_unselected_source() {
        let (_d, p) = db();
        let got = one(
            &SymbolQuery {
                name: Some("f".into()),
                ..q()
            },
            &p,
        );
        assert_eq!(
            got,
            r#"[{"id":"t:a.ts:f:1","repo":"t","name":"f","kind":"function","file":"a.ts","start_line":1,"end_line":3,"is_async":true,"is_exported":false,"tokens":["f"],"meta":{"b":1,"a":[2]}}]"#
        );
        let with = one(
            &SymbolQuery {
                with_source: true,
                name: Some("f".into()),
                ..q()
            },
            &p,
        );
        assert!(
            with.contains(r#""end_line":3,"source":"function f(){}","is_async":true"#),
            "{with}"
        );
    }

    #[test]
    fn name_prefix_is_case_sensitive_and_globs_are_literals() {
        let (_d, p) = db();
        let got = one(
            &SymbolQuery {
                name_prefix: Some("a_".into()),
                ..q()
            },
            &p,
        );
        assert!(got.contains("\"a_b\"") && !got.contains("\"axb\""), "{got}");
        let upper = one(
            &SymbolQuery {
                name_prefix: Some("A".into()),
                ..q()
            },
            &p,
        );
        assert_eq!(upper, "[]");
        assert_eq!(escape_glob("a*b?[c"), "a[*]b[?][[]c");
    }

    #[test]
    fn empty_id_list_means_none_and_limit_spans_chunks() {
        let (_d, p) = db();
        assert_eq!(
            one(
                &SymbolQuery {
                    ids: Some(vec![]),
                    ..q()
                },
                &p
            ),
            "[]"
        );
        let ids: Vec<String> = (0..2000)
            .map(|i| format!("x{i}"))
            .chain(["t:b.ts:axb:1".to_string()])
            .collect();
        let got = one(
            &SymbolQuery {
                ids: Some(ids),
                limit: Some(5),
                ..q()
            },
            &p,
        );
        assert!(got.contains("axb"), "{got}");
        assert_eq!(
            one(
                &SymbolQuery {
                    limit: Some(0),
                    ..q()
                },
                &p
            ),
            "[]"
        );
    }

    #[test]
    fn splits_a_large_result_into_complete_arrays_in_order() {
        let (_d, p) = db();
        let whole = one(&q(), &p);
        // A 1-byte limit forces a break before every element after the first of each chunk.
        let parts = find_symbols_chunked(&p, &q(), 1).unwrap();
        assert_eq!(parts.len(), 3, "{parts:?}");
        let mut merged: Vec<Value> = Vec::new();
        for part in &parts {
            let Value::Array(items) = serde_json::from_str::<Value>(part).unwrap() else {
                panic!("{part}")
            };
            merged.extend(items);
        }
        assert_eq!(
            Value::Array(merged),
            serde_json::from_str::<Value>(&whole).unwrap()
        );
    }

    #[test]
    fn no_repo_answers_empty_and_meta_reads_counts() {
        let (_d, p) = db();
        let m = index_meta(&p).unwrap().unwrap();
        assert_eq!(
            (
                m.repo.as_str(),
                m.root.as_str(),
                m.symbol_count,
                m.file_count
            ),
            ("t", "/r", 3, 0)
        );
        assert_eq!(m.updated_at.as_deref(), Some("42"));
        Connection::open(&p)
            .unwrap()
            .execute_batch("DELETE FROM meta")
            .unwrap();
        assert_eq!(one(&q(), &p), "[]");
        assert_eq!(index_meta(&p).unwrap(), None);
    }

    #[test]
    fn snapshot_pages_resume_after_the_last_rowid_and_end_empty() {
        let (_d, p) = db();
        let snap = Snapshot::open(&p).unwrap();
        assert_eq!(snap.repo(), Some("t"));
        let first = snap.page(&q(), None, 0, 2).unwrap();
        assert_eq!(first.count, 2);
        let rest = snap.page(&q(), None, first.last_rowid.unwrap(), 2).unwrap();
        assert_eq!(rest.count, 1);
        assert!(rest.json.contains("axb"), "{}", rest.json);
        let done = snap.page(&q(), None, rest.last_rowid.unwrap(), 2).unwrap();
        assert_eq!(
            (done.count, done.last_rowid, done.json.as_str()),
            (0, None, "[]")
        );
        // The rowid alias is a cursor, never a field of the symbol.
        assert!(!first.json.contains("_rid"), "{}", first.json);
    }

    #[test]
    fn snapshot_does_not_see_a_commit_made_after_it_opened() {
        let (_d, p) = db();
        let snap = Snapshot::open(&p).unwrap();
        Connection::open(&p)
            .unwrap()
            .execute_batch("INSERT INTO symbols (id,file,name,kind,start_line,end_line) VALUES ('n','n.ts','late','function',1,1)")
            .unwrap();
        let all = snap.page(&q(), None, 0, 100).unwrap();
        assert_eq!(all.count, 3, "{}", all.json);
        drop(snap);
        assert!(one(&q(), &p).contains("late"));
    }

    #[test]
    fn extras_mirror_json_parse_for_odd_but_valid_shapes() {
        let (_d, p) = db();
        let c = Connection::open(&p).unwrap();
        c.execute_batch(
            r#"INSERT INTO symbols (id,file,name,kind,start_line,end_line,extras) VALUES
                 ('a','x.ts','arr','function',1,1,'[1,2]'),
                 ('d','x.ts','dup','function',1,1,'{"tokens":["first"],"tokens":["last"],"meta":{"n":1.50,"k":1e3}}');"#,
        )
        .unwrap();
        let arr = one(
            &SymbolQuery {
                name: Some("arr".into()),
                ..q()
            },
            &p,
        );
        assert!(
            !arr.contains("tokens") && arr.ends_with(r#""end_line":1}]"#),
            "{arr}"
        );
        let dup = one(
            &SymbolQuery {
                name: Some("dup".into()),
                ..q()
            },
            &p,
        );
        // Last occurrence wins; numbers keep their stored spelling (JSON.parse reads 1.50 as 1.5).
        assert!(
            dup.contains(r#""tokens":["last"],"meta":{"n":1.50,"k":1e3}"#),
            "{dup}"
        );
        c.execute_batch(
            "INSERT INTO symbols (id,file,name,kind,start_line,end_line,extras) VALUES ('n','x.ts','nul','function',1,1,'null')",
        )
        .unwrap();
        let err = find_symbols_json(
            &p,
            &SymbolQuery {
                name: Some("nul".into()),
                ..q()
            },
        )
        .unwrap_err();
        assert!(err.message.contains("malformed extras"), "{err}");
    }

    #[test]
    fn string_escaping_round_trips() {
        let cases = [
            "",
            "plain ascii",
            "quote \" backslash \\ slash /",
            "newline\n tab\t cr\r bs\u{8} ff\u{c} nul\u{0} unit\u{1f}",
            "zażółć gęślą jaźń 中文 🚀 \u{2028} \u{2029} \u{7f}",
        ];
        for case in cases {
            let mut out = Vec::new();
            write_json_str(&mut out, case).unwrap();
            let back: String = serde_json::from_slice(&out).unwrap();
            assert_eq!(back, case, "{}", String::from_utf8_lossy(&out));
        }
    }

    #[test]
    fn writer_replaces_the_index_and_an_abandoned_write_leaves_it_untouched() {
        let (_d, p) = db();
        let row = |id: &str, mtime: Option<f64>| SymbolRowIn {
            id: id.into(),
            file: "w.ts".into(),
            name: id.into(),
            kind: "function".into(),
            start_line: 1.0,
            end_line: 2.0,
            is_exported: Some(true),
            extras: Some(r#"{"tokens":["w"]}"#.into()),
            start_byte: mtime,
            ..SymbolRowIn::default()
        };
        // Abandoned: dropped without commit.
        {
            let w = Writer::begin(&p).unwrap();
            w.insert_symbols(&[row("gone", None)]).unwrap();
        }
        assert!(one(&q(), &p).contains("axb"));
        let w = Writer::begin(&p).unwrap();
        w.insert_symbols(&[row("a", None), row("b", Some(3.5))])
            .unwrap();
        w.insert_files(&[FileRowIn {
            path: "w.ts".into(),
            language: "typescript".into(),
            symbol_count: 2.0,
            last_modified: 1.0,
            mtime_ms: Some(1.25),
            stale: None,
        }])
        .unwrap();
        w.commit(&[("repo".into(), "t".into())], true).unwrap();
        let got = one(&q(), &p);
        assert!(got.starts_with(r#"[{"id":"a","repo":"t","name":"a","kind":"function","file":"w.ts","start_line":1,"end_line":2,"is_exported":true,"tokens":["w"]}"#), "{got}");
        let conn = Connection::open(&p).unwrap();
        let ty: String = conn
            .query_row(
                "SELECT typeof(start_byte) FROM symbols WHERE id='b'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ty, "real");
        let ty: String = conn
            .query_row(
                "SELECT typeof(start_line) FROM symbols WHERE id='b'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ty, "integer");
        assert_eq!(index_meta(&p).unwrap().unwrap().file_count, 1);
    }

    #[test]
    fn a_full_database_reports_sqlite_full_and_the_index_survives() {
        // The native twin of sqlite-fault-classification.test.ts's "survives SQLite's automatic
        // rollback": SQLite rolls back by itself on SQLITE_FULL, so the error must be the FULL one
        // (code 13, which the TS side classifies) and the abandoned write must leave the old index.
        let (_d, p) = db();
        let w = Writer::begin(&p).unwrap();
        w.conn()
            .unwrap()
            .execute_batch("PRAGMA max_page_count = 4")
            .unwrap();
        let rows: Vec<SymbolRowIn> = (0..4000)
            .map(|i| SymbolRowIn {
                id: format!("x{i}"),
                file: "x.ts".into(),
                name: format!("x{i}"),
                kind: "function".into(),
                start_line: 1.0,
                end_line: 2.0,
                source: Some("y".repeat(200)),
                ..SymbolRowIn::default()
            })
            .collect();
        let err = w.insert_symbols(&rows).unwrap_err().to_string();
        assert!(err.contains("[sqlite:13]"), "{err}");
        drop(w);
        assert!(one(&q(), &p).contains("axb"));
    }

    #[test]
    fn a_missing_file_is_cantopen_not_an_empty_index() {
        let err = find_symbols_json(Path::new("/nonexistent/dir/x.db"), &q()).unwrap_err();
        assert_eq!(err.sqlite_code.map(|c| c & 0xff), Some(14), "{err}");
    }
}
