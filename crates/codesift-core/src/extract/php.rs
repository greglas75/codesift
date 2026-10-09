//! PHP symbols — a port of `src/parser/extractors/php-*.ts`.
//!
//! Carried over as written: a top-level `namespace X;` (no body) becomes the parent of every LATER
//! top-level node; docblock members (`@property`, then `@method`) are synthesised AFTER the class body
//! is walked, onto the class node's span, and skipped when a real member of that kind and name exists;
//! JS `\w` in the docblock patterns is ASCII, spelled out here because Rust's `\w` is Unicode.

use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use tree_sitter::Node;

use super::{
    js_trim, make_symbol, named_children, parse_utf16, Extracted, Meta, Opts, Sym, Utf16Source,
};

struct Ctx<'s> {
    src: &'s Utf16Source,
    file: &'s str,
    repo: &'s str,
    symbols: Vec<Sym>,
}

#[derive(Clone)]
struct State {
    parent: Option<String>,
    parent_is_test: bool,
}

pub fn extract(src: &Utf16Source, file: &str, repo: &str, timeout: Duration) -> Extracted {
    let lang: tree_sitter::Language = tree_sitter_php::LANGUAGE_PHP.into();
    let Some(tree) = parse_utf16(&lang, src, timeout) else {
        return Extracted {
            timed_out: true,
            ..Extracted::default()
        };
    };
    let mut ctx = Ctx {
        src,
        file,
        repo,
        symbols: Vec::new(),
    };
    let mut state = State {
        parent: None,
        parent_is_test: false,
    };
    for child in named_children(tree.root_node()) {
        if child.kind() == "namespace_definition" && child.child_by_field_name("body").is_none() {
            let id = create_namespace(&mut ctx, child, None);
            state = State {
                parent: Some(id),
                parent_is_test: false,
            };
            continue;
        }
        walk(&mut ctx, child, &state);
    }
    Extracted {
        symbols: ctx.symbols,
        ..Extracted::default()
    }
}

fn sym(ctx: &Ctx<'_>, node: Node<'_>, name: String, kind: &'static str, opts: Opts) -> Sym {
    make_symbol(ctx.src, ctx.file, ctx.repo, node, name, kind, opts)
}

fn walk(ctx: &mut Ctx<'_>, node: Node<'_>, state: &State) {
    match node.kind() {
        "namespace_definition" => {
            let id = create_namespace(ctx, node, state.parent.as_deref());
            if let Some(body) = node.child_by_field_name("body") {
                let inner = State {
                    parent: Some(id),
                    parent_is_test: false,
                };
                walk_children(ctx, body, &inner);
            }
        }
        "class_declaration" => handle_class(ctx, node, state),
        "interface_declaration" => handle_interface(ctx, node, state),
        "trait_declaration" => handle_trait(ctx, node, state),
        "enum_declaration" => handle_enum(ctx, node, state),
        "function_definition" => {
            let Some(name) = name_of(ctx, node).filter(|n| !n.is_empty()) else {
                return;
            };
            let opts = Opts {
                parent: state.parent.clone(),
                docstring: docstring(ctx, node),
                signature: signature(ctx, node),
                ..Opts::default()
            };
            let s = sym(ctx, node, name, "function", opts);
            ctx.symbols.push(s);
        }
        "method_declaration" => handle_method(ctx, node, state),
        "property_declaration" => handle_property(ctx, node, state),
        "const_declaration" => {
            for element in named_children(node) {
                if element.kind() != "const_element" {
                    continue;
                }
                let name = named_children(element)
                    .into_iter()
                    .find(|c| c.kind() == "name")
                    .map(|n| ctx.src.text(n))
                    .filter(|n| !n.is_empty());
                let Some(name) = name else { continue };
                let opts = Opts {
                    parent: state.parent.clone(),
                    docstring: docstring(ctx, node),
                    ..Opts::default()
                };
                let s = sym(ctx, element, name, "constant", opts);
                ctx.symbols.push(s);
            }
        }
        "enum_case" => {
            let Some(name) = name_of(ctx, node).filter(|n| !n.is_empty()) else {
                return;
            };
            let opts = Opts {
                parent: state.parent.clone(),
                ..Opts::default()
            };
            let s = sym(ctx, node, name, "constant", opts);
            ctx.symbols.push(s);
        }
        _ => walk_children(ctx, node, state),
    }
}

