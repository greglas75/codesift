//! `node:sqlite`'s `DatabaseSync` / `StatementSync`, over the core's SQLite copy (ADR-006 stage 1).
//!
//! Why this exists: two SQLite libraries in one process must never open the same file. POSIX
//! advisory locks belong to the PROCESS, so neither copy sees the other's locks, and a connection
//! closing in one copy releases locks — and deletes `-wal`/`-shm` — that a connection in the other
//! still relies on. Measured as `SQLITE_IOERR` in tests; in the field it is lost writes. The native
//! store can only be safe when ONE copy owns every index database in the process, so every
//! `node:sqlite` caller is switched to this class while the store is on.
//!
//! Hence the shape: a line-by-line port of `node_sqlite.cc` on the raw C API, not a rusqlite
//! wrapper — the observable behaviour is the contract. Numbers bind as REAL, bigints as INTEGER,
//! rows are null-prototype objects, an integer past 2^53 throws, an empty statement is "finalized".
//! `tests/native/sqlite-compat-scenarios.ts` is the transcript both implementations must produce.
//!
//! Errors leave Rust as `\u{1}code\u{1}errcode\u{1}errstr\u{1}message`; the TS facade rebuilds the
//! `Error`/`TypeError`/`RangeError` node would have thrown, with the same `code`/`errcode`/`errstr`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::ptr;
use std::rc::Rc;

use codesift_core::sqlite_ffi as ffi;
use napi::bindgen_prelude::{ToNapiValue, Unknown};
use napi::{sys, Env, JsValue, Status};
use napi_derive::napi;

// libsqlite3-sys's bindings leave this out, but the bundled library defines it (rusqlite closes with
// it). node closes with `_v2`, which defers the close until outstanding statements are finalized.
extern "C" {
    fn sqlite3_close_v2(db: *mut ffi::sqlite3) -> c_int;
}

const SEP: char = '\u{1}';
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

fn node_error(code: &str, message: &str) -> napi::Error {
    napi::Error::new(
        Status::GenericFailure,
        format!("{SEP}{code}{SEP}{SEP}{SEP}{message}"),
    )
}

fn invalid_state(message: &str) -> napi::Error {
    node_error("ERR_INVALID_STATE", message)
}

unsafe fn c_text(p: *const c_char) -> String {
    if p.is_null() {
        String::new()
    } else {
        CStr::from_ptr(p).to_string_lossy().into_owned()
    }
}

/// `THROW_ERR_SQLITE_ERROR(isolate, db)`: the connection's last message, its EXTENDED code.
fn sqlite_error(db: *mut ffi::sqlite3) -> napi::Error {
    let (code, msg, errstr) = unsafe {
        let code = ffi::sqlite3_extended_errcode(db);
        (
            code,
            c_text(ffi::sqlite3_errmsg(db)),
            c_text(ffi::sqlite3_errstr(code)),
        )
    };
    napi::Error::new(
        Status::GenericFailure,
        format!("{SEP}ERR_SQLITE_ERROR{SEP}{code}{SEP}{errstr}{SEP}{msg}"),
    )
}

/// A JS exception is already pending (a getter threw): napi-rs must not throw over it.
fn pending() -> napi::Error {
    napi::Error::from_status(Status::PendingException)
}

fn check(status: sys::napi_status) -> napi::Result<()> {
    if status == sys::Status::napi_ok {
        Ok(())
    } else if status == sys::Status::napi_pending_exception {
        Err(pending())
    } else {
        Err(napi::Error::new(
            Status::GenericFailure,
            format!("napi call failed ({status})"),
        ))
    }
}

/// A `napi_value` handed straight back to JS.
pub struct Raw(sys::napi_value);

impl ToNapiValue for Raw {
    unsafe fn to_napi_value(_env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        Ok(val.0)
    }
}

// ---------------------------------------------------------------------------
// connection state
// ---------------------------------------------------------------------------

struct Stmt {
    handle: *mut ffi::sqlite3_stmt,
    /// node's `bare_named_params_`: built on first named binding, and kept even when building it
    /// threw — node `emplace`s before it validates, so a second call skips the check.
    bare_names: Option<HashMap<String, String>>,
}

struct DbState {
    db: *mut ffi::sqlite3,
    next_id: u64,
    stmts: HashMap<u64, Stmt>,
}

