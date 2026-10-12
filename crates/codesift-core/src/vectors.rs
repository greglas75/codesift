//! Embedding vectors for semantic search (ADR-006 stage 11, plan
//! `docs/specs/2026-10-12-native-vectors-plan.md`).
//!
//! The TypeScript loader (`storage/embedding-store.ts` `loadEmbeddings`) parses each ndjson line with
//! `JSON.parse` into a `Float32Array` on the daemon's main thread, and refuses a file above 4× the
//! embedding budget — so an rdesigner worktree's 7.6 GB file (463k × 768) was never read at all and
//! semantic search there was BM25 in disguise. Here the same file is parsed in parallel into one
//! contiguous matrix outside the V8 heap.
//!
//! Everything a ranking depends on is reproduced exactly, so results are bit-identical to
//! `searchSemantic` (`search/semantic.ts`):
//! - floats: text → f64 (correctly rounded, serde_json `float_roundtrip`) → f32, as `JSON.parse` then
//!   `new Float32Array(...)` do;
//! - cosine: f64 accumulation in index order over the f32 values, `dot / (sqrt(na) * sqrt(nb))`, 0 for a
//!   zero norm — the TS loop's exact operations (no reassociation, so no SIMD reduction);
//! - order: a stable sort by score, descending, over load order — a `Map`'s insertion order, where a
//!   repeated id keeps its FIRST position and its LAST value.

use rayon::prelude::*;
use serde::Deserialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufReader, Read};
use std::path::Path;

use crate::bm25::is_test_file;

/// The binary vector file (`storage/vector-file.ts` documents the layout and is its writer).
pub const VEC_MAGIC: [u8; 8] = *b"CSVEC\0\0\x01";
const VEC_TRAILER: &[u8; 4] = b"CEND";
const VEC_ALIGN: usize = 64;

#[derive(Deserialize)]
struct VecHeader {
    dims: usize,
    count: usize,
}

fn invalid(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, format!("vector file: {msg}"))
}

/// A reader that checksums what it reads and counts the offset.
struct Hashed<R: Read> {
    inner: R,
    hasher: crc32fast::Hasher,
    offset: usize,
}

impl<R: Read> Hashed<R> {
    fn read_exact(&mut self, buf: &mut [u8]) -> io::Result<()> {
        self.inner.read_exact(buf).map_err(|e| {
            if e.kind() == io::ErrorKind::UnexpectedEof {
                invalid("truncated")
            } else {
                e
            }
        })?;
        self.hasher.update(buf);
        self.offset += buf.len();
        Ok(())
    }

    fn take(&mut self, n: usize) -> io::Result<Vec<u8>> {
        let mut buf = vec![0u8; n];
        self.read_exact(&mut buf)?;
        Ok(buf)
    }

    fn u32(&mut self) -> io::Result<u32> {
        let mut b = [0u8; 4];
        self.read_exact(&mut b)?;
        Ok(u32::from_le_bytes(b))
    }
}

/// A position with no file attached: never a search candidate.
const NO_FILE: u32 = u32::MAX;
/// Bytes read per round. Bounded so a 7.6 GB file never sits in memory whole; large enough that the
/// parallel parse of one block keeps every core busy.
const READ_BLOCK: usize = 64 << 20;

#[derive(Deserialize)]
struct Line {
    id: String,
    /// f64, then `as f32` below: serde's own f32 path rounds differently at the edges (it read the
    /// f32-overflow midpoint 3.4028235677973366e38 as f32::MAX; `Math.fround` and `as` give Infinity).
    vec: Vec<f64>,
    #[serde(default)]
    h: Option<f64>,
}

/// An id prefix rewrite applied on load (`EmbeddingMeta.id_rebase`: a worktree's clone of its donor's
/// file carries the donor's ids).
#[derive(Debug, Clone)]
pub struct Rebase {
    pub from: String,
    pub to: String,
}

#[derive(Default)]
pub struct Vectors {
    ids: Vec<String>,
    positions: HashMap<String, u32>,
    dims: usize,
    data: Vec<f32>,
    /// `sqrt(Σ b²)` per vector, summed in index order — the value the TS loop recomputes per query.
    norms: Vec<f64>,
    /// The content hash stored with each vector (`h`), for writers that persist it again.
    hashes: Vec<Option<u32>>,
    /// Per position, an index into `file_table`, or `NO_FILE`.
    files: Vec<u32>,
    file_table: Vec<String>,
    files_attached: bool,
    /// Lines whose vector width differs from the first — skipped, as both TS rankings skip them.
    skipped_width: usize,
    /// Lines that did not parse as `{id, vec}` — skipped, as the TS loader skips them.
    skipped_malformed: usize,
}