fn walk_children(ctx: &mut Ctx<'_>, node: Node<'_>, state: &State) {
    for child in named_children(node) {
        walk(ctx, child, state);
    }
}

fn name_of(ctx: &Ctx<'_>, node: Node<'_>) -> Option<String> {
    node.child_by_field_name("name").map(|n| ctx.src.text(n))
}

fn create_namespace(ctx: &mut Ctx<'_>, node: Node<'_>, parent: Option<&str>) -> String {
    let name = name_of(ctx, node).unwrap_or_else(|| "<anonymous>".to_string());
    let opts = Opts {
        parent: parent.map(str::to_string),
        ..Opts::default()
    };
    let s = sym(ctx, node, name, "namespace", opts);
    let id = s.id.clone();
    ctx.symbols.push(s);
    id
}

// --- php-doc.ts ---------------------------------------------------------------------------

/// `getDocstring`: the previous named sibling past visibility modifiers and attribute lists, when it
/// is a `/**` comment.
fn docstring(ctx: &Ctx<'_>, node: Node<'_>) -> Option<String> {
    let mut prev = node.prev_named_sibling();
    while let Some(p) = prev {
        if p.kind() == "visibility_modifier" || p.kind() == "attribute_list" {
            prev = p.prev_named_sibling();
        } else {
            break;
        }
    }
    let p = prev?;
    if p.kind() != "comment" {
        return None;
    }
    let text = ctx.src.text(p);
    text.starts_with("/**").then_some(text)
}

/// JS `\s` and `\S` as character classes for the `regex` crate (JS's set includes U+FEFF, not U+0085).
const JS_S: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";
const JS_NOT_S: &str = r"[^\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";

fn property_tag_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&format!(
            r"@property(?:-read|-write)?{JS_S}+({JS_NOT_S}+){JS_S}+\$([A-Za-z0-9_]+)"
        ))
        .expect("static regex")
    })
}

fn method_tag_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&format!(
            r"@method{JS_S}+(?:({JS_NOT_S}+){JS_S}+)?([A-Za-z0-9_]+){JS_S}*\("
        ))
        .expect("static regex")
    })
}

fn var_tag_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(&format!(r"@var{JS_S}+({JS_NOT_S}+)")).expect("static regex"))
}

/// `parsePhpDocTags`: every `@property`, then every `@method` — `(is_property, name, type)`.
fn doc_tags(doc: &str) -> Vec<(bool, String, Option<String>)> {
    let mut out = Vec::new();
    for c in property_tag_re().captures_iter(doc) {
        out.push((true, c[2].to_string(), Some(c[1].to_string())));
    }
    for c in method_tag_re().captures_iter(doc) {
        let ty = c
            .get(1)
            .map(|m| m.as_str().to_string())
            .filter(|s| !s.is_empty());
        out.push((false, c[2].to_string(), ty));
    }
    out
}

// --- php-class-metadata.ts ----------------------------------------------------------------

fn split_js_space_comma(s: &str) -> Vec<String> {
    // `split(/\s*,\s*/).filter(Boolean)`
    s.split(',')
        .map(|p| p.trim_matches(super::is_js_space).to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

fn parse_clause(ctx: &Ctx<'_>, clause: Option<Node<'_>>, keyword: &str) -> Vec<String> {
    let Some(clause) = clause else {
        return Vec::new();
    };
    let names: Vec<String> = named_children(clause)
        .into_iter()
        .filter(|c| c.kind() == "name" || c.kind() == "qualified_name")
        .map(|c| js_trim(&ctx.src.text(c)).to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if !names.is_empty() {
        return names;
    }
    let text = ctx.src.text(clause);
    // `.replace(new RegExp(`^${keyword}\\s+`), "")`: only when whitespace follows the keyword.
    let rest = match text.strip_prefix(keyword) {
        Some(r) if r.starts_with(super::is_js_space) => r.trim_start_matches(super::is_js_space),
        _ => text.as_str(),
    };
    let stripped = js_trim(rest);
    if stripped.is_empty() {
        Vec::new()
    } else {
        split_js_space_comma(stripped)
    }
}

fn clause_node<'t>(node: Node<'t>, kind: &str) -> Option<Node<'t>> {
    node.child_by_field_name(kind)
        .or_else(|| named_children(node).into_iter().find(|c| c.kind() == kind))
}

fn class_extends(ctx: &Ctx<'_>, node: Node<'_>) -> Vec<String> {
    parse_clause(ctx, clause_node(node, "base_clause"), "extends")
}

fn class_implements(ctx: &Ctx<'_>, node: Node<'_>) -> Vec<String> {
    parse_clause(
        ctx,
        clause_node(node, "class_interface_clause"),
        "implements",
    )
}

fn trait_uses(ctx: &Ctx<'_>, body: Option<Node<'_>>) -> Vec<String> {
    let Some(body) = body else { return Vec::new() };
    let mut out = Vec::new();
    for child in named_children(body) {
        if child.kind() != "use_declaration" {
            continue;
        }
        for c in named_children(child) {
            if c.kind() == "name" || c.kind() == "qualified_name" {
                let t = js_trim(&ctx.src.text(c)).to_string();
                if !t.is_empty() {
                    out.push(t);
                }
            }
        }
    }
    out
}

fn is_test_case_class(ctx: &Ctx<'_>, node: Node<'_>) -> bool {
    class_extends(ctx, node).iter().any(|base| {
        let last = base.rsplit('\\').next().unwrap_or("");
        matches!(last, "TestCase" | "Unit" | "Cest" | "Cept")
    })
}

fn classify_method(name: &str, parent_is_test: bool, doc: Option<&str>) -> &'static str {
    if matches!(
        name,
        "setUp" | "tearDown" | "setUpBeforeClass" | "tearDownAfterClass"
    ) {
        return "test_hook";
    }
    if parent_is_test && (name.starts_with("test") || doc.is_some_and(|d| d.contains("@test"))) {
        return "test_case";
    }
    "method"
}

