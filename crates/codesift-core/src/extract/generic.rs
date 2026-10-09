//! The generic fallback — a port of `extractGenericSymbols` in `symbol-extractor.ts`, which every
//! grammar without a dedicated extractor goes through (Java, Ruby, CSS).
//!
//! Its symbols are NOT `makeSymbol`'s: no byte offsets, no docstring or signature, and the name is the
//! `name` field or else the first `identifier` child, else `<anonymous>` (an empty name stays empty —
//! `??` only replaces null). Nested matches take the enclosing match as parent.

use std::time::Duration;

use tree_sitter::Node;

use super::{named_children, node_source, parse_utf16, Extracted, Sym, Utf16Source};

fn kind_of(node_kind: &str) -> Option<&'static str> {
    match node_kind {
        "function_declaration" | "function_definition" => Some("function"),
        "class_declaration" | "class_definition" => Some("class"),
        "method_definition" | "method_declaration" => Some("method"),
        _ => None,
    }
}

pub fn extract(
    src: &Utf16Source,
    file: &str,
    repo: &str,
    language: &str,
    timeout: Duration,
) -> Option<Extracted> {
    let lang: tree_sitter::Language = match language {
        "java" => tree_sitter_java::LANGUAGE.into(),
        "ruby" => tree_sitter_ruby::LANGUAGE.into(),
        "css" => tree_sitter_css::LANGUAGE.into(),
        _ => return None,
    };
    let Some(tree) = parse_utf16(&lang, src, timeout) else {
        return Some(Extracted {
            timed_out: true,
            ..Extracted::default()
        });
    };
    let mut symbols = Vec::new();
    walk(src, file, repo, tree.root_node(), None, &mut symbols);
    Some(Extracted {
        symbols,
        ..Extracted::default()
    })
}

fn walk(
    src: &Utf16Source,
    file: &str,
    repo: &str,
    node: Node<'_>,
    parent: Option<&str>,
    out: &mut Vec<Sym>,
) {
    let Some(kind) = kind_of(node.kind()) else {
        for child in named_children(node) {
            walk(src, file, repo, child, parent, out);
        }
        return;
    };
    let name_node = node.child_by_field_name("name").or_else(|| {
        named_children(node)
            .into_iter()
            .find(|c| c.kind() == "identifier")
    });
    let name = name_node
        .map(|n| src.text(n))
        .unwrap_or_else(|| "<anonymous>".to_string());
    let start_line = node.start_position().row + 1;
    let id = format!("{repo}:{file}:{name}:{start_line}");
    let sym = Sym {
        id: id.clone(),
        kind,
        start_line,
        end_line: node.end_position().row + 1,
        start_byte: None,
        end_byte: None,
        source: node_source(src, node),
        tokens: crate::bm25::tokenize_identifier(&name),
        name,
        docstring: None,
        parent: parent.filter(|p| !p.is_empty()).map(str::to_string),
        signature: None,
        decorators: Vec::new(),
        extends: Vec::new(),
        implements: Vec::new(),
        is_async: false,
        is_exported: false,
        exported_late: false,
        meta: Vec::new(),
    };
    out.push(sym);
    for child in named_children(node) {
        walk(src, file, repo, child, Some(&id), out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extract::write_json;

    #[test]
    fn java_classes_and_methods_without_byte_offsets() {
        let src = "class A { void run() {} class B { int go() { return 1; } } }";
        let syms = extract(
            &Utf16Source::from_text(src),
            "A.java",
            "r",
            "java",
            Duration::from_secs(10),
        )
        .unwrap()
        .symbols;
        let names: Vec<(&str, &str)> = syms.iter().map(|s| (s.name.as_str(), s.kind)).collect();
        assert_eq!(
            names,
            vec![
                ("A", "class"),
                ("run", "method"),
                ("B", "class"),
                ("go", "method")
            ]
        );
        assert_eq!(syms[3].parent.as_deref(), Some(syms[2].id.as_str()));
        let mut json = String::new();
        write_json(&syms[..1], "r", "A.java", &mut json);
        assert!(json.contains("\"end_line\":1,\"source\""), "{json}");
    }
}
