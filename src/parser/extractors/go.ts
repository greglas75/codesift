import type Parser from "web-tree-sitter";
import type { CodeSymbol, SymbolKind } from "../../types.js";
import { tokenizeIdentifier, makeSymbolId } from "../symbol-extractor.js";

const MAX_SOURCE_LENGTH = 5000;

// --- Helpers ---

function getNodeName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode?.text ?? null;
}

/**
 * Collects contiguous // comment lines immediately preceding a declaration.
 * Go convention uses // line comments for documentation (no block comment docs).
 */
function getDocstring(
  node: Parser.SyntaxNode,
  source: string,
): string | undefined {
  const comments: string[] = [];
  let prev = node.previousNamedSibling;

  // Walk backwards collecting contiguous comment nodes
  while (prev && prev.type === "comment") {
    const text = source.slice(prev.startIndex, prev.endIndex);
    comments.unshift(text);

    // Check if there's another comment directly above (contiguous)
    const nextPrev = prev.previousNamedSibling;
    if (
      nextPrev &&
      nextPrev.type === "comment" &&
      nextPrev.endPosition.row === prev.startPosition.row - 1
    ) {
      prev = nextPrev;
    } else {
      break;
    }
  }

  if (comments.length === 0) return undefined;
  return comments.join("\n");
}

/**
 * Extracts function/method signature: parameter list + return type.
 * For Go functions: `(ctx context.Context, id string) (Order, error)`
 * For Go methods: includes receiver in signature.
 */
function getSignature(
  node: Parser.SyntaxNode,
  source: string,
): string | undefined {
  const params = node.childForFieldName("parameters");
  if (!params) return undefined;

  let sig = "";

  // Include receiver for methods: func (s *Server) Handle(...)
  const receiver = node.childForFieldName("receiver");
  if (receiver) {
    sig += source.slice(receiver.startIndex, receiver.endIndex) + " ";
  }

  sig += source.slice(params.startIndex, params.endIndex);

  const result = node.childForFieldName("result");
  if (result) {
    sig += " " + source.slice(result.startIndex, result.endIndex);
  }

  return sig;
}

function extractNodeSource(
  node: Parser.SyntaxNode,
  source: string,
): string {
  const text = source.slice(node.startIndex, node.endIndex);
  if (text.length > MAX_SOURCE_LENGTH) {
    return text.slice(0, MAX_SOURCE_LENGTH) + "...";
  }
  return text;
}

function makeSymbol(
  node: Parser.SyntaxNode,
  name: string,
  kind: SymbolKind,
  filePath: string,
  source: string,
  repo: string,
  parentId?: string,
): CodeSymbol {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  const docstring = getDocstring(node, source);

  const sym: CodeSymbol = {
    id: makeSymbolId(repo, filePath, name, startLine),
    repo,
    name,
    kind,
    file: filePath,
    start_line: startLine,
    end_line: endLine,
    source: extractNodeSource(node, source),
    tokens: tokenizeIdentifier(name),
  };

  if (docstring) sym.docstring = docstring;
  if (parentId) sym.parent = parentId;

  return sym;
}

// --- Main extractor ---

export function extractGoSymbols(
  tree: Parser.Tree,
  filePath: string,
  source: string,
  repo: string,
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];

  function walk(node: Parser.SyntaxNode, parentId?: string): void {
    switch (node.type) {
      case "function_declaration": {
        const name = getNodeName(node);
        if (name) {
          const sym = makeSymbol(node, name, "function", filePath, source, repo, parentId);
          const sig = getSignature(node, source);
          if (sig) sym.signature = sig;
          symbols.push(sym);
        }
        break;
      }

      case "method_declaration": {
        const name = getNodeName(node);
        if (name) {
          const sym = makeSymbol(node, name, "method", filePath, source, repo, parentId);
          const sig = getSignature(node, source);
          if (sig) sym.signature = sig;
          symbols.push(sym);
        }
        break;
      }

      case "type_declaration": {
        // type_declaration contains one or more type_spec children
        for (const child of node.namedChildren) {
          if (child.type !== "type_spec") continue;

          const name = getNodeName(child);
          if (!name) continue;

          // Determine kind from the type body
          const typeBody = child.childForFieldName("type");
          let kind: SymbolKind = "type";
          if (typeBody) {
            switch (typeBody.type) {
              case "struct_type":
                kind = "class";
                break;
              case "interface_type":
                kind = "interface";
                break;
              default:
                kind = "type";
                break;
            }
          }

          // Use the parent type_declaration node for source/position
          // so the full `type Foo struct { ... }` is captured
          const sym = makeSymbol(node, name, kind, filePath, source, repo, parentId);
          symbols.push(sym);

          // For structs, walk fields as children
          if (kind === "class" && typeBody) {
            for (const field of typeBody.namedChildren) {
              if (field.type === "field_declaration_list") {
                for (const fieldDecl of field.namedChildren) {
                  if (fieldDecl.type === "field_declaration") {
                    const fieldName = getNodeName(fieldDecl);
                    if (fieldName) {
                      const fieldSym = makeSymbol(
                        fieldDecl, fieldName, "field", filePath, source, repo, sym.id,
                      );
                      symbols.push(fieldSym);
                    }
                  }
                }
              }
            }
          }
        }
        return;
      }

      case "const_declaration":
      case "var_declaration": {
        // Package-level const/var: only at top level (no parent)
        if (parentId) break;

        for (const child of node.namedChildren) {
          if (child.type === "const_spec" || child.type === "var_spec") {
            const name = getNodeName(child);
            if (name) {
              const sym = makeSymbol(node, name, "variable", filePath, source, repo);
              symbols.push(sym);
            }
          }
        }
        return;
      }

      default:
        break;
    }

    // Default: walk children
    for (const child of node.namedChildren) {
      walk(child, parentId);
    }
  }

  walk(tree.rootNode);
  return symbols;
}
