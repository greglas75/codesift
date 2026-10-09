//! Python symbols — a port of `src/parser/extractors/python.ts`.
//!
//! Load-bearing quirks carried over from the TypeScript, each visible in its output:
//! * the depth counter restarts at 0 inside a PLAIN class body (`walk(child, sym.id)` passes no depth)
//!   but not inside a decorated one;
//! * a decorated function's body is walked with the OUTER parent id, a plain function's with its own;
//! * `__all__` members of a computed expression are collected by a stack (last child first);
//! * decorator metadata keys keep the order of their first assignment.

use std::time::Duration;

use regex::Regex;
use tree_sitter::Node;

use super::{
    children, js_trim, make_symbol, meta_set, named_children, parse_utf16, Extracted, Meta, Opts,
    Sym, Utf16Source,
};

const MAX_WALK_DEPTH: usize = 200;

struct Ctx<'s> {
    src: &'s Utf16Source,
    file: &'s str,
    repo: &'s str,
    symbols: Vec<Sym>,
    warnings: Vec<String>,
}

pub fn extract(src: &Utf16Source, file: &str, repo: &str, timeout: Duration) -> Extracted {
    let lang: tree_sitter::Language = tree_sitter_python::LANGUAGE.into();
    let tree = match parse_utf16(&lang, src, timeout) {
        Ok(tree) => tree,
        Err(failure) => return failure.into(),
    };
    let mut ctx = Ctx {
        src,
        file,
        repo,
        symbols: Vec::new(),
        warnings: Vec::new(),
    };
    walk(&mut ctx, tree.root_node(), None, 0);
    Extracted {
        symbols: ctx.symbols,
        warnings: ctx.warnings,
        ..Extracted::default()
    }
}

fn sym(ctx: &Ctx<'_>, node: Node<'_>, name: String, kind: &'static str, opts: Opts) -> Sym {
    make_symbol(ctx.src, ctx.file, ctx.repo, node, name, kind, opts)
}

/// `getNodeName` without truthiness (callers decide).
fn node_name(ctx: &Ctx<'_>, node: Node<'_>) -> Option<String> {
    node.child_by_field_name("name").map(|n| ctx.src.text(n))
}

/// `getDocstring`: the body's first named child, when it is an expression statement whose first named
/// child is a string.
fn docstring(ctx: &Ctx<'_>, node: Node<'_>) -> Option<String> {
    let body = node.child_by_field_name("body")?;
    let first = named_children(body).into_iter().next()?;
    if first.kind() != "expression_statement" {
        return None;
    }
    let expr = named_children(first).into_iter().next()?;
    (expr.kind() == "string").then(|| ctx.src.text(expr))
}

fn signature(ctx: &Ctx<'_>, node: Node<'_>) -> Option<String> {
    let params = node.child_by_field_name("parameters")?;
    let mut sig = ctx.src.text(params);
    if let Some(rt) = node.child_by_field_name("return_type") {
        sig.push_str(" -> ");
        sig.push_str(&ctx.src.text(rt));
    }
    Some(sig)
}

fn is_test_case_class(ctx: &Ctx<'_>, node: Node<'_>) -> bool {
    let Some(sc) = node.child_by_field_name("superclasses") else {
        return false;
    };
    named_children(sc).iter().any(|a| {
        let t = ctx.src.text(*a);
        t == "TestCase" || t == "unittest.TestCase"
    })
}

fn superclasses(ctx: &Ctx<'_>, node: Node<'_>) -> Vec<String> {
    let Some(sc) = node.child_by_field_name("superclasses") else {
        return Vec::new();
    };
    named_children(sc)
        .into_iter()
        .filter(|a| a.kind() != "keyword_argument")
        .map(|a| ctx.src.text(a))
        .collect()
}

