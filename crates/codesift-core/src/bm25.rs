//! BM25F over symbols (ADR-006 stage 2) — a port of `src/search/bm25.ts` whose output must be the
//! SAME ranking, not a similar one: a different order is a silently different search answer.
//!
//! What "the same" requires, beyond the formulas:
//!
//! * **Map semantics.** The TypeScript index keys everything by symbol id in `Map`s, and ids are NOT
//!   unique (`repo:file:name:line`). `Map.set` on an existing id keeps the entry's POSITION and
//!   replaces its VALUE; deleting and re-adding moves it to the end. Ties in the final sort are broken
//!   by that insertion order (JS sort is stable), so every structure here reproduces it: one "key" per
//!   distinct id, postings as insertion-ordered vectors that are overwritten in place on a collision.
//! * **Removal re-derives tokens from the LAST symbol stored under an id** (`removeSymbolFromIndex`),
//!   so after a collision, tokens only the earlier symbol had stay in the postings as stale entries.
//!   Each key therefore remembers the token list of its last symbol, and removal uses exactly that.
//! * **Text slicing is in UTF-16 code units** (`source.slice(0, 500)`), not bytes or chars.
//! * **JS regex classes**: `\s` in the centrality pattern is spelled out, because JS's set includes
//!   U+FEFF and Rust's does not.
//!
//! The one thing that cannot be made bit-identical is `Math.log`/`Math.log2` against Rust's `ln`/
//! `log2`: neither is required to be correctly rounded, so idf can differ in the last bit. Every other
//! operation is IEEE-exact and done in the same order, so scores agree to ~1e-15 relative and the
//! parity tests compare order exactly wherever scores differ by more than that.

use std::collections::HashMap;
use std::sync::OnceLock;

use memchr::memmem;
use regex::Regex;

const K1: f64 = 1.2;
const B: f64 = 0.75;
/// `BODY_CHAR_LIMIT` — in UTF-16 code units, like `String.prototype.slice`.
const BODY_UTF16_LIMIT: usize = 500;
const TEST_FILE_SCORE_MULTIPLIER: f64 = 0.3;
const TEST_FILE_PATTERNS: [&str; 9] = [
    ".test.",
    ".spec.",
    "__tests__/",
    "test/mocks",
    "test-utils",
    "test-helpers",
    "Test.kt",
    "Tests.kt",
    "Spec.kt",
];

/// name, signature, docstring, body, comments — the order of `fieldNames` in bm25.ts, which is also
/// the order postings are visited in a search.
pub const FIELD_COUNT: usize = 5;

/// One symbol as the index needs it. Mirrors the `CodeSymbol` fields bm25.ts reads.
#[derive(Debug, Clone, Default)]
pub struct SymbolInput {
    pub id: String,
    pub file: String,
    pub name: String,
    pub signature: Option<String>,
    pub docstring: Option<String>,
    pub source: Option<String>,
}

/// One search result: the symbol id, its score and the query tokens it matched (in query order).
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub id: String,
    pub score: f64,
    pub matches: Vec<String>,
}

// ---------------------------------------------------------------------------------------------
// Tokenisation — `tokenizeText`, `tokenizeIdentifier`, `getFieldTokens`
// ---------------------------------------------------------------------------------------------

fn is_lower_or_digit(c: char) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit()
}

