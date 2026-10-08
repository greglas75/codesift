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
/// `None` on timeout, like the TypeScript path's rejected race.
pub fn parse_utf16(language: &Language, src: &Utf16Source, timeout: Duration) -> Option<Tree> {
    let mut parser = Parser::new();
    parser.set_language(language).ok()?;
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
    parser.parse_utf16_le_with_options(
        &mut |i, _| if i < units.len() { &units[i..] } else { &[] },
        None,
        Some(options),
    )
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

/// One file's extraction, serialised: the symbols as a JSON array in `makeSymbol` key order.
pub struct ExtractOutput {
    pub json: String,
    pub has_error: bool,
    pub timed_out: bool,
}

/// Threads with stacks large enough for any real syntax tree. The walk is recursive, like the
/// TypeScript one; a pool thread's default stack (512 KB for a secondary thread on macOS) would
/// overflow on deeply nested code and ABORT the process, where V8 throws a RangeError the TypeScript
/// extractor catches. 64 MB holds trees far deeper than V8's stack does, so on a pathological file this
/// extractor returns every symbol where the TypeScript one returns a partial list.
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

/// Parse and extract one file. `None` for a language this module does not handle.
pub fn extract_to_json(
    source: &str,
    file: &str,
    repo: &str,
    language: &str,
    timeout: Duration,
) -> Option<ExtractOutput> {
    pool().install(|| {
        let src = Utf16Source::from_text(source);
        let extracted = ts::extract(&src, file, repo, language, timeout)?;
        let mut json = String::new();
        ts::write_json(&extracted.symbols, repo, file, &mut json);
        Some(ExtractOutput {
            json,
            has_error: extracted.has_error,
            timed_out: extracted.timed_out,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