// --- php-node-metadata.ts -----------------------------------------------------------------

fn signature(ctx: &Ctx<'_>, node: Node<'_>) -> Option<String> {
    let params = node.child_by_field_name("parameters")?;
    let mut sig = ctx.src.text(params);
    if let Some(rt) = node.child_by_field_name("return_type") {
        sig.push_str(": ");
        sig.push_str(&ctx.src.text(rt));
    }
    Some(sig)
}

#[derive(Default)]
struct Modifiers {
    visibility: Option<String>,
    is_static: bool,
    is_abstract: bool,
    is_final: bool,
    is_readonly: bool,
}

fn modifiers(ctx: &Ctx<'_>, node: Node<'_>) -> Modifiers {
    let mut m = Modifiers::default();
    for child in named_children(node) {
        let text = js_trim(&ctx.src.text(child)).to_string();
        if child.kind() == "visibility_modifier" {
            if matches!(text.as_str(), "public" | "private" | "protected") {
                m.visibility = Some(text);
            }
            continue;
        }
        let flag = match child.kind() {
            "static_modifier" => "static",
            "abstract_modifier" => "abstract",
            "final_modifier" => "final",
            "readonly_modifier" => "readonly",
            // `MODIFIER_TEXT_FLAGS[text]` for a generic `modifier` node.
            "modifier" => text.as_str(),
            _ => "",
        };
        match flag {
            "static" => m.is_static = true,
            "abstract" => m.is_abstract = true,
            "final" => m.is_final = true,
            "readonly" => m.is_readonly = true,
            _ => {}
        }
    }
    m
}

fn walk_attribute_list(ctx: &Ctx<'_>, list: Node<'_>, out: &mut Vec<(String, Option<String>)>) {
    for group in named_children(list) {
        let attrs: Vec<Node<'_>> = match group.kind() {
            "attribute_group" => named_children(group)
                .into_iter()
                .filter(|c| c.kind() == "attribute")
                .collect(),
            "attribute" => vec![group],
            _ => continue,
        };
        for attr in attrs {
            let kids = named_children(attr);
            let Some(name) = kids
                .iter()
                .find(|c| c.kind() == "name" || c.kind() == "qualified_name")
            else {
                continue;
            };
            let args = kids.iter().find(|c| c.kind() == "arguments").map(|a| {
                let t = ctx.src.text(*a);
                let t = t.strip_prefix('(').unwrap_or(&t);
                let t = t.strip_suffix(')').unwrap_or(t);
                js_trim(t).to_string()
            });
            out.push((ctx.src.text(*name), args));
        }
    }
}

fn attributes(ctx: &Ctx<'_>, node: Node<'_>) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    let mut preceding = Vec::new();
    let mut prev = node.prev_named_sibling();
    while let Some(p) = prev {
        if p.kind() != "attribute_list" {
            break;
        }
        preceding.push(p);
        prev = p.prev_named_sibling();
    }
    preceding.reverse();
    for list in preceding {
        walk_attribute_list(ctx, list, &mut out);
    }
    for child in named_children(node) {
        if child.kind() == "attribute_list" {
            walk_attribute_list(ctx, child, &mut out);
        }
    }
    out
}

