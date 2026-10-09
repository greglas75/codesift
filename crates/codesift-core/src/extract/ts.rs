//! TypeScript / TSX / JavaScript symbols — a port of `src/parser/extractors/typescript*.ts`.
//!
//! Structure mirrors the TypeScript modules one to one (`walk` + `NODE_ACTIONS`, then the
//! declaration, class, module, CommonJS, test and type handlers), including the parts that look
//! accidental and are load-bearing for parity: a class is pushed AFTER its members; `export` and
//! `isExported` flow into the children of continue-after nodes; a test suite named `''` keeps the
//! empty name (`?? "describe"` only replaces null); the export post-pass APPENDS `is_exported` to a
//! symbol that did not have the key, so it serialises last.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use tree_sitter::Node;

use super::{
    children, descendants_of_type, is_js_space, js_trim, js_trim_end, named_children, parse_utf16,
    start_index, strip_quotes, truncate_source, Extracted, Meta, Opts, Sym, Utf16Source,
};

struct Ctx<'s> {
    src: &'s Utf16Source,
    file: &'s str,
    repo: &'s str,
    symbols: Vec<Sym>,
    local_re_exported: HashSet<String>,
    cjs_exported: HashSet<String>,
    overloads: HashMap<String, i64>,
}

/// `parseFile` + `extractTypeScriptSymbols` (JavaScript delegates to the same extractor).
pub fn extract(
    src: &Utf16Source,
    file: &str,
    repo: &str,
    language: &str,
    timeout: Duration,
) -> Option<Extracted> {
    let lang: tree_sitter::Language = match language {
        "typescript" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "javascript" => tree_sitter_javascript::LANGUAGE.into(),
        _ => return None,
    };
    let tree = match parse_utf16(&lang, src, timeout) {
        Ok(tree) => tree,
        Err(failure) => return Some(failure.into()),
    };
    let root = tree.root_node();
    let mut ctx = Ctx {
        src,
        file,
        repo,
        symbols: Vec::new(),
        local_re_exported: HashSet::new(),
        cjs_exported: HashSet::new(),
        overloads: HashMap::new(),
    };
    walk(&mut ctx, root, None, false);
    apply_export_post_pass(&mut ctx);
    Some(Extracted {
        symbols: ctx.symbols,
        has_error: root.has_error(),
        ..Extracted::default()
    })
}

// ---------------------------------------------------------------------------------------------
// typescript.ts — the walk
// ---------------------------------------------------------------------------------------------

fn walk(ctx: &mut Ctx<'_>, node: Node<'_>, parent: Option<&str>, exported: bool) {
    if node_action(ctx, node, parent, exported) {
        return;
    }
    for child in named_children(node) {
        walk(ctx, child, parent, exported);
    }
}

/// `NODE_ACTIONS[node.type]`; `true` = stop (do not walk the children).
fn node_action(ctx: &mut Ctx<'_>, node: Node<'_>, parent: Option<&str>, exported: bool) -> bool {
    match node.kind() {
        "function_declaration" | "generator_function_declaration" | "function_signature" => {
            handle_function_declaration(ctx, node, parent, exported);
            false
        }
        "lexical_declaration" => {
            handle_lexical_declaration(ctx, node, parent, exported);
            true
        }
        "class_declaration" | "abstract_class_declaration" | "class_expression" | "class" => {
            handle_class_like(ctx, node, parent, exported);
            true
        }
        "abstract_method_signature" => {
            if let Some(name) = node_name(ctx, node) {
                push_method(ctx, node, parent, name, true);
            }
            false
        }
        "method_definition" => {
            if let Some(name) = node_name(ctx, node) {
                push_method(ctx, node, parent, name, false);
            }
            false
        }
        "public_field_definition" | "field_definition" => {
            handle_field_definition(ctx, node, parent);
            false
        }
        "class_static_block" => {
            let opts = Opts {
                parent: parent.map(str::to_string),
                docstring: docstring(ctx, node),
                ..Opts::default()
            };
            let sym = make_symbol(ctx, node, "<static>".into(), "method", opts);
            ctx.symbols.push(sym);
            false
        }
        "interface_declaration" => {
            emit_named_type(ctx, node, parent, exported, "interface");
            false
        }
        "type_alias_declaration" => {
            emit_named_type(ctx, node, parent, exported, "type");
            false
        }
        "internal_module" | "module" => {
            handle_module_declaration(ctx, node, parent, exported);
            true
        }
        "ambient_declaration" => {
            handle_ambient_declaration(ctx, node, parent, exported);
            true
        }
        "enum_declaration" => {
            handle_enum_declaration(ctx, node, parent, exported);
            true
        }
        "export_statement" => {
            handle_export_statement(ctx, node, parent);
            true
        }
        "expression_statement" => handle_expression_statement(ctx, node, parent, exported),
        _ => false,
    }
}

fn handle_expression_statement(
    ctx: &mut Ctx<'_>,
    node: Node<'_>,
    parent: Option<&str>,
    exported: bool,
) -> bool {
    let first = named_children(node).into_iter().next();
    if let Some(first) = first {
        if first.kind() == "assignment_expression" && handle_cjs_export(ctx, first, node, parent) {
            return true;
        }
    }
    handle_test_expression_statement(ctx, node, parent, exported)
}

