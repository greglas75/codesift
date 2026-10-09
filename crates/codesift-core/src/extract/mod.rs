//! Symbol extraction on native tree-sitter (ADR-006 stage 3).
//!
//! Each language module is a port of its TypeScript extractor whose output must be the SAME symbols —
//! same ids, kinds, lines, offsets, source text, key order. The trees come from the same grammar
//! versions the shipped `.wasm` files were built from (verified by hash) and the same tree-sitter
//! runtime version as `web-tree-sitter`.
//!
//! **Everything positional is UTF-16.** web-tree-sitter parses a JS string, so `startIndex`, the stored
//! `start_byte`/`end_byte`, `source.slice(...)` and the 5,000-character truncation all count UTF-16
//! code units. Sources are parsed with `parse_utf16_le` and every offset here is a code-unit index.

pub mod generic;
pub mod go;
pub mod kotlin;
pub mod php;
pub mod python;
pub mod rust;
pub mod ts;

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tree_sitter::{Language, Node, ParseOptions, ParseState, Parser, Tree};

/// `MAX_SOURCE_LENGTH` of `_shared.ts`, in UTF-16 code units.
pub const MAX_SOURCE_LENGTH: usize = 5000;

/// A source text as web-tree-sitter sees it: UTF-16 code units.
pub struct Utf16Source {
    units: Vec<u16>,
}

impl Utf16Source {
    pub fn new(units: Vec<u16>) -> Self {
        Utf16Source { units }
    }

    pub fn from_text(s: &str) -> Self {
        Utf16Source {
            units: s.encode_utf16().collect(),
        }
    }

    pub fn len(&self) -> usize {
        self.units.len()
    }

    pub fn is_empty(&self) -> bool {
        self.units.is_empty()
    }

    pub fn units(&self) -> &[u16] {
        &self.units
    }

    /// `source.slice(start, end)`, clamped like JS. A lone surrogate at a cut becomes U+FFFD —
    /// the character SQLite stores for the TypeScript path's lone surrogate too.
    pub fn slice(&self, start: usize, end: usize) -> String {
        let end = end.min(self.units.len());
        let start = start.min(end);
        String::from_utf16_lossy(&self.units[start..end])
    }

    /// A node's `.text`.
    pub fn text(&self, node: Node<'_>) -> String {
        self.slice(start_index(node), end_index(node))
    }
}

/// `node.startIndex` — a UTF-16 code-unit index (the parse input is UTF-16, so tree-sitter's byte
/// offsets are twice it).
pub fn start_index(node: Node<'_>) -> usize {
    node.start_byte() / 2
}

pub fn end_index(node: Node<'_>) -> usize {
    node.end_byte() / 2
}

/// Code-unit length of a string, as `String.prototype.length` measures it.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `extractNodeSource`: the node's text, cut at `MAX_SOURCE_LENGTH` units plus `"..."`.
///
/// Slices only the units it keeps. Copying the whole node first and truncating after is O(node) per
/// symbol — and Go names every spec of a `const (...)` block after the WHOLE block, so a large block
/// made that quadratic (the Go stdlib took 2.2x the TypeScript time). V8's `slice` is O(1) there.
pub fn node_source(src: &Utf16Source, node: Node<'_>) -> String {
    let start = start_index(node);
    let end = end_index(node);
    if end - start <= MAX_SOURCE_LENGTH {
        return src.slice(start, end);
    }
    let mut out = src.slice(start, start + MAX_SOURCE_LENGTH);
    out.push_str("...");
    out
}

/// `text.length > MAX ? text.slice(0, MAX) + "..." : text`, in code units.
pub fn truncate_source(text: String) -> String {
    if utf16_len(&text) <= MAX_SOURCE_LENGTH {
        return text;
    }
    let units: Vec<u16> = text.encode_utf16().take(MAX_SOURCE_LENGTH).collect();
    let mut out = String::from_utf16_lossy(&units);
    out.push_str("...");
    out
}

/// JS `WhiteSpace` + `LineTerminator` — the set `trim`, `trimEnd` and regex `\s` use. Not Rust's
/// `char::is_whitespace`: JS includes U+FEFF and excludes U+0085.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

