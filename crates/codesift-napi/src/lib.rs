//! Node-API surface of the CodeSift core. Thin by rule: conversion in, call into
//! `codesift_core`, conversion out. Any logic that grows here is logic `cargo test` cannot reach.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

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
