//! Node-API surface of the CodeSift core. Thin by rule: conversion in, call into
//! `codesift_core`, conversion out. Any logic that grows here is logic `cargo test` cannot reach.

mod sqlite_compat;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use codesift_core::bm25;
use codesift_core::store::{self, StoreError, SymbolQuery};
use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Status, Task};
use napi_derive::napi;

/// Version of the loaded core crate.
#[napi]
pub fn version() -> String {
    codesift_core::version().to_string()
}

/// See `codesift_core::ABI_VERSION`. Exported to JS as `abiVersion`.
#[napi]
pub fn abi_version() -> u32 {
    codesift_core::ABI_VERSION
}

/// The message carries `[sqlite:<extended code>]` when SQLite produced the failure; the JS facade
/// turns that back into the `errcode` the shared classifier reads.
fn to_napi(err: StoreError) -> napi::Error {
    napi::Error::new(Status::GenericFailure, err.to_string())
}

/// `SymbolQuery` from queries.ts; napi maps the snake_case fields to its camelCase keys.
#[napi(object)]
pub struct SymbolQueryJs {
    pub with_source: bool,
    pub file: Option<String>,
    pub name: Option<String>,
    pub name_prefix: Option<String>,
    pub kind: Option<String>,
    pub parent: Option<String>,
    pub ids: Option<Vec<String>>,
    pub limit: Option<i64>,
    pub kinds: Option<Vec<String>>,
    pub names: Option<Vec<String>>,
    pub source_contains_any: Option<Vec<String>>,
    pub min_lines: Option<i64>,
    pub file_suffix_any: Option<Vec<String>>,
}

impl From<SymbolQueryJs> for SymbolQuery {
    fn from(q: SymbolQueryJs) -> Self {
        SymbolQuery {
            with_source: q.with_source,
            file: q.file,
            name: q.name,
            name_prefix: q.name_prefix,
            kind: q.kind,
            parent: q.parent,
            ids: q.ids,
            limit: q.limit,
            kinds: q.kinds,
            names: q.names,
            source_contains_any: q.source_contains_any,
            min_lines: q.min_lines,
            file_suffix_any: q.file_suffix_any,
        }
    }
}

pub struct FindSymbolsTask {
    db_path: PathBuf,
    query: SymbolQuery,
}

impl Task for FindSymbolsTask {
    type Output = Vec<String>;
    type JsValue = Vec<String>;

    fn compute(&mut self) -> napi::Result<Vec<String>> {
        store::find_symbols_json(&self.db_path, &self.query).map_err(to_napi)
    }

    fn resolve(&mut self, _env: Env, output: Vec<String>) -> napi::Result<Vec<String>> {
        Ok(output)
    }
}

/// Matching symbols as JSON arrays to concatenate in order (`store::CHUNK_BYTES`), computed on
/// the libuv thread pool.
#[napi]
pub fn find_symbols(db_path: String, query: SymbolQueryJs) -> AsyncTask<FindSymbolsTask> {
    AsyncTask::new(FindSymbolsTask {
        db_path: PathBuf::from(db_path),
        query: query.into(),
    })
}

#[napi(object)]
pub struct IndexMetaJs {
    pub repo: String,
    pub root: String,
    pub updated_at: Option<String>,
    pub symbol_count: i64,
    pub file_count: i64,
}

pub struct IndexMetaTask {
    db_path: PathBuf,
}

impl Task for IndexMetaTask {
    type Output = Option<store::IndexMeta>;
    type JsValue = Option<IndexMetaJs>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        store::index_meta(&self.db_path).map_err(to_napi)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output.map(|m| IndexMetaJs {
            repo: m.repo,
            root: m.root,
            updated_at: m.updated_at,
            symbol_count: m.symbol_count,
            file_count: m.file_count,
        }))
    }
}

/// Repo, root and counts, or `null` when the database holds no index.
#[napi]
pub fn index_meta(db_path: String) -> AsyncTask<IndexMetaTask> {
    AsyncTask::new(IndexMetaTask {
        db_path: PathBuf::from(db_path),
    })
}