pub fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_space)
}

/// `s.replace(/^['"`]|['"`]$/g, "")`: at most one leading and one trailing quote character.
pub fn strip_quotes(s: &str) -> String {
    let is_q = |c: char| c == '\'' || c == '"' || c == '`';
    let mut out = s;
    if out.starts_with(is_q) {
        out = &out[1..];
    }
    // `$` with /g matches at the end of the ORIGINAL string; when a one-character string was a
    // quote, the leading match already consumed it and nothing is left to strip.
    if out.ends_with(is_q) && !(s.len() == 1 && s.starts_with(is_q)) {
        out = &out[..out.len() - 1];
    }
    out.to_string()
}

/// Parse UTF-16 source with a wall-clock budget (`CODESIFT_PARSE_TIMEOUT_MS` on the JS side).
/// `TimedOut` when the budget ran out — like the TypeScript path's rejected race — and also when the
/// grammar cannot be loaded at all, which the JS side handles the same way (no symbols, one warning);
/// `TooDeep` when the tree is past `MAX_TREE_DEPTH`.
pub fn parse_utf16(
    language: &Language,
    src: &Utf16Source,
    timeout: Duration,
) -> Result<Tree, ParseFailure> {
    let mut parser = Parser::new();
    parser
        .set_language(language)
        .map_err(|_| ParseFailure::TimedOut)?;
    let started = Instant::now();
    let mut progress = |_: &ParseState| {
        if started.elapsed() > timeout {
            std::ops::ControlFlow::Break(())
        } else {
            std::ops::ControlFlow::Continue(())
        }
    };
    let options = ParseOptions::new().progress_callback(&mut progress);
    let units = src.units();
    // The binding hands the callback a CODE-UNIT offset (it divides tree-sitter's byte offset by 2
    // itself) — halving it again here returned text from the wrong place on every read past the
    // first, and the trees diverged from web-tree-sitter's late in a file.
    let tree = parser
        .parse_utf16_le_with_options(
            &mut |i, _| if i < units.len() { &units[i..] } else { &[] },
            None,
            Some(options),
        )
        .ok_or(ParseFailure::TimedOut)?;
    if tree_depth(&tree) > MAX_TREE_DEPTH {
        return Err(ParseFailure::TooDeep);
    }
    Ok(tree)
}

/// `node.namedChildren`.
pub fn named_children<'t>(node: Node<'t>) -> Vec<Node<'t>> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).collect()
}

/// `node.children` (anonymous nodes included).
pub fn children<'t>(node: Node<'t>) -> Vec<Node<'t>> {
    let mut cursor = node.walk();
    node.children(&mut cursor).collect()
}

/// `node.descendantsOfType(kind)`: every descendant of that type, in document order.
pub fn descendants_of_type<'t>(node: Node<'t>, kind: &str) -> Vec<Node<'t>> {
    let mut out = Vec::new();
    let mut stack: Vec<Node<'t>> = children(node).into_iter().rev().collect();
    while let Some(n) = stack.pop() {
        if n.kind() == kind {
            out.push(n);
        }
        let mut kids = children(n);
        kids.reverse();
        stack.extend(kids);
    }
    out
}

/// One metadata value; `meta` holds only booleans, integers and string lists.
#[derive(Debug, Clone, PartialEq)]
pub enum Meta {
    Bool(bool),
    Int(i64),
    Strs(Vec<String>),
    Str(String),
    /// PHP attributes: `[{name, args?}]`, keys in that order.
    Attrs(Vec<(String, Option<String>)>),
}

