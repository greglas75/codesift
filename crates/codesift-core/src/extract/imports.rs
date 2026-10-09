//! Import extraction for `.ts`/`.tsx` (ADR-006 stage 4): a 1:1 port of `extractTypeScriptImports`
//! (`src/utils/ts-imports.ts`). Only the specifiers are extracted here — resolving them against
//! tsconfig paths, workspace aliases and the indexed file set stays in TypeScript.
//!
//! Why it is worth a port: the import graph parses every file on a cold build, on the main thread,
//! one at a time — measured 23 s for 35,357 files, 95% of it parsing. Here a batch is parsed in
//! parallel off the main thread.
//!
//! Exactness: same grammar version as the shipped `.wasm`, same pre-order walk, same edges in the
//! same order. A file whose parse fails (budget, depth) yields `None`, and the caller runs the
//! TypeScript path for it — which is what decides that file's fate today.

use std::time::Duration;

use rayon::prelude::*;
use tree_sitter::{Language, Node};

use super::{
    children, end_index, named_children, parse_utf16, pool, start_index, strip_quotes, Utf16Source,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportEdge {
    pub path: String,
    pub kind: &'static str,
    pub is_type_only: bool,
    pub specifiers: Vec<String>,
}

const MOCK_CALLEES: [&str; 11] = [
    "vi.mock",
    "vi.doMock",
    "vi.unmock",
    "vi.doUnmock",
    "vi.importActual",
    "vi.importMock",
    "jest.mock",
    "jest.doMock",
    "jest.unmock",
    "jest.requireActual",
    "jest.requireMock",
];

/// The longest entry above, in UTF-16 units: a callee longer than this cannot be one, and reading the
/// text of every link of a long `a().b().c()…` chain would copy the chain once per call.
const MOCK_CALLEE_MAX_UNITS: usize = 18;

fn is_type_keyword(src: &Utf16Source, node: Node<'_>) -> bool {
    node.kind() == "type" && src.text(node) == "type"
}

/// `statementIsTypeOnly`: a top-level `type` keyword, or one inside a direct ERROR child.
fn statement_is_type_only(src: &Utf16Source, node: Node<'_>) -> bool {
    for child in children(node) {
        if is_type_keyword(src, child) {
            return true;
        }
        if child.kind() == "ERROR" && children(child).into_iter().any(|c| is_type_keyword(src, c)) {
            return true;
        }
    }
    false
}

/// `getSourcePath`; an empty string is `None`, as every caller tests the result for truthiness.
fn source_path(src: &Utf16Source, node: Node<'_>) -> Option<String> {
    let raw = match node.child_by_field_name("source") {
        Some(field) => strip_quotes(&src.text(field)),
        // Only in a statement with `from`: otherwise `export default "./x"` reads its exported
        // VALUE as a module to import.
        None if children(node).into_iter().any(|c| c.kind() == "from") => strip_quotes(
            &src.text(
                named_children(node)
                    .into_iter()
                    .find(|c| c.kind() == "string")?,
            ),
        ),
        None => return None,
    };
    (!raw.is_empty()).then_some(raw)
}

/// The `name`/`alias` text an `import_specifier` or `export_specifier` emits, when non-empty.
fn emit_name(src: &Utf16Source, spec: Node<'_>) -> Option<String> {
    let node = spec
        .child_by_field_name("alias")
        .or_else(|| spec.child_by_field_name("name"))?;
    let text = src.text(node);
    (!text.is_empty()).then_some(text)
}

/// `walkImportClause` → (specifiers, anyRuntimeSpecifier).
fn walk_import_clause(src: &Utf16Source, clause: Node<'_>) -> (Vec<String>, bool) {
    let mut specifiers = Vec::new();
    let mut any_runtime = false;
    for child in named_children(clause) {
        match child.kind() {
            "named_imports" => {
                let mut count = 0;
                for spec in named_children(child) {
                    if spec.kind() != "import_specifier" {
                        continue;
                    }
                    count += 1;
                    if let Some(name) = emit_name(src, spec) {
                        specifiers.push(name);
                    }
                    if !children(spec).into_iter().any(|c| is_type_keyword(src, c)) {
                        any_runtime = true;
                    }
                }
                if count == 0 {
                    any_runtime = true;
                }
            }
            "namespace_import" => {
                any_runtime = true;
                if let Some(id) = named_children(child)
                    .into_iter()
                    .find(|c| c.kind() == "identifier")
                {
                    specifiers.push(src.text(id));
                }
            }
            "identifier" => {
                any_runtime = true;
                specifiers.push(src.text(child));
            }
            _ => {}
        }
    }
    (specifiers, any_runtime)
}

/// `walkExportClause` → (specifiers, anyRuntimeSpecifier).
fn walk_export_clause(src: &Utf16Source, clause: Node<'_>) -> (Vec<String>, bool) {
    let mut specifiers = Vec::new();
    let mut any_runtime = false;
    let mut count = 0;
    for spec in named_children(clause) {
        if spec.kind() != "export_specifier" {
            continue;
        }
        count += 1;
        if let Some(name) = emit_name(src, spec) {
            specifiers.push(name);
        }
        if !children(spec).into_iter().any(|c| is_type_keyword(src, c)) {
            any_runtime = true;
        }
    }
    if count == 0 {
        any_runtime = true;
    }
    (specifiers, any_runtime)
}

/// `stringArgument`: the first argument when it is a plain string literal (empty → `None`).
fn string_argument(src: &Utf16Source, call: Node<'_>) -> Option<String> {
    let args = call.child_by_field_name("arguments")?;
    let first = named_children(args).into_iter().next()?;
    if first.kind() != "string" {
        return None;
    }
    let path = strip_quotes(&src.text(first));
    (!path.is_empty()).then_some(path)
}

/// `collectCallEdge`.
fn collect_call_edge(src: &Utf16Source, node: Node<'_>, edges: &mut Vec<ImportEdge>) {
    let Some(func) = node.child_by_field_name("function") else {
        return;
    };
    let edge = |path: String, kind: &'static str, is_type_only: bool| ImportEdge {
        path,
        kind,
        is_type_only,
        specifiers: Vec::new(),
    };
    match func.kind() {
        "import" => {
            if let Some(path) = string_argument(src, node) {
                let type_query = node.parent().is_some_and(|p| p.kind() == "type_query");
                edges.push(edge(path, "dynamic", type_query));
            }
        }
        "identifier" if src.text(func) == "require" => {
            if let Some(path) = string_argument(src, node) {
                edges.push(edge(path, "require", false));
            }
        }
        "member_expression"
            if end_index(func) - start_index(func) <= MOCK_CALLEE_MAX_UNITS
                && MOCK_CALLEES.contains(&src.text(func).as_str()) =>
        {
            if let Some(path) = string_argument(src, node) {
                edges.push(edge(path, "mock", false));
            }
        }
        _ => {}
    }
}