/// A read snapshot held across pages (see `store::Snapshot`). The connection lives behind a mutex
/// because each page is fetched on a pool thread; `close` (or GC) ends the read transaction.
#[napi]
pub struct SymbolSnapshot {
    inner: Arc<Mutex<Option<store::Snapshot>>>,
    repo: Option<String>,
}

#[napi]
impl SymbolSnapshot {
    /// The index's repo, or `null` when the database holds no index.
    #[napi(getter)]
    pub fn repo(&self) -> Option<String> {
        self.repo.clone()
    }

    /// One page, fetched on the libuv pool.
    #[napi]
    pub fn page(
        &self,
        query: SymbolQueryJs,
        id_chunk: Option<Vec<String>>,
        after_rowid: i64,
        rows: i64,
    ) -> AsyncTask<PageTask> {
        AsyncTask::new(PageTask {
            inner: Arc::clone(&self.inner),
            query: query.into(),
            id_chunk,
            after_rowid,
            rows,
        })
    }

    /// End the read transaction now rather than at garbage collection.
    #[napi]
    pub fn close(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.take();
        }
    }
}

pub struct OpenSnapshotTask {
    db_path: PathBuf,
}

impl Task for OpenSnapshotTask {
    type Output = store::Snapshot;
    type JsValue = SymbolSnapshot;

    fn compute(&mut self) -> napi::Result<store::Snapshot> {
        store::Snapshot::open(&self.db_path).map_err(to_napi)
    }

    fn resolve(&mut self, _env: Env, output: store::Snapshot) -> napi::Result<SymbolSnapshot> {
        let repo = output.repo().map(str::to_string);
        Ok(SymbolSnapshot {
            inner: Arc::new(Mutex::new(Some(output))),
            repo,
        })
    }
}

/// Open a read snapshot of the index for paged reading.
#[napi]
pub fn open_snapshot(db_path: String) -> AsyncTask<OpenSnapshotTask> {
    AsyncTask::new(OpenSnapshotTask {
        db_path: PathBuf::from(db_path),
    })
}

#[napi(object)]
pub struct PageJs {
    pub json: String,
    pub count: i64,
    pub last_rowid: Option<i64>,
}

pub struct PageTask {
    inner: Arc<Mutex<Option<store::Snapshot>>>,
    query: SymbolQuery,
    id_chunk: Option<Vec<String>>,
    after_rowid: i64,
    rows: i64,
}

impl Task for PageTask {
    type Output = store::Page;
    type JsValue = PageJs;

    fn compute(&mut self) -> napi::Result<store::Page> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| napi::Error::new(Status::GenericFailure, "snapshot lock poisoned"))?;
        let Some(snap) = guard.as_ref() else {
            return Err(napi::Error::new(
                Status::GenericFailure,
                "snapshot already closed",
            ));
        };
        snap.page(
            &self.query,
            self.id_chunk.as_deref(),
            self.after_rowid,
            self.rows,
        )
        .map_err(to_napi)
    }

    fn resolve(&mut self, _env: Env, p: store::Page) -> napi::Result<PageJs> {
        Ok(PageJs {
            json: p.json,
            count: p.count,
            last_rowid: p.last_rowid,
        })
    }
}

// ---------------------------------------------------------------------------------------------
// BM25 (ADR-006 stage 2)
// ---------------------------------------------------------------------------------------------

/// The `CodeSymbol` fields BM25 reads. JS passes its symbol objects as they are; napi reads only
/// these keys.
#[napi(object)]
pub struct Bm25SymbolJs {
    pub id: String,
    pub file: String,
    pub name: String,
    pub signature: Option<String>,
    pub docstring: Option<String>,
    pub source: Option<String>,
}

impl From<Bm25SymbolJs> for bm25::SymbolInput {
    fn from(s: Bm25SymbolJs) -> Self {
        bm25::SymbolInput {
            id: s.id,
            file: s.file,
            name: s.name,
            signature: s.signature,
            docstring: s.docstring,
            source: s.source,
        }
    }
}

