//! Kotlin and Gradle KTS symbols — ports of `kotlin.ts` (+ `kotlin-ast-helpers.ts`,
//! `kotlin-test-symbols.ts`) and `gradle-kts.ts`. Both run on the Kotlin grammar, as the TypeScript
//! path does (`parseFile` maps `gradle-kts` to the `kotlin` parser).
//!
//! Carried over as written: `hasModifier` matches the text of ANY node under `modifiers`; an
//! annotation's name is the LAST identifier of its type in DFS order, backticks stripped, last
//! dot-segment; a property or function declaration keeps walking into its children with the same
//! parent; a Kotest body is searched one level below non-call statements, no deeper.

use std::time::Duration;

use tree_sitter::Node;

use super::{
    children, js_trim, make_symbol, named_children, parse_utf16, Extracted, Meta, Opts, Sym,
    Utf16Source,
};

struct Ctx<'s> {
    src: &'s Utf16Source,
    file: &'s str,
    repo: &'s str,
    symbols: Vec<Sym>,
}

fn parse(src: &Utf16Source, timeout: Duration) -> Option<tree_sitter::Tree> {
    let lang: tree_sitter::Language = tree_sitter_kotlin_ng::LANGUAGE.into();
    parse_utf16(&lang, src, timeout)
}

pub fn extract(src: &Utf16Source, file: &str, repo: &str, timeout: Duration) -> Extracted {
    let Some(tree) = parse(src, timeout) else {
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
    walk(&mut ctx, tree.root_node(), None);
    Extracted {
        symbols: ctx.symbols,
        ..Extracted::default()
    }
}

fn sym(ctx: &Ctx<'_>, node: Node<'_>, name: String, kind: &'static str, opts: Opts) -> Sym {
    make_symbol(ctx.src, ctx.file, ctx.repo, node, name, kind, opts)
}

fn first_named<'t>(node: Node<'t>, kind: &str) -> Option<Node<'t>> {
    named_children(node).into_iter().find(|c| c.kind() == kind)
}

// --- kotlin-ast-helpers.ts ----------------------------------------------------------------

/// `getName`: the `name` field, else the first identifier child. An empty name field does NOT fall
/// back (`??` only replaces null) — callers then reject the empty string.
fn get_name(ctx: &Ctx<'_>, node: Node<'_>) -> Option<String> {
    match node.child_by_field_name("name") {
        Some(n) => Some(ctx.src.text(n)),
        None => first_named(node, "identifier").map(|n| ctx.src.text(n)),
    }
}

fn docstring(ctx: &Ctx<'_>, node: Node<'_>) -> Option<String> {
    let prev = node.prev_named_sibling()?;
    if prev.kind() != "block_comment" {
        return None;
    }
    let text = ctx.src.text(prev);
    text.starts_with("/**").then_some(text)
}

fn is_interface(node: Node<'_>) -> bool {
    for c in children(node) {
        if c.kind() == "interface" {
            return true;
        }
        if c.kind() == "identifier" || c.kind() == "class_body" {
            break;
        }
    }
    false
}

fn has_modifier(ctx: &Ctx<'_>, node: Node<'_>, modifier: &str) -> bool {
    let Some(mods) = first_named(node, "modifiers") else {
        return false;
    };
    let mut stack = vec![mods];
    while let Some(n) = stack.pop() {
        if ctx.src.text(n) == modifier {
            return true;
        }
        stack.extend(children(n));
    }
    false
}

fn kmp_modifier(ctx: &Ctx<'_>, node: Node<'_>) -> Option<&'static str> {
    let mods = first_named(node, "modifiers")?;
    for m in named_children(mods) {
        if m.kind() != "platform_modifier" {
            continue;
        }
        match js_trim(&ctx.src.text(m)) {
            "expect" => return Some("expect"),
            "actual" => return Some("actual"),
            _ => {}
        }
    }
    None
}

fn strip_backticks(s: &str) -> &str {
    let s = s.strip_prefix('`').unwrap_or(s);
    s.strip_suffix('`').unwrap_or(s)
}

