//! The call graph — a port of `buildAdjacencyIndex` / `extractCallSites` in `src/tools/graph-tools.ts`
//! (ADR-006 stage 7).
//!
//! Built straight from the index database, off the main thread. Measured on a 454,892-symbol index,
//! the TypeScript build held the event loop for 4.1 s with tests skipped and 11.7 s with them
//! included (28.3M edges, +1.17 GB of heap) — on every `trace_call_chain`, `impact_analysis` and
//! `trace_route`. Here the edges are `u32` node positions, outside V8.
//!
//! Exactness is the contract, so the quirks are kept, not fixed:
//! - nodes are positions in rowid order, which is the order `loadIndexSqlite` builds `index.symbols` in;
//! - `callers` / `callees` are keyed by symbol ID, so colliding ids share a caller list and the last
//!   callee list wins, as with the TypeScript `Map`s;
//! - a target whose id equals the caller's id is skipped (id equality, not identity);
//! - the regexes use JS semantics: ASCII `\w` and `\b`, and JS's `\s` spelled out.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use rayon::prelude::*;
use regex::Regex;

use crate::store::{open, symbols_by_rowid_json, Result, StoreError};

/// `MIN_CALL_NAME_LENGTH`, counted in UTF-16 units like JS `.length`.
const MIN_CALL_NAME_LENGTH: usize = 3;

const CALLABLE_KINDS: &[&str] = &[
    "function",
    "method",
    "class",
    "default_export",
    "variable",
    "component",
    "hook",
];

/// `REACT_STDLIB_HOOKS` (react-shared-tools.ts).
const REACT_STDLIB_HOOKS: &[&str] = &[
    "useState",
    "useEffect",
    "useCallback",
    "useMemo",
    "useRef",
    "useContext",
    "useReducer",
    "useLayoutEffect",
    "useImperativeHandle",
    "useDebugValue",
    "useDeferredValue",
    "useTransition",
    "useId",
    "useSyncExternalStore",
    "useInsertionEffect",
    "useOptimistic",
    "useFormState",
    "useFormStatus",
    "use",
];

/// `KEYWORD_SET` (graph-tools.ts).
const KEYWORDS: &[&str] = &[
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "return",
    "typeof",
    "instanceof",
    "new",
    "throw",
    "delete",
    "void",
    "yield",
    "await",
    "import",
    "export",
    "from",
    "const",
    "let",
    "var",
    "function",
    "class",
    "extends",
    "implements",
    "interface",
    "type",
    "enum",
    "async",
    "static",
    "get",
    "set",
    "constructor",
    "super",
    "this",
    "true",
    "false",
    "null",
    "undefined",
    "try",
    "finally",
    "else",
    "case",
    "default",
    "break",
    "continue",
    "do",
    "in",
    "of",
    "as",
    "is",
    "keyof",
    "readonly",
    "declare",
    "abstract",
    "override",
    "public",
    "private",
    "protected",
    "when",
    "fun",
    "val",
    "data",
    "sealed",
    "object",
    "companion",
    "suspend",
    "inline",
    "reified",
    "lateinit",
    "init",
    "typealias",
    "by",
    "internal",
    "open",
    "inner",
    "crossinline",
    "noinline",
    "tailrec",
    "operator",
    "infix",
    "annotation",
    "actual",
    "expect",
    "foreach",
    "endforeach",
    "endif",
    "endwhile",
    "endfor",
    "endswitch",
    "match",
    "fn",
    "list",
    "array",
    "empty",
    "isset",
    "unset",
    "print",
    "echo",
    "include",
    "include_once",
    "require",
    "require_once",
    "global",
    "clone",
    "trait",
    "namespace",
    "use",
];

/// JavaScript's `\s` (it is not Unicode `White_Space`: JS adds U+FEFF and omits U+0085).
const JS_WS: &str = r"[\t\n\x0B\x0C\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";

fn call_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // /\b([a-zA-Z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/g
    RE.get_or_init(|| {
        Regex::new(&format!(
            r"(?-u:\b)([a-zA-Z_$][A-Za-z0-9_$]*){JS_WS}*(?:<[^>]*>)?{JS_WS}*\("
        ))
        .expect("static regex")
    })
}

fn jsx_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // /<([A-Z][a-zA-Z0-9_$]*)\b/g
    RE.get_or_init(|| Regex::new(r"<([A-Z][a-zA-Z0-9_$]*)(?-u:\b)").expect("static regex"))
}