fn classify_function(name: &str, parent: Option<&str>, decorator_texts: &[String]) -> &'static str {
    if decorator_texts
        .iter()
        .any(|t| t.contains("pytest.fixture") || t.contains("@fixture"))
    {
        return "test_hook";
    }
    if name.starts_with("test_") {
        return "test_case";
    }
    if parent.is_some_and(|p| !p.is_empty()) {
        return "method";
    }
    "function"
}

/// `/^[A-Z][A-Z0-9_]*$/`
fn is_screaming(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b[0].is_ascii_uppercase()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'_')
}

/// `/^__\w+__$/` (JS `\w` is ASCII).
fn is_dunder(name: &str) -> bool {
    name.len() >= 5
        && name.starts_with("__")
        && name.ends_with("__")
        && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

fn list_string_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)^[bruf]*('{3}|"{3}|['"])|'{3}|"{3}|['"]$"#).expect("static regex")
    })
}

fn quote_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"^['"]|['"]$"#).expect("static regex"))
}

/// `parseAllAssignment`.
fn parse_all(ctx: &Ctx<'_>, rhs: Node<'_>) -> (Vec<String>, bool) {
    if rhs.kind() == "list" || rhs.kind() == "tuple" {
        let mut members = Vec::new();
        let mut computed = false;
        for el in named_children(rhs) {
            if el.kind() == "string" {
                members.push(
                    list_string_re()
                        .replace_all(&ctx.src.text(el), "")
                        .into_owned(),
                );
            } else {
                computed = true;
            }
        }
        return (members, computed);
    }
    let mut members = Vec::new();
    let mut stack = vec![rhs];
    while let Some(n) = stack.pop() {
        if n.kind() == "string" {
            members.push(quote_re().replace_all(&ctx.src.text(n), "").into_owned());
            continue;
        }
        stack.extend(named_children(n));
    }
    (members, true)
}

/// `classifyDecorators`.
fn classify_decorators(texts: &[String]) -> Vec<(&'static str, Meta)> {
    let mut meta = Vec::new();
    for d in texts {
        if d == "@abstractmethod" || d.starts_with("@abstractmethod(") {
            meta_set(&mut meta, "is_abstract", Meta::Bool(true));
        }
        if (d == "@dataclass" || d.starts_with("@dataclass(")) && d.contains("frozen=True") {
            meta_set(&mut meta, "dataclass_frozen", Meta::Bool(true));
        }
        if let Some(kind) = accessor_kind(d) {
            meta_set(&mut meta, "property_accessor", Meta::Str(kind.to_string()));
        }
    }
    meta
}

/// `/^@\w+\.(setter|deleter|getter)\b/`
fn accessor_kind(d: &str) -> Option<&'static str> {
    let rest = d.strip_prefix('@')?;
    let word_len = rest
        .bytes()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == b'_')
        .count();
    // `\w+` is greedy but backtracks: the last `.` inside a word run cannot occur (`.` is not `\w`),
    // so the first `.` after the word is the only candidate.
    if word_len == 0 {
        return None;
    }
    let after = rest[word_len..].strip_prefix('.')?;
    for kind in ["setter", "deleter", "getter"] {
        if let Some(tail) = after.strip_prefix(kind) {
            if !tail
                .bytes()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == b'_')
            {
                return Some(kind);
            }
        }
    }
    None
}

fn is_async(node: Node<'_>) -> bool {
    node.kind() == "async_function_definition" || children(node).iter().any(|c| c.kind() == "async")
}