fn simple_user_type_name(ctx: &Ctx<'_>, node: Node<'_>) -> String {
    let mut ids: Vec<String> = Vec::new();
    let mut stack = vec![node];
    while let Some(n) = stack.pop() {
        if n.kind() == "identifier" {
            ids.push(ctx.src.text(n));
        }
        let mut kids = named_children(n);
        kids.reverse();
        stack.extend(kids);
    }
    let selected = ids.pop().unwrap_or_else(|| ctx.src.text(node));
    let unescaped = strip_backticks(js_trim(&selected)).to_string();
    js_trim(unescaped.rsplit('.').next().unwrap_or(&unescaped)).to_string()
}

fn annotations(ctx: &Ctx<'_>, node: Node<'_>) -> Vec<String> {
    let Some(mods) = first_named(node, "modifiers") else {
        return Vec::new();
    };
    named_children(mods)
        .into_iter()
        .filter(|m| m.kind() == "annotation")
        .map(|a| {
            if let Some(ut) = first_named(a, "user_type") {
                return simple_user_type_name(ctx, ut);
            }
            let raw = || {
                let t = ctx.src.text(a);
                t.strip_prefix('@').unwrap_or(&t).to_string()
            };
            match first_named(a, "constructor_invocation") {
                Some(ci) => match first_named(ci, "user_type") {
                    Some(ut) => simple_user_type_name(ctx, ut),
                    None => raw(),
                },
                None => raw(),
            }
        })
        .collect()
}

fn property_name(ctx: &Ctx<'_>, node: Node<'_>) -> Option<String> {
    let var = first_named(node, "variable_declaration")?;
    first_named(var, "identifier").map(|i| ctx.src.text(i))
}

fn receiver_type(ctx: &Ctx<'_>, node: Node<'_>) -> Option<String> {
    let name = node
        .child_by_field_name("name")
        .or_else(|| first_named(node, "identifier"))?;
    let name_start = super::start_index(name);
    named_children(node)
        .into_iter()
        .find(|c| c.kind() == "user_type" && super::end_index(*c) < name_start)
        .map(|c| ctx.src.text(c))
}

fn signature(ctx: &Ctx<'_>, node: Node<'_>) -> Option<String> {
    let params = first_named(node, "function_value_parameters")?;
    let mut sig = String::new();
    if has_modifier(ctx, node, "suspend") {
        sig.push_str("suspend ");
    }
    if let Some(r) = receiver_type(ctx, node) {
        sig.push_str(&r);
        sig.push('.');
    }
    if let Some(tp) = first_named(node, "type_parameters") {
        sig.push_str(&ctx.src.text(tp));
        sig.push(' ');
    }
    sig.push_str(&ctx.src.text(params));
    let params_end = super::end_index(params);
    if let Some(rt) = named_children(node).into_iter().find(|c| {
        super::start_index(*c) > params_end
            && matches!(
                c.kind(),
                "user_type" | "nullable_type" | "function_type" | "parenthesized_type"
            )
    }) {
        sig.push_str(": ");
        sig.push_str(&ctx.src.text(rt));
    }
    let trimmed = js_trim(&sig);
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

// --- kotlin-test-symbols.ts ---------------------------------------------------------------

fn test_kind(annotations: &[String]) -> Option<&'static str> {
    for a in annotations {
        if matches!(a.as_str(), "Test" | "ParameterizedTest" | "RepeatedTest") {
            return Some("test_case");
        }
        if matches!(
            a.as_str(),
            "BeforeEach"
                | "AfterEach"
                | "BeforeAll"
                | "AfterAll"
                | "Before"
                | "After"
                | "BeforeClass"
                | "AfterClass"
        ) {
            return Some("test_hook");
        }
    }
    None
}

const KOTEST_SPECS: [&str; 10] = [
    "FunSpec",
    "DescribeSpec",
    "StringSpec",
    "BehaviorSpec",
    "ShouldSpec",
    "WordSpec",
    "FeatureSpec",
    "ExpectSpec",
    "AnnotationSpec",
    "FreeSpec",
];

const KOTEST_KEYWORDS: [&str; 15] = [
    "test",
    "it",
    "describe",
    "context",
    "should",
    "given",
    "when",
    "then",
    "feature",
    "scenario",
    "expect",
    "xtest",
    "xit",
    "xdescribe",
    "xcontext",
];