fn php_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // /(?:->|::)([a-zA-Z_][\w]*)\s*\(/g
    RE.get_or_init(|| {
        Regex::new(&format!(r"(?:->|::)([a-zA-Z_][A-Za-z0-9_]*){JS_WS}*\(")).expect("static regex")
    })
}

fn test_file_res() -> &'static [Regex] {
    static RES: OnceLock<Vec<Regex>> = OnceLock::new();
    // TEST_FILE_REGEX_PATTERNS (utils/test-file.ts), for isTestFileStrict.
    RES.get_or_init(|| {
        [
            r"\.test\.[jt]sx?$",
            r"\.spec\.[jt]sx?$",
            r"\.e2e\.[jt]sx?$",
            r"/__tests__/",
            r"/test/",
            r"/tests/",
            r"Test\.kts?$",
            r"Tests\.kts?$",
            r"Spec\.kts?$",
            r"/androidTest/",
            r"/commonTest/",
        ]
        .iter()
        .map(|p| Regex::new(p).expect("static regex"))
        .collect()
    })
}

/// `isTestFileStrict`.
pub fn is_test_file_strict(path: &str) -> bool {
    test_file_res().iter().any(|re| re.is_match(path))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallSite {
    pub name: String,
    pub is_method_call: bool,
}

/// `extractCallSites`: call-pattern matches, then JSX, then PHP accessors, deduplicated on
/// (name, is_method_call) in first-seen order.
pub fn extract_call_sites(source: &str) -> Vec<CallSite> {
    let bytes = source.as_bytes();
    let mut out: Vec<CallSite> = Vec::new();
    let mut seen: std::collections::HashSet<(String, bool)> = std::collections::HashSet::new();
    let mut push = |name: &str, is_method_call: bool, out: &mut Vec<CallSite>| {
        if seen.insert((name.to_string(), is_method_call)) {
            out.push(CallSite {
                name: name.to_string(),
                is_method_call,
            });
        }
    };
    // isMethodCallAt: skip spaces/tabs backwards, then a `.` (with or without a preceding `?`).
    let is_method_call_at = |index: usize| -> bool {
        let mut i = index;
        while i > 0 && (bytes[i - 1] == b' ' || bytes[i - 1] == b'\t') {
            i -= 1;
        }
        i > 0 && bytes[i - 1] == b'.'
    };
    for caps in call_re().captures_iter(source) {
        let name = caps.get(1).expect("group 1").as_str();
        if KEYWORDS.contains(&name) || name.len() < MIN_CALL_NAME_LENGTH {
            continue;
        }
        let start = caps.get(0).expect("match").start();
        push(name, is_method_call_at(start), &mut out);
    }
    for caps in jsx_re().captures_iter(source) {
        let name = caps.get(1).expect("group 1").as_str();
        if name.len() >= MIN_CALL_NAME_LENGTH {
            push(name, false, &mut out);
        }
    }
    for caps in php_re().captures_iter(source) {
        let name = caps.get(1).expect("group 1").as_str();
        if !KEYWORDS.contains(&name) && name.len() >= MIN_CALL_NAME_LENGTH {
            push(name, true, &mut out);
        }
    }
    out
}

/// What [`CallGraph::impact_walk`] found; positions are node positions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImpactWalk {
    /// Every symbol in a changed file, in node order.
    pub changed: Vec<u32>,
    /// The affected symbols shown (changed first, then callers breadth-first), capped.
    pub affected: Vec<u32>,
    /// file -> files with callers of its symbols, at most `max_dependency_files` entries.
    pub dependency_graph: Vec<(String, Vec<String>)>,
    /// (test symbol, the callee that put its file in the result).
    pub test_hits: Vec<(u32, u32)>,
    /// Per `changed` entry: how many of its callers are in another file.
    pub changed_external_callers: Vec<u32>,
}