impl DbState {
    fn handle(&self) -> napi::Result<*mut ffi::sqlite3> {
        if self.db.is_null() {
            Err(invalid_state("database is not open"))
        } else {
            Ok(self.db)
        }
    }

    /// `FinalizeStatements` + `sqlite3_close_v2`. Every statement becomes "finalized", including
    /// across a later `open()` — node never re-prepares them.
    fn close(&mut self) -> c_int {
        for (_, s) in self.stmts.drain() {
            if !s.handle.is_null() {
                unsafe { ffi::sqlite3_finalize(s.handle) };
            }
        }
        let r = unsafe { sqlite3_close_v2(self.db) };
        // Only a successful close releases the handle; on failure it stays, so the error can be read
        // from it and a later close can retry — as node clears `connection_` only after the check.
        if r == ffi::SQLITE_OK {
            self.db = ptr::null_mut();
        }
        r
    }
}

impl Drop for DbState {
    fn drop(&mut self) {
        if !self.db.is_null() {
            self.close();
        }
    }
}

/// `DatabaseSync` constructor options, as node reads them.
#[napi(object)]
pub struct SqliteOpenOptions {
    pub open: Option<bool>,
    pub read_only: Option<bool>,
    pub enable_foreign_key_constraints: Option<bool>,
    pub enable_double_quoted_string_literals: Option<bool>,
    pub timeout: Option<i32>,
}

#[napi]
pub struct SqliteDatabase {
    state: Rc<RefCell<DbState>>,
    location: CString,
    read_only: bool,
    foreign_keys: bool,
    dqs: bool,
    timeout: i32,
}

#[napi]
impl SqliteDatabase {
    #[napi(constructor)]
    pub fn new(location: String, options: Option<SqliteOpenOptions>) -> napi::Result<Self> {
        let location = CString::new(location).map_err(|_| {
            node_error(
                "ERR_INVALID_ARG_TYPE",
                "The \"path\" argument must be a string without null bytes.",
            )
        })?;
        let o = options.unwrap_or(SqliteOpenOptions {
            open: None,
            read_only: None,
            enable_foreign_key_constraints: None,
            enable_double_quoted_string_literals: None,
            timeout: None,
        });
        let db = SqliteDatabase {
            state: Rc::new(RefCell::new(DbState {
                db: ptr::null_mut(),
                next_id: 0,
                stmts: HashMap::new(),
            })),
            location,
            read_only: o.read_only.unwrap_or(false),
            foreign_keys: o.enable_foreign_key_constraints.unwrap_or(true),
            dqs: o.enable_double_quoted_string_literals.unwrap_or(false),
            timeout: o.timeout.unwrap_or(0),
        };
        if o.open.unwrap_or(true) {
            db.open_inner()?;
        }
        Ok(db)
    }

    fn open_inner(&self) -> napi::Result<()> {
        let mut st = self.state.borrow_mut();
        if !st.db.is_null() {
            return Err(invalid_state("database is already open"));
        }
        let flags = ffi::SQLITE_OPEN_URI
            | if self.read_only {
                ffi::SQLITE_OPEN_READONLY
            } else {
                ffi::SQLITE_OPEN_READWRITE | ffi::SQLITE_OPEN_CREATE
            };
        let mut db: *mut ffi::sqlite3 = ptr::null_mut();
        let r =
            unsafe { ffi::sqlite3_open_v2(self.location.as_ptr(), &mut db, flags, ptr::null()) };
        if r != ffi::SQLITE_OK {
            let err = sqlite_error(db);
            unsafe { sqlite3_close_v2(db) };
            return Err(err);
        }
        let dqs = c_int::from(self.dqs);
        let fk = c_int::from(self.foreign_keys);
        let mut fk_out: c_int = 0;
        // Checked, as node checks them: an option that silently failed to apply (foreign keys off,
        // double-quoted strings accepted) would be a connection that answers differently from node's.
        let applied = unsafe {
            [
                ffi::sqlite3_db_config(
                    db,
                    ffi::SQLITE_DBCONFIG_DQS_DML,
                    dqs,
                    ptr::null_mut::<c_int>(),
                ),
                ffi::sqlite3_db_config(
                    db,
                    ffi::SQLITE_DBCONFIG_DQS_DDL,
                    dqs,
                    ptr::null_mut::<c_int>(),
                ),
                ffi::sqlite3_db_config(
                    db,
                    ffi::SQLITE_DBCONFIG_ENABLE_FKEY,
                    fk,
                    &mut fk_out as *mut c_int,
                ),
                ffi::sqlite3_busy_timeout(db, self.timeout),
            ]
        };
        if applied.iter().any(|&r| r != ffi::SQLITE_OK) {
            let err = sqlite_error(db);
            unsafe { sqlite3_close_v2(db) };
            return Err(err);
        }
        st.db = db;
        Ok(())
    }