/// The two camelCase `replace` passes of bm25.ts / symbol-utils.ts, then `split("\0")`:
///
/// 1. `/([a-z0-9])([A-Z])/g -> "$1\0$2"` — a break at every lower/digit -> upper boundary. (A match
///    consumes the uppercase letter, which can never start the next match, so "every boundary" and
///    "non-overlapping matches" are the same set.)
/// 2. `/([A-Z]+)([A-Z][a-z])/g -> "$1\0$2"` — in each maximal run of 2+ uppercase letters that is
///    followed by a lowercase letter, a break before the run's last letter (greedy `+` backtracks
///    exactly one letter). `camel_split_matches_the_regexes` checks this against the regexes.
fn camel_split(part: &str) -> Vec<String> {
    let chars: Vec<char> = part.chars().collect();
    let mut pass1: Vec<char> = Vec::with_capacity(chars.len() + 4);
    for (i, &c) in chars.iter().enumerate() {
        pass1.push(c);
        if let Some(&next) = chars.get(i + 1) {
            if is_lower_or_digit(c) && next.is_ascii_uppercase() {
                pass1.push('\0');
            }
        }
    }
    let mut breaks = vec![false; pass1.len()];
    let mut i = 0;
    while i < pass1.len() {
        if pass1[i].is_ascii_uppercase() {
            let start = i;
            while i < pass1.len() && pass1[i].is_ascii_uppercase() {
                i += 1;
            }
            let run = i - start;
            if run >= 2 && i < pass1.len() && pass1[i].is_ascii_lowercase() {
                breaks[i - 1] = true;
            }
        } else {
            i += 1;
        }
    }
    let mut out = Vec::new();
    let mut cur = String::new();
    for (i, &c) in pass1.iter().enumerate() {
        if breaks[i] {
            out.push(std::mem::take(&mut cur));
        }
        if c == '\0' {
            out.push(std::mem::take(&mut cur));
        } else {
            cur.push(c);
        }
    }
    out.push(cur);
    out
}

/// `tokenizeText`: runs of ASCII alphanumerics, camel-split, lowercased, at least 2 characters.
pub fn tokenize_text(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    for part in text.split(|c: char| !c.is_ascii_alphanumeric()) {
        if part.is_empty() {
            continue;
        }
        for sub in camel_split(part) {
            // Parts are ASCII, so byte length is the UTF-16 length `lower.length` measures.
            if sub.len() >= 2 {
                tokens.push(sub.to_ascii_lowercase());
            }
        }
    }
    tokens
}

/// `tokenizeIdentifier`: split on `_`, camel-split, lowercased (full Unicode, like `toLowerCase`),
/// non-empty.
pub fn tokenize_identifier(name: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    for part in name.split('_') {
        if part.is_empty() {
            continue;
        }
        for sub in camel_split(part) {
            if !sub.is_empty() {
                tokens.push(sub.to_lowercase());
            }
        }
    }
    tokens
}

/// `source.slice(0, 500)` measured in UTF-16 code units. A character that would straddle the limit
/// is dropped: JS keeps its lone high surrogate, which every tokeniser here treats as a separator.
fn body_prefix(source: &str) -> &str {
    let mut units = 0;
    for (idx, c) in source.char_indices() {
        let width = c.len_utf16();
        if units + width > BODY_UTF16_LIMIT {
            return &source[..idx];
        }
        units += width;
    }
    source
}

fn line_comment_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"//[^\n]*").expect("static regex"))
}

fn block_comment_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)/\*.*?\*/").expect("static regex"))
}

/// `splitCodeAndComments`: `//` comments are cut first, then `/* */` blocks from what remains.
fn split_code_and_comments(source: &str) -> (String, String) {
    let mut comments: Vec<String> = Vec::new();
    let pass1 = line_comment_re().replace_all(source, |c: &regex::Captures<'_>| {
        comments.push(c[0].to_string());
        ""
    });
    let pass2 = block_comment_re().replace_all(&pass1, |c: &regex::Captures<'_>| {
        comments.push(c[0].to_string());
        ""
    });
    (pass2.into_owned(), comments.join(" "))
}

/// `getFieldTokens` — truthiness included: an empty signature or docstring tokenises to nothing.
fn field_tokens(sym: &SymbolInput) -> [Vec<String>; FIELD_COUNT] {
    let source = sym.source.as_deref().map(body_prefix).unwrap_or("");
    let (code, comments) = split_code_and_comments(source);
    let text_or_none = |v: &Option<String>| match v.as_deref() {
        Some(s) if !s.is_empty() => tokenize_text(s),
        _ => Vec::new(),
    };
    [
        tokenize_identifier(&sym.name),
        text_or_none(&sym.signature),
        text_or_none(&sym.docstring),
        if source.is_empty() {
            Vec::new()
        } else {
            tokenize_text(&code)
        },
        if comments.is_empty() {
            Vec::new()
        } else {
            tokenize_text(&comments)
        },
    ]
}