fn walk(ctx: &mut Ctx<'_>, node: Node<'_>, parent: Option<&str>, depth: usize) {
    if depth > MAX_WALK_DEPTH {
        ctx.warnings.push(format!(
            "[python-extractor] MAX_WALK_DEPTH ({MAX_WALK_DEPTH}) hit at {}:{} — deeper symbols dropped",
            ctx.file,
            node.start_position().row + 1
        ));
        return;
    }
    match node.kind() {
        "expression_statement" => {
            if expression_statement(ctx, node, parent) {
                return;
            }
        }
        "async_function_definition" | "function_definition" => {
            if let Some(name) = node_name(ctx, node).filter(|n| !n.is_empty()) {
                let mut meta = Vec::new();
                if is_dunder(&name) {
                    meta.push(("is_dunder", Meta::Bool(true)));
                }
                let kind = classify_function(&name, parent, &[]);
                let opts = Opts {
                    parent: parent.map(str::to_string),
                    docstring: docstring(ctx, node),
                    signature: signature(ctx, node),
                    is_async: is_async(node),
                    meta,
                    ..Opts::default()
                };
                let s = sym(ctx, node, name, kind, opts);
                let id = s.id.clone();
                ctx.symbols.push(s);
                if let Some(body) = node.child_by_field_name("body") {
                    for child in named_children(body) {
                        walk(ctx, child, Some(&id), depth + 1);
                    }
                }
            }
            return;
        }
        "class_definition" => {
            let name = node_name(ctx, node).unwrap_or_else(|| "<anonymous>".to_string());
            let kind = if is_test_case_class(ctx, node) {
                "test_suite"
            } else {
                "class"
            };
            let opts = Opts {
                parent: parent.map(str::to_string),
                docstring: docstring(ctx, node),
                extends: superclasses(ctx, node),
                ..Opts::default()
            };
            let s = sym(ctx, node, name, kind, opts);
            let id = s.id.clone();
            ctx.symbols.push(s);
            if let Some(body) = node.child_by_field_name("body") {
                for child in named_children(body) {
                    walk(ctx, child, Some(&id), 0);
                }
            }
            return;
        }
        "decorated_definition" => {
            let mut decorators: Vec<Node<'_>> = Vec::new();
            let mut inner: Option<Node<'_>> = None;
            for child in named_children(node) {
                if child.kind() == "decorator" {
                    decorators.push(child);
                } else {
                    inner = Some(child);
                }
            }
            if let Some(inner) = inner {
                decorated(ctx, node, inner, &decorators, parent, depth);
                return;
            }
        }
        _ => {}
    }
    for child in named_children(node) {
        walk(ctx, child, parent, depth + 1);
    }
}

/// The `expression_statement` case; `true` = return (no default walk).
fn expression_statement(ctx: &mut Ctx<'_>, node: Node<'_>, parent: Option<&str>) -> bool {
    let Some(inner) = named_children(node).into_iter().next() else {
        return false;
    };
    if inner.kind() != "assignment" {
        return false;
    }
    let (Some(lhs), rhs, annot) = (
        inner.child_by_field_name("left"),
        inner.child_by_field_name("right"),
        inner.child_by_field_name("type"),
    ) else {
        return false;
    };
    if lhs.kind() != "identifier" {
        return false;
    }
    let name = ctx.src.text(lhs);
    if let Some(p) = parent.filter(|p| !p.is_empty()) {
        if annot.is_some() {
            let s = sym(
                ctx,
                node,
                name,
                "field",
                Opts {
                    parent: Some(p.to_string()),
                    ..Opts::default()
                },
            );
            ctx.symbols.push(s);
        }
        return true;
    }
    if name == "__all__" {
        let mut meta = Vec::new();
        if let Some(rhs) = rhs {
            let (members, computed) = parse_all(ctx, rhs);
            meta.push(("all_members", Meta::Strs(members)));
            if computed {
                meta.push(("all_computed", Meta::Bool(true)));
            }
        }
        let s = sym(
            ctx,
            node,
            name,
            "constant",
            Opts {
                meta,
                ..Opts::default()
            },
        );
        ctx.symbols.push(s);
        return true;
    }
    if is_screaming(&name) {
        let s = sym(ctx, node, name, "constant", Opts::default());
        ctx.symbols.push(s);
        return true;
    }
    false
}