    #[napi]
    pub fn open(&self) -> napi::Result<()> {
        self.open_inner()
    }

    #[napi(getter)]
    pub fn is_open(&self) -> bool {
        !self.state.borrow().db.is_null()
    }

    #[napi(getter)]
    pub fn is_transaction(&self) -> napi::Result<bool> {
        let db = self.state.borrow().handle()?;
        Ok(unsafe { ffi::sqlite3_get_autocommit(db) } == 0)
    }

    #[napi]
    pub fn close(&self) -> napi::Result<()> {
        let mut st = self.state.borrow_mut();
        let db = st.handle()?;
        let r = st.close();
        if r != ffi::SQLITE_OK {
            return Err(sqlite_error(db));
        }
        Ok(())
    }

    #[napi]
    pub fn exec(&self, sql: String) -> napi::Result<()> {
        let db = self.state.borrow().handle()?;
        let sql = CString::new(sql).map_err(|_| sqlite_nul())?;
        let r =
            unsafe { ffi::sqlite3_exec(db, sql.as_ptr(), None, ptr::null_mut(), ptr::null_mut()) };
        if r != ffi::SQLITE_OK {
            return Err(sqlite_error(db));
        }
        Ok(())
    }

    #[napi]
    pub fn prepare(&self, sql: String) -> napi::Result<SqliteStatement> {
        let mut st = self.state.borrow_mut();
        let db = st.handle()?;
        let sql = CString::new(sql).map_err(|_| sqlite_nul())?;
        let mut handle: *mut ffi::sqlite3_stmt = ptr::null_mut();
        let r =
            unsafe { ffi::sqlite3_prepare_v2(db, sql.as_ptr(), -1, &mut handle, ptr::null_mut()) };
        if r != ffi::SQLITE_OK {
            return Err(sqlite_error(db));
        }
        // SQL that compiles to nothing (`""`, a comment). Node 24.21 refuses it here; 24.18 returned
        // a statement that reported itself finalized on first use. Pinned to the newer behaviour.
        if handle.is_null() {
            return Err(node_error(
                "ERR_INVALID_ARG_VALUE",
                "The SQL query contains no statements.",
            ));
        }
        let id = st.next_id;
        st.next_id += 1;
        st.stmts.insert(
            id,
            Stmt {
                handle,
                bare_names: None,
            },
        );
        Ok(SqliteStatement {
            state: Rc::clone(&self.state),
            id,
        })
    }
}

/// A JS string with an embedded NUL. node passes `*Utf8Value` to SQLite, which stops at the NUL; the
/// facade never sends one (it truncates the same way), so reaching this is a facade bug.
fn sqlite_nul() -> napi::Error {
    node_error("ERR_INVALID_ARG_VALUE", "SQL must not contain a NUL byte")
}

// ---------------------------------------------------------------------------
// statements
// ---------------------------------------------------------------------------

#[napi]
pub struct SqliteStatement {
    state: Rc<RefCell<DbState>>,
    id: u64,
}

impl Drop for SqliteStatement {
    fn drop(&mut self) {
        // A GC finalizer; never contend with a live borrow — leaking one statement until close()
        // beats a panic across the FFI boundary.
        if let Ok(mut st) = self.state.try_borrow_mut() {
            if let Some(s) = st.stmts.remove(&self.id) {
                if !s.handle.is_null() {
                    unsafe { ffi::sqlite3_finalize(s.handle) };
                }
            }
        }
    }
}

/// Resets the statement on every exit path, as node's `OnScopeLeave` does.
/// Resets only a statement that is still live: one finalized by re-entrant JS mid-call is freed memory.
struct ResetGuard<'a>(&'a SqliteStatement, *mut ffi::sqlite3_stmt);

