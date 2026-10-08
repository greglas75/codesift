//! Times the Rust half of a native read on a real index, without Node:
//!   cargo run --release -p codesift-core --example time_find -- <db> [kind]
//! The difference between this and the JS-side `findSymbols` time is the string handoff to V8;
//! the `sql only` line is the floor — SQLite stepping the same rows with no JSON at all.
use std::path::Path;
use std::time::Instant;

use codesift_core::store::{find_symbols_json, SymbolQuery};
use rusqlite::Connection;

fn main() {
    let db = std::env::args()
        .nth(1)
        .expect("usage: time_find <db> [kind]");
    let kind = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "function".to_string());
    for with_source in [true, false] {
        let q = SymbolQuery {
            with_source,
            kind: Some(kind.clone()),
            ..Default::default()
        };
        let mut best = u128::MAX;
        let mut bytes = 0;
        for _ in 0..3 {
            let t = Instant::now();
            let chunks = find_symbols_json(Path::new(&db), &q).unwrap();
            best = best.min(t.elapsed().as_millis());
            bytes = chunks.iter().map(String::len).sum::<usize>();
        }
        println!(
            "with_source={with_source}: {best} ms, {} MB",
            bytes / 1_000_000
        );
    }
    let conn = Connection::open(&db).unwrap();
    let mut best = u128::MAX;
    for _ in 0..3 {
        let t = Instant::now();
        let mut stmt = conn
            .prepare("SELECT * FROM symbols WHERE kind = ?")
            .unwrap();
        let cols = stmt.column_count();
        let mut rows = stmt.query([&kind]).unwrap();
        let mut touched = 0usize;
        while let Some(row) = rows.next().unwrap() {
            for i in 0..cols {
                if let rusqlite::types::ValueRef::Text(t) = row.get_ref(i).unwrap() {
                    touched += t.len();
                }
            }
        }
        best = best.min(t.elapsed().as_millis());
        std::hint::black_box(touched);
    }
    println!("sql only (with source): {best} ms");
}
