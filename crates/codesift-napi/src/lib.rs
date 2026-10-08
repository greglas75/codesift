//! Node-API surface of the CodeSift core. Thin by rule: conversion in, call into
//! `codesift_core`, conversion out. Any logic that grows here is logic `cargo test` cannot reach.

use std::path::PathBuf;

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