#[napi(object)]
pub struct Bm25HitJs {
    pub id: String,
    pub score: f64,
    pub matches: Vec<String>,
}

/// A BM25 index held in Rust memory, outside the V8 heap. Ingestion is driven in batches by the JS
/// builder: `ingestAsync` tokenises a batch in parallel off the main thread (only converting the
/// symbols' strings in happens on it); a search over the postings is milliseconds and stays sync.
#[napi]
pub struct NativeBm25 {
    inner: Arc<Mutex<bm25::Bm25>>,
}

fn lock(m: &Mutex<bm25::Bm25>) -> napi::Result<std::sync::MutexGuard<'_, bm25::Bm25>> {
    m.lock()
        .map_err(|_| napi::Error::new(Status::GenericFailure, "bm25 lock poisoned"))
}

pub struct IngestTask {
    inner: Arc<Mutex<bm25::Bm25>>,
    batch: Vec<bm25::SymbolInput>,
}

impl Task for IngestTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<()> {
        let prepared = codesift_core::bm25::prepare_batch(&self.batch);
        lock(&self.inner)?.ingest_build_prepared(prepared);
        Ok(())
    }

    fn resolve(&mut self, _env: Env, _out: ()) -> napi::Result<()> {
        Ok(())
    }
}

#[napi]
impl NativeBm25 {
    #[napi(constructor)]
    pub fn new() -> Self {
        NativeBm25 {
            inner: Arc::new(Mutex::new(bm25::Bm25::new())),
        }
    }

    /// One batch of a build, in order, on the main thread.
    #[napi]
    pub fn ingest(&self, symbols: Vec<Bm25SymbolJs>) -> napi::Result<()> {
        let batch: Vec<bm25::SymbolInput> = symbols.into_iter().map(Into::into).collect();
        lock(&self.inner)?.ingest_build(&batch);
        Ok(())
    }

    /// One batch of a build, tokenised off the main thread. Batches must be awaited in order.
    #[napi]
    pub fn ingest_async(&self, symbols: Vec<Bm25SymbolJs>) -> AsyncTask<IngestTask> {
        AsyncTask::new(IngestTask {
            inner: Arc::clone(&self.inner),
            batch: symbols.into_iter().map(Into::into).collect(),
        })
    }

    /// End of a build: resolves import centrality over every file seen.
    #[napi]
    pub fn finish(&self) -> napi::Result<()> {
        lock(&self.inner)?.finish();
        Ok(())
    }

    /// `weights` in field order: name, signature, docstring, body, comments.
    #[napi]
    pub fn search(
        &self,
        query: String,
        top_k: u32,
        weights: Vec<f64>,
    ) -> napi::Result<Vec<Bm25HitJs>> {
        let w: [f64; bm25::FIELD_COUNT] = weights.try_into().map_err(|_| {
            napi::Error::new(Status::InvalidArg, "weights must have exactly 5 entries")
        })?;
        Ok(lock(&self.inner)?
            .search(&query, top_k as usize, &w)
            .into_iter()
            .map(|h| Bm25HitJs {
                id: h.id,
                score: h.score,
                matches: h.matches,
            })
            .collect())
    }

    #[napi]
    pub fn update_file(&self, file: String, symbols: Vec<Bm25SymbolJs>) -> napi::Result<()> {
        let batch: Vec<bm25::SymbolInput> = symbols.into_iter().map(Into::into).collect();
        lock(&self.inner)?.update_file(&file, &batch);
        Ok(())
    }

    /// `[file, score]` for every file with a non-zero import centrality.
    #[napi]
    pub fn centrality(&self) -> napi::Result<Vec<(String, f64)>> {
        Ok(lock(&self.inner)?.centrality_entries())
    }

    #[napi(getter)]
    pub fn doc_count(&self) -> napi::Result<i64> {
        Ok(lock(&self.inner)?.doc_count())
    }