fn apply_export_post_pass(ctx: &mut Ctx<'_>) {
    if ctx.local_re_exported.is_empty() && ctx.cjs_exported.is_empty() {
        return;
    }
    for sym in &mut ctx.symbols {
        if !sym.is_exported
            && !sym.exported_late
            && (ctx.local_re_exported.contains(&sym.name) || ctx.cjs_exported.contains(&sym.name))
        {
            sym.exported_late = true;
        }
    }
}

// ---------------------------------------------------------------------------------------------
// _shared.ts / typescript-shared.ts
// ---------------------------------------------------------------------------------------------

/// `getNodeName`, with the callers' truthiness folded in: an empty name is no name.
fn node_name(ctx: &Ctx<'_>, node: Node<'_>) -> Option<String> {
    node.child_by_field_name("name")
        .map(|n| ctx.src.text(n))
        .filter(|s| !s.is_empty())
}

/// `getNodeName` without the truthiness (callers that test `=== null` / `??` keep empty strings).
fn raw_node_name(ctx: &Ctx<'_>, node: Node<'_>) -> Option<String> {
    node.child_by_field_name("name").map(|n| ctx.src.text(n))
}

fn make_symbol(ctx: &Ctx<'_>, node: Node<'_>, name: String, kind: &'static str, opts: Opts) -> Sym {
    super::make_symbol(ctx.src, ctx.file, ctx.repo, node, name, kind, opts)
}

/// `getDocstring`: the previous named sibling, when it is a `/**` or `//` comment.
fn docstring(ctx: &Ctx<'_>, node: Node<'_>) -> Option<String> {
    let prev = node.prev_named_sibling()?;
    if prev.kind() != "comment" {
        return None;
    }
    let text = ctx.src.text(prev);
    (text.starts_with("/**") || text.starts_with("//")).then_some(text)
}

/// `getDecorators`: own decorator children, then the leading decorator siblings (document order),
/// deduplicated by trimmed text.
fn decorators(ctx: &Ctx<'_>, node: Node<'_>) -> Vec<String> {
    let mut nodes: Vec<Node<'_>> = named_children(node)
        .into_iter()
        .filter(|c| c.kind() == "decorator")
        .collect();
    let mut leading: Vec<Node<'_>> = Vec::new();
    let mut sib = node.prev_named_sibling();
    while let Some(s) = sib {
        if s.kind() != "decorator" {
            break;
        }
        leading.push(s);
        sib = s.prev_named_sibling();
    }
    leading.reverse();
    nodes.extend(leading);
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for d in nodes {
        let text = js_trim(&ctx.src.text(d)).to_string();
        if seen.insert(text.clone()) {
            out.push(text);
        }
    }
    out
}

/// `getSignature`: type parameters + parameters + return type, verbatim.
fn signature(ctx: &Ctx<'_>, node: Node<'_>) -> Option<String> {
    let params = node.child_by_field_name("parameters")?;
    let mut sig = String::new();
    if let Some(tp) = node.child_by_field_name("type_parameters") {
        sig.push_str(&ctx.src.text(tp));
    }
    sig.push_str(&ctx.src.text(params));
    if let Some(rt) = node.child_by_field_name("return_type") {
        sig.push_str(&ctx.src.text(rt));
    }
    Some(sig)
}

fn has_export_modifier(node: Node<'_>) -> bool {
    children(node).iter().any(|c| c.kind() == "export")
}

/// `hasAsyncModifier`, including `ERROR` children whose text matches `/^\s*async\b/`.
fn has_async_modifier(ctx: &Ctx<'_>, node: Node<'_>) -> bool {
    children(node).iter().any(|c| {
        c.kind() == "async"
            || (c.kind() == "ERROR" && {
                let text = ctx.src.text(*c);
                let rest = text.trim_start_matches(is_js_space);
                rest.starts_with("async")
                    && !rest[5..]
                        .chars()
                        .next()
                        .is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_')
            })
    })
}

fn unwrap_parentheses(node: Node<'_>) -> Node<'_> {
    let mut cur = node;
    while cur.kind() == "parenthesized_expression" {
        match named_children(cur).into_iter().next() {
            Some(inner) => cur = inner,
            None => break,
        }
    }
    cur
}

/// `/^[A-Z][A-Z0-9_]+$/`
fn is_screaming_case(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() >= 2
        && b[0].is_ascii_uppercase()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'_')
}

// ---------------------------------------------------------------------------------------------
// typescript-react.ts
// ---------------------------------------------------------------------------------------------

const JSX_TYPES: [&str; 3] = ["jsx_element", "jsx_self_closing_element", "jsx_fragment"];

fn is_jsx(kind: &str) -> bool {
    JSX_TYPES.contains(&kind)
}

/// `/^use[A-Z]/`
fn is_hook_name(name: &str) -> bool {
    name.starts_with("use") && name.as_bytes().get(3).is_some_and(u8::is_ascii_uppercase)
}

