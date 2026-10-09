//! CodeSift core — the parts of the server that are bounded by memory and I/O rather than by
//! tool logic: index storage, BM25, parsing (ADR-006). Nothing here knows about Node; the
//! `codesift-napi` crate is the only binding layer.

pub mod bm25;
pub mod callgraph;
pub mod extract;
pub mod store;

/// The raw C API of the SQLite copy `store` is built on. Re-exported so the binding layer's
/// `node:sqlite`-compatible class (`codesift-napi`'s `sqlite_compat`) links the SAME copy — one
/// SQLite per process for every index database is the safety condition of the native store.
pub use rusqlite::ffi as sqlite_ffi;

/// Shape version of the surface `codesift-napi` exposes to JS.
///
/// The loader (`src/native/index.ts`, `NATIVE_ABI`) refuses a binary whose number differs. A
/// stale `.node` left in `native/` by an older build would otherwise be loaded and called with
/// arguments it does not understand — the same failure as a daemon running replaced files, one
/// layer down. Bump it on ANY change to an exported function's name, arguments or result — and when
/// the set of languages `extractSymbols` accepts grows, since JS routes them by that set.
pub const ABI_VERSION: u32 = 17;

/// Version of this crate, so `/health` can say which core build is loaded.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_the_crate_version() {
        assert_eq!(version(), env!("CARGO_PKG_VERSION"));
        assert!(!version().is_empty());
    }
}
