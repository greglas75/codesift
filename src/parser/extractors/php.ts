import type Parser from "web-tree-sitter";
import type { CodeSymbol, SymbolKind } from "../../types.js";
import { getNodeName, makeSymbol } from "./_shared.js";

// --- PHPDoc tag parser ---

/**
 * Parse `@property` and `@method` tags from a PHPDoc block.
 * Used to synthesize Yii2 ActiveRecord magic properties (which live only in
 * the docblock, not as real PHP fields).
 *
 * Supports forms:
 *   @property int $id                  → { tag: "property", name: "id", type: "int" }
 *   @property string $name             → { tag: "property", name: "name", type: "string" }
 *   @method getPosts()                 → { tag: "method", name: "getPosts" }
 *   @method ActiveQuery getPosts()     → { tag: "method", name: "getPosts", type: "ActiveQuery" }
 *
 * Returns [] for empty / undefined input. Tag order is preserved.
 */
export function parsePhpDocTags(
  docstring?: string,
): Array<{ tag: "property" | "method"; name: string; type?: string }> {
  if (!docstring) return [];
  const results: Array<{ tag: "property" | "method"; name: string; type?: string }> = [];

  const propRe = /@property(?:-read|-write)?\s+(\S+)\s+\$(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = propRe.exec(docstring)) !== null) {
    const entry: { tag: "property"; name: string; type?: string } = {
      tag: "property",
      name: m[2]!,
    };
    if (m[1]) entry.type = m[1];
    results.push(entry);
  }

  // @method [returnType] name(args)
  // - With return type:  @method ActiveQuery getPosts(int $limit)
  // - Without type:      @method getPosts()
  const methodRe = /@method\s+(?:(\S+)\s+)?(\w+)\s*\(/g;
  while ((m = methodRe.exec(docstring)) !== null) {
    const entry: { tag: "method"; name: string; type?: string } = {
      tag: "method",
      name: m[2]!,
    };
    if (m[1]) entry.type = m[1];
    results.push(entry);
  }

  return results;
}

// --- Helpers ---

/**
 * PHP docblocks are `comment` nodes starting with `/**` that precede a declaration.
 * Walk backwards through siblings collecting contiguous doc comments.
 */
function getDocstring(
  node: Parser.SyntaxNode,
  source: string,
): string | undefined {
  let prev = node.previousNamedSibling;

  // Skip visibility_modifier and other attributes to reach the comment
  while (prev && (prev.type === "visibility_modifier" || prev.type === "attribute_list")) {
    prev = prev.previousNamedSibling;
  }

  if (!prev || prev.type !== "comment") return undefined;

  const text = source.slice(prev.startIndex, prev.endIndex);
  if (!text.startsWith("/**")) return undefined;

  return text;
}

/**
 * Extract parameter list and optional return type.
 * e.g. "(string $name, int $age = 0): bool"
 */
function getSignature(
  node: Parser.SyntaxNode,
  source: string,
): string | undefined {
  const params = node.childForFieldName("parameters");
  if (!params) return undefined;

  let sig = source.slice(params.startIndex, params.endIndex);

  const returnType = node.childForFieldName("return_type");
  if (returnType) {
    sig += ": " + source.slice(returnType.startIndex, returnType.endIndex);
  }

  return sig;
}

/**
 * Check if a class extends TestCase (PHPUnit).
 */
function isTestCaseClass(node: Parser.SyntaxNode): boolean {
  const baseClause = node.childForFieldName("base_clause");
  if (baseClause) {
    const text = baseClause.text;
    if (text.includes("TestCase")) return true;
  }

  // Also check named children for "base_clause" node type
  for (const child of node.namedChildren) {
    if (child.type === "base_clause" && child.text.includes("TestCase")) {
      return true;
    }
  }

  return false;
}

/**
 * Classify a method declaration based on PHPUnit patterns.
 */
function classifyMethod(
  name: string,
  parentIsTest: boolean,
  docstring: string | undefined,
): SymbolKind {
  // Test hooks
  const hooks = ["setUp", "tearDown", "setUpBeforeClass", "tearDownAfterClass"];
  if (hooks.includes(name)) return "test_hook";

  // Test case: method starts with "test" or has @test annotation
  if (parentIsTest) {
    if (name.startsWith("test")) return "test_case";
    if (docstring?.includes("@test")) return "test_case";
  }

  return "method";
}

/**
 * Extract name from a property_element node.
 * Property elements contain variable_name → name nodes.
 * Returns the name without the $ prefix.
 */
function getPropertyName(node: Parser.SyntaxNode): string | null {
  for (const child of node.namedChildren) {
    if (child.type === "property_element") {
      // variable_name → name
      const varName = child.namedChildren.find(c => c.type === "variable_name");
      if (varName) {
        const nameNode = varName.namedChildren.find(c => c.type === "name");
        return nameNode ? "$" + nameNode.text : null;
      }
    }
  }
  return null;
}

// --- Main extractor ---