    #[napi]
    pub fn footprint_bytes(&self) -> napi::Result<f64> {
        Ok(lock(&self.inner)?.footprint_bytes() as f64)
    }
}

impl Default for NativeBm25 {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------------------------
// Symbol extraction (ADR-006 stage 3)
// ---------------------------------------------------------------------------------------------

#[napi(object)]
pub struct ExtractedJs {
    /// The symbols as a JSON array, in `makeSymbol` key order.
    pub json: String,
    /// The tree had syntax errors (the TypeScript extractor logs a warning).
    pub has_error: bool,
    /// The parse ran past its budget; no symbols, as the TypeScript path's rejected race.
    pub timed_out: bool,
    /// Warnings the TypeScript extractor would have printed; the JS side prints them.
    pub warnings: Vec<String>,
}

/// Parse `source` and extract its symbols off the main thread — on tokio's blocking pool, so that
/// many files can be in flight at once without occupying libuv's four threads, which the indexer's
/// file reads need. `file` is the repo-relative path the symbol ids carry.
#[napi]
pub async fn extract_symbols(
    source: String,
    file: String,
    repo: String,
    language: String,
    timeout_ms: u32,
) -> napi::Result<ExtractedJs> {
    let lang = language.clone();
    let out = tokio::task::spawn_blocking(move || {
        codesift_core::extract::extract_to_json(
            &source,
            &file,
            &repo,
            &lang,
            std::time::Duration::from_millis(timeout_ms as u64),
        )
    })
    .await
    .map_err(|e| napi::Error::new(Status::GenericFailure, e.to_string()))?
    .ok_or_else(|| {
        napi::Error::new(
            Status::InvalidArg,
            format!("no native extractor for language {language:?}"),
        )
    })?;
    Ok(ExtractedJs {
        json: out.json,
        has_error: out.has_error,
        timed_out: out.timed_out,
        warnings: out.warnings,
    })
}

/// `extractTypeScriptImports` over a batch of `.ts`/`.tsx` sources (stage 4), parsed in parallel on
/// the extract pool: a JSON array with one entry per source, `null` where the parse failed.
#[napi]
pub async fn extract_ts_imports(
    sources: Vec<String>,
    tsx: Vec<bool>,
    timeout_ms: u32,
) -> napi::Result<String> {
    if sources.len() != tsx.len() {
        return Err(napi::Error::new(
            Status::InvalidArg,
            format!(
                "extractTsImports: {} sources but {} tsx flags",
                sources.len(),
                tsx.len()
            ),
        ));
    }
    tokio::task::spawn_blocking(move || {
        codesift_core::extract::imports::imports_batch_json(
            &sources,
            &tsx,
            std::time::Duration::from_millis(timeout_ms as u64),
        )
    })
    .await
    .map_err(|e| napi::Error::new(Status::GenericFailure, e.to_string()))
}

// ---------------------------------------------------------------------------------------------
// Whole-index write (ADR-006, the write half of stage 1)
// ---------------------------------------------------------------------------------------------

/// A `CodeSymbol` as the row writer reads it; JS passes its symbol objects plus the extras JSON.
/// `js_name` keeps the snake_case keys `CodeSymbol` actually has — `#[napi(object)]` would otherwise
/// look for camelCase ones and reject every symbol.
#[napi(object)]
pub struct SymbolRowJs {
    pub id: String,
    pub file: String,
    pub name: String,
    pub kind: String,
    #[napi(js_name = "start_line")]
    pub start_line: f64,
    #[napi(js_name = "end_line")]
    pub end_line: f64,
    #[napi(js_name = "start_col")]
    pub start_col: Option<f64>,
    #[napi(js_name = "end_col")]
    pub end_col: Option<f64>,
    #[napi(js_name = "start_byte")]
    pub start_byte: Option<f64>,
    #[napi(js_name = "end_byte")]
    pub end_byte: Option<f64>,
    pub signature: Option<String>,
    pub docstring: Option<String>,
    pub source: Option<String>,
    pub parent: Option<String>,
    #[napi(js_name = "is_async")]
    pub is_async: Option<bool>,
    #[napi(js_name = "is_exported")]
    pub is_exported: Option<bool>,
}

#[napi(object)]
pub struct FileRowJs {
    pub path: String,
    pub language: String,
    #[napi(js_name = "symbol_count")]
    pub symbol_count: f64,
    #[napi(js_name = "last_modified")]
    pub last_modified: f64,
    #[napi(js_name = "mtime_ms")]
    pub mtime_ms: Option<f64>,
    pub stale: Option<bool>,
}

#[napi(object)]
pub struct MetaEntryJs {
    pub key: String,
    pub value: String,
}

type SharedWriter = Arc<Mutex<Option<store::Writer>>>;

fn with_writer<T>(
    w: &SharedWriter,
    f: impl FnOnce(&store::Writer) -> Result<T, StoreError>,
) -> napi::Result<T> {
    let guard = w
        .lock()
        .map_err(|_| napi::Error::new(Status::GenericFailure, "writer lock poisoned"))?;
    let writer = guard
        .as_ref()
        .ok_or_else(|| napi::Error::new(Status::GenericFailure, "index writer already finished"))?;
    f(writer).map_err(to_napi)
}

/// A whole-index replacement in progress. Rows are inserted off the main thread; `commit` finishes
/// it, `rollback` (or garbage collection) abandons it and leaves the previous index untouched.
#[napi]
pub struct IndexWriter {
    inner: SharedWriter,
}

pub struct BeginWriteTask {
    db_path: PathBuf,
}

impl Task for BeginWriteTask {
    type Output = store::Writer;
    type JsValue = IndexWriter;