/// One parsed line: id (rebased), vector, content hash.
type Parsed = (String, Vec<f32>, Option<u32>);

pub struct Hit {
    pub id: String,
    pub score: f64,
}

fn parse_line(raw: &[u8], rebase: Option<&Rebase>) -> Option<Parsed> {
    let trimmed = raw.trim_ascii();
    if trimmed.is_empty() {
        return None;
    }
    let line: Line = serde_json::from_slice(trimmed).ok()?;
    if line.id.is_empty() {
        return None;
    }
    let id = match rebase {
        Some(r) if line.id.starts_with(&r.from) => format!("{}{}", r.to, &line.id[r.from.len()..]),
        _ => line.id,
    };
    // `h` is an FNV-1a hash `>>> 0`, so a u32; anything else is kept as "no hash".
    let h = line
        .h
        .filter(|v| v.fract() == 0.0 && *v >= 0.0 && *v <= f64::from(u32::MAX))
        .map(|v| v as u32);
    Some((id, line.vec.into_iter().map(|x| x as f32).collect(), h))
}

fn norm(v: &[f32]) -> f64 {
    let mut sum = 0.0f64;
    for &x in v {
        let x = f64::from(x);
        sum += x * x;
    }
    sum.sqrt()
}

impl Vectors {
    /// Either format, told apart by the first bytes: a vector file, else ndjson.
    pub fn load(path: &Path, rebase: Option<&Rebase>) -> io::Result<Vectors> {
        let mut magic = [0u8; 8];
        let n = File::open(path)?.read(&mut magic)?;
        if n == magic.len() && magic == VEC_MAGIC {
            Vectors::load_vec(path, rebase)
        } else {
            Vectors::load_ndjson(path, rebase)
        }
    }

    /// Read a vector file. A foreign, truncated or corrupt file is an error — the whole file, since
    /// one checksum cannot say which vector is wrong.
    pub fn load_vec(path: &Path, rebase: Option<&Rebase>) -> io::Result<Vectors> {
        let file = File::open(path)?;
        let size = file.metadata()?.len() as usize;
        let mut r = Hashed {
            inner: BufReader::with_capacity(READ_BLOCK, file),
            hasher: crc32fast::Hasher::new(),
            offset: 0,
        };
        let head = r.take(12)?;
        if head[..8] != VEC_MAGIC {
            return Err(invalid("not a vector file (magic)"));
        }
        let header_len = u32::from_le_bytes(head[8..12].try_into().unwrap()) as usize;
        if header_len > size {
            return Err(invalid("truncated"));
        }
        let header: VecHeader =
            serde_json::from_slice(&r.take(header_len)?).map_err(|_| invalid("bad header"))?;
        let (dims, count) = (header.dims, header.count);
        if count > size {
            return Err(invalid("bad header"));
        }
        let mut ids = Vec::with_capacity(count);
        for _ in 0..count {
            let len = r.u32()? as usize;
            if len > size {
                return Err(invalid("truncated"));
            }
            // Lossy like Buffer#toString("utf-8"), so both readers see the same id.
            ids.push(String::from_utf8_lossy(&r.take(len)?).into_owned());
        }
        let flags = r.take(count)?;
        let hashes = r.take(count * 4)?;
        let pad = (VEC_ALIGN - r.offset % VEC_ALIGN) % VEC_ALIGN;
        if r.take(pad)?.iter().any(|&b| b != 0) {
            return Err(invalid("bad padding"));
        }
        let row = dims * 4;
        if r.offset + count * row + 8 != size {
            return Err(invalid("size does not match the header"));
        }
        if dims == 0 && count > 0 {
            return Err(invalid("zero-width vectors"));
        }

        let mut out = Vectors::default();
        out.data.reserve_exact(count * dims);
        let rows_per_read = (READ_BLOCK / row.max(1)).max(1);
        let mut buf = vec![0u8; rows_per_read * row];
        let mut vec = vec![0f32; dims];
        let mut next = 0;
        while next < count {
            let rows = rows_per_read.min(count - next);
            r.read_exact(&mut buf[..rows * row])?;
            for k in 0..rows {
                let bytes = &buf[k * row..(k + 1) * row];
                for (d, v) in vec.iter_mut().enumerate() {
                    *v = f32::from_le_bytes(bytes[d * 4..d * 4 + 4].try_into().unwrap());
                }
                let i = next + k;
                let id = match rebase {
                    Some(rb) if ids[i].starts_with(&rb.from) => {
                        format!("{}{}", rb.to, &ids[i][rb.from.len()..])
                    }
                    _ => std::mem::take(&mut ids[i]),
                };
                let h = (flags[i] == 1)
                    .then(|| u32::from_le_bytes(hashes[i * 4..i * 4 + 4].try_into().unwrap()));
                out.insert(id, &vec, h);
            }
            next += rows;
        }
        let computed = r.hasher.clone().finalize();
        let mut trailer = [0u8; 8];
        r.inner
            .read_exact(&mut trailer)
            .map_err(|_| invalid("missing trailer"))?;
        if &trailer[4..] != VEC_TRAILER {
            return Err(invalid("missing trailer"));
        }
        if u32::from_le_bytes(trailer[..4].try_into().unwrap()) != computed {
            return Err(invalid("checksum mismatch"));
        }
        out.data.shrink_to_fit();
        Ok(out)
    }

