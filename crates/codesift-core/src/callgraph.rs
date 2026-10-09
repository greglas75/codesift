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
use std::path::Path;
use std::sync::OnceLock;

use rayon::prelude::*;
use regex::Regex;

use crate::store::{open, Result};

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
        result
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
        let _ = rowids;
        Ok(CallGraph {
            node_count: nodes.len(),
            id_hash,
            callees,
            callers,
            edges,
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

    /// Resident bytes, counted from the containers (for the cache budget and `/health`).
    pub fn footprint_bytes(&self) -> usize {
        let map = |m: &HashMap<String, Vec<u32>>| -> usize {
            m.iter()
                .map(|(k, v)| k.capacity() + v.capacity() * 4 + 48)
                .sum::<usize>()
        };
        map(&self.callees) + map(&self.callers)
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