/// `isTestFile` — substring patterns, not the stricter regex set.
pub fn is_test_file(path: &str) -> bool {
    TEST_FILE_PATTERNS.iter().any(|p| path.contains(p))
}

/// The import pattern centrality counts: `/from\s+['"]\.?\.\/([\w/.-]+)['"]/g`, with JS's `\s` and
/// `\w` spelled out (JS `\s` includes U+FEFF; Rust's does not; JS `\w` is ASCII-only).
fn import_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            "from[\\t\\n\\x0B\\x0C\\r \\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}]+['\"]\\.?\\./([A-Za-z0-9_/.-]+)['\"]",
        )
        .expect("static regex")
    })
}

// ---------------------------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------------------------

/// Per distinct symbol id. `alive` is "present in `index.symbols`"; postings may still name a dead
/// key (a stale entry after a collision), exactly as the TypeScript maps can.
#[derive(Debug, Clone)]
struct Key {
    id: String,
    alive: bool,
    file: u32,
    lengths: [u32; FIELD_COUNT],
    /// Unique (field, token) pairs of the LAST symbol ingested under this id, `field << 29 | token`
    /// — what removal deletes, because removal re-derives from the stored (last) symbol.
    tokens: Vec<u32>,
    /// Pairs whose postings still hold this key although `tokens` does not name them: left behind by
    /// an earlier symbol under the same id. Empty unless the id collided — which is what keeps the
    /// presence check below cheap: a key that never collided is known to be absent everywhere else.
    stale: Vec<u32>,
}

const FIELD_SHIFT: u32 = 29;
const TOKEN_MASK: u32 = (1 << FIELD_SHIFT) - 1;

#[derive(Debug, Default)]
pub struct Bm25 {
    vocab: Vec<String>,
    vocab_ids: HashMap<String, u32>,
    /// Per field: token -> postings in insertion order, `(key, tf)`.
    postings: [HashMap<u32, Vec<(u32, u32)>>; FIELD_COUNT],
    keys: Vec<Key>,
    key_ids: HashMap<String, u32>,
    files: Vec<String>,
    file_ids: HashMap<String, u32>,
    total_field_lengths: [i64; FIELD_COUNT],
    doc_count: i64,
    /// Per file id; 0 where nothing imports it.
    centrality: Vec<f64>,
    /// Build-time only: imports seen so far, resolved against the complete file set in `finish`.
    pending_imports: Vec<String>,
}

impl Bm25 {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn doc_count(&self) -> i64 {
        self.doc_count
    }

    fn file_id(&mut self, file: &str) -> u32 {
        if let Some(&id) = self.file_ids.get(file) {
            return id;
        }
        let id = self.files.len() as u32;
        self.files.push(file.to_string());
        self.file_ids.insert(file.to_string(), id);
        self.centrality.push(0.0);
        id
    }

    fn vocab_id(&mut self, token: &str) -> u32 {
        if let Some(&id) = self.vocab_ids.get(token) {
            return id;
        }
        let id = self.vocab.len() as u32;
        self.vocab.push(token.to_string());
        self.vocab_ids.insert(token.to_string(), id);
        id
    }