    /// Parse an embeddings ndjson file. A missing file is an error; malformed lines are skipped.
    pub fn load_ndjson(path: &Path, rebase: Option<&Rebase>) -> io::Result<Vectors> {
        let mut file = File::open(path)?;
        let mut out = Vectors::default();
        let mut carry: Vec<u8> = Vec::new();
        let mut block = vec![0u8; READ_BLOCK];
        loop {
            let n = file.read(&mut block)?;
            if n == 0 {
                break;
            }
            carry.extend_from_slice(&block[..n]);
            let Some(last_nl) = memchr::memrchr(b'\n', &carry) else {
                continue;
            };
            let rest = carry.split_off(last_nl + 1);
            out.ingest_lines(&carry, rebase);
            carry = rest;
        }
        if !carry.is_empty() {
            out.ingest_lines(&carry, rebase);
        }
        // Growth by doubling leaves up to half the matrix as spare capacity; the footprint counts
        // capacity, so trim it rather than report (and reserve) bytes nothing uses.
        out.data.shrink_to_fit();
        out.norms.shrink_to_fit();
        out.hashes.shrink_to_fit();
        out.files.shrink_to_fit();
        out.ids.shrink_to_fit();
        Ok(out)
    }

    /// Parse whole lines in parallel, then insert them in file order.
    fn ingest_lines(&mut self, bytes: &[u8], rebase: Option<&Rebase>) {
        let lines: Vec<&[u8]> = bytes.split(|&b| b == b'\n').collect();
        let parsed: Vec<Option<Parsed>> = lines
            .par_iter()
            .map(|raw| parse_line(raw, rebase))
            .collect();
        for (raw, entry) in lines.iter().zip(parsed) {
            match entry {
                Some((id, vec, h)) => self.insert(id, &vec, h),
                None => {
                    if !raw.trim_ascii().is_empty() {
                        self.skipped_malformed += 1;
                    }
                }
            }
        }
    }

    fn insert(&mut self, id: String, vec: &[f32], h: Option<u32>) {
        if vec.is_empty() {
            self.skipped_width += 1;
            return;
        }
        if self.dims == 0 {
            self.dims = vec.len();
        }
        if vec.len() != self.dims {
            self.skipped_width += 1;
            return;
        }
        if let Some(&pos) = self.positions.get(&id) {
            // A Map's `set` on an existing key: the value changes, the position does not.
            let at = pos as usize;
            self.data[at * self.dims..(at + 1) * self.dims].copy_from_slice(vec);
            self.norms[at] = norm(vec);
            if h.is_some() {
                self.hashes[at] = h;
            }
            return;
        }
        let pos = self.ids.len() as u32;
        self.positions.insert(id.clone(), pos);
        self.ids.push(id);
        self.data.extend_from_slice(vec);
        self.norms.push(norm(vec));
        self.hashes.push(h);
        self.files.push(NO_FILE);
    }