fn find_kotest_lambda<'t>(ctx: &Ctx<'_>, node: Node<'t>) -> Option<Node<'t>> {
    let delegation = first_named(node, "delegation_specifiers")?;
    for spec in named_children(delegation) {
        if spec.kind() != "delegation_specifier" {
            continue;
        }
        let Some(ctor) = first_named(spec, "constructor_invocation") else {
            continue;
        };
        let Some(ut) = first_named(ctor, "user_type") else {
            continue;
        };
        let Some(ident) = first_named(ut, "identifier") else {
            continue;
        };
        if !KOTEST_SPECS.contains(&ctx.src.text(ident).as_str()) {
            continue;
        }
        let args = first_named(ctor, "value_arguments")?;
        let arg = first_named(args, "value_argument")?;
        return first_named(arg, "lambda_literal");
    }
    None
}

fn unquote(ctx: &Ctx<'_>, node: Node<'_>) -> String {
    if let Some(content) = first_named(node, "string_content") {
        return ctx.src.text(content);
    }
    let t = ctx.src.text(node);
    let t = t.strip_prefix('"').unwrap_or(&t);
    t.strip_suffix('"').unwrap_or(t).to_string()
}

fn kotest_test_name(ctx: &Ctx<'_>, call: Node<'_>) -> Option<String> {
    let kids = named_children(call);
    if !kids.iter().any(|c| c.kind() == "annotated_lambda") {
        return None;
    }
    let first = *kids.first()?;
    if first.kind() == "string_literal" {
        return Some(unquote(ctx, first));
    }
    if first.kind() != "call_expression" {
        return None;
    }
    let callee = first_named(first, "identifier")?;
    let keyword = strip_backticks(&ctx.src.text(callee)).to_string();
    if !KOTEST_KEYWORDS.contains(&keyword.as_str()) {
        return None;
    }
    let args = first_named(first, "value_arguments")?;
    let arg = first_named(args, "value_argument")?;
    let lit = first_named(arg, "string_literal")?;
    Some(unquote(ctx, lit))
}

fn walk_kotest_lambda(ctx: &mut Ctx<'_>, lambda: Node<'_>, parent: &str) {
    for child in named_children(lambda) {
        if child.kind() != "call_expression" {
            for grand in named_children(child) {
                if grand.kind() == "call_expression" {
                    walk_kotest_call(ctx, grand, parent);
                }
            }
            continue;
        }
        walk_kotest_call(ctx, child, parent);
    }
}

fn walk_kotest_call(ctx: &mut Ctx<'_>, call: Node<'_>, parent: &str) {
    let Some(name) = kotest_test_name(ctx, call).filter(|n| !n.is_empty()) else {
        return;
    };
    let opts = Opts {
        parent: Some(parent.to_string()),
        ..Opts::default()
    };
    let s = sym(ctx, call, name, "test_case", opts);
    let id = s.id.clone();
    ctx.symbols.push(s);
    let Some(annotated) = first_named(call, "annotated_lambda") else {
        return;
    };
    let Some(inner) = first_named(annotated, "lambda_literal") else {
        return;
    };
    walk_kotest_lambda(ctx, inner, &id);
}

// --- kotlin.ts ----------------------------------------------------------------------------

