import type Parser from "web-tree-sitter";
import type { CodeSymbol, SymbolKind } from "../../types.js";
import { getNodeName, makeSymbol } from "./_shared.js";

/**
 * Extract doc comments (/// or //!) preceding a node.
 */
function getDocstring(
  node: Parser.SyntaxNode,
  source: string,
): string | undefined {
  const lines: string[] = [];
  let prev = node.previousNamedSibling;

  while (prev && prev.type === "line_comment") {
    const text = source.slice(prev.startIndex, prev.endIndex);
    if (text.startsWith("///") || text.startsWith("//!")) {
      lines.unshift(text);
      prev = prev.previousNamedSibling;
    } else {
      break;
    }
  }

  return lines.length > 0 ? lines.join("\n") : undefined;
}

function getSignature(node: Parser.SyntaxNode, source: string): string | undefined {
  const params = node.childForFieldName("parameters");
  const returnType = node.childForFieldName("return_type");

  if (!params) return undefined;

  let sig = source.slice(params.startIndex, params.endIndex);
  if (returnType) {
    sig += " -> " + source.slice(returnType.startIndex, returnType.endIndex);
  }
  return sig;
}

export function extractRustSymbols(
  tree: Parser.Tree,
  filePath: string,
  source: string,
  repo: string,
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];

  function addSymbol(
    node: Parser.SyntaxNode,
    name: string,
    kind: SymbolKind,
    parentId?: string,
    signature?: string,
  ): string {
    const sym = makeSymbol(node, name, kind, filePath, source, repo, {
      parentId,
      docstring: getDocstring(node, source),
      signature,
    });
    symbols.push(sym);
    return sym.id;
  }

  function walk(node: Parser.SyntaxNode, parentId?: string): void {
    switch (node.type) {
      case "function_item": {
        const name = getNodeName(node);
        if (name) {
          const sig = getSignature(node, source);
          addSymbol(node, name, "function", parentId, sig);
        }
        break;
      }

      case "struct_item": {
        const name = getNodeName(node);
        if (name) {
          const id = addSymbol(node, name, "class", parentId);
          // Extract fields
          const body = node.childForFieldName("body");
          if (body) {
            for (const child of body.namedChildren) {
              if (child.type === "field_declaration") {
                const fieldName = getNodeName(child);
                if (fieldName) {
                  addSymbol(child, fieldName, "field", id);
                }
              }
            }
          }
        }
        break;
      }

      case "enum_item": {
        const name = getNodeName(node);
        if (name) {
          addSymbol(node, name, "enum", parentId);
        }
        break;
      }

      case "trait_item": {
        const name = getNodeName(node);
        if (name) {
          const id = addSymbol(node, name, "interface", parentId);
          // Walk trait body for method signatures
          const body = node.childForFieldName("body");
          if (body) {
            for (const child of body.namedChildren) {
              walk(child, id);
            }
          }
        }
        return; // Don't recurse further — already walked body
      }

      case "impl_item": {
        // `impl Type { ... }` or `impl Trait for Type { ... }`
        const typeNode = node.childForFieldName("type");
        const implName = typeNode?.text;
        const body = node.childForFieldName("body");
        if (body && implName) {
          for (const child of body.namedChildren) {
            if (child.type === "function_item") {
              const methodName = getNodeName(child);
              if (methodName) {
                const sig = getSignature(child, source);
                // Find the parent struct symbol if it exists
                const parentStructId = symbols.find(
                  (s) => s.name === implName && (s.kind === "class" || s.kind === "interface"),
                )?.id;
                addSymbol(child, methodName, "method", parentStructId, sig);
              }
            }
          }
        }
        return; // Already walked body
      }

      case "type_item": {
        const name = getNodeName(node);
        if (name) {
          addSymbol(node, name, "type", parentId);
        }
        break;
      }

      case "const_item":
      case "static_item": {
        const name = getNodeName(node);
        if (name) {
          addSymbol(node, name, "variable", parentId);
        }
        break;
      }

      case "mod_item": {
        const name = getNodeName(node);
        if (name) {
          const id = addSymbol(node, name, "module", parentId);
          const body = node.childForFieldName("body");
          if (body) {
            for (const child of body.namedChildren) {
              walk(child, id);
            }
          }
        }
        return;
      }

      default:
        break;
    }

    // Recurse into children for top-level nodes
    for (const child of node.namedChildren) {
      walk(child, parentId);
    }
  }

  walk(tree.rootNode);
  return symbols;
}