    pub fn len(&self) -> usize {
        self.ids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    pub fn dims(&self) -> usize {
        self.dims
    }

    pub fn skipped_width(&self) -> usize {
        self.skipped_width
    }

    pub fn skipped_malformed(&self) -> usize {
        self.skipped_malformed
    }

    pub fn files_attached(&self) -> bool {
        self.files_attached
    }

    /// Resident bytes, priced the way the other native caches price themselves: the buffers' capacity
    /// plus a per-entry overhead for each map entry.
    pub fn footprint_bytes(&self) -> usize {
        let ids: usize = self.ids.iter().map(|s| s.capacity() + 24).sum();
        let table: usize = self.file_table.iter().map(|s| s.capacity() + 24).sum();
        self.data.capacity() * 4
            + self.norms.capacity() * 8
            + self.hashes.capacity() * 8
            + self.files.capacity() * 4
            + ids * 2 // the id strings, once in `ids` and once as `positions` keys
            + self.positions.capacity() * 16
            + table
    }

    /// The file of each id, replacing whatever was attached before: an id the caller does not list
    /// (a symbol deleted since the embedding run) stops being a candidate. Ids without a vector are
    /// ignored.
    pub fn attach_files(&mut self, ids: &[String], files: &[String]) {
        self.files.iter_mut().for_each(|f| *f = NO_FILE);
        self.file_table.clear();
        let mut table: HashMap<&str, u32> = HashMap::new();
        for (id, file) in ids.iter().zip(files) {
            let Some(&pos) = self.positions.get(id) else {
                continue;
            };
            let next = table.len() as u32;
            let at = *table.entry(file.as_str()).or_insert(next);
            if at == next {
                self.file_table.push(file.clone());
            }
            self.files[pos as usize] = at;
        }
        self.files_attached = true;
    }

    /// `searchSemantic` over the vectors whose file is attached and passes the filter (`file`
    /// contains `contains`; not a test file when `exclude_tests`), top `top_k` by cosine, ties in load
    /// order. A query of another width than the stored vectors matches nothing.
    pub fn search(
        &self,
        query: &[f32],
        top_k: usize,
        contains: Option<&str>,
        exclude_tests: bool,
    ) -> Result<Vec<Hit>, &'static str> {
        if !self.files_attached {
            return Err("vectors have no files attached");
        }
        if query.len() != self.dims || self.dims == 0 || top_k == 0 {
            return Ok(Vec::new());
        }
        let file_ok: Vec<bool> = self
            .file_table
            .iter()
            .map(|f| contains.is_none_or(|c| f.contains(c)) && !(exclude_tests && is_test_file(f)))
            .collect();
        let qn = norm(query);
        let dims = self.dims;
        let mut scored: Vec<(f64, u32)> = (0..self.ids.len())
            .into_par_iter()
            .filter_map(|pos| {
                let file = self.files[pos];
                if file == NO_FILE || !file_ok[file as usize] {
                    return None;
                }
                let v = &self.data[pos * dims..(pos + 1) * dims];
                let mut dot = 0.0f64;
                for (a, b) in query.iter().zip(v) {
                    dot += f64::from(*a) * f64::from(*b);
                }
                let denom = qn * self.norms[pos];
                let score = if denom > 0.0 { dot / denom } else { 0.0 };
                Some((score, pos as u32))
            })
            .collect();
        // Score descending, then position: the order a stable sort leaves equal scores in.
        let by_rank = |a: &(f64, u32), b: &(f64, u32)| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.1.cmp(&b.1))
        };
        if scored.len() > top_k {
            scored.select_nth_unstable_by(top_k - 1, by_rank);
            scored.truncate(top_k);
        }
        scored.sort_by(by_rank);
        Ok(scored
            .into_iter()
            .map(|(score, pos)| Hit {
                id: self.ids[pos as usize].clone(),
                score,
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(lines: &[&str]) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        f
    }

    fn attach_all(v: &mut Vectors, file: &str) {
        let ids = v.ids.clone();
        let files = vec![file.to_string(); ids.len()];
        v.attach_files(&ids, &files);
    }

    #[test]
    fn a_repeated_id_keeps_its_first_position_and_its_last_value() {
        // Map semantics: catches a loader that appends the second copy (two hits for one id).
        let f = write(&[
            r#"{"id":"a","vec":[1,0],"h":7}"#,
            r#"{"id":"b","vec":[0,1]}"#,
            r#"{"id":"a","vec":[0,1]}"#,
        ]);
        let mut v = Vectors::load_ndjson(f.path(), None).unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(v.ids, ["a", "b"]);
        assert_eq!(&v.data[0..2], &[0.0, 1.0]);
        // A line without `h` keeps the hash an earlier line stored, as `hashes.set` only runs with one.
        assert_eq!(v.hashes[0], Some(7));
        attach_all(&mut v, "src/x.ts");
        let hits = v.search(&[0.0, 1.0], 10, None, false).unwrap();
        // Equal scores: load order, so "a" (first position) before "b".
        assert_eq!(
            hits.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
    }

    #[test]
    fn rebase_rewrites_the_prefix_and_bad_lines_are_skipped() {
        let f = write(&[
            r#"{"id":"donor:src/a.ts:f:1","vec":[1,2,3]}"#,
            "not json",
            r#"{"id":"","vec":[1,2,3]}"#,
            r#"{"id":"donor:src/b.ts:g:2","vec":[1,2]}"#,
            "",
            r#"{"id":"other:x","vec":[3,2,1]}"#,
        ]);
        let rebase = Rebase {
            from: "donor:".into(),
            to: "wt:".into(),
        };
        let v = Vectors::load_ndjson(f.path(), Some(&rebase)).unwrap();
        assert_eq!(v.ids, ["wt:src/a.ts:f:1", "other:x"]);
        assert_eq!(v.skipped_width(), 1);
        assert_eq!(v.skipped_malformed(), 2);
    }

    #[test]
    fn floats_round_like_json_parse_then_float32array() {
        // 0.1 is not an f32; both paths go text → f64 → f32 (round to nearest even).
        let f = write(&[r#"{"id":"a","vec":[0.1,1e-46,3.4028235677973366e38]}"#]);
        let v = Vectors::load_ndjson(f.path(), None).unwrap();
        assert_eq!(v.data[0], 0.1f64 as f32);
        assert_eq!(v.data[1], 1e-46f64 as f32);
        assert_eq!(v.data[2], 3.4028235677973366e38f64 as f32);
    }

    #[test]
    fn search_ranks_by_cosine_filters_and_cuts_after_the_filter() {
        let f = write(&[
            r#"{"id":"t","vec":[1,0]}"#,
            r#"{"id":"a","vec":[0.9,0.1]}"#,
            r#"{"id":"b","vec":[0.5,0.5]}"#,
            r#"{"id":"gone","vec":[1,0]}"#,
            r#"{"id":"zero","vec":[0,0]}"#,
        ]);
        let mut v = Vectors::load_ndjson(f.path(), None).unwrap();
        // "gone" is not listed: a deleted symbol, never a candidate.
        v.attach_files(
            &["t".into(), "a".into(), "b".into(), "zero".into()],
            &[
                "src/a.test.ts".into(),
                "src/a.ts".into(),
                "lib/b.ts".into(),
                "src/z.ts".into(),
            ],
        );
        let ids = |hits: Vec<Hit>| hits.into_iter().map(|h| h.id).collect::<Vec<_>>();
        assert_eq!(
            ids(v.search(&[1.0, 0.0], 10, None, false).unwrap()),
            ["t", "a", "b", "zero"]
        );
        assert_eq!(ids(v.search(&[1.0, 0.0], 1, None, true).unwrap()), ["a"]);
        assert_eq!(
            ids(v.search(&[1.0, 0.0], 10, Some("src/"), true).unwrap()),
            ["a", "zero"]
        );
        // Another width: nothing, as the TS ranking skips every vector.
        assert!(v
            .search(&[1.0, 0.0, 0.0], 10, None, false)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn scores_equal_the_ts_formula_bit_for_bit() {
        let f = write(&[r#"{"id":"a","vec":[0.3,-0.7,0.25]}"#]);
        let mut v = Vectors::load_ndjson(f.path(), None).unwrap();
        attach_all(&mut v, "a.ts");
        let q = [0.1f32, 0.2, -0.9];
        let b = [0.3f32, -0.7, 0.25];
        let (mut dot, mut na, mut nb) = (0.0f64, 0.0f64, 0.0f64);
        for i in 0..3 {
            let (x, y) = (f64::from(q[i]), f64::from(b[i]));
            dot += x * y;
            na += x * x;
            nb += y * y;
        }
        let expected = dot / (na.sqrt() * nb.sqrt());
        let hits = v.search(&q, 1, None, false).unwrap();
        assert_eq!(hits[0].score.to_bits(), expected.to_bits());
    }

    #[test]
    fn top_k_selection_matches_a_full_stable_sort() {
        // Many ties: a selection that broke ties differently from the stable sort would reorder them.
        let lines: Vec<String> = (0..500)
            .map(|i| format!(r#"{{"id":"s{i}","vec":[{},{}]}}"#, i % 7, (i * 3) % 5))
            .collect();
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let f = write(&refs);
        let mut v = Vectors::load_ndjson(f.path(), None).unwrap();
        attach_all(&mut v, "a.ts");
        let all = v.search(&[1.0, 2.0], 500, None, false).unwrap();
        let top = v.search(&[1.0, 2.0], 37, None, false).unwrap();
        let ids = |h: &[Hit]| h.iter().map(|x| x.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(&top), ids(&all[..37]));
    }

    /// The layout `storage/vector-file.ts` writes, for the reader's tests.
    fn vec_file(rows: &[(&str, &[f32], Option<u32>)]) -> Vec<u8> {
        let dims = rows.first().map_or(0, |r| r.1.len());
        let mut out = Vec::new();
        out.extend_from_slice(&VEC_MAGIC);
        let header = format!(r#"{{"dims":{dims},"count":{}}}"#, rows.len());
        out.extend_from_slice(&(header.len() as u32).to_le_bytes());
        out.extend_from_slice(header.as_bytes());
        for (id, _, _) in rows {
            out.extend_from_slice(&(id.len() as u32).to_le_bytes());
            out.extend_from_slice(id.as_bytes());
        }
        for (_, _, h) in rows {
            out.push(u8::from(h.is_some()));
        }
        for (_, _, h) in rows {
            out.extend_from_slice(&h.unwrap_or(0).to_le_bytes());
        }
        while out.len() % VEC_ALIGN != 0 {
            out.push(0);
        }
        for (_, v, _) in rows {
            for x in *v {
                out.extend_from_slice(&x.to_le_bytes());
            }
        }
        let crc = crc32fast::hash(&out);
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(VEC_TRAILER);
        out
    }

    fn file_with(bytes: &[u8]) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(bytes).unwrap();
        f
    }

    #[test]
    fn a_vector_file_loads_like_the_ndjson_it_replaces() {
        // Same content both ways — ids, values, hashes, a repeated id, the rebase.
        let rows: [(&str, &[f32], Option<u32>); 3] = [
            ("d:a", &[0.1, -2.5], Some(9)),
            ("d:b", &[3.0, 4.0], None),
            ("d:a", &[1.0, 0.0], None),
        ];
        let f = file_with(&vec_file(&rows));
        let nd = write(&[
            r#"{"id":"d:a","vec":[0.10000000149011612,-2.5],"h":9}"#,
            r#"{"id":"d:b","vec":[3,4]}"#,
            r#"{"id":"d:a","vec":[1,0]}"#,
        ]);
        let rebase = Rebase {
            from: "d:".into(),
            to: "w:".into(),
        };
        let a = Vectors::load(f.path(), Some(&rebase)).unwrap();
        let b = Vectors::load(nd.path(), Some(&rebase)).unwrap();
        assert_eq!(a.ids, ["w:a", "w:b"]);
        assert_eq!(a.ids, b.ids);
        assert_eq!(a.data, b.data);
        assert_eq!(a.hashes, b.hashes);
        assert_eq!(a.norms, b.norms);
    }

    #[test]
    fn a_damaged_vector_file_is_refused_whole() {
        // Bug it catches: a flipped byte in the matrix served as a valid but wrong vector.
        let rows: [(&str, &[f32], Option<u32>); 2] =
            [("a", &[1.0, 2.0], None), ("b", &[3.0, 4.0], None)];
        let good = vec_file(&rows);
        let mut flipped = good.clone();
        let at = good.len() - 9;
        flipped[at] ^= 0x40;
        let err = Vectors::load(file_with(&flipped).path(), None)
            .err()
            .unwrap();
        assert!(err.to_string().contains("checksum"), "{err}");
        let truncated = &good[..good.len() - 12];
        assert!(Vectors::load(file_with(truncated).path(), None).is_err());
        assert_eq!(
            Vectors::load(file_with(&good).path(), None).unwrap().len(),
            2
        );
    }

    #[test]
    fn search_refuses_before_files_are_attached() {
        let f = write(&[r#"{"id":"a","vec":[1,0]}"#]);
        let v = Vectors::load_ndjson(f.path(), None).unwrap();
        assert!(v.search(&[1.0, 0.0], 1, None, false).is_err());
    }
}