    /// `ingestSymbol` (without the docCount bookkeeping, which differs between build and update).
    fn ingest(&mut self, sym: &SymbolInput) {
        let file = self.file_id(&sym.file);
        let existing = self.key_ids.get(&sym.id).copied();
        // A key that is alive is being overwritten in place (`Map.set` on an existing id); a dead or
        // new one is (re-)appended, which is where a deleted-then-added Map entry goes.
        let key = match existing {
            Some(k) => k,
            None => {
                let k = self.keys.len() as u32;
                self.keys.push(Key {
                    id: sym.id.clone(),
                    alive: false,
                    file,
                    lengths: [0; FIELD_COUNT],
                    tokens: Vec::new(),
                    stale: Vec::new(),
                });
                self.key_ids.insert(sym.id.clone(), k);
                k
            }
        };
        // Pairs where a posting for this key already exists: `postings.set` will OVERWRITE those in
        // place (keeping their position) and append everywhere else.
        let present: Vec<u32> = {
            let k = &self.keys[key as usize];
            k.tokens.iter().chain(k.stale.iter()).copied().collect()
        };

        let fields = field_tokens(sym);
        let mut lengths = [0u32; FIELD_COUNT];
        let mut key_tokens: Vec<u32> = Vec::new();
        for (f, tokens) in fields.iter().enumerate() {
            self.total_field_lengths[f] += tokens.len() as i64;
            lengths[f] = tokens.len() as u32;
            // `countTermFrequencies`: first-occurrence order, which is the order `postings.set` runs.
            let mut tf: Vec<(u32, u32)> = Vec::new();
            let mut seen: HashMap<u32, usize> = HashMap::new();
            for t in tokens {
                let tid = self.vocab_id(t);
                match seen.get(&tid) {
                    Some(&i) => tf[i].1 += 1,
                    None => {
                        seen.insert(tid, tf.len());
                        tf.push((tid, 1));
                    }
                }
            }
            for (tid, freq) in tf {
                let packed = ((f as u32) << FIELD_SHIFT) | tid;
                let list = self.postings[f].entry(tid).or_default();
                let overwritten = present.contains(&packed)
                    && match list.iter_mut().find(|(k, _)| *k == key) {
                        Some(entry) => {
                            entry.1 = freq;
                            true
                        }
                        None => false,
                    };
                if !overwritten {
                    list.push((key, freq));
                }
                key_tokens.push(packed);
            }
        }
        let k = &mut self.keys[key as usize];
        // Everything this key occupied that the new symbol does not name stays behind as stale.
        k.stale = present
            .into_iter()
            .filter(|p| !key_tokens.contains(p))
            .collect();
        k.alive = true;
        k.file = file;
        k.lengths = lengths;
        k.tokens = key_tokens;
    }

    /// Build-mode ingestion of a batch (the loop of `buildBM25IndexYielding`). Import paths are
    /// collected now and resolved in `finish`, against every file the build will have seen.
    pub fn ingest_build(&mut self, batch: &[SymbolInput]) {
        for sym in batch {
            self.ingest(sym);
            self.doc_count += 1;
            if let Some(src) = sym.source.as_deref() {
                if !src.is_empty() {
                    for c in import_re().captures_iter(src) {
                        self.pending_imports.push(c[1].to_string());
                    }
                }
            }
        }
    }

    /// `finishBuild`'s centrality pass: each import counts once toward the FIRST file (in first-seen
    /// order) whose path contains it; centrality is `log2(1 + count)`.
    pub fn finish(&mut self) {
        let mut counts = vec![0u64; self.files.len()];
        let mut resolved: HashMap<String, Option<usize>> = HashMap::new();
        for imported in std::mem::take(&mut self.pending_imports) {
            // Same answer for the same string, since the file set is fixed now — memoised, which
            // turns the O(imports x files) scan bm25.ts warns about into O(distinct imports x files).
            let hit = *resolved.entry(imported.clone()).or_insert_with(|| {
                let finder = memmem::Finder::new(imported.as_bytes());
                self.files
                    .iter()
                    .position(|f| finder.find(f.as_bytes()).is_some())
            });
            if let Some(i) = hit {
                counts[i] += 1;
            }
        }
        for (i, &n) in counts.iter().enumerate() {
            self.centrality[i] = if n > 0 { (1.0 + n as f64).log2() } else { 0.0 };
        }
    }

    fn remove_key(&mut self, key: u32) {
        let k = &self.keys[key as usize];
        let lengths = k.lengths;
        let tokens = k.tokens.clone();
        for (f, total) in self.total_field_lengths.iter_mut().enumerate() {
            *total -= lengths[f] as i64;
        }
        for packed in tokens {
            let f = (packed >> FIELD_SHIFT) as usize;
            let tid = packed & TOKEN_MASK;
            if let Some(list) = self.postings[f].get_mut(&tid) {
                list.retain(|(k, _)| *k != key);
                // A token nobody carries any more goes, as `postings.delete(token)` does.
                if list.is_empty() {
                    self.postings[f].remove(&tid);
                }
            }
        }
        let k = &mut self.keys[key as usize];
        k.alive = false;
        k.tokens = Vec::new();
        self.doc_count -= 1;
    }