    fn compute(&mut self) -> napi::Result<store::Writer> {
        store::Writer::begin(&self.db_path).map_err(to_napi)
    }

    fn resolve(&mut self, _env: Env, w: store::Writer) -> napi::Result<IndexWriter> {
        Ok(IndexWriter {
            inner: Arc::new(Mutex::new(Some(w))),
        })
    }
}

/// Open a write transaction that replaces the whole index (DELETE then insert).
#[napi]
pub fn begin_index_write(db_path: String) -> AsyncTask<BeginWriteTask> {
    AsyncTask::new(BeginWriteTask {
        db_path: PathBuf::from(db_path),
    })
}

pub struct InsertSymbolsTask {
    inner: SharedWriter,
    rows: Vec<store::SymbolRowIn>,
}

impl Task for InsertSymbolsTask {
    type Output = ();
    type JsValue = ();
    fn compute(&mut self) -> napi::Result<()> {
        with_writer(&self.inner, |w| w.insert_symbols(&self.rows))
    }
    fn resolve(&mut self, _env: Env, _o: ()) -> napi::Result<()> {
        Ok(())
    }
}

pub struct InsertFilesTask {
    inner: SharedWriter,
    rows: Vec<store::FileRowIn>,
}

impl Task for InsertFilesTask {
    type Output = ();
    type JsValue = ();
    fn compute(&mut self) -> napi::Result<()> {
        with_writer(&self.inner, |w| w.insert_files(&self.rows))
    }
    fn resolve(&mut self, _env: Env, _o: ()) -> napi::Result<()> {
        Ok(())
    }
}

pub struct CommitTask {
    inner: SharedWriter,
    meta: Vec<(String, String)>,
    source_complete: bool,
}

impl Task for CommitTask {
    type Output = ();
    type JsValue = ();
    fn compute(&mut self) -> napi::Result<()> {
        let writer = self
            .inner
            .lock()
            .map_err(|_| napi::Error::new(Status::GenericFailure, "writer lock poisoned"))?
            .take()
            .ok_or_else(|| {
                napi::Error::new(Status::GenericFailure, "index writer already finished")
            })?;
        writer
            .commit(&self.meta, self.source_complete)
            .map_err(to_napi)
    }
    fn resolve(&mut self, _env: Env, _o: ()) -> napi::Result<()> {
        Ok(())
    }
}

#[napi]
impl IndexWriter {
    /// Insert symbol rows; `extras` holds each symbol's `JSON.stringify`ed extras (or null).
    #[napi]
    pub fn insert_symbols(
        &self,
        symbols: Vec<SymbolRowJs>,
        extras: Vec<Option<String>>,
    ) -> napi::Result<AsyncTask<InsertSymbolsTask>> {
        if symbols.len() != extras.len() {
            return Err(napi::Error::new(
                Status::InvalidArg,
                "symbols and extras differ in length",
            ));
        }
        let rows = symbols
            .into_iter()
            .zip(extras)
            .map(|(s, e)| store::SymbolRowIn {
                id: s.id,
                file: s.file,
                name: s.name,
                kind: s.kind,
                start_line: s.start_line,
                end_line: s.end_line,
                start_col: s.start_col,
                end_col: s.end_col,
                start_byte: s.start_byte,
                end_byte: s.end_byte,
                signature: s.signature,
                docstring: s.docstring,
                source: s.source,
                parent: s.parent,
                is_async: s.is_async,
                is_exported: s.is_exported,
                extras: e,
            })
            .collect();
        Ok(AsyncTask::new(InsertSymbolsTask {
            inner: Arc::clone(&self.inner),
            rows,
        }))
    }