/// A `CodeSymbol` as `makeSymbol` builds it.
#[derive(Debug, Clone, PartialEq)]
pub struct Sym {
    pub id: String,
    pub name: String,
    pub kind: &'static str,
    pub start_line: usize,
    pub end_line: usize,
    /// `None` only for the generic extractor, whose symbols never carried byte offsets.
    pub start_byte: Option<usize>,
    pub end_byte: Option<usize>,
    pub source: String,
    pub tokens: Vec<String>,
    pub docstring: Option<String>,
    pub parent: Option<String>,
    pub signature: Option<String>,
    pub decorators: Vec<String>,
    pub extends: Vec<String>,
    pub implements: Vec<String>,
    pub is_async: bool,
    /// Set at creation (`is_exported: true` in the options).
    pub is_exported: bool,
    /// Set by the export post-pass on a symbol that had no `is_exported` key: serialised LAST.
    pub exported_late: bool,
    pub meta: Vec<(&'static str, Meta)>,
}

#[derive(Default)]
pub struct Opts {
    pub parent: Option<String>,
    pub docstring: Option<String>,
    pub signature: Option<String>,
    pub decorators: Vec<String>,
    pub extends: Vec<String>,
    pub implements: Vec<String>,
    pub is_async: bool,
    pub is_exported: bool,
    pub meta: Vec<(&'static str, Meta)>,
}

/// `makeSymbol` of `_shared.ts`. Truthiness is the caller's contract there and is applied here:
/// an empty docstring, parent or signature is left out, as `if (opts?.docstring)` leaves it out.
#[allow(clippy::too_many_arguments)]
pub fn make_symbol(
    src: &Utf16Source,
    file: &str,
    repo: &str,
    node: Node<'_>,
    name: String,
    kind: &'static str,
    opts: Opts,
) -> Sym {
    let start_line = node.start_position().row + 1;
    let id = format!("{repo}:{file}:{name}:{start_line}");
    let source = node_source(src, node);
    let tokens = crate::bm25::tokenize_identifier(&name);
    Sym {
        id,
        kind,
        start_line,
        end_line: node.end_position().row + 1,
        start_byte: Some(start_index(node)),
        end_byte: Some(end_index(node)),
        source,
        tokens,
        name,
        docstring: opts.docstring.filter(|s| !s.is_empty()),
        parent: opts.parent.filter(|s| !s.is_empty()),
        signature: opts.signature.filter(|s| !s.is_empty()),
        decorators: opts.decorators,
        extends: opts.extends,
        implements: opts.implements,
        is_async: opts.is_async,
        is_exported: opts.is_exported,
        exported_late: false,
        meta: opts.meta,
    }
}

/// Set a meta key the way a JS object assignment does: an existing key keeps its position and takes
/// the new value; a new key goes last.
pub fn meta_set(meta: &mut Vec<(&'static str, Meta)>, key: &'static str, value: Meta) {
    match meta.iter_mut().find(|(k, _)| *k == key) {
        Some(entry) => entry.1 = value,
        None => meta.push((key, value)),
    }
}

// ---------------------------------------------------------------------------------------------
// Serialisation — `makeSymbol`'s key order, then a late `is_exported`
// ---------------------------------------------------------------------------------------------

/// Append the symbols as a JSON array, in `makeSymbol`'s key order.
pub fn write_json(symbols: &[Sym], repo: &str, file: &str, out: &mut String) {
    use std::fmt::Write;
    let q = |s: &str| serde_json::to_string(s).expect("string serialises");
    let qs = |v: &[String]| serde_json::to_string(v).expect("strings serialise");
    out.push('[');
    for (i, s) in symbols.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        let _ = write!(
            out,
            "{{\"id\":{},\"repo\":{},\"name\":{},\"kind\":\"{}\",\"file\":{},\"start_line\":{},\"end_line\":{}",
            q(&s.id),
            q(repo),
            q(&s.name),
            s.kind,
            q(file),
            s.start_line,
            s.end_line,
        );
        if let (Some(sb), Some(eb)) = (s.start_byte, s.end_byte) {
            let _ = write!(out, ",\"start_byte\":{sb},\"end_byte\":{eb}");
        }
        let _ = write!(
            out,
            ",\"source\":{},\"tokens\":{}",
            q(&s.source),
            qs(&s.tokens)
        );
        if let Some(d) = &s.docstring {
            let _ = write!(out, ",\"docstring\":{}", q(d));
        }
        if let Some(p) = &s.parent {
            let _ = write!(out, ",\"parent\":{}", q(p));
        }
        if let Some(sig) = &s.signature {
            let _ = write!(out, ",\"signature\":{}", q(sig));
        }
        if !s.decorators.is_empty() {
            let _ = write!(out, ",\"decorators\":{}", qs(&s.decorators));
        }
        if !s.extends.is_empty() {
            let _ = write!(out, ",\"extends\":{}", qs(&s.extends));
        }
        if !s.implements.is_empty() {
            let _ = write!(out, ",\"implements\":{}", qs(&s.implements));
        }
        if s.is_async {
            out.push_str(",\"is_async\":true");
        }
        if s.is_exported {
            out.push_str(",\"is_exported\":true");
        }
        if !s.meta.is_empty() {
            out.push_str(",\"meta\":{");
            for (j, (k, v)) in s.meta.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                let _ = write!(out, "\"{k}\":");
                match v {
                    Meta::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
                    Meta::Int(n) => {
                        let _ = write!(out, "{n}");
                    }
                    Meta::Str(t) => out.push_str(&q(t)),
                    Meta::Strs(list) => out.push_str(&qs(list)),
                    Meta::Attrs(list) => {
                        out.push('[');
                        for (n, (name, args)) in list.iter().enumerate() {
                            if n > 0 {
                                out.push(',');
                            }
                            let _ = write!(out, "{{\"name\":{}", q(name));
                            if let Some(a) = args {
                                let _ = write!(out, ",\"args\":{}", q(a));
                            }
                            out.push('}');
                        }
                        out.push(']');
                    }
                }
            }
            out.push('}');
        }
        if s.exported_late {
            out.push_str(",\"is_exported\":true");
        }
        out.push('}');
    }
    out.push(']');
}

/// One file's symbols, before serialisation.
#[derive(Default)]
pub struct Extracted {
    pub symbols: Vec<Sym>,
    /// The tree had syntax errors (the TypeScript extractor warns about it).
    pub has_error: bool,
    /// The parse was abandoned at the timeout; the TypeScript path logs and indexes nothing.
    pub timed_out: bool,
    /// Messages the TypeScript extractor would have `console.warn`ed; the JS side prints them.
    pub warnings: Vec<String>,
    /// The tree was deeper than `MAX_TREE_DEPTH`, so nothing was extracted (see `parse_utf16`).
    pub too_deep: bool,
}

/// Why `parse_utf16` produced no tree to walk.
pub enum ParseFailure {
    TimedOut,
    TooDeep,
}

impl From<ParseFailure> for Extracted {
    fn from(f: ParseFailure) -> Self {
        Extracted {
            timed_out: matches!(f, ParseFailure::TimedOut),
            too_deep: matches!(f, ParseFailure::TooDeep),
            ..Extracted::default()
        }
    }
}

/// Deepest syntax tree the (recursive) walkers are handed.
///
/// The extractors recurse once per tree level, as their TypeScript originals do. In TypeScript a
/// pathological tree (a generated file nesting thousands of levels) overflows the JS stack, the
/// RangeError is caught, and that ONE file fails. In Rust a stack overflow aborts the process — the
/// daemon or the index child, every client with it (measured: 1,000,000 nested brackets in one `.js`
/// file → SIGABRT). The rayon pool's 64 MB stacks hold far more than V8's ~10k frames, so this bound
/// only rejects trees the TypeScript path already failed on.
pub const MAX_TREE_DEPTH: usize = 20_000;

/// Depth of the deepest node, walked with a cursor (no recursion, so it cannot overflow itself).
fn tree_depth(tree: &Tree) -> usize {
    let mut cursor = tree.walk();
    let (mut depth, mut max) = (1usize, 1usize);
    loop {
        if cursor.goto_first_child() {
            depth += 1;
            max = max.max(depth);
            if max > MAX_TREE_DEPTH {
                return max;
            }
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return max;
            }
            depth -= 1;
        }
    }
}

