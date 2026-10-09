//! Go symbols — a port of `src/parser/extractors/go.ts`.
//!
//! Carried over as written: the docstring's FIRST comment need not touch the declaration (only later
//! ones must be on consecutive lines); every `type_spec` takes its position and source from the whole
//! `type_declaration`; a field or spec with several names (`a, b int`) is named after the first.

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
    let lang: tree_sitter::Language = tree_sitter_go::LANGUAGE.into();
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

fn sym(ctx: &Ctx<'_>, node: Node<'_>, name: String, kind: &'static str, opts: Opts) -> Sym {
    make_symbol(ctx.src, ctx.file, ctx.repo, node, name, kind, opts)
}

fn name_of(ctx: &Ctx<'_>, node: Node<'_>) -> Option<String> {
    node.child_by_field_name("name")
        .map(|n| ctx.src.text(n))
        .filter(|s| !s.is_empty())
}

/// `getDocstring`: contiguous `//` comments above the declaration, joined by newlines.
fn docstring(ctx: &Ctx<'_>, node: Node<'_>) -> Option<String> {
    let mut comments: Vec<String> = Vec::new();
    let mut prev = node.prev_named_sibling();
    while let Some(p) = prev {
        if p.kind() != "comment" {
            break;
        }
        comments.push(ctx.src.text(p));
        match p.prev_named_sibling() {
            Some(np)
                if np.kind() == "comment"
                    && np.end_position().row + 1 == p.start_position().row =>
            {
                prev = Some(np);
            }
            _ => break,
        }
    }
    if comments.is_empty() {
        return None;
    }
    comments.reverse();
    Some(comments.join("\n"))
}

/// `getSignature`: receiver + parameters + result, space-separated.
fn signature(ctx: &Ctx<'_>, node: Node<'_>) -> Option<String> {
    let params = node.child_by_field_name("parameters")?;
    let mut sig = String::new();
    if let Some(r) = node.child_by_field_name("receiver") {
        sig.push_str(&ctx.src.text(r));
        sig.push(' ');
    }
    sig.push_str(&ctx.src.text(params));
    if let Some(res) = node.child_by_field_name("result") {
        sig.push(' ');
        sig.push_str(&ctx.src.text(res));
    }
    Some(sig)
}

fn walk(ctx: &mut Ctx<'_>, node: Node<'_>, parent: Option<&str>) {
    match node.kind() {
        "function_declaration" | "method_declaration" => {
            if let Some(name) = name_of(ctx, node) {
                let kind = if node.kind() == "function_declaration" {
                    "function"
                } else {
                    "method"
                };
                let opts = Opts {
                    parent: parent.map(str::to_string),
                    docstring: docstring(ctx, node),
                    signature: signature(ctx, node),
                    ..Opts::default()
                };
                let s = sym(ctx, node, name, kind, opts);
                ctx.symbols.push(s);
            }
        }
        "type_declaration" => {
            for spec in named_children(node) {
                if spec.kind() != "type_spec" {
                    continue;
                }
                let Some(name) = name_of(ctx, spec) else {
                    continue;
                };
                let body = spec.child_by_field_name("type");
                let kind = match body.map(|b| b.kind()) {
                    Some("struct_type") => "class",
                    Some("interface_type") => "interface",
                    _ => "type",
                };
                let opts = Opts {
                    parent: parent.map(str::to_string),
                    docstring: docstring(ctx, node),
                    ..Opts::default()
                };
                let s = sym(ctx, node, name, kind, opts);
                let id = s.id.clone();
                ctx.symbols.push(s);
                if kind != "class" {
                    continue;
                }
                let Some(body) = body else { continue };
                for list in named_children(body) {
                    if list.kind() != "field_declaration_list" {
                        continue;
                    }
                    for field in named_children(list) {
                        if field.kind() != "field_declaration" {
                            continue;
                        }
                        if let Some(field_name) = name_of(ctx, field) {
                            let opts = Opts {
                                parent: Some(id.clone()),
                                docstring: docstring(ctx, field),
                                ..Opts::default()
                            };
                            let fs = sym(ctx, field, field_name, "field", opts);
                            ctx.symbols.push(fs);
                        }
                    }
                }
            }
            return;
        }
        "const_declaration" | "var_declaration" if parent.is_none() => {
            for spec in named_children(node) {
                if !matches!(spec.kind(), "const_spec" | "var_spec") {
                    continue;
                }
                if let Some(name) = name_of(ctx, spec) {
                    let opts = Opts {
                        docstring: docstring(ctx, node),
                        ..Opts::default()
                    };
                    let s = sym(ctx, node, name, "variable", opts);
                    ctx.symbols.push(s);
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
    fn functions_methods_structs_fields_and_package_vars() {
        let src = "package x\n\n// Server serves.\n// Second line.\ntype Server struct {\n\t// addr doc\n\tAddr, Alt string\n}\n\ntype Doer interface{ Do() }\n\nfunc (s *Server) Handle(ctx context.Context) (int, error) { return 0, nil }\n\nconst A, B = 1, 2\n";
        let syms = extract(
            &Utf16Source::from_text(src),
            "x.go",
            "r",
            Duration::from_secs(10),
        )
        .symbols;
        let kinds: Vec<(&str, &str)> = syms.iter().map(|s| (s.name.as_str(), s.kind)).collect();
        assert_eq!(
            kinds,
            vec![
                ("Server", "class"),
                ("Addr", "field"),
                ("Doer", "interface"),
                ("Handle", "method"),
                ("A", "variable")
            ]
        );
        assert_eq!(
            syms[0].docstring.as_deref(),
            Some("// Server serves.\n// Second line.")
        );
        assert_eq!(
            syms[3].signature.as_deref(),
            Some("(s *Server) (ctx context.Context) (int, error)")
        );
    }
}
