import type Parser from "web-tree-sitter";
import type { CodeSymbol, SymbolKind } from "../../types.js";
import { getNodeName, makeSymbol } from "./_shared.js";

// --- Helpers ---

/**
 * Gets the name from a Kotlin AST node.
 * Falls back to first `identifier` child when `childForFieldName("name")` returns null
 * (needed for enum_entry, class_parameter, type_alias, etc.).
 */
function getName(node: Parser.SyntaxNode): string | null {
  return getNodeName(node)
    ?? node.namedChildren.find((c) => c.type === "identifier")?.text
    ?? null;
}

/**
 * Collects KDoc comment (/** ... *​/) immediately preceding a declaration.
 * In tree-sitter-kotlin, KDoc appears as `block_comment` starting with `/**`.
 * Always checks the declaration node's previousNamedSibling (not modifiers).
 */
function getDocstring(
  node: Parser.SyntaxNode,
  source: string,
): string | undefined {
  const prev = node.previousNamedSibling;
  if (!prev || prev.type !== "block_comment") return undefined;

  const text = source.slice(prev.startIndex, prev.endIndex);
  if (!text.startsWith("/**")) return undefined;
  return text;
}

/**
 * Checks if a class_declaration has the `interface` keyword (unnamed child).
 */
function isInterface(node: Parser.SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === "interface") return true;
    // Stop once we hit the identifier or class_body
    if (child && (child.type === "identifier" || child.type === "class_body")) break;
  }
  return false;
}

/**
 * Checks if modifiers contain a specific modifier keyword.
 * Works with class_modifier, function_modifier, property_modifier, inheritance_modifier.
 */
function hasModifier(node: Parser.SyntaxNode, modifier: string): boolean {
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  if (!mods) return false;

  // Walk recursively through modifier tree to find the keyword
  function findMod(n: Parser.SyntaxNode): boolean {
    if (n.text === modifier && !n.isNamed) return true;
    if (n.isNamed && n.text === modifier) return true;
    for (let i = 0; i < n.childCount; i++) {
      const child = n.child(i);
      if (child && findMod(child)) return true;
    }
    return false;
  }

  return findMod(mods);
}

/**
 * Gets annotation names from a node's modifiers.
 * Annotation structure: modifiers → annotation → @ + user_type → identifier
 */
function getAnnotations(node: Parser.SyntaxNode): string[] {
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  if (!mods) return [];

  return mods.namedChildren
    .filter((m) => m.type === "annotation")
    .map((a) => {
      const userType = a.namedChildren.find((c) => c.type === "user_type");
      if (userType) {
        const ident = userType.namedChildren.find((c) => c.type === "identifier");
        return ident?.text ?? userType.text;
      }
      // Fallback: constructor_invocation for annotations with args
      const ctorInvoc = a.namedChildren.find((c) => c.type === "constructor_invocation");
      if (ctorInvoc) {
        const ut = ctorInvoc.namedChildren.find((c) => c.type === "user_type");
        const ident = ut?.namedChildren.find((c) => c.type === "identifier");
        return ident?.text ?? ut?.text ?? a.text.replace(/^@/, "");
      }
      return a.text.replace(/^@/, "");
    });
}

const TEST_ANNOTATIONS = new Set(["Test", "ParameterizedTest", "RepeatedTest"]);
const HOOK_ANNOTATIONS = new Set([
  "BeforeEach", "AfterEach", "BeforeAll", "AfterAll",
  "Before", "After", "BeforeClass", "AfterClass",
]);

/**
 * Determines if a function is a test or test hook based on annotations.
 */
function getTestKind(node: Parser.SyntaxNode): SymbolKind | null {
  const annotations = getAnnotations(node);
  for (const ann of annotations) {
    if (TEST_ANNOTATIONS.has(ann)) return "test_case";
    if (HOOK_ANNOTATIONS.has(ann)) return "test_hook";
  }
  return null;
}

/**
 * Gets the name of a property_declaration (stored in variable_declaration/identifier).
 */
function getPropertyName(node: Parser.SyntaxNode): string | null {
  const varDecl = node.namedChildren.find((c) => c.type === "variable_declaration");
  if (varDecl) {
    const ident = varDecl.namedChildren.find((c) => c.type === "identifier");
    return ident?.text ?? null;
  }
  return null;
}

/**
 * Detects if a function_declaration is an extension function.
 * Extension functions have a user_type before the identifier with a "." between them.
 * Returns the receiver type name or null.
 */
function getReceiverType(
  node: Parser.SyntaxNode,
  source: string,
): string | null {
  const nameNode = node.childForFieldName("name")
    ?? node.namedChildren.find((c) => c.type === "identifier");
  if (!nameNode) return null;

  // Look for user_type that appears BEFORE the function name
  for (const child of node.namedChildren) {
    if (child.type === "user_type" && child.endIndex < nameNode.startIndex) {
      return source.slice(child.startIndex, child.endIndex);
    }
  }
  return null;
}

/**
 * Extracts function signature: parameter list + return type.
 * For Kotlin: `(name: String, age: Int): User?`
 */
