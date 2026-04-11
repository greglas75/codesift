/**
 * Python import extraction via tree-sitter AST.
 *
 * Walks `import_statement`, `import_from_statement`, and `if TYPE_CHECKING`
 * blocks to produce a flat list of raw import descriptors. Resolution to
 * file paths is the resolver's job (see python-import-resolver.ts).
 *
 * Because this uses the AST (not regex), string literals and comments
 * cannot produce false positives.
 */
import type Parser from "web-tree-sitter";

export interface PythonImportRef {
  /** Dotted module path (empty string for `from . import X`) */
  module: string;
  /** Number of leading dots on relative imports (0 = absolute) */
  level: number;
  /** True if inside `if TYPE_CHECKING:` block */
  is_type_only: boolean;
  /** True for `from X import *` */
  is_star: boolean;
  /** Original source text for debugging */
  raw: string;
}

/**
 * Extract all Python imports from a parsed tree-sitter tree.
 */
export function extractPythonImports(
  tree: Parser.Tree,
): PythonImportRef[] {
  const imports: PythonImportRef[] = [];

  function walk(node: Parser.SyntaxNode, inTypeChecking: boolean): void {
    switch (node.type) {
      case "if_statement": {
        // Detect `if TYPE_CHECKING:` or `if typing.TYPE_CHECKING:`
        const condition = node.childForFieldName("condition");
        const conditionText = condition?.text ?? "";
        const isTypeCheck = /\bTYPE_CHECKING\b/.test(conditionText);

        // Walk the consequence with type_only flag if this is a TYPE_CHECKING block
        const consequence = node.childForFieldName("consequence");
        if (consequence) {
          walk(consequence, inTypeChecking || isTypeCheck);
        }

        // Walk elif / else clauses (named "alternative") without type_only.
        // Compare by start index since node refs from childForFieldName are
        // distinct JS objects from the namedChildren array.
        const conditionStart = condition?.startIndex;
        const consequenceStart = consequence?.startIndex;
        for (const child of node.namedChildren) {
          if (child.startIndex === conditionStart) continue;
          if (child.startIndex === consequenceStart) continue;
          walk(child, inTypeChecking);
        }
        return;
      }

      case "import_statement": {
        // `import a`, `import a.b`, `import a, b, c`
        // Children are `dotted_name` or `aliased_import` nodes
        for (const child of node.namedChildren) {
          let moduleName: string | null = null;
          if (child.type === "dotted_name") {
            moduleName = child.text;
          } else if (child.type === "aliased_import") {
            const name = child.childForFieldName("name");
            moduleName = name?.text ?? null;
          }
          if (moduleName) {
            imports.push({
              module: moduleName,
              level: 0,
              is_type_only: inTypeChecking,
              is_star: false,
              raw: node.text,
            });
          }
        }
        return;
      }

      case "import_from_statement": {
        // `from X import Y`, `from . import Y`, `from ..X import Y`, `from X import *`
        const moduleNameNode = node.childForFieldName("module_name");

        let level = 0;
        let module = "";

        if (moduleNameNode) {
          if (moduleNameNode.type === "relative_import") {
            // Count leading dots and find optional dotted_name
            level = countRelativeDots(moduleNameNode);
            const dottedName = moduleNameNode.namedChildren.find(
              (c) => c.type === "dotted_name",
            );
            module = dottedName?.text ?? "";
          } else if (moduleNameNode.type === "dotted_name") {
            module = moduleNameNode.text;
          }
        }

        // Detect wildcard_import `import *`
        const is_star = node.namedChildren.some(
          (c) => c.type === "wildcard_import",
        );

        imports.push({
          module,
          level,
          is_type_only: inTypeChecking,
          is_star,
          raw: node.text,
        });
        return;
      }

      default: {
        for (const child of node.namedChildren) {
          walk(child, inTypeChecking);
        }
        return;
      }
    }
  }

  walk(tree.rootNode, false);
  return imports;
}

/**
 * Count the leading dots in a `relative_import` node.
 * The dots appear as unnamed `import_prefix` child node or as separate
 * "." tokens depending on grammar version.
 */
function countRelativeDots(relImport: Parser.SyntaxNode): number {
  // Walk all children (named + unnamed); each "." token represents one level
  let dots = 0;
  for (let i = 0; i < relImport.childCount; i++) {
    const child = relImport.child(i);
    if (!child) continue;
    if (child.type === "import_prefix") {
      // Some grammar versions expose dots as an import_prefix node;
      // count dots in its text
      dots += (child.text.match(/\./g) ?? []).length;
    } else if (child.type === ".") {
      dots += 1;
    }
  }
  return dots;
}