fn decorated(
    ctx: &mut Ctx<'_>,
    node: Node<'_>,
    inner: Node<'_>,
    decorators: &[Node<'_>],
    parent: Option<&str>,
    depth: usize,
) {
    let texts: Vec<String> = decorators
        .iter()
        .map(|d| js_trim(&ctx.src.text(*d)).to_string())
        .collect();
    let decorator_meta = classify_decorators(&texts);
    match inner.kind() {
        "function_definition" | "async_function_definition" => {
            let Some(name) = node_name(ctx, inner).filter(|n| !n.is_empty()) else {
                return;
            };
            let kind = classify_function(&name, parent, &texts);
            let mut meta = decorator_meta;
            if is_dunder(&name) {
                meta_set(&mut meta, "is_dunder", Meta::Bool(true));
            }
            let opts = Opts {
                parent: parent.map(str::to_string),
                docstring: docstring(ctx, inner),
                signature: signature(ctx, inner),
                is_async: is_async(inner),
                decorators: texts,
                meta,
                ..Opts::default()
            };
            let s = sym(ctx, node, name, kind, opts);
            ctx.symbols.push(s);
            if let Some(body) = inner.child_by_field_name("body") {
                for child in named_children(body) {
                    walk(ctx, child, parent, depth + 1);
                }
            }
        }
        "class_definition" => {
            let name = node_name(ctx, inner).unwrap_or_else(|| "<anonymous>".to_string());
            let kind = if is_test_case_class(ctx, inner) {
                "test_suite"
            } else {
                "class"
            };
            let opts = Opts {
                parent: parent.map(str::to_string),
                docstring: docstring(ctx, inner),
                decorators: texts,
                extends: superclasses(ctx, inner),
                meta: decorator_meta,
                ..Opts::default()
            };
            let s = sym(ctx, node, name, kind, opts);
            let id = s.id.clone();
            ctx.symbols.push(s);
            if let Some(body) = inner.child_by_field_name("body") {
                for child in named_children(body) {
                    walk(ctx, child, Some(&id), depth + 1);
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(src: &str) -> Vec<Sym> {
        extract(
            &Utf16Source::from_text(src),
            "m.py",
            "r",
            Duration::from_secs(10),
        )
        .symbols
    }

    #[test]
    fn classes_methods_decorators_and_all() {
        let syms = run(
            "__all__ = ['a', \"b\", '''c''']\nMAX = 1\n@dataclass(frozen=True)\nclass P(Base, metaclass=M):\n    \"\"\"Doc.\"\"\"\n    x: int = 0\n    @property\n    def v(self) -> int:\n        return 1\n    @v.setter\n    @abstractmethod\n    async def v2(self, n): ...\n",
        );
        let kinds: Vec<(&str, &str)> = syms.iter().map(|s| (s.name.as_str(), s.kind)).collect();
        assert_eq!(
            kinds,
            vec![
                ("__all__", "constant"),
                ("MAX", "constant"),
                ("P", "class"),
                ("x", "field"),
                ("v", "method"),
                ("v2", "method")
            ]
        );
        assert_eq!(
            syms[0].meta,
            vec![(
                "all_members",
                Meta::Strs(vec!["a".into(), "b".into(), "c".into()])
            )]
        );
        assert_eq!(syms[2].extends, vec!["Base"]);
        assert_eq!(syms[2].docstring.as_deref(), Some("\"\"\"Doc.\"\"\""));
        assert_eq!(
            syms[5].meta,
            vec![
                ("property_accessor", Meta::Str("setter".into())),
                ("is_abstract", Meta::Bool(true))
            ]
        );
        assert!(syms[5].is_async);
    }

    #[test]
    fn accessor_regex_needs_a_word_boundary() {
        assert_eq!(accessor_kind("@x.setter"), Some("setter"));
        assert_eq!(accessor_kind("@x.setterish"), None);
        assert_eq!(accessor_kind("@.setter"), None);
    }
}