/// Handle one node; `true` when the walk descends into its named children.
fn visit(src: &Utf16Source, node: Node<'_>, edges: &mut Vec<ImportEdge>) -> bool {
    match node.kind() {
        "import_statement" => {
            let named = named_children(node);
            if let Some(clause) = named.iter().find(|c| c.kind() == "import_require_clause") {
                // Not tested for emptiness in the TypeScript either.
                if let Some(source) = clause.child_by_field_name("source") {
                    let id = named_children(*clause)
                        .into_iter()
                        .find(|c| c.kind() == "identifier");
                    edges.push(ImportEdge {
                        path: strip_quotes(&src.text(source)),
                        kind: "static",
                        is_type_only: false,
                        specifiers: id.map(|id| vec![src.text(id)]).unwrap_or_default(),
                    });
                }
                return false;
            }
            let Some(path) = source_path(src, node) else {
                return false;
            };
            let stmt_type_only = statement_is_type_only(src, node);
            match named.iter().find(|c| c.kind() == "import_clause") {
                None => edges.push(ImportEdge {
                    path,
                    kind: "static",
                    is_type_only: stmt_type_only,
                    specifiers: Vec::new(),
                }),
                Some(clause) => {
                    let (specifiers, any_runtime) = walk_import_clause(src, *clause);
                    edges.push(ImportEdge {
                        path,
                        kind: "static",
                        is_type_only: stmt_type_only || !any_runtime,
                        specifiers,
                    });
                }
            }
            false
        }
        "export_statement" => {
            let Some(path) = source_path(src, node) else {
                return true; // a local export: nested re-exports are still walked
            };
            let stmt_type_only = statement_is_type_only(src, node);
            let mut specifiers = Vec::new();
            let mut saw_clause = false;
            let mut any_runtime = true;
            for child in named_children(node) {
                if child.kind() == "export_clause" {
                    saw_clause = true;
                    let (names, runtime) = walk_export_clause(src, child);
                    specifiers = names; // replaces, as `specifiers = w.specifiers` does
                    any_runtime = runtime;
                }
                if child.kind() == "namespace_export" {
                    if let Some(id) = named_children(child)
                        .into_iter()
                        .find(|c| c.kind() == "identifier")
                    {
                        specifiers.push(src.text(id));
                    }
                }
            }
            edges.push(ImportEdge {
                path,
                kind: "static",
                is_type_only: stmt_type_only || (saw_clause && !any_runtime),
                specifiers,
            });
            false
        }
        "call_expression" => {
            // Descends too: `import("./a").then(…)` nests the real call inside this one.
            collect_call_edge(src, node, edges);
            true
        }
        _ => true,
    }
}