/// One graph, for one (database, skip_tests, filter_react_hooks).
pub struct CallGraph {
    node_count: usize,
    /// Two independent FNV-1a 32 hashes over every id in node order (UTF-16 units, NUL-separated) —
    /// the JS side recomputes them over `index.symbols` to prove its array matches node order before
    /// mapping positions onto it.
    id_hash: (u32, u32),
    callees: HashMap<String, Vec<u32>>,
    callers: HashMap<String, Vec<u32>>,
    edges: usize,
    /// Per node: its id and rowid, so a caller holding no index can name nodes and fetch them.
    ids: Vec<String>,
    rowids: Vec<i64>,
    /// Per node, an index into `files` — what `impact_analysis` asks of a node besides its id.
    file_of: Vec<u32>,
    files: Vec<String>,
    db_path: PathBuf,
}

struct Node {
    id: String,
    name: String,
    kind: String,
    file: String,
}

const FNV_OFFSET: u32 = 0x811c_9dc5;
const FNV_PRIME: u32 = 0x0100_0193;
const ALT_OFFSET: u32 = 0x5bd1_e995;

fn hash_ids<'a>(ids: impl Iterator<Item = &'a str>) -> (u32, u32) {
    let (mut a, mut b) = (FNV_OFFSET, ALT_OFFSET);
    for id in ids {
        for unit in id.encode_utf16().chain(std::iter::once(0u16)) {
            a = (a ^ u32::from(unit)).wrapping_mul(FNV_PRIME);
            b = (b ^ u32::from(unit)).wrapping_mul(FNV_PRIME);
        }
    }
    (a, b)
}

/// Rows per extraction batch: sources are read in batches so the whole table's text is never
/// resident at once, and each batch is scanned in parallel then applied in order.
const BATCH: usize = 8192;

impl CallGraph {
    pub fn build(db_path: &Path, skip_tests: bool, filter_react_hooks: bool) -> Result<CallGraph> {
        let conn = open(db_path)?;
        conn.execute_batch("BEGIN")?;
        let result = Self::build_in(&conn, skip_tests, filter_react_hooks);
        let _ = conn.execute_batch("COMMIT");
        let mut graph = result?;
        graph.db_path = db_path.to_path_buf();
        Ok(graph)
    }

    fn build_in(
        conn: &rusqlite::Connection,
        skip_tests: bool,
        filter_react_hooks: bool,
    ) -> Result<CallGraph> {
        // Pass 1: every symbol's identity, in rowid order (= `index.symbols` order).
        let mut nodes: Vec<Node> = Vec::new();
        let mut rowids: Vec<i64> = Vec::new();
        {
            let mut stmt =
                conn.prepare("SELECT rowid, id, name, kind, file FROM symbols ORDER BY rowid")?;
            let mut rows = stmt.query([])?;
            while let Some(r) = rows.next()? {
                rowids.push(r.get(0)?);
                nodes.push(Node {
                    id: r.get(1)?,
                    name: r.get(2)?,
                    kind: r.get(3)?,
                    file: r.get(4)?,
                });
            }
        }
        let id_hash = hash_ids(nodes.iter().map(|n| n.id.as_str()));
        let included: Vec<bool> = nodes
            .iter()
            .map(|n| !skip_tests || !is_test_file_strict(&n.file))
            .collect();

        // name -> callable targets, in symbol order.
        let mut name_to: HashMap<&str, Vec<u32>> = HashMap::new();
        for (i, n) in nodes.iter().enumerate() {
            if !included[i] || !CALLABLE_KINDS.contains(&n.kind.as_str()) {
                continue;
            }
            if n.name.encode_utf16().count() < MIN_CALL_NAME_LENGTH {
                continue;
            }
            name_to.entry(n.name.as_str()).or_default().push(i as u32);
        }

        // Pass 2: sources in batches, call sites extracted in parallel, edges applied in order.
        let mut callees: HashMap<String, Vec<u32>> = HashMap::new();
        let mut callers: HashMap<String, Vec<u32>> = HashMap::new();
        let mut edges = 0usize;
        let mut stmt = conn.prepare("SELECT source FROM symbols ORDER BY rowid")?;
        let mut rows = stmt.query([])?;
        let mut position = 0usize;
        loop {
            let mut batch: Vec<(usize, String)> = Vec::with_capacity(BATCH);
            let mut exhausted = false;
            while batch.len() < BATCH {
                match rows.next()? {
                    Some(r) => {
                        let source: Option<String> = r.get(0)?;
                        let i = position;
                        position += 1;
                        // `if (!sym.source) continue` — no source, or an empty one.
                        if included[i] {
                            if let Some(src) = source.filter(|s| !s.is_empty()) {
                                batch.push((i, src));
                            }
                        }
                    }
                    None => {
                        exhausted = true;
                        break;
                    }
                }
            }
            let sites: Vec<(usize, Vec<CallSite>)> = batch
                .into_par_iter()
                .map(|(i, src)| (i, extract_call_sites(&src)))
                .collect();
            for (i, call_sites) in sites {
                let caller_id = nodes[i].id.as_str();
                let mut sym_callees: Vec<u32> = Vec::new();
                for site in &call_sites {
                    if site.is_method_call {
                        continue;
                    }
                    if filter_react_hooks && REACT_STDLIB_HOOKS.contains(&site.name.as_str()) {
                        continue;
                    }
                    let Some(targets) = name_to.get(site.name.as_str()) else {
                        continue;
                    };
                    for &t in targets {
                        let target_id = nodes[t as usize].id.as_str();
                        if target_id == caller_id {
                            continue;
                        }
                        sym_callees.push(t);
                        callers
                            .entry(target_id.to_string())
                            .or_default()
                            .push(i as u32);
                        edges += 1;
                    }
                }
                if !sym_callees.is_empty() {
                    callees.insert(caller_id.to_string(), sym_callees);
                }
            }
            if exhausted {
                break;
            }
        }
        let mut files: Vec<String> = Vec::new();
        let mut file_index: HashMap<String, u32> = HashMap::new();
        let mut file_of: Vec<u32> = Vec::with_capacity(nodes.len());
        let mut ids: Vec<String> = Vec::with_capacity(nodes.len());
        for n in nodes {
            // Look up before inserting: `entry` would need an owned key, a clone per node.
            let f = match file_index.get(&n.file) {
                Some(&f) => f,
                None => {
                    let f = files.len() as u32;
                    file_index.insert(n.file.clone(), f);
                    files.push(n.file);
                    f
                }
            };
            file_of.push(f);
            ids.push(n.id);
        }
        Ok(CallGraph {
            node_count: ids.len(),
            id_hash,
            callees,
            callers,
            edges,
            ids,
            rowids,
            file_of,
            files,
            db_path: PathBuf::new(),
        })
    }