fn walk(ctx: &mut Ctx<'_>, node: Node<'_>, parent: Option<&str>) {
    match node.kind() {
        "function_declaration" => {
            if let Some(name) = get_name(ctx, node).filter(|n| !n.is_empty()) {
                let anns = annotations(ctx, node);
                let composable = anns.iter().any(|a| a == "Composable");
                let preview = anns.iter().any(|a| a == "Preview");
                let kind = test_kind(&anns).unwrap_or(if composable {
                    "component"
                } else if parent.is_some_and(|p| !p.is_empty()) {
                    "method"
                } else {
                    "function"
                });
                let mut meta = Vec::new();
                if let Some(k) = kmp_modifier(ctx, node) {
                    meta.push(("kmp_modifier", Meta::Str(k.to_string())));
                }
                if composable {
                    meta.push(("compose", Meta::Bool(true)));
                }
                if preview {
                    meta.push(("compose_preview", Meta::Bool(true)));
                }
                let opts = Opts {
                    parent: parent.map(str::to_string),
                    docstring: docstring(ctx, node),
                    signature: signature(ctx, node),
                    decorators: anns.clone(),
                    meta,
                    ..Opts::default()
                };
                let s = sym(ctx, node, name, kind, opts);
                ctx.symbols.push(s);
            }
        }
        "class_declaration" => {
            let Some(name) = get_name(ctx, node).filter(|n| !n.is_empty()) else {
                return;
            };
            let kotest = find_kotest_lambda(ctx, node);
            let base = if is_interface(node) {
                "interface"
            } else {
                "class"
            };
            let kind = if kotest.is_some() { "test_suite" } else { base };
            let anns = annotations(ctx, node);
            let mut meta = Vec::new();
            if let Some(k) = kmp_modifier(ctx, node) {
                meta.push(("kmp_modifier", Meta::Str(k.to_string())));
            }
            let opts = Opts {
                parent: parent.map(str::to_string),
                docstring: docstring(ctx, node),
                decorators: anns,
                meta,
                ..Opts::default()
            };
            let s = sym(ctx, node, name, kind, opts);
            let id = s.id.clone();
            ctx.symbols.push(s);
            if let Some(lambda) = kotest {
                walk_kotest_lambda(ctx, lambda, &id);
            }
            if let Some(params) = first_named(node, "primary_constructor")
                .and_then(|pc| first_named(pc, "class_parameters"))
            {
                for param in named_children(params) {
                    if param.kind() != "class_parameter" {
                        continue;
                    }
                    let has_val_var = children(param)
                        .iter()
                        .any(|c| matches!(c.kind(), "val" | "var"));
                    if let Some(pname) = get_name(ctx, param).filter(|n| !n.is_empty()) {
                        if has_val_var {
                            let opts = Opts {
                                parent: Some(id.clone()),
                                ..Opts::default()
                            };
                            let f = sym(ctx, param, pname, "field", opts);
                            ctx.symbols.push(f);
                        }
                    }
                }
            }
            if let Some(body) = first_named(node, "enum_class_body") {
                for entry in named_children(body) {
                    if entry.kind() != "enum_entry" {
                        continue;
                    }
                    if let Some(ename) = get_name(ctx, entry).filter(|n| !n.is_empty()) {
                        let opts = Opts {
                            parent: Some(id.clone()),
                            ..Opts::default()
                        };
                        let e = sym(ctx, entry, ename, "field", opts);
                        ctx.symbols.push(e);
                    }
                }
            }
            if let Some(body) = named_children(node)
                .into_iter()
                .find(|c| c.kind() == "class_body" || c.kind() == "enum_class_body")
            {
                for child in named_children(body) {
                    walk(ctx, child, Some(&id));
                }
            }
            return;
        }
        "object_declaration" => {
            let Some(name) = get_name(ctx, node).filter(|n| !n.is_empty()) else {
                return;
            };
            let opts = Opts {
                parent: parent.map(str::to_string),
                docstring: docstring(ctx, node),
                decorators: annotations(ctx, node),
                ..Opts::default()
            };
            let s = sym(ctx, node, name, "class", opts);
            let id = s.id.clone();
            ctx.symbols.push(s);
            if let Some(body) = first_named(node, "class_body") {
                for child in named_children(body) {
                    walk(ctx, child, Some(&id));
                }
            }
            return;
        }
        "companion_object" => {
            let name = first_named(node, "identifier")
                .map(|n| ctx.src.text(n))
                .unwrap_or_else(|| "Companion".to_string());
            let opts = Opts {
                parent: parent.map(str::to_string),
                docstring: docstring(ctx, node),
                ..Opts::default()
            };
            let s = sym(ctx, node, name, "class", opts);
            let id = s.id.clone();
            ctx.symbols.push(s);
            if let Some(body) = first_named(node, "class_body") {
                for child in named_children(body) {
                    walk(ctx, child, Some(&id));
                }
            }
            return;
        }
        "property_declaration" => {
            if let Some(name) = property_name(ctx, node).filter(|n| !n.is_empty()) {
                let kind = if has_modifier(ctx, node, "const") {
                    "constant"
                } else if parent.is_some_and(|p| !p.is_empty()) {
                    "field"
                } else {
                    "variable"
                };
                let mut meta = Vec::new();
                if let Some(k) = kmp_modifier(ctx, node) {
                    meta.push(("kmp_modifier", Meta::Str(k.to_string())));
                }
                let opts = Opts {
                    parent: parent.map(str::to_string),
                    docstring: docstring(ctx, node),
                    decorators: annotations(ctx, node),
                    meta,
                    ..Opts::default()
                };
                let s = sym(ctx, node, name, kind, opts);
                ctx.symbols.push(s);
            }
        }
        "type_alias" => {
            if let Some(name) = get_name(ctx, node).filter(|n| !n.is_empty()) {
                let opts = Opts {
                    parent: parent.map(str::to_string),
                    docstring: docstring(ctx, node),
                    ..Opts::default()
                };
                let s = sym(ctx, node, name, "type", opts);
                ctx.symbols.push(s);
            }
        }
        _ => {}
    }
    for child in named_children(node) {
        walk(ctx, child, parent);
    }
}