const TYPE_NODES: [&str; 6] = [
    "primitive_type",
    "named_type",
    "optional_type",
    "union_type",
    "intersection_type",
    "disjunctive_normal_form_type",
];

fn inline_type(ctx: &Ctx<'_>, node: Node<'_>) -> Option<String> {
    named_children(node)
        .into_iter()
        .find(|c| TYPE_NODES.contains(&c.kind()))
        .map(|c| js_trim(&ctx.src.text(c)).to_string())
}

// --- php-walker.ts handlers -----------------------------------------------------------------

fn push_attrs(meta: &mut Vec<(&'static str, Meta)>, attrs: Vec<(String, Option<String>)>) {
    if !attrs.is_empty() {
        meta.push(("attributes", Meta::Attrs(attrs)));
    }
}

fn handle_class(ctx: &mut Ctx<'_>, node: Node<'_>, state: &State) {
    let is_test = is_test_case_class(ctx, node);
    let doc = docstring(ctx, node);
    let body = node.child_by_field_name("body");
    let m = modifiers(ctx, node);
    let mut meta = Vec::new();
    if m.is_abstract {
        meta.push(("is_abstract", Meta::Bool(true)));
    }
    if m.is_final {
        meta.push(("is_final", Meta::Bool(true)));
    }
    if m.is_readonly {
        meta.push(("is_readonly", Meta::Bool(true)));
    }
    let traits = trait_uses(ctx, body);
    if !traits.is_empty() {
        meta.push(("uses_traits", Meta::Strs(traits)));
    }
    push_attrs(&mut meta, attributes(ctx, node));
    let opts = Opts {
        parent: state.parent.clone(),
        docstring: doc.clone(),
        extends: class_extends(ctx, node),
        implements: class_implements(ctx, node),
        meta,
        ..Opts::default()
    };
    let name = name_of(ctx, node).unwrap_or_else(|| "<anonymous>".to_string());
    let kind = if is_test { "test_suite" } else { "class" };
    let s = sym(ctx, node, name, kind, opts);
    let id = s.id.clone();
    ctx.symbols.push(s);
    if let Some(body) = body {
        let inner = State {
            parent: Some(id.clone()),
            parent_is_test: is_test,
        };
        walk_children(ctx, body, &inner);
    }
    synthesize_doc_tags(ctx, node, &id, doc.as_deref());
}

fn handle_interface(ctx: &mut Ctx<'_>, node: Node<'_>, state: &State) {
    let doc = docstring(ctx, node);
    let mut meta = Vec::new();
    push_attrs(&mut meta, attributes(ctx, node));
    let opts = Opts {
        parent: state.parent.clone(),
        docstring: doc.clone(),
        extends: class_extends(ctx, node),
        meta,
        ..Opts::default()
    };
    let name = name_of(ctx, node).unwrap_or_else(|| "<anonymous>".to_string());
    let s = sym(ctx, node, name, "interface", opts);
    let id = s.id.clone();
    ctx.symbols.push(s);
    if let Some(body) = node.child_by_field_name("body") {
        let inner = State {
            parent: Some(id.clone()),
            parent_is_test: false,
        };
        walk_children(ctx, body, &inner);
    }
    synthesize_doc_tags(ctx, node, &id, doc.as_deref());
}

fn handle_trait(ctx: &mut Ctx<'_>, node: Node<'_>, state: &State) {
    let doc = docstring(ctx, node);
    let body = node.child_by_field_name("body");
    let mut meta = Vec::new();
    let traits = trait_uses(ctx, body);
    if !traits.is_empty() {
        meta.push(("uses_traits", Meta::Strs(traits)));
    }
    push_attrs(&mut meta, attributes(ctx, node));
    let opts = Opts {
        parent: state.parent.clone(),
        docstring: doc.clone(),
        meta,
        ..Opts::default()
    };
    let name = name_of(ctx, node).unwrap_or_else(|| "<anonymous>".to_string());
    let s = sym(ctx, node, name, "type", opts);
    let id = s.id.clone();
    ctx.symbols.push(s);
    if let Some(body) = body {
        let inner = State {
            parent: Some(id.clone()),
            parent_is_test: false,
        };
        walk_children(ctx, body, &inner);
    }
    synthesize_doc_tags(ctx, node, &id, doc.as_deref());
}

fn handle_enum(ctx: &mut Ctx<'_>, node: Node<'_>, state: &State) {
    let mut meta = Vec::new();
    let backing = named_children(node)
        .into_iter()
        .find(|c| c.kind() == "primitive_type")
        .map(|c| js_trim(&ctx.src.text(c)).to_string())
        .filter(|s| !s.is_empty());
    if let Some(b) = backing {
        meta.push(("backed_type", Meta::Str(b)));
    }
    push_attrs(&mut meta, attributes(ctx, node));
    let opts = Opts {
        parent: state.parent.clone(),
        docstring: docstring(ctx, node),
        implements: class_implements(ctx, node),
        meta,
        ..Opts::default()
    };
    let name = name_of(ctx, node).unwrap_or_else(|| "<anonymous>".to_string());
    let s = sym(ctx, node, name, "enum", opts);
    let id = s.id.clone();
    ctx.symbols.push(s);
    let body = node.child_by_field_name("body").or_else(|| {
        named_children(node)
            .into_iter()
            .find(|c| c.kind() == "enum_declaration_list")
    });
    if let Some(body) = body {
        let inner = State {
            parent: Some(id),
            parent_is_test: false,
        };
        walk_children(ctx, body, &inner);
    }
}

fn handle_method(ctx: &mut Ctx<'_>, node: Node<'_>, state: &State) {
    let Some(name) = name_of(ctx, node).filter(|n| !n.is_empty()) else {
        return;
    };
    let doc = docstring(ctx, node);
    let m = modifiers(ctx, node);
    let mut meta = Vec::new();
    if let Some(v) = m.visibility {
        meta.push(("visibility", Meta::Str(v)));
    }
    if m.is_static {
        meta.push(("is_static", Meta::Bool(true)));
    }
    if m.is_abstract {
        meta.push(("is_abstract", Meta::Bool(true)));
    }
    if m.is_final {
        meta.push(("is_final", Meta::Bool(true)));
    }
    push_attrs(&mut meta, attributes(ctx, node));
    let kind = classify_method(&name, state.parent_is_test, doc.as_deref());
    let opts = Opts {
        parent: state.parent.clone(),
        docstring: doc,
        signature: signature(ctx, node),
        meta,
        ..Opts::default()
    };
    let is_ctor = name == "__construct";
    let s = sym(ctx, node, name, kind, opts);
    ctx.symbols.push(s);
    if is_ctor {
        if let Some(class_id) = state.parent.clone().filter(|p| !p.is_empty()) {
            emit_promoted_fields(ctx, node, &class_id);
        }
    }
}

fn handle_property(ctx: &mut Ctx<'_>, node: Node<'_>, state: &State) {
    let mut entries: Vec<(String, Node<'_>)> = Vec::new();
    for prop in named_children(node) {
        if prop.kind() != "property_element" {
            continue;
        }
        let var = named_children(prop)
            .into_iter()
            .find(|c| c.kind() == "variable_name");
        let name = var.and_then(|v| named_children(v).into_iter().find(|c| c.kind() == "name"));
        if let Some(n) = name {
            entries.push((format!("${}", ctx.src.text(n)), prop));
        }
    }
    if entries.is_empty() {
        return;
    }
    let doc = docstring(ctx, node);
    let m = modifiers(ctx, node);
    let mut meta = Vec::new();
    if let Some(v) = m.visibility {
        meta.push(("visibility", Meta::Str(v)));
    }
    if m.is_static {
        meta.push(("is_static", Meta::Bool(true)));
    }
    if m.is_readonly {
        meta.push(("is_readonly", Meta::Bool(true)));
    }
    let inline = inline_type(ctx, node).filter(|s| !s.is_empty());
    let doc_type = doc
        .as_deref()
        .and_then(|d| var_tag_re().captures(d).map(|c| c[1].to_string()));
    if let Some(t) = inline {
        meta.push(("type", Meta::Str(t)));
        meta.push(("type_source", Meta::Str("inline".to_string())));
    } else if let Some(t) = doc_type {
        meta.push(("type", Meta::Str(t)));
        meta.push(("type_source", Meta::Str("phpdoc".to_string())));
    }
    push_attrs(&mut meta, attributes(ctx, node));
    for (name, prop) in entries {
        let opts = Opts {
            parent: state.parent.clone(),
            docstring: doc.clone(),
            meta: meta.clone(),
            ..Opts::default()
        };
        let s = sym(ctx, prop, name, "field", opts);
        ctx.symbols.push(s);
    }
}

fn emit_promoted_fields(ctx: &mut Ctx<'_>, method: Node<'_>, class_id: &str) {
    let params = method.child_by_field_name("parameters").or_else(|| {
        named_children(method)
            .into_iter()
            .find(|c| c.kind() == "formal_parameters")
    });
    let Some(params) = params else { return };
    for param in named_children(params) {
        if param.kind() != "property_promotion_parameter" {
            continue;
        }
        let var = named_children(param)
            .into_iter()
            .find(|c| c.kind() == "variable_name");
        let Some(name) =
            var.and_then(|v| named_children(v).into_iter().find(|c| c.kind() == "name"))
        else {
            continue;
        };
        let m = modifiers(ctx, param);
        let mut meta = vec![("from_constructor", Meta::Bool(true))];
        if let Some(v) = m.visibility {
            meta.push(("visibility", Meta::Str(v)));
        }
        if m.is_readonly {
            meta.push(("is_readonly", Meta::Bool(true)));
        }
        if let Some(t) = inline_type(ctx, param).filter(|s| !s.is_empty()) {
            meta.push(("type", Meta::Str(t)));
            meta.push(("type_source", Meta::Str("inline".to_string())));
        }
        push_attrs(&mut meta, attributes(ctx, param));
        let opts = Opts {
            parent: Some(class_id.to_string()),
            meta,
            ..Opts::default()
        };
        let s = sym(
            ctx,
            param,
            format!("${}", ctx.src.text(name)),
            "field",
            opts,
        );
        ctx.symbols.push(s);
    }
}

/// `comparableMemberName`: fields compare without the `$`, everything else case-insensitively.
fn comparable(name: &str, kind: &str) -> String {
    if kind == "field" {
        name.strip_prefix('$').unwrap_or(name).to_string()
    } else {
        name.to_lowercase()
    }
}

/// `synthesizeDocstringTags`.
fn synthesize_doc_tags(ctx: &mut Ctx<'_>, node: Node<'_>, parent_id: &str, doc: Option<&str>) {
    let Some(doc) = doc.filter(|d| !d.is_empty()) else {
        return;
    };
    for (is_property, name, ty) in doc_tags(doc) {
        let kind = if is_property { "field" } else { "method" };
        let wanted = comparable(&name, kind);
        let exists = ctx.symbols.iter().any(|s| {
            s.parent.as_deref() == Some(parent_id)
                && s.kind == kind
                && comparable(&s.name, s.kind) == wanted
        });
        if exists {
            continue;
        }
        let opts = Opts {
            parent: Some(parent_id.to_string()),
            signature: ty,
            meta: vec![("synthetic", Meta::Bool(true))],
            ..Opts::default()
        };
        let s = sym(ctx, node, name, kind, opts);
        ctx.symbols.push(s);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classes_docblock_members_promotion_and_namespaces() {
        let src = "<?php\nnamespace App\\Models;\n\n/**\n * @property int $id\n * @property-read string $name\n * @method self find(int $id)\n */\n#[Entity]\nfinal class User extends \\Base\\Model implements A, B {\n    use SoftDeletes;\n    /** @var string */\n    protected $email;\n    public function __construct(private readonly int $age) {}\n    public function name(): string { return ''; }\n}\nenum Status: string { case Active = 'a'; }\n";
        let syms = extract(
            &Utf16Source::from_text(src),
            "User.php",
            "r",
            Duration::from_secs(10),
        )
        .symbols;
        let kinds: Vec<(&str, &str)> = syms.iter().map(|s| (s.name.as_str(), s.kind)).collect();
        assert_eq!(
            kinds,
            vec![
                ("App\\Models", "namespace"),
                ("User", "class"),
                ("$email", "field"),
                ("__construct", "method"),
                ("$age", "field"),
                ("name", "method"),
                ("id", "field"),
                ("name", "field"),
                ("find", "method"),
                ("Status", "enum"),
                ("Active", "constant")
            ]
        );
        assert_eq!(syms[1].extends, vec!["\\Base\\Model"]);
        assert_eq!(syms[1].implements, vec!["A", "B"]);
        assert_eq!(syms[1].parent.as_deref(), Some(syms[0].id.as_str()));
    }
}