/// `extractTypeScriptImports` over a parsed tree: a pre-order walk, iterative so a deep tree
/// cannot overflow the stack.
pub fn extract_imports(src: &Utf16Source, root: Node<'_>) -> Vec<ImportEdge> {
    let mut edges = Vec::new();
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if visit(src, node, &mut edges) {
            let mut kids = named_children(node);
            kids.reverse();
            stack.extend(kids);
        }
    }
    edges
}

fn language(tsx: bool) -> Language {
    if tsx {
        tree_sitter_typescript::LANGUAGE_TSX.into()
    } else {
        tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
    }
}

/// Parse and extract one file; `None` when the parse failed (the caller falls back to TypeScript).
pub fn imports_of(source: &str, tsx: bool, timeout: Duration) -> Option<Vec<ImportEdge>> {
    let src = Utf16Source::from_text(source);
    let tree = parse_utf16(&language(tsx), &src, timeout).ok()?;
    Some(extract_imports(&src, tree.root_node()))
}

fn write_edges(edges: &[ImportEdge], out: &mut String) {
    let q = |s: &str| serde_json::to_string(s).expect("string serialises");
    out.push('[');
    for (i, e) in edges.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"path\":");
        out.push_str(&q(&e.path));
        out.push_str(",\"kind\":\"");
        out.push_str(e.kind);
        out.push_str("\",\"is_type_only\":");
        out.push_str(if e.is_type_only { "true" } else { "false" });
        out.push_str(",\"specifiers\":");
        out.push_str(&serde_json::to_string(&e.specifiers).expect("strings serialise"));
        out.push('}');
    }
    out.push(']');
}