/// `/^[A-Z]/`
fn is_component_name(name: &str) -> bool {
    name.as_bytes().first().is_some_and(u8::is_ascii_uppercase)
}

fn returns_jsx(node: Node<'_>) -> bool {
    let Some(body) = node.child_by_field_name("body") else {
        return false;
    };
    if is_jsx(body.kind()) {
        return true;
    }
    if body.kind() == "parenthesized_expression"
        && named_children(body).iter().any(|c| is_jsx(c.kind()))
    {
        return true;
    }
    for ret in descendants_of_type(body, "return_statement") {
        for child in named_children(ret) {
            if is_jsx(child.kind()) {
                return true;
            }
            if child.kind() == "parenthesized_expression"
                && named_children(child).iter().any(|i| is_jsx(i.kind()))
            {
                return true;
            }
        }
    }
    false
}

const REACT_WRAPPER_NAMES: [&str; 3] = ["memo", "forwardRef", "lazy"];

fn is_react_wrapper(ctx: &Ctx<'_>, call: Node<'_>) -> bool {
    let Some(f) = call.child_by_field_name("function") else {
        return false;
    };
    if f.kind() == "identifier" && REACT_WRAPPER_NAMES.contains(&ctx.src.text(f).as_str()) {
        return true;
    }
    if f.kind() == "member_expression" {
        if let Some(prop) = f.child_by_field_name("property") {
            return REACT_WRAPPER_NAMES.contains(&ctx.src.text(prop).as_str());
        }
    }
    false
}

fn wrapper_name(ctx: &Ctx<'_>, call: Node<'_>) -> Option<String> {
    let f = call.child_by_field_name("function")?;
    match f.kind() {
        "identifier" => Some(ctx.src.text(f)),
        "member_expression" => f.child_by_field_name("property").map(|p| ctx.src.text(p)),
        _ => None,
    }
}