impl Drop for ResetGuard<'_> {
    fn drop(&mut self) {
        if self.0.still_live(self.1).is_ok() {
            unsafe { ffi::sqlite3_reset(self.1) };
        }
    }
}

struct Js {
    env: sys::napi_env,
}

thread_local! {
    /// UTF-8 conversion buffer for bound strings; grows to the longest one seen and is reused.
    static SCRATCH: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

impl Js {
    fn type_of(&self, v: sys::napi_value) -> napi::Result<sys::napi_valuetype> {
        let mut t = 0;
        check(unsafe { sys::napi_typeof(self.env, v, &mut t) })?;
        Ok(t)
    }

    fn string(&self, s: &[u8]) -> napi::Result<sys::napi_value> {
        let mut out = ptr::null_mut();
        check(unsafe {
            sys::napi_create_string_utf8(self.env, s.as_ptr().cast(), s.len() as isize, &mut out)
        })?;
        Ok(out)
    }

    /// The string's UTF-8 bytes, handed to `f` from a reused buffer. One O(1) call for the UTF-16
    /// length bounds the size (at most 3 bytes per unit: a surrogate pair is 4 bytes for 2 units, a
    /// lone surrogate becomes U+FFFD's 3), so the text is transcoded once — asking napi for the UTF-8
    /// length first walks the whole string an extra time.
    fn with_utf8<R>(&self, v: sys::napi_value, f: impl FnOnce(&[u8]) -> R) -> napi::Result<R> {
        let mut units = 0usize;
        check(unsafe {
            sys::napi_get_value_string_utf16(self.env, v, ptr::null_mut(), 0, &mut units)
        })?;
        SCRATCH.with(|cell| {
            let mut buf = cell.borrow_mut();
            let cap = units * 3 + 1;
            if buf.len() < cap {
                buf.resize(cap, 0);
            }
            let mut written = 0usize;
            check(unsafe {
                sys::napi_get_value_string_utf8(
                    self.env,
                    v,
                    buf.as_mut_ptr().cast(),
                    cap,
                    &mut written,
                )
            })?;
            Ok(f(&buf[..written]))
        })
    }

    fn double(&self, d: f64) -> napi::Result<sys::napi_value> {
        let mut out = ptr::null_mut();
        check(unsafe { sys::napi_create_double(self.env, d, &mut out) })?;
        Ok(out)
    }

    fn null(&self) -> napi::Result<sys::napi_value> {
        let mut out = ptr::null_mut();
        check(unsafe { sys::napi_get_null(self.env, &mut out) })?;
        Ok(out)
    }

    fn undefined(&self) -> napi::Result<sys::napi_value> {
        let mut out = ptr::null_mut();
        check(unsafe { sys::napi_get_undefined(self.env, &mut out) })?;
        Ok(out)
    }

    /// The bytes of an ArrayBufferView, or None for anything else.
    fn view_bytes(&self, v: sys::napi_value) -> napi::Result<Option<&[u8]>> {
        let mut is = false;
        check(unsafe { sys::napi_is_typedarray(self.env, v, &mut is) })?;
        if is {
            let (mut ty, mut len, mut data) = (0, 0usize, ptr::null_mut::<c_void>());
            check(unsafe {
                sys::napi_get_typedarray_info(
                    self.env,
                    v,
                    &mut ty,
                    &mut len,
                    &mut data,
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            })?;
            let width = match ty {
                sys::TypedarrayType::int8_array
                | sys::TypedarrayType::uint8_array
                | sys::TypedarrayType::uint8_clamped_array => 1,
                sys::TypedarrayType::int16_array | sys::TypedarrayType::uint16_array => 2,
                sys::TypedarrayType::int32_array
                | sys::TypedarrayType::uint32_array
                | sys::TypedarrayType::float32_array => 4,
                sys::TypedarrayType::float64_array
                | sys::TypedarrayType::bigint64_array
                | sys::TypedarrayType::biguint64_array => 8,
                // Float16Array (napi 11). Any kind newer than that is refused rather than sized
                // through its JS `byteLength`: reading a property runs JS, and JS can close the
                // database mid-bind (the use-after-free this module guards against).
                11 => 2,
                _ => return Ok(None),
            };
            return Ok(Some(slice(data, len * width)));
        }
        check(unsafe { sys::napi_is_dataview(self.env, v, &mut is) })?;
        if is {
            let (mut len, mut data) = (0usize, ptr::null_mut::<c_void>());
            check(unsafe {
                sys::napi_get_dataview_info(
                    self.env,
                    v,
                    &mut len,
                    &mut data,
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            })?;
            return Ok(Some(slice(data, len)));
        }
        Ok(None)
    }
}

fn slice<'a>(data: *mut c_void, len: usize) -> &'a [u8] {
    if len == 0 || data.is_null() {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(data.cast::<u8>(), len) }
    }
}

impl SqliteStatement {
    /// `(db, stmt)` for a call, in node's order of checks.
    fn handles(&self) -> napi::Result<(*mut ffi::sqlite3, *mut ffi::sqlite3_stmt)> {
        let st = self.state.borrow();
        let handle = match st.stmts.get(&self.id) {
            Some(s) if !s.handle.is_null() => s.handle,
            _ => return Err(invalid_state("statement has been finalized")),
        };
        Ok((st.handle()?, handle))
    }

    /// After any call that can run JS: is `stmt` still this statement's live handle? A getter or a
    /// Proxy trap in the named-parameter object can call `db.close()`, which finalizes every
    /// statement; continuing with the old pointer would be a use-after-free, not an exception.
    fn still_live(&self, stmt: *mut ffi::sqlite3_stmt) -> napi::Result<()> {
        match self.handles() {
            Ok((_, current)) if current == stmt => Ok(()),
            Ok(_) => Err(invalid_state("statement has been finalized")),
            Err(e) => Err(e),
        }
    }

    /// `StatementSync::BindParams`.
    fn bind(
        &self,
        js: &Js,
        db: *mut ffi::sqlite3,
        stmt: *mut ffi::sqlite3_stmt,
        named: Option<Unknown<'_>>,
        positional: &[Unknown<'_>],
    ) -> napi::Result<()> {
        if unsafe { ffi::sqlite3_clear_bindings(stmt) } != ffi::SQLITE_OK {
            return Err(sqlite_error(db));
        }
        if let Some(obj) = named {
            self.bind_named(js, db, stmt, obj.value().value)?;
        }
        let mut anon: c_int = 1;
        for v in positional {
            // Skip the slots that have a NAME (`$a`, `:a`, `@a`); `?NNN` is positional, so it is
            // filled in order like a bare `?`.
            while is_named_slot(stmt, anon) {
                anon += 1;
            }
            bind_value(js, db, stmt, anon, v.value().value)?;
            anon += 1;
        }
        Ok(())
    }

    fn bind_named(
        &self,
        js: &Js,
        db: *mut ffi::sqlite3,
        stmt: *mut ffi::sqlite3_stmt,
        obj: sys::napi_value,
    ) -> napi::Result<()> {
        self.ensure_bare_names(stmt)?;
        let mut keys = ptr::null_mut();
        check(unsafe {
            sys::napi_get_all_property_names(
                js.env,
                obj,
                sys::KeyCollectionMode::own_only,
                sys::KeyFilter::enumerable | sys::KeyFilter::skip_symbols,
                sys::KeyConversion::numbers_to_strings,
                &mut keys,
            )
        })?;
        // A Proxy's ownKeys trap is JS, and JS can close the database under us.
        self.still_live(stmt)?;
        let mut n = 0u32;
        check(unsafe { sys::napi_get_array_length(js.env, keys, &mut n) })?;
        for i in 0..n {
            let mut key = ptr::null_mut();
            check(unsafe { sys::napi_get_element(js.env, keys, i, &mut key) })?;
            let name = js.with_utf8(key, <[u8]>::to_vec)?;
            let cname = CString::new(name.clone()).unwrap_or_default();
            let mut index = unsafe { ffi::sqlite3_bind_parameter_index(stmt, cname.as_ptr()) };
            if index == 0 {
                let st = self.state.borrow();
                let full = st
                    .stmts
                    .get(&self.id)
                    .and_then(|s| s.bare_names.as_ref())
                    .and_then(|m| m.get(&*String::from_utf8_lossy(&name)).cloned());
                drop(st);
                if let Some(full) = full {
                    let cfull = CString::new(full).unwrap_or_default();
                    index = unsafe { ffi::sqlite3_bind_parameter_index(stmt, cfull.as_ptr()) };
                }
                if index == 0 {
                    return Err(invalid_state(&format!(
                        "Unknown named parameter '{}'",
                        String::from_utf8_lossy(&name)
                    )));
                }
            }
            let mut value = ptr::null_mut();
            check(unsafe { sys::napi_get_property(js.env, obj, key, &mut value) })?;
            // So is a getter — the statement may have been finalized by the time it returns.
            self.still_live(stmt)?;
            bind_value(js, db, stmt, index, value)?;
        }
        Ok(())
    }

    fn ensure_bare_names(&self, stmt: *mut ffi::sqlite3_stmt) -> napi::Result<()> {
        let mut st = self.state.borrow_mut();
        let Some(s) = st.stmts.get_mut(&self.id) else {
            return Ok(());
        };
        if s.bare_names.is_some() {
            return Ok(());
        }
        let map = s.bare_names.insert(HashMap::new());
        let count = unsafe { ffi::sqlite3_bind_parameter_count(stmt) };
        for i in 1..=count {
            let p = unsafe { ffi::sqlite3_bind_parameter_name(stmt, i) };
            if p.is_null() {
                continue;
            }
            let full = unsafe { c_text(p) };
            let bare = full.chars().skip(1).collect::<String>();
            match map.get(&bare) {
                None => {
                    map.insert(bare, full);
                }
                Some(existing) if *existing != full => {
                    return Err(invalid_state(&format!(
                        "Cannot create bare named parameter '{bare}' because of conflicting names '{existing}' and '{full}'."
                    )));
                }
                Some(_) => {}
            }
        }
        Ok(())
    }
}

fn is_named_slot(stmt: *mut ffi::sqlite3_stmt, index: c_int) -> bool {
    let p = unsafe { ffi::sqlite3_bind_parameter_name(stmt, index) };
    !p.is_null() && unsafe { *p } as u8 != b'?'
}

/// `StatementSync::BindValue`.
fn bind_value(
    js: &Js,
    db: *mut ffi::sqlite3,
    stmt: *mut ffi::sqlite3_stmt,
    index: c_int,
    v: sys::napi_value,
) -> napi::Result<()> {
    let r = match js.type_of(v)? {
        sys::ValueType::napi_number => {
            let mut d = 0f64;
            check(unsafe { sys::napi_get_value_double(js.env, v, &mut d) })?;
            unsafe { ffi::sqlite3_bind_double(stmt, index, d) }
        }
        sys::ValueType::napi_string => {
            js.with_utf8(v, |s| unsafe {
                // TRANSIENT: SQLite copies, so the scratch buffer is free again on return.
                ffi::sqlite3_bind_text(
                    stmt,
                    index,
                    s.as_ptr().cast(),
                    s.len() as c_int,
                    ffi::SQLITE_TRANSIENT(),
                )
            })?
        }
        sys::ValueType::napi_null => unsafe { ffi::sqlite3_bind_null(stmt, index) },
        // Node 24.21 binds a boolean as INTEGER 0/1; 24.18 refused it. The newer behaviour is the
        // one pinned (see PINNED in sqlite-compat-parity.test.ts).
        sys::ValueType::napi_boolean => {
            let mut b = false;
            check(unsafe { sys::napi_get_value_bool(js.env, v, &mut b) })?;
            unsafe { ffi::sqlite3_bind_int(stmt, index, c_int::from(b)) }
        }
        sys::ValueType::napi_bigint => {
            let (mut n, mut lossless) = (0i64, false);
            check(unsafe { sys::napi_get_value_bigint_int64(js.env, v, &mut n, &mut lossless) })?;
            if !lossless {
                return Err(node_error(
                    "ERR_INVALID_ARG_VALUE",
                    "BigInt value is too large to bind.",
                ));
            }
            unsafe { ffi::sqlite3_bind_int64(stmt, index, n) }
        }
        sys::ValueType::napi_object => match js.view_bytes(v)? {
            Some(bytes) => unsafe {
                ffi::sqlite3_bind_blob(
                    stmt,
                    index,
                    bytes.as_ptr().cast(),
                    bytes.len() as c_int,
                    ffi::SQLITE_TRANSIENT(),
                )
            },
            None => return Err(cannot_bind(index)),
        },
        _ => return Err(cannot_bind(index)),
    };
    if r != ffi::SQLITE_OK {
        return Err(sqlite_error(db));
    }
    Ok(())
}

fn cannot_bind(index: c_int) -> napi::Error {
    node_error(
        "ERR_INVALID_ARG_TYPE",
        &format!("Provided value cannot be bound to SQLite parameter {index}."),
    )
}

/// Column names, created once per call rather than once per row.
fn column_keys(js: &Js, stmt: *mut ffi::sqlite3_stmt) -> napi::Result<Vec<sys::napi_value>> {
    let n = unsafe { ffi::sqlite3_column_count(stmt) };
    (0..n)
        .map(|i| {
            let p = unsafe { ffi::sqlite3_column_name(stmt, i) };
            let bytes = if p.is_null() {
                &[][..]
            } else {
                unsafe { CStr::from_ptr(p) }.to_bytes()
            };
            js.string(bytes)
        })
        .collect()
}

/// `StatementSync::ColumnToValue`.
fn column_value(js: &Js, stmt: *mut ffi::sqlite3_stmt, i: c_int) -> napi::Result<sys::napi_value> {
    unsafe {
        match ffi::sqlite3_column_type(stmt, i) {
            ffi::SQLITE_INTEGER => {
                let n = ffi::sqlite3_column_int64(stmt, i);
                if n.unsigned_abs() > MAX_SAFE_INTEGER as u64 {
                    return Err(node_error(
                        "ERR_OUT_OF_RANGE",
                        &format!(
                            "Value is too large to be represented as a JavaScript number: {n}"
                        ),
                    ));
                }
                js.double(n as f64)
            }
            ffi::SQLITE_FLOAT => js.double(ffi::sqlite3_column_double(stmt, i)),
            ffi::SQLITE_TEXT => {
                let p = ffi::sqlite3_column_text(stmt, i);
                let len = ffi::sqlite3_column_bytes(stmt, i) as usize;
                js.string(slice(p as *mut c_void, len))
            }
            ffi::SQLITE_BLOB => {
                let p = ffi::sqlite3_column_blob(stmt, i);
                let len = ffi::sqlite3_column_bytes(stmt, i) as usize;
                let mut data = ptr::null_mut::<c_void>();
                let mut ab = ptr::null_mut();
                check(sys::napi_create_arraybuffer(
                    js.env, len, &mut data, &mut ab,
                ))?;
                if len > 0 {
                    ptr::copy_nonoverlapping(p.cast::<u8>(), data.cast::<u8>(), len);
                }
                let mut out = ptr::null_mut();
                check(sys::napi_create_typedarray(
                    js.env,
                    sys::TypedarrayType::uint8_array,
                    len,
                    ab,
                    0,
                    &mut out,
                ))?;
                Ok(out)
            }
            _ => js.null(),
        }
    }
}

/// Builds each row with ONE call into JS: a factory the facade compiles per column list,
/// `(v0, v1, …) => ({ __proto__: null, "id": v0, … })`. Node builds rows with V8's
/// `Object::New(proto, names, values, n)`, which napi does not expose; per-column `napi_set_property`
/// crossed the boundary for every value and made a full index load 1.8x slower than node's (1,100 vs
/// 620 ms, 455k rows), and `Object.create(null)` + one `napi_define_properties` was still 1.6x.
struct RowBuilder {
    factory: sys::napi_value,
    width: usize,
}

impl RowBuilder {
    /// `make_factory(names)` returns the row constructor for these columns (the facade caches them).
    fn new(
        js: &Js,
        stmt: *mut ffi::sqlite3_stmt,
        make_factory: sys::napi_value,
    ) -> napi::Result<Self> {
        let keys = column_keys(js, stmt)?;
        let mut names = ptr::null_mut();
        check(unsafe { sys::napi_create_array_with_length(js.env, keys.len(), &mut names) })?;
        for (i, k) in keys.iter().enumerate() {
            check(unsafe { sys::napi_set_element(js.env, names, i as u32, *k) })?;
        }
        let undefined = js.undefined()?;
        let mut factory = ptr::null_mut();
        check(unsafe {
            sys::napi_call_function(js.env, undefined, make_factory, 1, &names, &mut factory)
        })?;
        Ok(RowBuilder {
            factory,
            width: keys.len(),
        })
    }

    fn row(
        &self,
        js: &Js,
        stmt: *mut ffi::sqlite3_stmt,
        values: &mut Vec<sys::napi_value>,
    ) -> napi::Result<sys::napi_value> {
        // Values first, as node does: a column that throws (an integer past 2^53) leaves no object.
        values.clear();
        for i in 0..self.width {
            values.push(column_value(js, stmt, i as c_int)?);
        }
        let undefined = js.undefined()?;
        let mut row = ptr::null_mut();
        check(unsafe {
            sys::napi_call_function(
                js.env,
                undefined,
                self.factory,
                values.len(),
                values.as_ptr(),
                &mut row,
            )
        })?;
        Ok(row)
    }
}

#[napi]
impl SqliteStatement {
    #[napi]
    pub fn get(
        &self,
        env: Env,
        named: Option<Unknown<'_>>,
        positional: Vec<Unknown<'_>>,
        make_row: Unknown<'_>,
    ) -> napi::Result<Raw> {
        let (db, stmt) = self.handles()?;
        let js = Js { env: env.raw() };
        let _reset = ResetGuard(self, stmt);
        self.bind(&js, db, stmt, named, &positional)?;
        match unsafe { ffi::sqlite3_step(stmt) } {
            ffi::SQLITE_ROW => {
                let builder = RowBuilder::new(&js, stmt, make_row.value().value)?;
                Ok(Raw(builder.row(&js, stmt, &mut Vec::new())?))
            }
            ffi::SQLITE_DONE => Ok(Raw(js.undefined()?)),
            _ => Err(sqlite_error(db)),
        }
    }

    #[napi]
    pub fn all(
        &self,
        env: Env,
        named: Option<Unknown<'_>>,
        positional: Vec<Unknown<'_>>,
        make_row: Unknown<'_>,
    ) -> napi::Result<Raw> {
        let (db, stmt) = self.handles()?;
        let js = Js { env: env.raw() };
        let _reset = ResetGuard(self, stmt);
        self.bind(&js, db, stmt, named, &positional)?;
        // Column names are read after the first step, as node does: a step can re-prepare the
        // statement after a schema change, and `SELECT *` then has different columns.
        let mut builder: Option<RowBuilder> = None;
        let mut values = Vec::new();
        let mut rows = Vec::new();
        loop {
            match unsafe { ffi::sqlite3_step(stmt) } {
                ffi::SQLITE_ROW => {
                    let b = match builder.as_ref() {
                        Some(b) => b,
                        None => builder.insert(RowBuilder::new(&js, stmt, make_row.value().value)?),
                    };
                    rows.push(b.row(&js, stmt, &mut values)?);
                }
                ffi::SQLITE_DONE => break,
                _ => return Err(sqlite_error(db)),
            }
        }
        let mut arr = ptr::null_mut();
        check(unsafe { sys::napi_create_array_with_length(js.env, rows.len(), &mut arr) })?;
        for (i, r) in rows.into_iter().enumerate() {
            check(unsafe { sys::napi_set_element(js.env, arr, i as u32, r) })?;
        }
        Ok(Raw(arr))
    }

    /// One step, then reset — node's `Run`. The error, if any, is the reset's.
    #[napi]
    pub fn run(
        &self,
        env: Env,
        named: Option<Unknown<'_>>,
        positional: Vec<Unknown<'_>>,
    ) -> napi::Result<Raw> {
        let (db, stmt) = self.handles()?;
        let js = Js { env: env.raw() };
        {
            let _reset = ResetGuard(self, stmt);
            self.bind(&js, db, stmt, named, &positional)?;
        }
        unsafe { ffi::sqlite3_step(stmt) };
        if unsafe { ffi::sqlite3_reset(stmt) } != ffi::SQLITE_OK {
            return Err(sqlite_error(db));
        }
        let changes = unsafe { ffi::sqlite3_changes64(db) };
        let rowid = unsafe { ffi::sqlite3_last_insert_rowid(db) };
        let mut out = ptr::null_mut();
        check(unsafe { sys::napi_create_object(js.env, &mut out) })?;
        for (key, n) in [(c"changes", changes), (c"lastInsertRowid", rowid)] {
            let v = js.double(n as f64)?;
            check(unsafe { sys::napi_set_named_property(js.env, out, key.as_ptr(), v) })?;
        }
        Ok(Raw(out))
    }
}