    /// `updateBM25ForFile`: drop every live symbol whose STORED file is `file`, ingest the new ones.
    /// Centrality is deliberately left as it was, as bm25.ts leaves it.
    pub fn update_file(&mut self, file: &str, symbols: &[SymbolInput]) {
        let stale: Vec<u32> = match self.file_ids.get(file) {
            Some(&fid) => (0..self.keys.len() as u32)
                .filter(|&k| self.keys[k as usize].alive && self.keys[k as usize].file == fid)
                .collect(),
            None => Vec::new(),
        };
        for key in stale {
            self.remove_key(key);
        }
        for sym in symbols {
            self.ingest(sym);
            self.doc_count += 1;
        }
    }

    fn avg_field_length(&self, f: usize) -> f64 {
        if self.doc_count > 0 {
            self.total_field_lengths[f] as f64 / self.doc_count as f64
        } else {
            0.0
        }
    }

    /// `searchBM25`, returning ids instead of symbol objects (the JS side owns those).
    pub fn search(&self, query: &str, top_k: usize, weights: &[f64; FIELD_COUNT]) -> Vec<Hit> {
        if self.doc_count == 0 || query.trim().is_empty() {
            return Vec::new();
        }
        let query_tokens = tokenize_text(query);
        if query_tokens.is_empty() {
            return Vec::new();
        }
        let n = self.doc_count as f64;
        // Insertion-ordered score accumulation: `scores` and `matchedTokens` are Maps.
        let mut order: Vec<u32> = Vec::new();
        let mut slot: HashMap<u32, usize> = HashMap::new();
        let mut scores: Vec<f64> = Vec::new();
        let mut matched: Vec<Vec<usize>> = Vec::new();

        for (qi, q) in query_tokens.iter().enumerate() {
            let Some(&tid) = self.vocab_ids.get(q) else {
                continue;
            };
            for (f, &weight) in weights.iter().enumerate() {
                let Some(list) = self.postings[f].get(&tid) else {
                    continue;
                };
                let df = list.len() as f64;
                let idf = ((n - df + 0.5) / (df + 0.5) + 1.0).ln();
                let avg = self.avg_field_length(f);
                for &(key, tf) in list {
                    let k = &self.keys[key as usize];
                    let fl = if k.alive { k.lengths[f] as f64 } else { 0.0 };
                    let norm = if avg > 0.0 { fl / avg } else { 1.0 };
                    let tf = tf as f64;
                    let tf_score = (tf * (K1 + 1.0)) / (tf + K1 * (1.0 - B + B * norm));
                    let field_score = idf * tf_score * weight;
                    let s = *slot.entry(key).or_insert_with(|| {
                        order.push(key);
                        scores.push(0.0);
                        matched.push(Vec::new());
                        order.len() - 1
                    });
                    scores[s] += field_score;
                    // A Set of query TOKENS: a repeated query token is matched once.
                    if !matched[s]
                        .iter()
                        .any(|&m| query_tokens[m] == query_tokens[qi])
                    {
                        matched[s].push(qi);
                    }
                }
            }
        }

        let max_centrality = self.centrality.iter().copied().fold(1.0f64, f64::max);
        for (s, &key) in order.iter().enumerate() {
            let k = &self.keys[key as usize];
            // `index.symbols.get(id)` misses for a dead key: its score is left unadjusted.
            if !k.alive {
                continue;
            }
            let score = scores[s];
            let mut adjusted = score;
            let c = self.centrality[k.file as usize];
            if c > 0.0 {
                adjusted += score * 0.1 * (c / max_centrality);
            }
            if is_test_file(&self.files[k.file as usize]) {
                adjusted *= TEST_FILE_SCORE_MULTIPLIER;
            }
            scores[s] = adjusted;
        }

        // Stable sort by score descending — ties keep insertion order, as Array.prototype.sort does.
        let mut ranked: Vec<usize> = (0..order.len()).collect();
        ranked.sort_by(|&a, &b| {
            scores[b]
                .partial_cmp(&scores[a])
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        ranked.truncate(top_k);

        ranked
            .into_iter()
            .filter_map(|s| {
                let k = &self.keys[order[s] as usize];
                // `index.symbols.get(id)` after the slice: a dead key is dropped, not replaced.
                k.alive.then(|| Hit {
                    id: k.id.clone(),
                    score: scores[s],
                    matches: matched[s]
                        .iter()
                        .map(|&m| query_tokens[m].clone())
                        .collect(),
                })
            })
            .collect()
    }

    /// Files with a non-zero import centrality, and the score — `index.centrality` of bm25.ts, which
    /// `search_text(ranked=true)` reads by file.
    pub fn centrality_entries(&self) -> Vec<(String, f64)> {
        self.files
            .iter()
            .zip(&self.centrality)
            .filter(|(_, &c)| c > 0.0)
            .map(|(f, &c)| (f.clone(), c))
            .collect()
    }

    /// Resident bytes, from what is actually allocated — the number the cache budget is enforced
    /// against, replacing bm25.ts's per-token estimate for native indexes.
    pub fn footprint_bytes(&self) -> usize {
        let strings = |v: &[String]| v.iter().map(|s| s.capacity() + 24).sum::<usize>();
        let map_overhead = 48;
        let mut bytes = strings(&self.vocab) * 2 + self.vocab_ids.capacity() * (map_overhead / 2);
        for field in &self.postings {
            bytes += field.capacity() * map_overhead;
            bytes += field.values().map(|l| l.capacity() * 8 + 24).sum::<usize>();
        }
        bytes += self
            .keys
            .iter()
            .map(|k| k.id.capacity() * 2 + (k.tokens.capacity() + k.stale.capacity()) * 4 + 96)
            .sum::<usize>();
        bytes += self.key_ids.capacity() * map_overhead;
        bytes += strings(&self.files) * 2 + self.file_ids.capacity() * map_overhead;
        bytes += self.centrality.capacity() * 8;
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sym(id: &str, file: &str, name: &str, source: &str) -> SymbolInput {
        SymbolInput {
            id: id.into(),
            file: file.into(),
            name: name.into(),
            signature: None,
            docstring: None,
            source: if source.is_empty() {
                None
            } else {
                Some(source.into())
            },
        }
    }

    const W: [f64; FIELD_COUNT] = [3.0, 1.0, 1.5, 1.0, 0.5];

    /// The regexes of bm25.ts, applied literally — the oracle for the hand-written split.
    fn camel_split_by_regex(part: &str) -> Vec<String> {
        let a = Regex::new("([a-z0-9])([A-Z])").unwrap();
        let b = Regex::new("([A-Z]+)([A-Z][a-z])").unwrap();
        let s = a.replace_all(part, "${1}\0${2}");
        let s = b.replace_all(&s, "${1}\0${2}");
        s.split('\0').map(str::to_string).collect()
    }

    #[test]
    fn camel_split_matches_the_regexes() {
        let alphabet: Vec<char> = "aZ9bYQx0_É\0".chars().collect();
        let mut seed: u64 = 7;
        for _ in 0..20_000 {
            let len = (seed % 9) as usize;
            let mut s = String::new();
            for _ in 0..len {
                seed = seed
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                s.push(alphabet[(seed >> 33) as usize % alphabet.len()]);
            }
            seed = seed.wrapping_add(1);
            assert_eq!(camel_split(&s), camel_split_by_regex(&s), "input {s:?}");
        }
        for s in [
            "XMLHttpRequest",
            "getHTTPResponseCode",
            "ABCdEFg",
            "aBcD",
            "parseJSON2Html",
            "IOError",
        ] {
            assert_eq!(camel_split(s), camel_split_by_regex(s), "input {s}");
        }
    }

    #[test]
    fn tokenizers_follow_the_typescript_rules() {
        assert_eq!(
            tokenize_text("getHTTPResponse(x) a_b"),
            vec!["get", "http", "response"]
        );
        assert_eq!(
            tokenize_identifier("parse_XMLHttp"),
            vec!["parse", "xml", "http"]
        );
        assert_eq!(tokenize_identifier("ΣΊΣΥΦΟΣ_x"), vec!["σίσυφος", "x"]);
    }

    #[test]
    fn body_prefix_counts_utf16_units_and_drops_a_straddling_char() {
        let s = format!("{}🚀tail", "a".repeat(499));
        assert_eq!(body_prefix(&s), "a".repeat(499));
        let s = format!("{}é", "a".repeat(499));
        assert_eq!(body_prefix(&s), s);
    }

    #[test]
    fn comments_are_split_line_first_then_blocks() {
        let (code, comments) = split_code_and_comments("a // one\nb /* two\n */ c");
        assert_eq!(code, "a \nb  c");
        assert_eq!(comments, "// one /* two\n */");
    }

    #[test]
    fn search_ranks_and_reports_matches() {
        let mut idx = Bm25::new();
        idx.ingest_build(&[
            sym(
                "1",
                "src/user.ts",
                "createUser",
                "function createUser() { return makeUser(); }",
            ),
            sym(
                "2",
                "src/user.test.ts",
                "createUserTest",
                "it('creates user')",
            ),
            sym(
                "3",
                "src/order.ts",
                "createOrder",
                "import x from './user';",
            ),
        ]);
        idx.finish();
        let hits = idx.search("create user", 10, &W);
        assert_eq!(hits[0].id, "1");
        assert_eq!(hits[0].matches, vec!["create", "user"]);
        // The test file is demoted below production code.
        let pos_test = hits.iter().position(|h| h.id == "2").unwrap();
        assert!(pos_test > 0);
        assert!(idx.centrality[idx.file_ids["src/user.ts"] as usize] > 0.0);
    }

    #[test]
    fn a_colliding_id_overwrites_in_place_and_leaves_stale_tokens_on_removal() {
        let mut idx = Bm25::new();
        idx.ingest_build(&[
            sym("dup", "a.ts", "alphaOnly", ""),
            sym("x", "b.ts", "other", ""),
        ]);
        idx.ingest_build(&[sym("dup", "a.ts", "betaOnly", "")]);
        idx.finish();
        assert_eq!(idx.doc_count(), 3);
        // Both names' tokens point at the one key.
        assert_eq!(idx.search("alpha", 10, &W).len(), 1);
        assert_eq!(idx.search("beta", 10, &W).len(), 1);
        idx.update_file("a.ts", &[]);
        // Removal re-derives from the LAST symbol (betaOnly): alpha's posting stays, but its key is
        // dead, so the hit is dropped after ranking.
        assert!(idx.search("beta", 10, &W).is_empty());
        assert!(idx.search("alpha", 10, &W).is_empty());
        assert!(idx.postings[0].contains_key(&idx.vocab_ids["alpha"]));
        assert_eq!(idx.doc_count(), 2);
    }

    #[test]
    fn re_adding_a_dead_key_overwrites_its_stale_entry_instead_of_duplicating_it() {
        let mut idx = Bm25::new();
        idx.ingest_build(&[
            sym("dup", "a.ts", "alphaOnly", ""),
            sym("x", "b.ts", "alpha", ""),
        ]);
        idx.ingest_build(&[sym("dup", "a.ts", "betaOnly", "")]);
        idx.finish();
        idx.update_file("a.ts", &[]);
        // `alpha` still holds the stale (dup) entry ahead of x; re-adding dup must overwrite it in
        // place, so dup keeps FIRST position among the tied alpha matches, as Map.set would.
        idx.update_file("a.ts", &[sym("dup", "a.ts", "alpha", "")]);
        let list = &idx.postings[0][&idx.vocab_ids["alpha"]];
        assert_eq!(
            list.iter()
                .filter(|(k, _)| *k == idx.key_ids["dup"])
                .count(),
            1
        );
        assert_eq!(list[0].0, idx.key_ids["dup"]);
    }

    #[test]
    fn update_moves_a_reingested_symbol_to_the_end_for_ties() {
        let mut idx = Bm25::new();
        idx.ingest_build(&[sym("a", "a.ts", "same", ""), sym("b", "b.ts", "same", "")]);
        idx.finish();
        let ids = |idx: &Bm25| {
            idx.search("same", 10, &W)
                .into_iter()
                .map(|h| h.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&idx), vec!["a", "b"]);
        idx.update_file("a.ts", &[sym("a", "a.ts", "same", "")]);
        assert_eq!(ids(&idx), vec!["b", "a"]);
    }
}