/// One file's extraction, serialised: the symbols as a JSON array in `makeSymbol` key order.
pub struct ExtractOutput {
    pub json: String,
    pub has_error: bool,
    pub timed_out: bool,
    pub warnings: Vec<String>,
}

/// Threads with stacks large enough for any real syntax tree. The walks are recursive, like the
/// TypeScript ones; a pool thread's default stack (512 KB for a secondary thread on macOS) would
/// overflow on deeply nested code and ABORT the process, where V8 throws a RangeError the TypeScript
/// extractor catches. 64 MB holds trees far deeper than V8's stack does, so on a pathological file
/// these extractors return every symbol where the TypeScript ones return a partial list.
fn pool() -> &'static rayon::ThreadPool {
    static POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();
    POOL.get_or_init(|| {
        rayon::ThreadPoolBuilder::new()
            .stack_size(64 << 20)
            .thread_name(|i| format!("codesift-extract-{i}"))
            .build()
            .expect("extract thread pool")
    })
}

/// Languages with a native extractor — the JS side routes only these here.
pub const LANGUAGES: [&str; 7] = [
    "typescript",
    "tsx",
    "javascript",
    "python",
    "go",
    "rust",
    "php",
];

/// Parse and extract one file. `None` for a language without a native extractor.
pub fn extract_to_json(
    source: &str,
    file: &str,
    repo: &str,
    language: &str,
    timeout: Duration,
) -> Option<ExtractOutput> {
    pool().install(|| {
        let src = Utf16Source::from_text(source);
        let extracted = match language {
            "typescript" | "tsx" | "javascript" => {
                ts::extract(&src, file, repo, language, timeout)?
            }
            "python" => python::extract(&src, file, repo, timeout),
            "go" => go::extract(&src, file, repo, timeout),
            "rust" => rust::extract(&src, file, repo, timeout),
            "php" => php::extract(&src, file, repo, timeout),
            "kotlin" => kotlin::extract(&src, file, repo, timeout),
            "gradle-kts" => kotlin::extract_gradle_kts(&src, file, repo, timeout),
            "java" | "ruby" | "css" => generic::extract(&src, file, repo, language, timeout)?,
            _ => return None,
        };
        let mut warnings = extracted.warnings;
        if extracted.too_deep {
            warnings.push(format!(
                "[parser] {file}: syntax tree deeper than {MAX_TREE_DEPTH} levels — no symbols extracted"
            ));
        }
        let mut json = String::new();
        write_json(&extracted.symbols, repo, file, &mut json);
        Some(ExtractOutput {
            json,
            has_error: extracted.has_error,
            timed_out: extracted.timed_out,
            warnings,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Bug it catches: a walker recursing into a 1,000,000-level tree overflowed the stack and aborted the
    // whole process (daemon or index child) — TypeScript fails that one file with a caught RangeError.
    #[test]
    fn a_tree_deeper_than_the_bound_is_skipped_with_a_warning_not_a_crash() {
        let source = format!("x = {}1{};", "[".repeat(1_000_000), "]".repeat(1_000_000));
        let out = extract_to_json(
            &source,
            "deep.js",
            "r",
            "javascript",
            Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(out.json, "[]");
        assert!(!out.timed_out);
        assert!(
            out.warnings
                .iter()
                .any(|w| w.contains("deep.js") && w.contains("deeper than")),
            "{:?}",
            out.warnings
        );
    }

    #[test]
    fn strip_quotes_matches_the_regex() {
        assert_eq!(strip_quotes("'a'"), "a");
        assert_eq!(strip_quotes("`tpl`"), "tpl");
        assert_eq!(strip_quotes("plain"), "plain");
        assert_eq!(strip_quotes("'"), "");
        assert_eq!(strip_quotes("''"), "");
        assert_eq!(strip_quotes("'a"), "a");
    }

    #[test]
    fn truncation_counts_utf16_units() {
        let s = format!("{}🚀tail", "a".repeat(4999));
        let t = truncate_source(s);
        // The emoji straddles the limit: its high surrogate is kept by JS, U+FFFD here.
        assert_eq!(t, format!("{}\u{FFFD}...", "a".repeat(4999)));
        assert_eq!(truncate_source("short".into()), "short");
    }

    #[test]
    fn js_whitespace_is_not_rusts() {
        assert_eq!(js_trim("\u{FEFF} x \u{0085}"), "x \u{0085}");
    }
}