fn wrapped_function(call: Node<'_>) -> Option<Node<'_>> {
    let args = call.child_by_field_name("arguments")?;
    let first = named_children(args).into_iter().next()?;
    matches!(first.kind(), "arrow_function" | "function_expression").then_some(first)
}

fn extends_indicates_react_component(list: &[String]) -> bool {
    let is_base = |s: &str| s == "Component" || s == "PureComponent";
    list.iter()
        .any(|name| is_base(name) || name.rfind('.').is_some_and(|i| is_base(&name[i + 1..])))
}

fn classify_react_kind(name: &str, fn_node: Option<Node<'_>>) -> &'static str {
    if is_hook_name(name) {
        return "hook";
    }
    if is_component_name(name) && fn_node.is_some_and(returns_jsx) {
        return "component";
    }
    "function"
}

// ---------------------------------------------------------------------------------------------
// typescript-declaration-nodes.ts
// ---------------------------------------------------------------------------------------------

fn handle_function_declaration(
    ctx: &mut Ctx<'_>,
    node: Node<'_>,
    parent: Option<&str>,
    exported: bool,
) {
    let Some(name) = node_name(ctx, node) else {
        return;
    };
    let kind = classify_react_kind(&name, Some(node));
    let mut meta = Vec::new();
    if node.kind() == "generator_function_declaration" {
        meta.push(("generator", Meta::Bool(true)));
    }
    if node.kind() == "function_signature" {
        let key = format!("{}:{}", parent.unwrap_or(""), name);
        let next = ctx.overloads.get(&key).copied().unwrap_or(0) + 1;
        ctx.overloads.insert(key, next);
        if next > 1 {
            meta.push(("overload_index", Meta::Int(next - 1)));
        }
    }
    let opts = Opts {
        parent: parent.map(str::to_string),
        docstring: docstring(ctx, node),
        signature: signature(ctx, node),
        decorators: decorators(ctx, node),
        is_async: has_async_modifier(ctx, node),
        is_exported: exported || has_export_modifier(node),
        meta,
        ..Opts::default()
    };
    let sym = make_symbol(ctx, node, name, kind, opts);
    ctx.symbols.push(sym);
}

fn handle_lexical_declaration(
    ctx: &mut Ctx<'_>,
    node: Node<'_>,
    parent: Option<&str>,
    exported: bool,
) {
    let exported = exported || has_export_modifier(node);
    let is_const = children(node).iter().any(|c| c.kind() == "const");
    for declarator in named_children(node) {
        if declarator.kind() != "variable_declarator" {
            continue;
        }
        let Some(name) = node_name(ctx, declarator) else {
            continue;
        };
        let value = declarator.child_by_field_name("value");
        let base = Opts {
            parent: parent.map(str::to_string),
            docstring: docstring(ctx, node),
            is_exported: exported,
            ..Opts::default()
        };
        match value {
            Some(v) if v.kind() == "arrow_function" => {
                let kind = classify_react_kind(&name, Some(v));
                let opts = Opts {
                    signature: signature(ctx, v),
                    is_async: has_async_modifier(ctx, v),
                    ..base
                };
                let sym = make_symbol(ctx, node, name, kind, opts);
                ctx.symbols.push(sym);
            }
            Some(v) if v.kind() == "call_expression" && is_react_wrapper(ctx, v) => {
                let inner = wrapped_function(v);
                let kind = if is_hook_name(&name) {
                    "hook"
                } else if !is_component_name(&name) {
                    "function"
                } else if wrapper_name(ctx, v).as_deref() == Some("lazy")
                    || inner.is_some_and(returns_jsx)
                {
                    "component"
                } else {
                    "function"
                };
                let opts = Opts {
                    signature: inner.and_then(|f| signature(ctx, f)),
                    ..base
                };
                let sym = make_symbol(ctx, node, name, kind, opts);
                ctx.symbols.push(sym);
            }
            _ => {
                let kind = if is_const && is_screaming_case(&name) {
                    "constant"
                } else {
                    "variable"
                };
                let sym = make_symbol(ctx, node, name, kind, base);
                let id = sym.id.clone();
                ctx.symbols.push(sym);
                if let Some(v) = value {
                    if v.kind() == "object" {
                        extract_object_literal_methods(ctx, v, &id);
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// typescript-class-nodes.ts
// ---------------------------------------------------------------------------------------------

fn heritage_names(ctx: &Ctx<'_>, node: Node<'_>) -> Vec<String> {
    match node.kind() {
        "identifier" | "type_identifier" => vec![ctx.src.text(node)],
        "member_expression" | "nested_type_identifier" => {
            vec![ctx
                .src
                .text(node)
                .chars()
                .filter(|c| !is_js_space(*c))
                .collect()]
        }
        "generic_type" => {
            let inner = node
                .child_by_field_name("name")
                .or_else(|| named_children(node).into_iter().next());
            inner.map(|n| heritage_names(ctx, n)).unwrap_or_default()
        }
        "intersection_type" | "union_type" => named_children(node)
            .into_iter()
            .flat_map(|c| heritage_names(ctx, c))
            .collect(),
        _ => Vec::new(),
    }
}

fn class_heritage(ctx: &Ctx<'_>, node: Node<'_>) -> (Vec<String>, Vec<String>) {
    let mut ext = Vec::new();
    let mut imp = Vec::new();
    for child in named_children(node) {
        if child.kind() != "class_heritage" {
            continue;
        }
        for clause in named_children(child) {
            let target = match clause.kind() {
                "extends_clause" => &mut ext,
                "implements_clause" => &mut imp,
                _ => continue,
            };
            for t in named_children(clause) {
                target.extend(heritage_names(ctx, t));
            }
        }
    }
    (ext, imp)
}

/// `trimClassBody`. Note the no-body branch returns the WHOLE node text, untruncated — as the
/// TypeScript does.
fn trim_class_body(ctx: &Ctx<'_>, node: Node<'_>) -> String {
    let Some(body) = node.child_by_field_name("body") else {
        return ctx.src.text(node);
    };
    let mut result = ctx.src.slice(start_index(node), start_index(body) + 1);
    for child in named_children(body) {
        result.push_str("\n  ");
        if matches!(
            child.kind(),
            "method_definition" | "abstract_method_signature"
        ) {
            if let Some(method_body) = child.child_by_field_name("body") {
                let head = ctx.src.slice(start_index(child), start_index(method_body));
                result.push_str(js_trim_end(&head));
                result.push_str(" { … }");
                continue;
            }
        }
        result.push_str(&ctx.src.text(child));
    }
    result.push_str("\n}");
    truncate_source(result)
}

fn modifiers(ctx: &Ctx<'_>, node: Node<'_>) -> Vec<String> {
    let mut mods = Vec::new();
    for c in children(node) {
        match c.kind() {
            "static" | "abstract" | "readonly" | "declare" | "accessor" => {
                mods.push(c.kind().to_string())
            }
            "accessibility_modifier" => mods.push(ctx.src.text(c)),
            "override_modifier" => mods.push("override".to_string()),
            _ => {}
        }
    }
    mods
}

fn accessor_kind(node: Node<'_>) -> Option<&'static str> {
    for c in children(node) {
        match c.kind() {
            "get" => return Some("get"),
            "set" => return Some("set"),
            "accessor" => return Some("accessor"),
            _ => {}
        }
    }
    None
}

fn member_meta(ctx: &Ctx<'_>, node: Node<'_>, force_abstract: bool) -> Vec<(&'static str, Meta)> {
    let mut mods = modifiers(ctx, node);
    if force_abstract && !mods.iter().any(|m| m == "abstract") {
        mods.push("abstract".to_string());
    }
    let mut meta = Vec::new();
    if !mods.is_empty() {
        meta.push(("modifiers", Meta::Strs(mods)));
    }
    if let Some(k) = accessor_kind(node) {
        meta.push(("accessor_kind", Meta::Str(k.to_string())));
    }
    meta
}

fn push_method(
    ctx: &mut Ctx<'_>,
    node: Node<'_>,
    parent: Option<&str>,
    name: String,
    force_abstract: bool,
) {
    let opts = Opts {
        parent: parent.map(str::to_string),
        docstring: docstring(ctx, node),
        signature: signature(ctx, node),
        decorators: decorators(ctx, node),
        is_async: has_async_modifier(ctx, node),
        meta: member_meta(ctx, node, force_abstract),
        ..Opts::default()
    };
    let sym = make_symbol(ctx, node, name, "method", opts);
    ctx.symbols.push(sym);
}

fn handle_field_definition(ctx: &mut Ctx<'_>, node: Node<'_>, parent: Option<&str>) {
    let name_node = node
        .child_by_field_name("name")
        .or_else(|| node.child_by_field_name("property"));
    let Some(name) = name_node.map(|n| ctx.src.text(n)).filter(|s| !s.is_empty()) else {
        return;
    };
    let opts = Opts {
        parent: parent.map(str::to_string),
        docstring: docstring(ctx, node),
        decorators: decorators(ctx, node),
        meta: member_meta(ctx, node, false),
        ..Opts::default()
    };
    let sym = make_symbol(ctx, node, name, "field", opts);
    ctx.symbols.push(sym);
}

fn handle_class_like(ctx: &mut Ctx<'_>, node: Node<'_>, parent: Option<&str>, exported: bool) {
    let name = raw_node_name(ctx, node)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "<anonymous>".to_string());
    let (ext, imp) = class_heritage(ctx, node);
    let kind = if extends_indicates_react_component(&ext) {
        "component"
    } else {
        "class"
    };
    let opts = Opts {
        parent: parent.map(str::to_string),
        docstring: docstring(ctx, node),
        decorators: decorators(ctx, node),
        extends: ext,
        implements: imp,
        is_exported: exported || has_export_modifier(node),
        ..Opts::default()
    };
    let mut sym = make_symbol(ctx, node, name, kind, opts);
    for child in named_children(node) {
        walk(ctx, child, Some(&sym.id), false);
    }
    sym.source = trim_class_body(ctx, node);
    ctx.symbols.push(sym);
}

// ---------------------------------------------------------------------------------------------
// typescript-module-nodes.ts
// ---------------------------------------------------------------------------------------------

fn strip_quoted_name(ctx: &Ctx<'_>, node: Node<'_>) -> String {
    let text = ctx.src.text(node);
    if node.kind() == "string" {
        strip_quotes(&text)
    } else {
        text
    }
}

fn handle_module_declaration(
    ctx: &mut Ctx<'_>,
    node: Node<'_>,
    parent: Option<&str>,
    exported: bool,
) {
    let name = match node.child_by_field_name("name") {
        Some(n) => strip_quoted_name(ctx, n),
        None => match named_children(node)
            .into_iter()
            .find(|c| matches!(c.kind(), "identifier" | "string"))
        {
            Some(n) => strip_quoted_name(ctx, n),
            None => return,
        },
    };
    let exported = exported || has_export_modifier(node);
    let opts = Opts {
        parent: parent.map(str::to_string),
        docstring: docstring(ctx, node),
        is_exported: exported,
        ..Opts::default()
    };
    let sym = make_symbol(ctx, node, name, "namespace", opts);
    let id = sym.id.clone();
    ctx.symbols.push(sym);
    let body = node.child_by_field_name("body").or_else(|| {
        named_children(node)
            .into_iter()
            .find(|c| c.kind() == "statement_block")
    });
    if let Some(body) = body {
        for child in named_children(body) {
            walk(ctx, child, Some(&id), exported);
        }
    }
}

fn handle_ambient_declaration(
    ctx: &mut Ctx<'_>,
    node: Node<'_>,
    parent: Option<&str>,
    exported: bool,
) {
    let ambient = exported || has_export_modifier(node);
    for child in named_children(node) {
        let string_named_module = child.kind() == "module"
            && (child
                .child_by_field_name("name")
                .is_some_and(|n| n.kind() == "string")
                || named_children(child).iter().any(|c| c.kind() == "string"));
        walk(ctx, child, parent, ambient || string_named_module);
    }
}

const ANONYMOUS_DEFAULT_TYPES: [&str; 7] = [
    "function_expression",
    "class",
    "class_declaration",
    "class_expression",
    "function_declaration",
    "generator_function_declaration",
    "arrow_function",
];

fn handle_export_statement(ctx: &mut Ctx<'_>, node: Node<'_>, parent: Option<&str>) {
    if node.child_by_field_name("source").is_some() {
        for child in named_children(node) {
            match child.kind() {
                "export_clause" => {
                    for spec in named_children(child) {
                        if spec.kind() != "export_specifier" {
                            continue;
                        }
                        let name_node = spec
                            .child_by_field_name("alias")
                            .or_else(|| spec.child_by_field_name("name"));
                        let Some(name) =
                            name_node.map(|n| ctx.src.text(n)).filter(|s| !s.is_empty())
                        else {
                            continue;
                        };
                        let opts = Opts {
                            parent: parent.map(str::to_string),
                            is_exported: true,
                            ..Opts::default()
                        };
                        let sym = make_symbol(ctx, spec, name, "variable", opts);
                        ctx.symbols.push(sym);
                    }
                }
                "namespace_export" => {
                    for id in named_children(child) {
                        if id.kind() != "identifier" {
                            continue;
                        }
                        let opts = Opts {
                            parent: parent.map(str::to_string),
                            is_exported: true,
                            ..Opts::default()
                        };
                        let sym = make_symbol(ctx, child, ctx.src.text(id), "namespace", opts);
                        ctx.symbols.push(sym);
                    }
                }
                _ => {}
            }
        }
        return;
    }

    for child in named_children(node) {
        if child.kind() != "export_clause" {
            continue;
        }
        for spec in named_children(child) {
            if spec.kind() == "export_specifier" {
                if let Some(n) = spec.child_by_field_name("name") {
                    ctx.local_re_exported.insert(ctx.src.text(n));
                }
            }
        }
    }

    if children(node).iter().any(|c| c.kind() == "default") {
        for child in named_children(node) {
            let inner = unwrap_parentheses(child);
            if !ANONYMOUS_DEFAULT_TYPES.contains(&inner.kind()) || node_name(ctx, inner).is_some() {
                continue;
            }
            let is_class = matches!(
                inner.kind(),
                "class" | "class_declaration" | "class_expression"
            );
            let mut meta = Vec::new();
            if returns_jsx(inner) {
                meta.push(("is_react_component", Meta::Bool(true)));
            }
            let opts = Opts {
                parent: parent.map(str::to_string),
                is_exported: true,
                signature: if is_class {
                    None
                } else {
                    signature(ctx, inner)
                },
                meta,
                ..Opts::default()
            };
            let sym = make_symbol(ctx, inner, "default".into(), "default_export", opts);
            let id = sym.id.clone();
            ctx.symbols.push(sym);
            walk(ctx, inner, Some(&id), true);
            return;
        }
    }

    for child in named_children(node) {
        walk(ctx, child, parent, true);
    }
}

// ---------------------------------------------------------------------------------------------
// typescript-cjs-nodes.ts
// ---------------------------------------------------------------------------------------------

enum CjsTarget {
    ModuleExports(Option<String>),
    Exports(String),
}

fn parse_cjs_lhs(ctx: &Ctx<'_>, lhs: Node<'_>) -> Option<CjsTarget> {
    if lhs.kind() != "member_expression" {
        return None;
    }
    let obj = lhs.child_by_field_name("object")?;
    let prop = lhs.child_by_field_name("property")?;
    if obj.kind() == "identifier" {
        let o = ctx.src.text(obj);
        if o == "exports" {
            return Some(CjsTarget::Exports(ctx.src.text(prop)));
        }
        if o == "module" && ctx.src.text(prop) == "exports" {
            return Some(CjsTarget::ModuleExports(None));
        }
        return None;
    }
    if obj.kind() == "member_expression" {
        let inner_obj = obj.child_by_field_name("object");
        let inner_prop = obj.child_by_field_name("property");
        if inner_obj.is_some_and(|o| o.kind() == "identifier" && ctx.src.text(o) == "module")
            && inner_prop.is_some_and(|p| ctx.src.text(p) == "exports")
        {
            return Some(CjsTarget::ModuleExports(Some(ctx.src.text(prop))));
        }
    }
    None
}

fn is_function_like(node: Node<'_>) -> bool {
    matches!(node.kind(), "arrow_function" | "function_expression")
}

fn handle_cjs_export(
    ctx: &mut Ctx<'_>,
    assign: Node<'_>,
    stmt: Node<'_>,
    parent: Option<&str>,
) -> bool {
    let (Some(lhs), Some(rhs)) = (
        assign.child_by_field_name("left"),
        assign.child_by_field_name("right"),
    ) else {
        return false;
    };
    let property = match parse_cjs_lhs(ctx, lhs) {
        None => return false,
        Some(CjsTarget::Exports(p)) => Some(p),
        Some(CjsTarget::ModuleExports(p)) => p,
    };
    if let Some(name) = property.filter(|p| !p.is_empty()) {
        let kind = if is_function_like(rhs) {
            classify_react_kind(&name, Some(rhs))
        } else if rhs.kind() == "class_expression" {
            "class"
        } else if is_screaming_case(&name) {
            "constant"
        } else {
            "variable"
        };
        let opts = Opts {
            parent: parent.map(str::to_string),
            docstring: docstring(ctx, stmt),
            signature: if is_function_like(rhs) {
                signature(ctx, rhs)
            } else {
                None
            },
            is_exported: true,
            ..Opts::default()
        };
        let sym = make_symbol(ctx, stmt, name.clone(), kind, opts);
        ctx.symbols.push(sym);
        ctx.cjs_exported.insert(name);
        return true;
    }
    match rhs.kind() {
        "identifier" => {
            ctx.cjs_exported.insert(ctx.src.text(rhs));
            true
        }
        "object" => {
            for member in named_children(rhs) {
                match member.kind() {
                    "shorthand_property_identifier" => {
                        ctx.cjs_exported.insert(ctx.src.text(member));
                    }
                    "pair" => {
                        let (Some(key), Some(val)) = (
                            member.child_by_field_name("key"),
                            member.child_by_field_name("value"),
                        ) else {
                            continue;
                        };
                        let key_name = strip_quotes(&ctx.src.text(key));
                        if val.kind() == "identifier" {
                            ctx.cjs_exported.insert(ctx.src.text(val));
                            ctx.cjs_exported.insert(key_name);
                        } else if is_function_like(val) {
                            let kind = classify_react_kind(&key_name, Some(val));
                            let opts = Opts {
                                parent: parent.map(str::to_string),
                                signature: signature(ctx, val),
                                is_exported: true,
                                ..Opts::default()
                            };
                            let sym = make_symbol(ctx, member, key_name, kind, opts);
                            ctx.symbols.push(sym);
                        }
                    }
                    _ => {}
                }
            }
            true
        }
        "arrow_function" | "function_expression" | "class_expression" => {
            let opts = Opts {
                parent: parent.map(str::to_string),
                signature: if is_function_like(rhs) {
                    signature(ctx, rhs)
                } else {
                    None
                },
                is_exported: true,
                ..Opts::default()
            };
            let sym = make_symbol(ctx, stmt, "default".into(), "default_export", opts);
            ctx.symbols.push(sym);
            true
        }
        _ => false,
    }
}

fn extract_object_literal_methods(ctx: &mut Ctx<'_>, object: Node<'_>, parent_id: &str) {
    for child in named_children(object) {
        if child.kind() == "method_definition" {
            let Some(name) = node_name(ctx, child) else {
                continue;
            };
            let opts = Opts {
                parent: Some(parent_id.to_string()),
                signature: signature(ctx, child),
                ..Opts::default()
            };
            let sym = make_symbol(ctx, child, name, "method", opts);
            ctx.symbols.push(sym);
            continue;
        }
        if child.kind() == "pair" {
            let (Some(key), Some(val)) = (
                child.child_by_field_name("key"),
                child.child_by_field_name("value"),
            ) else {
                continue;
            };
            if !is_function_like(val) {
                continue;
            }
            let name = strip_quotes(&ctx.src.text(key));
            let kind = classify_react_kind(&name, Some(val));
            let opts = Opts {
                parent: Some(parent_id.to_string()),
                signature: signature(ctx, val),
                ..Opts::default()
            };
            let sym = make_symbol(
                ctx,
                child,
                name,
                if kind == "function" { "method" } else { kind },
                opts,
            );
            ctx.symbols.push(sym);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// typescript-test-nodes.ts
// ---------------------------------------------------------------------------------------------

fn parse_test_callee(ctx: &Ctx<'_>, call: Node<'_>) -> Option<(String, Option<String>)> {
    let f = call.child_by_field_name("function")?;
    let member = |m: Node<'_>| -> Option<(String, Option<String>)> {
        let obj = m.child_by_field_name("object")?;
        let prop = m.child_by_field_name("property")?;
        (obj.kind() == "identifier").then(|| (ctx.src.text(obj), Some(ctx.src.text(prop))))
    };
    match f.kind() {
        "identifier" => Some((ctx.src.text(f), None)),
        "member_expression" => member(f),
        "call_expression" => {
            let inner = f.child_by_field_name("function")?;
            if inner.kind() == "member_expression" {
                member(inner)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// `getTestName`: `null` only when there is no first argument; an empty string stays empty.
fn test_name(ctx: &Ctx<'_>, call: Node<'_>) -> Option<String> {
    let args = call.child_by_field_name("arguments")?;
    let first = named_children(args).into_iter().next()?;
    let text = ctx.src.text(first);
    Some(if matches!(first.kind(), "string" | "template_string") {
        strip_quotes(&text)
    } else {
        text
    })
}

fn handle_test_expression_statement(
    ctx: &mut Ctx<'_>,
    node: Node<'_>,
    parent: Option<&str>,
    _exported: bool,
) -> bool {
    let Some(expr) = named_children(node).into_iter().next() else {
        return false;
    };
    if expr.kind() != "call_expression" {
        return false;
    }
    let Some((base, method)) = parse_test_callee(ctx, expr) else {
        return false;
    };
    let allowed = |set: &[&str]| method.as_deref().is_none_or(|m| set.contains(&m));

    if base == "describe" && allowed(&["skip", "only", "each"]) {
        let name = test_name(ctx, expr).unwrap_or_else(|| "describe".to_string());
        let opts = Opts {
            parent: parent.map(str::to_string),
            docstring: docstring(ctx, node),
            ..Opts::default()
        };
        let sym = make_symbol(ctx, node, name, "test_suite", opts);
        let id = sym.id.clone();
        ctx.symbols.push(sym);
        if let Some(args) = expr.child_by_field_name("arguments") {
            for arg in named_children(args) {
                if !matches!(arg.kind(), "arrow_function" | "function") {
                    continue;
                }
                for body_child in named_children(arg) {
                    walk(ctx, body_child, Some(&id), false);
                }
            }
        }
        return true;
    }
    if (base == "it" || base == "test")
        && allowed(&["skip", "todo", "each", "only", "failing", "concurrent"])
    {
        let name = test_name(ctx, expr).unwrap_or_else(|| base.clone());
        let opts = Opts {
            parent: parent.map(str::to_string),
            docstring: docstring(ctx, node),
            ..Opts::default()
        };
        let sym = make_symbol(ctx, node, name, "test_case", opts);
        ctx.symbols.push(sym);
        return true;
    }
    if method.is_none()
        && matches!(
            base.as_str(),
            "beforeEach" | "afterEach" | "beforeAll" | "afterAll"
        )
    {
        let opts = Opts {
            parent: parent.map(str::to_string),
            docstring: docstring(ctx, node),
            ..Opts::default()
        };
        let sym = make_symbol(ctx, node, base, "test_hook", opts);
        ctx.symbols.push(sym);
        return true;
    }
    false
}

// ---------------------------------------------------------------------------------------------
// typescript-type-nodes.ts
// ---------------------------------------------------------------------------------------------

fn emit_named_type(
    ctx: &mut Ctx<'_>,
    node: Node<'_>,
    parent: Option<&str>,
    exported: bool,
    kind: &'static str,
) {
    let Some(name) = node_name(ctx, node) else {
        return;
    };
    let opts = Opts {
        parent: parent.map(str::to_string),
        docstring: docstring(ctx, node),
        is_exported: exported || has_export_modifier(node),
        ..Opts::default()
    };
    let sym = make_symbol(ctx, node, name, kind, opts);
    ctx.symbols.push(sym);
}

fn handle_enum_declaration(
    ctx: &mut Ctx<'_>,
    node: Node<'_>,
    parent: Option<&str>,
    exported: bool,
) {
    let Some(name) = node_name(ctx, node) else {
        return;
    };
    let opts = Opts {
        parent: parent.map(str::to_string),
        docstring: docstring(ctx, node),
        is_exported: exported || has_export_modifier(node),
        ..Opts::default()
    };
    let sym = make_symbol(ctx, node, name, "enum", opts);
    let id = sym.id.clone();
    ctx.symbols.push(sym);
    let Some(body) = node.child_by_field_name("body") else {
        return;
    };
    for child in named_children(body) {
        let member = match child.kind() {
            "enum_assignment" => node_name(ctx, child),
            "property_identifier" => Some(ctx.src.text(child)).filter(|s| !s.is_empty()),
            _ => None,
        };
        if let Some(member) = member {
            let opts = Opts {
                parent: Some(id.clone()),
                ..Opts::default()
            };
            let sym = make_symbol(ctx, child, member, "constant", opts);
            ctx.symbols.push(sym);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extract::write_json;

    fn run(src: &str, lang: &str) -> Vec<Sym> {
        extract(
            &Utf16Source::from_text(src),
            "a.ts",
            "r",
            lang,
            Duration::from_secs(10),
        )
        .unwrap()
        .symbols
    }

    fn names(syms: &[Sym]) -> Vec<(String, &'static str)> {
        syms.iter().map(|s| (s.name.clone(), s.kind)).collect()
    }

    #[test]
    fn class_members_come_before_the_class_and_the_class_source_is_a_shell() {
        let syms = run("export class A extends React.Component {\n  x = 1;\n  async go(a: number): void { return; }\n}\n", "typescript");
        assert_eq!(
            names(&syms),
            vec![
                ("x".into(), "field"),
                ("go".into(), "method"),
                ("A".into(), "component")
            ]
        );
        let a = &syms[2];
        assert!(a.is_exported);
        assert_eq!(a.extends, vec!["React.Component"]);
        assert_eq!(
            a.source,
            "class A extends React.Component {\n  x = 1\n  async go(a: number): void { … }\n}"
        );
        assert!(syms[1].is_async);
        assert_eq!(syms[1].parent.as_deref(), Some(a.id.as_str()));
        assert_eq!(syms[1].signature.as_deref(), Some("(a: number): void"));
    }

    #[test]
    fn offsets_are_utf16_code_units() {
        let syms = run("const s = '🚀';\nfunction f() {}\n", "typescript");
        let f = syms.iter().find(|s| s.name == "f").unwrap();
        // "const s = '🚀';\n" is 16 code units (the emoji is two).
        assert_eq!(f.start_byte, Some(16));
        assert_eq!(f.start_line, 2);
    }

    #[test]
    fn tests_suites_hooks_and_an_empty_suite_name() {
        let syms = run(
            "describe('', () => {\n  beforeEach(() => {});\n  it.skip('works', () => {});\n});\n",
            "typescript",
        );
        assert_eq!(
            names(&syms),
            vec![
                ("".into(), "test_suite"),
                ("beforeEach".into(), "test_hook"),
                ("works".into(), "test_case")
            ]
        );
    }

    #[test]
    fn cjs_exports_and_the_late_is_exported_key() {
        let syms = run(
            "function helper() {}\nmodule.exports = { helper, run: () => 1 };\n",
            "javascript",
        );
        let helper = syms.iter().find(|s| s.name == "helper").unwrap();
        assert!(!helper.is_exported && helper.exported_late);
        let mut out = String::new();
        write_json(&syms, "r", "a.ts", &mut out);
        assert!(
            out.contains("\"tokens\":[\"helper\"],\"signature\":\"()\",\"is_exported\":true}"),
            "{out}"
        );
    }
}