/// A batch, in parallel: one JSON array with an entry per source — that file's edges in
/// `TsImportEdge` shape, or `null` where the parse failed.
pub fn imports_batch_json(sources: &[String], tsx: &[bool], timeout: Duration) -> String {
    let parts: Vec<Option<String>> = pool().install(|| {
        sources
            .par_iter()
            .enumerate()
            .map(|(i, source)| {
                // A missing flag is not guessed: the wrong grammar parses JSX as errors and still
                // returns edges, which the fallback would never get to correct.
                let tsx = *tsx.get(i)?;
                // A panic in one file must cost that file, not the whole batch.
                let edges = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    imports_of(source, tsx, timeout)
                }))
                .ok()
                .flatten()?;
                let mut out = String::new();
                write_edges(&edges, &mut out);
                Some(out)
            })
            .collect()
    });
    let mut out = String::with_capacity(
        parts
            .iter()
            .map(|p| p.as_ref().map_or(4, String::len) + 1)
            .sum::<usize>()
            + 2,
    );
    out.push('[');
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(part.as_deref().unwrap_or("null"));
    }
    out.push(']');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edges(source: &str) -> Vec<(String, &'static str, bool, Vec<String>)> {
        imports_of(source, false, Duration::from_secs(10))
            .unwrap()
            .into_iter()
            .map(|e| (e.path, e.kind, e.is_type_only, e.specifiers))
            .collect()
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn static_forms_and_type_only_rules() {
        let src = r#"
import a, { b as c, type D } from "./x";
import type { E } from './y';
import { type F } from "./z";
import {} from "./empty";
import * as ns from "./ns";
import "./side";
import req = require("./req");
export { g, type H } from "./re";
export type { I } from "./ti";
export * from "./star";
export * as space from "./space";
export const local = 1;
"#;
        assert_eq!(
            edges(src),
            vec![
                ("./x".into(), "static", false, s(&["a", "c", "D"])),
                ("./y".into(), "static", true, s(&["E"])),
                ("./z".into(), "static", true, s(&["F"])),
                ("./empty".into(), "static", false, s(&[])),
                ("./ns".into(), "static", false, s(&["ns"])),
                ("./side".into(), "static", false, s(&[])),
                ("./req".into(), "static", false, s(&["req"])),
                ("./re".into(), "static", false, s(&["g", "H"])),
                ("./ti".into(), "static", true, s(&["I"])),
                ("./star".into(), "static", false, s(&[])),
                ("./space".into(), "static", false, s(&["space"])),
            ]
        );
    }

    // Bug it catches: returning after a call edge dropped `import("./a").then(...)`'s inner call, and
    // a type-position `typeof import()` counted as a runtime dependency.
    #[test]
    fn calls_dynamic_require_mock_and_type_queries() {
        let src = r#"
const m = await import("./dyn");
import("./then").then((x) => x);
const r = require("./cjs");
vi.mock("./mocked");
jest.requireActual("./actual");
type T = typeof import("./typed");
import(name);
require(`./tpl`);
other.mock("./not-a-runner");
"#;
        assert_eq!(
            edges(src),
            vec![
                ("./dyn".into(), "dynamic", false, s(&[])),
                ("./then".into(), "dynamic", false, s(&[])),
                ("./cjs".into(), "require", false, s(&[])),
                ("./mocked".into(), "mock", false, s(&[])),
                ("./actual".into(), "mock", false, s(&[])),
                ("./typed".into(), "dynamic", true, s(&[])),
            ]
        );
    }

    // Bug it catches: the no-`source` fallback read an exported string value as a module.
    #[test]
    fn an_exported_string_value_is_not_a_module() {
        assert_eq!(edges("export default \"./x\";\nexport = 'y';"), vec![]);
    }

    #[test]
    fn batch_marks_failed_parses_null_and_keeps_order() {
        let sources = vec![
            "import a from './a'".to_string(),
            format!("x = {}1{};", "[".repeat(30_000), "]".repeat(30_000)),
            "const C = () => <div>{require('./b')}</div>".to_string(),
        ];
        let json = imports_batch_json(&sources, &[false, false, true], Duration::from_secs(30));
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed[0][0]["path"], "./a");
        assert!(parsed[1].is_null());
        assert_eq!(parsed[2][0]["kind"], "require");
        let short = imports_batch_json(&sources[..2], &[false], Duration::from_secs(30));
        assert!(serde_json::from_str::<serde_json::Value>(&short).unwrap()[1].is_null());
    }
}