    pub fn node_count(&self) -> usize {
        self.node_count
    }

    pub fn id_hash(&self) -> (u32, u32) {
        self.id_hash
    }

    pub fn edge_count(&self) -> usize {
        self.edges
    }

    pub fn callees(&self, id: &str) -> Option<&[u32]> {
        self.callees.get(id).map(Vec::as_slice)
    }

    pub fn callers(&self, id: &str) -> Option<&[u32]> {
        self.callers.get(id).map(Vec::as_slice)
    }

    /// The ids of these node positions (out-of-range positions are an error).
    pub fn ids_at(&self, positions: &[u32]) -> Result<Vec<String>> {
        positions
            .iter()
            .map(|&p| {
                self.ids.get(p as usize).cloned().ok_or_else(|| StoreError {
                    sqlite_code: None,
                    message: format!("node {p} out of range"),
                })
            })
            .collect()
    }

    /// The file of each node position (out-of-range positions are an error).
    pub fn files_at(&self, positions: &[u32]) -> Result<Vec<String>> {
        positions
            .iter()
            .map(|&p| {
                self.file_of
                    .get(p as usize)
                    .map(|&f| self.files[f as usize].clone())
                    .ok_or_else(|| StoreError {
                        sqlite_code: None,
                        message: format!("node {p} out of range"),
                    })
            })
            .collect()
    }

