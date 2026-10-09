//! Rust symbols — a port of `src/parser/extractors/rust.ts`.
//!
//! Carried over as written: an `impl` method's parent is the FIRST symbol extracted so far whose name
//! equals the impl's full type text (so `impl<T> Foo<T>` finds no `Foo`) and whose kind is class or
//! interface; doc comments are the `///`/`//!` line comments directly before the item, contiguous or
//! not; a `function_item` keeps walking into its body with the same parent.

use std::time::Duration;

use tree_sitter::Node;

use super::{make_symbol, named_children, parse_utf16, Extracted, Opts, Sym, Utf16Source};

struct Ctx<'s> {
    src: &'s Utf16Source,
    file: &'s str,
    repo: &'s str,
    symbols: Vec<Sym>,
}

pub fn extract(src: &Utf16Source, file: &str, repo: &str, timeout: Duration) -> Extracted {
    let lang: tree_sitter::Language = tree_sitter_rust::LANGUAGE.into();
    let tree = match parse_utf16(&lang, src, timeout) {
        Ok(tree) => tree,
        Err(failure) => return failure.into(),
    };
    let mut ctx = Ctx {
        src,
        file,
        repo,
        symbols: Vec::new(),
    };
    walk(&mut ctx, tree.root_node(), None);
    Extracted {
        symbols: ctx.symbols,
        ..Extracted::default()
    }
}

fn name_of(ctx: &Ctx<'_>, node: Node<'_>) -> Option<String> {
    node.child_by_field_name("name")
        .map(|n| ctx.src.text(n))
        .filter(|s| !s.is_empty())
}

fn docstring(ctx: &Ctx<'_>, node: Node<'_>) -> Option<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut prev = node.prev_named_sibling();
    while let Some(p) = prev {
        if p.kind() != "line_comment" {
            break;
        }
        let text = ctx.src.text(p);
        if !(text.starts_with("///") || text.starts_with("//!")) {
            break;
        }
        lines.push(text);
        prev = p.prev_named_sibling();
    }
    if lines.is_empty() {
        return None;
    }
    lines.reverse();
    Some(lines.join("\n"))
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

/// `addSymbol`: push and return the id.
fn add(
    ctx: &mut Ctx<'_>,
    node: Node<'_>,
    name: String,
    kind: &'static str,
    parent: Option<&str>,
    signature: Option<String>,
) -> String {
    let opts = Opts {
        parent: parent.map(str::to_string),
        docstring: docstring(ctx, node),
        signature,
        ..Opts::default()
    };
    let s = make_symbol(ctx.src, ctx.file, ctx.repo, node, name, kind, opts);
    let id = s.id.clone();
    ctx.symbols.push(s);
    id
}

fn walk(ctx: &mut Ctx<'_>, node: Node<'_>, parent: Option<&str>) {
    match node.kind() {
        "function_item" => {
            if let Some(name) = name_of(ctx, node) {
                let sig = signature(ctx, node);
                add(ctx, node, name, "function", parent, sig);
            }
        }
        "struct_item" => {
            if let Some(name) = name_of(ctx, node) {
                let id = add(ctx, node, name, "class", parent, None);
                if let Some(body) = node.child_by_field_name("body") {
                    for child in named_children(body) {
                        if child.kind() == "field_declaration" {
                            if let Some(field) = name_of(ctx, child) {
                                add(ctx, child, field, "field", Some(&id), None);
                            }
                        }
                    }
                }
            }
        }
        "enum_item" | "type_item" | "const_item" | "static_item" => {
            if let Some(name) = name_of(ctx, node) {
                let kind = match node.kind() {
                    "enum_item" => "enum",
                    "type_item" => "type",
                    _ => "variable",
                };
                add(ctx, node, name, kind, parent, None);
            }
        }
        "trait_item" | "mod_item" => {
            if let Some(name) = name_of(ctx, node) {
                let kind = if node.kind() == "trait_item" {
                    "interface"
                } else {
                    "module"
                };
                let id = add(ctx, node, name, kind, parent, None);
                if let Some(body) = node.child_by_field_name("body") {
                    for child in named_children(body) {
                        walk(ctx, child, Some(&id));
                    }
                }
            }
            return;
        }
        "impl_item" => {
            let impl_name = node
                .child_by_field_name("type")
                .map(|t| ctx.src.text(t))
                .filter(|s| !s.is_empty());
            if let (Some(body), Some(impl_name)) = (node.child_by_field_name("body"), impl_name) {
                for child in named_children(body) {
                    if child.kind() != "function_item" {
                        continue;
                    }
                    let Some(method) = name_of(ctx, child) else {
                        continue;
                    };
                    let sig = signature(ctx, child);
                    let parent_struct = ctx
                        .symbols
                        .iter()
                        .find(|s| {
                            s.name == impl_name && (s.kind == "class" || s.kind == "interface")
                        })
                        .map(|s| s.id.clone());
                    add(ctx, child, method, "method", parent_struct.as_deref(), sig);
                }
            }
            return;
        }
        _ => {}
    }
    for child in named_children(node) {
        walk(ctx, child, parent);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn items_impls_and_doc_comments() {
        let src = "/// A point.\n/// Two lines.\npub struct Point { pub x: i32, y: i32 }\n\nimpl Point {\n    pub fn new(x: i32) -> Self { fn helper() {} Point { x, y: 0 } }\n}\n\nimpl<T> Wrap<T> { fn get(&self) {} }\n\ntrait Shape { fn area(&self) -> f64 { 0.0 } }\n\nmod inner { const LIMIT: u32 = 3; }\n";
        let syms = extract(
            &Utf16Source::from_text(src),
            "lib.rs",
            "r",
            Duration::from_secs(10),
        )
        .symbols;
        let kinds: Vec<(&str, &str)> = syms.iter().map(|s| (s.name.as_str(), s.kind)).collect();
        assert_eq!(
            kinds,
            vec![
                ("Point", "class"),
                ("x", "field"),
                ("y", "field"),
                ("new", "method"),
                ("get", "method"),
                ("Shape", "interface"),
                ("area", "function"),
                ("inner", "module"),
                ("LIMIT", "variable")
            ]
        );
        assert_eq!(
            syms[0].docstring.as_deref(),
            // tree-sitter-rust 0.24 includes the newline in a line_comment node, so the TypeScript
            // join yields the doubled newline too.
            Some("/// A point.\n\n/// Two lines.\n")
        );
        assert_eq!(syms[3].parent.as_deref(), Some(syms[0].id.as_str()));
        assert_eq!(syms[4].parent, None);
        assert_eq!(syms[3].signature.as_deref(), Some("(x: i32) -> Self"));
    }
}
