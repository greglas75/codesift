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
import type { Node as TSNode, Tree as TSTree } from "web-tree-sitter";
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
  tree: TSTree,
): PythonImportRef[] {
  const imports: PythonImportRef[] = [];

  function walk(node: TSNode, inTypeChecking: boolean): void {
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
function countRelativeDots(relImport: TSNode): number {
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

/**
 * Regex fallback for when the tree-sitter parse is unavailable.
 *
 * The AST path is strictly better and stays the default — it cannot be fooled by an import written
 * inside a docstring, and it knows which imports sit under `if TYPE_CHECKING:`. This exists because
 * the alternative on a parser failure was **nothing at all**: `collectPythonEdges` logged a warning
 * and returned, so every import edge in that file vanished from the graph with no signal. Measured
 * on this machine 2026-08-19: 30 such failures, all `memory access out of bounds` from an exhausted
 * WASM heap, across a reporting module and its test suite — files whose edges simply stopped
 * existing for `find_circular_deps`, `detect_communities`, `impact_analysis` and `check_boundaries`.
 *
 * TypeScript already had this shape of fallback; Python did not.
 *
 * Known and accepted limits, since a fallback that pretends to be the AST is worse than one that
 * admits what it is: an `import` inside a triple-quoted string is matched here and would not be by
 * the AST, and `is_type_only` is always false because block structure is not tracked. Both make the
 * graph slightly too CONNECTED, which is the safer direction — a missing edge hides a cycle, a
 * spurious one merely adds noise a human can see.
 */
export function extractPythonImportsByRegex(source: string): PythonImportRef[] {
  const imports: PythonImportRef[] = [];

  for (const rawLine of source.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line.length === 0) continue;

    // `from .`, `from ..pkg.mod`, `from pkg import a, b` / `import *`
    const fromMatch = /^from\s+(\.*)([A-Za-z_][\w.]*)?\s+import\s+(.+)$/.exec(line);
    if (fromMatch) {
      const dots = fromMatch[1] ?? "";
      const targets = fromMatch[3] ?? "";
      imports.push({
        module: fromMatch[2] ?? "",
        level: dots.length,
        is_type_only: false,
        is_star: targets.trim().startsWith("*"),
        raw: line,
      });
      continue;
    }

    // `import a.b.c`, `import a as x, b.c as y`
    const importMatch = /^import\s+(.+)$/.exec(line);
    if (importMatch) {
      for (const part of (importMatch[1] ?? "").split(",")) {
        const name = /^([A-Za-z_][\w.]*)/.exec(part.trim())?.[1];
        if (name) {
          imports.push({ module: name, level: 0, is_type_only: false, is_star: false, raw: line });
        }
      }
    }
  }

  return imports;
}