    /// `impact_analysis`'s walks (impact-tools.ts `impactFromIndex`), done here so a 1.4M-node graph
    /// costs one call instead of several per node. Same visit order, same first-wins and
    /// insertion-order rules as the TypeScript Maps and Sets; see the fields of [`ImpactWalk`].
    pub fn impact_walk(
        &self,
        changed_files: &[String],
        max_depth: usize,
        max_affected: usize,
        max_dependency_files: usize,
    ) -> ImpactWalk {
        let file_idx: HashMap<&str, u32> = self
            .files
            .iter()
            .enumerate()
            .map(|(i, f)| (f.as_str(), i as u32))
            .collect();
        let changed_set: std::collections::HashSet<u32> = changed_files
            .iter()
            .filter_map(|f| file_idx.get(f.as_str()).copied())
            .collect();
        let changed: Vec<u32> = (0..self.file_of.len() as u32)
            .filter(|&p| changed_set.contains(&self.file_of[p as usize]))
            .collect();

        // findAffectedSymbols: a Map keyed by id — a repeated id keeps its slot and takes the later
        // node (`set` on a changed symbol), a caller is added only the first time its id is seen.
        let mut slot: HashMap<&str, usize> = HashMap::new();
        let mut affected: Vec<u32> = Vec::new();
        for &p in &changed {
            let id = self.ids[p as usize].as_str();
            match slot.get(id) {
                Some(&k) => affected[k] = p,
                None => {
                    slot.insert(id, affected.len());
                    affected.push(p);
                }
            }
        }
        // Only the first `max_affected` entries are ever read, and the walk only appends — so it stops
        // once they exist. The TypeScript walks on to the end and slices; on 556 changed files of a
        // 1.4M-node graph that was most of the 5 s the call took.
        let mut frontier = changed.clone();
        'walk: for _ in 0..max_depth {
            if affected.len() >= max_affected {
                break;
            }
            let mut next: Vec<u32> = Vec::new();
            for &p in &frontier {
                let Some(callers) = self.callers.get(self.ids[p as usize].as_str()) else {
                    continue;
                };
                for &c in callers {
                    let cid = self.ids[c as usize].as_str();
                    if !slot.contains_key(cid) {
                        slot.insert(cid, affected.len());
                        affected.push(c);
                        next.push(c);
                        if affected.len() >= max_affected {
                            break 'walk;
                        }
                    }
                }
            }
            if next.is_empty() {
                break;
            }
            frontier = next;
        }
        affected.truncate(max_affected);

        // changed files + the files of the affected symbols shown
        let mut affected_files: std::collections::HashSet<u32> = changed_set;
        for &p in &affected {
            affected_files.insert(self.file_of[p as usize]);
        }

        // buildFileDependencyGraph: files in order of their first symbol, dependents in first-seen order
        let mut groups: Vec<(u32, Vec<u32>)> = Vec::new();
        let mut group_of: HashMap<u32, usize> = HashMap::new();
        for p in 0..self.file_of.len() as u32 {
            let f = self.file_of[p as usize];
            if !affected_files.contains(&f) {
                continue;
            }
            match group_of.get(&f) {
                Some(&g) => groups[g].1.push(p),
                None => {
                    group_of.insert(f, groups.len());
                    groups.push((f, vec![p]));
                }
            }
        }
        let mut dependency_graph: Vec<(String, Vec<String>)> = Vec::new();
        for (f, nodes) in &groups {
            if dependency_graph.len() >= max_dependency_files {
                break;
            }
            let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
            let mut dependents: Vec<String> = Vec::new();
            for &p in nodes {
                let Some(callers) = self.callers.get(self.ids[p as usize].as_str()) else {
                    continue;
                };
                for &c in callers {
                    let cf = self.file_of[c as usize];
                    if cf != *f && seen.insert(cf) {
                        dependents.push(self.files[cf as usize].clone());
                    }
                }
            }
            if !dependents.is_empty() {
                dependency_graph.push((self.files[*f as usize].clone(), dependents));
            }
        }

        // findAffectedTests, indirect half: test files already counted (changed directly) are skipped,
        // and a file counts once — at its first symbol whose callees reach an affected file.
        let is_test: Vec<bool> = self.files.iter().map(|f| is_test_file_strict(f)).collect();
        let mut seen_tests: std::collections::HashSet<u32> = changed_files
            .iter()
            .filter(|f| is_test_file_strict(f))
            .filter_map(|f| file_idx.get(f.as_str()).copied())
            .collect();
        let mut test_hits: Vec<(u32, u32)> = Vec::new();
        for p in 0..self.file_of.len() as u32 {
            let f = self.file_of[p as usize];
            if !is_test[f as usize] || seen_tests.contains(&f) {
                continue;
            }
            let Some(callees) = self.callees.get(self.ids[p as usize].as_str()) else {
                continue;
            };
            if let Some(&c) = callees
                .iter()
                .find(|&&c| affected_files.contains(&self.file_of[c as usize]))
            {
                seen_tests.insert(f);
                test_hits.push((p, c));
            }
        }