function getSignature(
  node: Parser.SyntaxNode,
  source: string,
): string | undefined {
  const params = node.namedChildren.find(
    (c) => c.type === "function_value_parameters",
  );
  if (!params) return undefined;

  let sig = "";

  // Prefix with suspend if present
  if (hasModifier(node, "suspend")) {
    sig += "suspend ";
  }

  // Include receiver type for extension functions
  const receiver = getReceiverType(node, source);
  if (receiver) {
    sig += receiver + ".";
  }

  // Type parameters (generics)
  const typeParams = node.namedChildren.find(
    (c) => c.type === "type_parameters",
  );
  if (typeParams) {
    sig += source.slice(typeParams.startIndex, typeParams.endIndex) + " ";
  }

  sig += source.slice(params.startIndex, params.endIndex);

  // Return type: find user_type / nullable_type / function_type AFTER params
  for (const child of node.namedChildren) {
    if (
      child.startIndex > params.endIndex &&
      (child.type === "user_type" ||
        child.type === "nullable_type" ||
        child.type === "function_type" ||
        child.type === "parenthesized_type")
    ) {
      sig += ": " + source.slice(child.startIndex, child.endIndex);
      break;
    }
  }

  return sig.trim() || undefined;
}

// --- Main extractor ---

export function extractKotlinSymbols(
  tree: Parser.Tree,
  filePath: string,
  source: string,
  repo: string,
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];

  function walk(node: Parser.SyntaxNode, parentId?: string): void {
    switch (node.type) {
      case "function_declaration": {
        const name = getName(node);
        if (name) {
          const testKind = getTestKind(node);
          const kind: SymbolKind = testKind ?? (parentId ? "method" : "function");
          const sym = makeSymbol(node, name, kind, filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
            signature: getSignature(node, source),
          });
          symbols.push(sym);
        }
        break;
      }

      case "class_declaration": {
        const name = getName(node);
        if (name) {
          // Distinguish interface from class by checking for unnamed `interface` keyword
          const kind: SymbolKind = isInterface(node) ? "interface" : "class";
          const sym = makeSymbol(node, name, kind, filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
          });
          symbols.push(sym);

          // Extract primary constructor val/var params as fields
          const primaryCtor = node.namedChildren.find(
            (c) => c.type === "primary_constructor",
          );
          if (primaryCtor) {
            const classParams = primaryCtor.namedChildren.find(
              (c) => c.type === "class_parameters",
            );
            if (classParams) {
              for (const param of classParams.namedChildren) {
                if (param.type === "class_parameter") {
                  const paramName = getName(param);
                  // Check for val/var keyword (unnamed child)
                  let hasValVar = false;
                  for (let i = 0; i < param.childCount; i++) {
                    const child = param.child(i);
                    if (
                      child &&
                      (child.type === "val" || child.type === "var")
                    ) {
                      hasValVar = true;
                      break;
                    }
                  }
                  if (paramName && hasValVar) {
                    const fieldSym = makeSymbol(
                      param,
                      paramName,
                      "field",
                      filePath,
                      source,
                      repo,
                      { parentId: sym.id },
                    );
                    symbols.push(fieldSym);
                  }
                }
              }
            }
          }

          // Extract enum entries
          const enumBody = node.namedChildren.find(
            (c) => c.type === "enum_class_body",
          );
          if (enumBody) {
            for (const entry of enumBody.namedChildren) {
              if (entry.type === "enum_entry") {
                const entryName = getName(entry);
                if (entryName) {
                  const entrySym = makeSymbol(
                    entry,
                    entryName,
                    "field",
                    filePath,
                    source,
                    repo,
                    { parentId: sym.id },
                  );
                  symbols.push(entrySym);
                }
              }
            }
          }

          // Walk class body for methods, nested classes, properties, etc.
          const classBody = node.namedChildren.find(
            (c) => c.type === "class_body" || c.type === "enum_class_body",
          );
          if (classBody) {
            for (const child of classBody.namedChildren) {
              walk(child, sym.id);
            }
          }
        }
        return; // Don't default-walk (handled above)
      }

      case "object_declaration": {
        const name = getName(node);
        if (name) {
          const sym = makeSymbol(node, name, "class", filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
          });
          symbols.push(sym);

          const body = node.namedChildren.find(
            (c) => c.type === "class_body",
          );
          if (body) {
            for (const child of body.namedChildren) {
              walk(child, sym.id);
            }
          }
        }
        return;
      }

      case "companion_object": {
        const nameNode = node.namedChildren.find(
          (c) => c.type === "identifier",
        );
        const name = nameNode?.text ?? "Companion";
        const sym = makeSymbol(node, name, "class", filePath, source, repo, {
          parentId,
          docstring: getDocstring(node, source),
        });
        symbols.push(sym);

        const body = node.namedChildren.find(
          (c) => c.type === "class_body",
        );
        if (body) {
          for (const child of body.namedChildren) {
            walk(child, sym.id);
          }
        }
        return;
      }

      case "property_declaration": {
        const name = getPropertyName(node);
        if (name) {
          const isConst = hasModifier(node, "const");
          let kind: SymbolKind;
          if (isConst) {
            kind = "constant";
          } else if (parentId) {
            kind = "field";
          } else {
            kind = "variable";
          }
          const sym = makeSymbol(node, name, kind, filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
          });
          symbols.push(sym);
        }
        break;
      }

      case "type_alias": {
        const name = getName(node);
        if (name) {
          const sym = makeSymbol(node, name, "type", filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
          });
          symbols.push(sym);
        }
        break;
      }

      default:
        break;
    }

    // Default: walk children (only if we didn't return early)
    for (const child of node.namedChildren) {
      walk(child, parentId);
    }
  }

  walk(tree.rootNode);
  return symbols;
}
