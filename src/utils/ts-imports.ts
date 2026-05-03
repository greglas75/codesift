/**
 * ts-imports.ts — tree-sitter AST extractor for TypeScript/TSX imports + re-exports.
 *
 * Mirrors the structure of `python-imports.ts`. The graph builder calls
 * `extractTypeScriptImports(tree)` to walk `import_statement` and
 * `export_statement` (with `source` field) nodes; it returns flat edges with
 * an `is_type_only` flag derived from statement-level OR per-specifier `type`
 * modifiers.
 *
 * Detection rules:
 *   - statement-level `import type { X } from "y"` → all specifiers type-only
 *   - per-specifier `import { type X, Y } from "y"` → type_only:false (any
 *     runtime specifier present makes the entire edge runtime; the import is
 *     loaded at runtime regardless of which subset is used as types only)
 *   - `import * as ns from "y"` / default / side-effect → runtime
 *   - `export { X } from "y"` → runtime; `export type { X } from "y"` → type_only:true
 *   - `export * from "y"` → runtime; `export type * from "y"` → type_only:true
 */

import type Parser from "web-tree-sitter";

export interface TsImportEdge {
  /** raw specifier text from the import source (relative or bare/aliased) */
  path: string;
  /** true when entire statement is type-only OR all named specifiers carry `type` */
  is_type_only: boolean;
  /** imported/re-exported names (for future use; empty for side-effect imports) */
  specifiers: string[];
}

/** True when this statement node has a top-level `type` keyword child
 * (e.g., `import type {...}` or `export type {...}`).
 *
 * Some grammar versions wrap `type` inside an ERROR node for niche syntaxes
 * like `export type * from "y"`. We walk one level into ERROR children to
 * handle that case. */
function statementIsTypeOnly(node: Parser.SyntaxNode): boolean {
  for (const child of node.children) {
    if (child.type === "type" && child.text === "type") return true;
    if (child.type === "ERROR") {
      for (const inner of child.children) {
        if (inner.type === "type" && inner.text === "type") return true;
      }
    }
  }
  return false;
}

/** Extract source string from `import_statement` or `export_statement` source field.
 * Returns undefined when the statement has no `from` clause (e.g. local export). */
function getSourcePath(node: Parser.SyntaxNode): string | undefined {
  // import_statement: source field directly
  // export_statement: also exposes source field when `from` is present
  const sourceField = node.childForFieldName("source");
  if (sourceField) {
    return sourceField.text.replace(/^['"`]|['"`]$/g, "");
  }
  // Fallback: scan named children for a `string` node (some grammar variants
  // expose it without a named field)
  for (const child of node.namedChildren) {
    if (child.type === "string") {
      return child.text.replace(/^['"`]|['"`]$/g, "");
    }
  }
  return undefined;
}

/** Walk an `import_clause` to collect specifiers.
 * Returns { specifiers, anyRuntimeSpecifier }. anyRuntimeSpecifier is true when
 * at least one specifier is NOT prefixed with `type` (per-specifier modifier).
 * For default + namespace imports (no named clause) anyRuntimeSpecifier=true. */
function walkImportClause(
  clause: Parser.SyntaxNode,
): { specifiers: string[]; anyRuntimeSpecifier: boolean } {
  const specifiers: string[] = [];
  let anyRuntimeSpecifier = false;

  for (const child of clause.namedChildren) {
    if (child.type === "named_imports") {
      // import_specifier nodes; check each for leading `type` keyword
      for (const spec of child.namedChildren) {
        if (spec.type !== "import_specifier") continue;
        const nameNode = spec.childForFieldName("name");
        const aliasNode = spec.childForFieldName("alias");
        const emitName = (aliasNode ?? nameNode)?.text;
        if (emitName) specifiers.push(emitName);
        // Per-specifier `type`: an `import_specifier` with the keyword `type`
        // as its first child token.
        const isTyped = spec.children.some(
          (c) => c.type === "type" && c.text === "type",
        );
        if (!isTyped) anyRuntimeSpecifier = true;
      }
    } else if (child.type === "namespace_import") {
      // import * as ns — runtime
      anyRuntimeSpecifier = true;
      const id = child.namedChildren.find((c) => c.type === "identifier");
      if (id) specifiers.push(id.text);
    } else if (child.type === "identifier") {
      // default import — runtime
      anyRuntimeSpecifier = true;
      specifiers.push(child.text);
    }
  }
  return { specifiers, anyRuntimeSpecifier };
}

/** Walk an `export_clause` (named re-exports) to collect names.
 * Returns specifiers list. Type-only-ness is derived from the parent
 * export_statement, not per-specifier here (TS does not distinguish at the
 * specifier level inside `export {X} from "y"` to the same extent as imports). */
function walkExportClause(clause: Parser.SyntaxNode): string[] {
  const specifiers: string[] = [];
  for (const spec of clause.namedChildren) {
    if (spec.type !== "export_specifier") continue;
    const nameNode = spec.childForFieldName("name");
    const aliasNode = spec.childForFieldName("alias");
    const emitName = (aliasNode ?? nameNode)?.text;
    if (emitName) specifiers.push(emitName);
  }
  return specifiers;
}

/** Walk the tree and return all import + re-export edges. */
export function extractTypeScriptImports(tree: Parser.Tree): TsImportEdge[] {
  const edges: TsImportEdge[] = [];

  function visit(node: Parser.SyntaxNode): void {
    if (node.type === "import_statement") {
      const path = getSourcePath(node);
      if (!path) return; // malformed; skip
      const stmtTypeOnly = statementIsTypeOnly(node);
      const importClause = node.namedChildren.find((c) => c.type === "import_clause");
      if (!importClause) {
        // side-effect import: `import "x"`
        edges.push({ path, is_type_only: stmtTypeOnly, specifiers: [] });
        return;
      }
      const { specifiers, anyRuntimeSpecifier } = walkImportClause(importClause);
      // Edge is type_only only when statement-level `type` modifier is present
      // OR when every named specifier is per-specifier-typed (no runtime member).
      const is_type_only = stmtTypeOnly || !anyRuntimeSpecifier;
      edges.push({ path, is_type_only, specifiers });
      return;
    }

    if (node.type === "export_statement") {
      const path = getSourcePath(node);
      if (!path) {
        // Local export with no `from` clause; recurse into children for nested
        // re-exports (rare). Continue walking.
        for (const c of node.namedChildren) visit(c);
        return;
      }
      const is_type_only = statementIsTypeOnly(node);
      let specifiers: string[] = [];
      for (const child of node.namedChildren) {
        if (child.type === "export_clause") {
          specifiers = walkExportClause(child);
        }
        // namespace_export `export * as ns from "y"` → record `ns` as specifier
        if (child.type === "namespace_export") {
          const id = child.namedChildren.find((c) => c.type === "identifier");
          if (id) specifiers.push(id.text);
        }
      }
      edges.push({ path, is_type_only, specifiers });
      return;
    }

    // Recurse into children for top-level scan (most imports are at root, but
    // some declarations nest them — e.g., declare module).
    for (const c of node.namedChildren) visit(c);
  }

  visit(tree.rootNode);
  return edges;
}