        // calculateRiskScores: per changed symbol, its callers in other files
        let changed_external_callers = changed
            .iter()
            .map(|&p| {
                let f = self.file_of[p as usize];
                self.callers
                    .get(self.ids[p as usize].as_str())
                    .map_or(0, |cs| {
                        cs.iter()
                            .filter(|&&c| self.file_of[c as usize] != f)
                            .count()
                    }) as u32
            })
            .collect();

        ImpactWalk {
            changed,
            affected,
            dependency_graph,
            test_hits,
            changed_external_callers,
        }
    }

    /// `(callers, callees)` list lengths for each id, 0 where the map has no entry — what
    /// `classifySymbolRoles` reads off the TypeScript maps.
    pub fn degrees(&self, ids: &[String]) -> Vec<u32> {
        let mut out = Vec::with_capacity(ids.len() * 2);
        for id in ids {
            out.push(self.callers.get(id).map_or(0, Vec::len) as u32);
            out.push(self.callees.get(id).map_or(0, Vec::len) as u32);
        }
        out
    }

    /// The symbols at these node positions, in order, read from the database the graph was built
    /// from. Each row is checked against the id the graph recorded, so a write since the build is an
    /// error rather than a different symbol.
    pub fn symbols_json(&self, positions: &[u32], with_source: bool) -> Result<Vec<String>> {
        let ids = self.ids_at(positions)?;
        let rowids: Vec<i64> = positions.iter().map(|&p| self.rowids[p as usize]).collect();
        symbols_by_rowid_json(&self.db_path, &rowids, Some(&ids), with_source)
    }

    /// Resident bytes, counted from the containers (for the cache budget and `/health`).
    pub fn footprint_bytes(&self) -> usize {
        let map = |m: &HashMap<String, Vec<u32>>| -> usize {
            m.iter()
                .map(|(k, v)| k.capacity() + v.capacity() * 4 + 48)
                .sum::<usize>()
        };
        map(&self.callees)
            + map(&self.callers)
            + self.ids.iter().map(|s| s.capacity() + 24).sum::<usize>()
            + self.rowids.capacity() * 8
            + self.file_of.capacity() * 4
            + self.files.iter().map(|s| s.capacity() + 24).sum::<usize>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(src: &str) -> Vec<(String, bool)> {
        extract_call_sites(src)
            .into_iter()
            .map(|c| (c.name, c.is_method_call))
            .collect()
    }

    // Expected values are what graph-tools.ts `extractCallSites` returns for the same input (run
    // against the TypeScript implementation, not reasoned out).
    #[test]
    fn call_sites_in_js_order_with_method_flags_and_dedupe() {
        assert_eq!(
            names("foo(); obj.bar(); a?.baz(x); foo(); if (x) {} <Widget a={1}/> $this->run(); Cls::make();"),
            vec![
                ("foo".into(), false),
                ("bar".into(), true),
                ("baz".into(), true),
                ("run".into(), false),
                ("make".into(), false),
                ("Widget".into(), false),
                ("run".into(), true),
                ("make".into(), true),
            ]
        );
    }

    #[test]
    fn generics_spaces_keywords_short_names_and_jsx_from_a_generic() {
        assert_eq!(
            names("useThing<Props>(x); go (1); id(2); return(3); obj . spaced(4);"),
            vec![
                ("useThing".into(), false),
                ("spaced".into(), true),
                ("Props".into(), false)
            ]
        );
    }

    #[test]
    fn js_whitespace_includes_bom_but_not_nel() {
        assert_eq!(names("call\u{FEFF}(1)"), vec![("call".into(), false)]);
        assert!(names("call\u{0085}(1)").is_empty());
    }

    #[test]
    fn ascii_word_boundary_around_dollar() {
        // `\b` cannot sit between a space and `$`, so ` $xyz(` matches from the `x`.
        assert_eq!(names("a$xyz(1)"), vec![("a$xyz".into(), false)]);
        assert_eq!(names(" $xyz(1)"), vec![("xyz".into(), false)]);
    }

    #[test]
    fn strict_test_files() {
        assert!(is_test_file_strict("src/a.test.ts"));
        assert!(is_test_file_strict("pkg/__tests__/x.js"));
        assert!(is_test_file_strict("app/src/androidTest/A.kt"));
        assert!(is_test_file_strict("UserSpec.kt"));
        assert!(!is_test_file_strict("src/test-utils.ts"));
        assert!(!is_test_file_strict("src/latest.ts"));
    }
}