export function extractPhpSymbols(
  tree: Parser.Tree,
  filePath: string,
  source: string,
  repo: string,
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];

  function walk(node: Parser.SyntaxNode, parentId?: string, parentIsTest = false): void {
    switch (node.type) {
      case "namespace_definition": {
        const nameNode = node.childForFieldName("name");
        const name = nameNode?.text ?? "<anonymous>";
        const sym = makeSymbol(node, name, "namespace", filePath, source, repo, {
          parentId,
        });
        symbols.push(sym);

        // Walk body with namespace as parent
        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.namedChildren) {
            walk(child, sym.id, false);
          }
        } else {
          // Namespace without braces — remaining siblings are children
          // (tree-sitter handles this by putting declarations as siblings)
          // We continue walking at the parent level, but with namespace as parent
          // This is handled naturally since siblings follow after this node
        }
        return;
      }

      case "class_declaration": {
        const name = getNodeName(node) ?? "<anonymous>";
        const isTest = isTestCaseClass(node);
        const kind: SymbolKind = isTest ? "test_suite" : "class";
        const docstring = getDocstring(node, source);
        const sym = makeSymbol(node, name, kind, filePath, source, repo, {
          parentId,
          docstring,
        });
        symbols.push(sym);

        // 1. Walk class body FIRST so real methods/fields are in `symbols`
        //    before dedup runs for synthetic @property/@method tags.
        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.namedChildren) {
            walk(child, sym.id, isTest);
          }
        }

        // 2. Synthesize @property / @method from the class docblock.
        //    Yii2 ActiveRecord uses these heavily ("magic properties") —
        //    they don't exist as real PHP fields but they're very much
        //    part of the public API. Dedup against real members (same
        //    name+kind+parent): real wins, synthetic skipped.
        if (docstring) {
          const tags = parsePhpDocTags(docstring);
          for (const tag of tags) {
            const targetKind: SymbolKind = tag.tag === "property" ? "field" : "method";
            const realExists = symbols.some(
              (s) =>
                s.parent === sym.id &&
                s.name === tag.name &&
                s.kind === targetKind &&
                !s.meta?.synthetic,
            );
            if (realExists) continue;
            const synOpts: {
              parentId: string;
              signature?: string;
              meta: Record<string, unknown>;
            } = {
              parentId: sym.id,
              meta: { synthetic: true },
            };
            if (tag.type) synOpts.signature = tag.type;
            const synthetic = makeSymbol(
              node,
              tag.name,
              targetKind,
              filePath,
              source,
              repo,
              synOpts,
            );
            symbols.push(synthetic);
          }
        }
        return;
      }

      case "interface_declaration": {
        const name = getNodeName(node) ?? "<anonymous>";
        const sym = makeSymbol(node, name, "interface", filePath, source, repo, {
          parentId,
          docstring: getDocstring(node, source),
        });
        symbols.push(sym);

        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.namedChildren) {
            walk(child, sym.id, false);
          }
        }
        return;
      }

      case "trait_declaration": {
        const name = getNodeName(node) ?? "<anonymous>";
        const sym = makeSymbol(node, name, "type", filePath, source, repo, {
          parentId,
          docstring: getDocstring(node, source),
        });
        symbols.push(sym);

        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.namedChildren) {
            walk(child, sym.id, false);
          }
        }
        return;
      }

      case "enum_declaration": {
        const name = getNodeName(node) ?? "<anonymous>";
        const sym = makeSymbol(node, name, "enum", filePath, source, repo, {
          parentId,
          docstring: getDocstring(node, source),
        });
        symbols.push(sym);

        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.namedChildren) {
            walk(child, sym.id, false);
          }
        }
        return;
      }

      case "function_definition": {
        const name = getNodeName(node);
        if (name) {
          const sym = makeSymbol(node, name, "function", filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
            signature: getSignature(node, source),
          });
          symbols.push(sym);
        }
        return;
      }

      case "method_declaration": {
        const name = getNodeName(node);
        if (name) {
          const docstring = getDocstring(node, source);
          const kind = classifyMethod(name, parentIsTest, docstring);
          const sym = makeSymbol(node, name, kind, filePath, source, repo, {
            parentId,
            docstring,
            signature: getSignature(node, source),
          });
          symbols.push(sym);
        }
        return;
      }

      case "property_declaration": {
        const propName = getPropertyName(node);
        if (propName) {
          const sym = makeSymbol(node, propName, "field", filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
          });
          symbols.push(sym);
        }
        return;
      }

      case "const_declaration": {
        // Class constants or global constants: const FOO = 'bar';
        // May have multiple const_element children
        for (const child of node.namedChildren) {
          if (child.type === "const_element") {
            // const_element doesn't use named fields — name is first child of type "name"
            const nameNode = child.namedChildren.find(c => c.type === "name");
            const name = nameNode?.text;
            if (name) {
              const sym = makeSymbol(child, name, "constant", filePath, source, repo, {
                parentId,
                docstring: getDocstring(node, source),
              });
              symbols.push(sym);
            }
          }
        }
        return;
      }

      case "enum_case": {
        const name = getNodeName(node);
        if (name) {
          const sym = makeSymbol(node, name, "constant", filePath, source, repo, {
            parentId,
          });
          symbols.push(sym);
        }
        return;
      }

      default:
        break;
    }

    // Default: walk children
    for (const child of node.namedChildren) {
      walk(child, parentId, parentIsTest);
    }
  }

  walk(tree.rootNode);
  return symbols;
}