    #[napi]
    pub fn insert_files(&self, files: Vec<FileRowJs>) -> AsyncTask<InsertFilesTask> {
        let rows = files
            .into_iter()
            .map(|f| store::FileRowIn {
                path: f.path,
                language: f.language,
                symbol_count: f.symbol_count,
                last_modified: f.last_modified,
                mtime_ms: f.mtime_ms,
                stale: f.stale,
            })
            .collect();
        AsyncTask::new(InsertFilesTask {
            inner: Arc::clone(&self.inner),
            rows,
        })
    }

    /// Write meta (in order), clear the lossy marker when `sourceComplete`, COMMIT.
    #[napi]
    pub fn commit(&self, meta: Vec<MetaEntryJs>, source_complete: bool) -> AsyncTask<CommitTask> {
        AsyncTask::new(CommitTask {
            inner: Arc::clone(&self.inner),
            meta: meta.into_iter().map(|m| (m.key, m.value)).collect(),
            source_complete,
        })
    }

    /// Abandon the write; the previous index stays as it was.
    #[napi]
    pub fn rollback(&self) {
        if let Ok(mut g) = self.inner.lock() {
            g.take();
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Call graph (stage 7)
// ---------------------------------------------------------------------------------------------

/// The call graph of one index (see `codesift_core::callgraph`). Node values are positions in rowid
/// order — `index.symbols` positions once the JS side has checked `idHash` against its array.
#[napi]
pub struct NativeCallGraph {
    /// `None` after `release()`. An evicted graph must free its memory when the JS cache drops it, not
    /// when V8 next collects the wrapper — V8 cannot see these bytes, so it has no reason to hurry, and
    /// a few evicted graphs are gigabytes. A task in flight keeps its own `Arc` until it finishes.
    inner: Mutex<Option<Arc<codesift_core::callgraph::CallGraph>>>,
}

impl NativeCallGraph {
    fn graph(&self) -> napi::Result<Arc<codesift_core::callgraph::CallGraph>> {
        self.inner
            .lock()
            .map_err(|_| napi::Error::new(Status::GenericFailure, "call graph lock poisoned"))?
            .clone()
            .ok_or_else(|| napi::Error::new(Status::GenericFailure, "call graph released"))
    }
}

#[napi]
impl NativeCallGraph {
    #[napi(getter)]
    pub fn node_count(&self) -> napi::Result<u32> {
        Ok(self.graph()?.node_count() as u32)
    }

    #[napi(getter)]
    pub fn edge_count(&self) -> napi::Result<f64> {
        Ok(self.graph()?.edge_count() as f64)
    }

    /// The two FNV-1a hashes of every id in node order (UTF-16 units, NUL-separated).
    #[napi]
    pub fn id_hash(&self) -> napi::Result<Vec<u32>> {
        let (a, b) = self.graph()?.id_hash();
        Ok(vec![a, b])
    }

    /// Node positions of the symbols `id` calls, or `null` (the TypeScript map has no entry).
    #[napi]
    pub fn callees(&self, id: String) -> napi::Result<Option<napi::bindgen_prelude::Uint32Array>> {
        Ok(self
            .graph()?
            .callees(&id)
            .map(|v| napi::bindgen_prelude::Uint32Array::new(v.to_vec())))
    }

    /// Node positions of the symbols that call `id`, or `null`.
    #[napi]
    pub fn callers(&self, id: String) -> napi::Result<Option<napi::bindgen_prelude::Uint32Array>> {
        Ok(self
            .graph()?
            .callers(&id)
            .map(|v| napi::bindgen_prelude::Uint32Array::new(v.to_vec())))
    }

    /// Resident bytes; 0 once released.
    #[napi]
    pub fn footprint_bytes(&self) -> f64 {
        self.graph().map_or(0.0, |g| g.footprint_bytes() as f64)
    }

    /// Drop the graph now (the JS cache calls this on eviction).
    #[napi]
    pub fn release(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.take();
        }
    }

    /// The ids of these node positions.
    #[napi]
    pub fn ids_at(
        &self,
        positions: napi::bindgen_prelude::Uint32Array,
    ) -> napi::Result<Vec<String>> {
        self.graph()?.ids_at(&positions).map_err(to_napi)
    }

    /// `[callers0, callees0, callers1, callees1, …]` list lengths for `ids`.
    #[napi]
    pub fn degrees(&self, ids: Vec<String>) -> napi::Result<napi::bindgen_prelude::Uint32Array> {
        Ok(napi::bindgen_prelude::Uint32Array::new(
            self.graph()?.degrees(&ids),
        ))
    }

    /// The symbols at these node positions, as JSON arrays to concatenate in order, read off the main
    /// thread from the database the graph was built from.
    #[napi]
    pub fn symbols_json(
        &self,
        positions: napi::bindgen_prelude::Uint32Array,
        with_source: bool,
    ) -> napi::Result<AsyncTask<GraphSymbolsTask>> {
        Ok(AsyncTask::new(GraphSymbolsTask {
            graph: self.graph()?,
            positions: positions.to_vec(),
            with_source,
        }))
    }
}

pub struct GraphSymbolsTask {
    graph: Arc<codesift_core::callgraph::CallGraph>,
    positions: Vec<u32>,
    with_source: bool,
}

impl Task for GraphSymbolsTask {
    type Output = Vec<String>;
    type JsValue = Vec<String>;

    fn compute(&mut self) -> napi::Result<Vec<String>> {
        self.graph
            .symbols_json(&self.positions, self.with_source)
            .map_err(to_napi)
    }

    fn resolve(&mut self, _env: Env, output: Vec<String>) -> napi::Result<Vec<String>> {
        Ok(output)
    }
}

pub struct BuildCallGraphTask {
    db_path: PathBuf,
    skip_tests: bool,
    filter_react_hooks: bool,
}

impl Task for BuildCallGraphTask {
    type Output = codesift_core::callgraph::CallGraph;
    type JsValue = NativeCallGraph;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        codesift_core::callgraph::CallGraph::build(
            &self.db_path,
            self.skip_tests,
            self.filter_react_hooks,
        )
        .map_err(to_napi)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<NativeCallGraph> {
        Ok(NativeCallGraph {
            inner: Mutex::new(Some(Arc::new(output))),
        })
    }
}

/// Build the call graph of an index off the main thread.
#[napi]
pub fn build_call_graph(
    db_path: String,
    skip_tests: bool,
    filter_react_hooks: bool,
) -> AsyncTask<BuildCallGraphTask> {
    AsyncTask::new(BuildCallGraphTask {
        db_path: PathBuf::from(db_path),
        skip_tests,
        filter_react_hooks,
    })
}