// --- gradle-kts.ts ------------------------------------------------------------------------

pub fn extract_gradle_kts(
    src: &Utf16Source,
    file: &str,
    repo: &str,
    timeout: Duration,
) -> Extracted {
    let Some(tree) = parse(src, timeout) else {
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
    for child in named_children(tree.root_node()) {
        if child.kind() != "call_expression" {
            continue;
        }
        let Some(block) = first_named(child, "identifier").map(|i| ctx.src.text(i)) else {
            continue;
        };
        let Some(lambda) =
            first_named(child, "annotated_lambda").and_then(|a| first_named(a, "lambda_literal"))
        else {
            continue;
        };
        match block.as_str() {
            "plugins" => gradle_plugins(&mut ctx, lambda),
            "dependencies" => gradle_dependencies(&mut ctx, lambda),
            "android" | "kotlin" | "java" | "buildscript" | "allprojects" | "subprojects"
            | "application" | "jvm" | "tasks" => gradle_config(&mut ctx, lambda, &block),
            _ => {}
        }
    }
    Extracted {
        symbols: ctx.symbols,
        ..Extracted::default()
    }
}

/// `parsePluginCall`: `(declarator, name)`.
fn plugin_call(ctx: &Ctx<'_>, call: Node<'_>) -> Option<(String, String)> {
    let callee = first_named(call, "identifier")?;
    let declarator = ctx.src.text(callee);
    if !matches!(declarator.as_str(), "id" | "kotlin" | "alias") {
        return None;
    }
    let args = first_named(call, "value_arguments")?;
    let arg = first_named(args, "value_argument")?;
    if let Some(lit) = first_named(arg, "string_literal") {
        return Some((declarator, unquote(ctx, lit)));
    }
    let nav = first_named(arg, "navigation_expression")?;
    let full = js_trim(&ctx.src.text(nav)).to_string();
    let stripped = full
        .strip_prefix("libs.plugins.")
        .unwrap_or(&full)
        .to_string();
    Some((
        declarator,
        if stripped.is_empty() { full } else { stripped },
    ))
}

fn push_plugin(
    ctx: &mut Ctx<'_>,
    node: Node<'_>,
    declarator: String,
    name: String,
    version: Option<String>,
) {
    let mut meta = vec![
        ("gradle_type", Meta::Str("plugin".to_string())),
        ("declarator", Meta::Str(declarator)),
    ];
    if let Some(v) = version.filter(|v| !v.is_empty()) {
        meta.push(("version", Meta::Str(v)));
    }
    let s = sym(
        ctx,
        node,
        name,
        "variable",
        Opts {
            meta,
            ..Opts::default()
        },
    );
    ctx.symbols.push(s);
}

fn gradle_plugins(ctx: &mut Ctx<'_>, lambda: Node<'_>) {
    for entry in named_children(lambda) {
        match entry.kind() {
            "call_expression" => {
                if let Some((d, n)) = plugin_call(ctx, entry) {
                    push_plugin(ctx, entry, d, n, None);
                }
            }
            "infix_expression" => {
                let Some(call) = first_named(entry, "call_expression") else {
                    continue;
                };
                let Some((d, n)) = plugin_call(ctx, call) else {
                    continue;
                };
                let version = named_children(entry)
                    .into_iter()
                    .rfind(|c| c.kind() == "string_literal")
                    .map(|l| unquote(ctx, l));
                push_plugin(ctx, entry, d, n, version);
            }
            _ => {}
        }
    }
}

fn gradle_dependencies(ctx: &mut Ctx<'_>, lambda: Node<'_>) {
    for entry in named_children(lambda) {
        if entry.kind() != "call_expression" {
            continue;
        }
        let Some(callee) = first_named(entry, "identifier") else {
            continue;
        };
        let configuration = ctx.src.text(callee);
        let Some(arg) =
            first_named(entry, "value_arguments").and_then(|a| first_named(a, "value_argument"))
        else {
            continue;
        };
        let (coordinate, via) = match first_named(arg, "string_literal") {
            Some(lit) => (unquote(ctx, lit), "literal"),
            None => match first_named(arg, "navigation_expression") {
                Some(nav) => (js_trim(&ctx.src.text(nav)).to_string(), "catalog"),
                None => continue,
            },
        };
        if coordinate.is_empty() {
            continue;
        }
        let meta = vec![
            ("gradle_type", Meta::Str("dependency".to_string())),
            ("configuration", Meta::Str(configuration)),
            ("source", Meta::Str(via.to_string())),
        ];
        let s = sym(
            ctx,
            entry,
            coordinate,
            "variable",
            Opts {
                meta,
                ..Opts::default()
            },
        );
        ctx.symbols.push(s);
    }
}

fn gradle_config(ctx: &mut Ctx<'_>, lambda: Node<'_>, block: &str) {
    for entry in named_children(lambda) {
        if entry.kind() != "assignment" {
            continue;
        }
        let kids = named_children(entry);
        let Some(&lhs) = kids.first() else { continue };
        if lhs.kind() != "identifier" {
            continue;
        }
        let Some(&rhs) = kids.last() else { continue };
        if rhs == lhs {
            continue;
        }
        let value = if rhs.kind() == "string_literal" {
            unquote(ctx, rhs)
        } else {
            ctx.src.text(rhs)
        };
        let property = ctx.src.text(lhs);
        let meta = vec![
            ("gradle_type", Meta::Str("config".to_string())),
            ("block", Meta::Str(block.to_string())),
            ("property", Meta::Str(property.clone())),
            ("value", Meta::Str(value)),
        ];
        let s = sym(
            ctx,
            entry,
            format!("{block}.{property}"),
            "variable",
            Opts {
                meta,
                ..Opts::default()
            },
        );
        ctx.symbols.push(s);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classes_objects_properties_and_kotest() {
        let src = "package x\n\n/** A repo. */\n@Singleton\nclass Repo(private val api: Api, name: String) {\n    val cache = mutableMapOf<String, Int>()\n    suspend fun load(id: String): User? = null\n    companion object { const val MAX = 3 }\n}\n\nclass MySpec : FunSpec({\n    test(\"adds\") { }\n    context(\"group\") { test(\"inner\") { } }\n})\n\nenum class Color { RED, GREEN }\n";
        let syms = extract(
            &Utf16Source::from_text(src),
            "Repo.kt",
            "r",
            Duration::from_secs(10),
        )
        .symbols;
        let kinds: Vec<(&str, &str)> = syms.iter().map(|s| (s.name.as_str(), s.kind)).collect();
        assert!(kinds.contains(&("Repo", "class")), "{kinds:?}");
        assert!(kinds.contains(&("api", "field")), "{kinds:?}");
        assert!(!kinds.iter().any(|(n, _)| *n == "name"), "{kinds:?}");
        assert!(kinds.contains(&("MAX", "constant")), "{kinds:?}");
        assert!(kinds.contains(&("MySpec", "test_suite")), "{kinds:?}");
        assert!(kinds.contains(&("inner", "test_case")), "{kinds:?}");
        assert!(kinds.contains(&("RED", "field")), "{kinds:?}");
    }

    #[test]
    fn gradle_plugins_dependencies_and_config() {
        let src = "plugins {\n    kotlin(\"jvm\") version \"1.9.0\"\n    id(\"com.android.application\")\n    alias(libs.plugins.ktor)\n}\ndependencies {\n    implementation(\"io.ktor:ktor-server:2.3.0\")\n    api(libs.okhttp)\n    api(project(\":core\"))\n}\nandroid { namespace = \"com.example\"\n compileSdk = 34 }\n";
        let syms = extract_gradle_kts(
            &Utf16Source::from_text(src),
            "build.gradle.kts",
            "r",
            Duration::from_secs(10),
        )
        .symbols;
        let names: Vec<&str> = syms.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "jvm",
                "com.android.application",
                "ktor",
                "io.ktor:ktor-server:2.3.0",
                "libs.okhttp",
                "android.namespace",
                "android.compileSdk"
            ]
        );
    }
}
