import Parser from "web-tree-sitter";
import type { CodeSymbol, SymbolKind } from "../../types.js";
import { tokenizeIdentifier, makeSymbolId } from "../symbol-extractor.js";

const MAX_SOURCE_LENGTH = 5000;

// --- Helpers ---

function getNodeName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode?.text ?? null;
}

function getDocstring(
  node: Parser.SyntaxNode,
  source: string,
): string | undefined {
  const prev = node.previousNamedSibling;
  if (!prev) return undefined;

  if (prev.type === "comment") {
    const text = source.slice(prev.startIndex, prev.endIndex);
    // JSDoc: /** ... */ or line comment: // ...
    if (text.startsWith("/**") || text.startsWith("//")) {
      return text;
    }
  }
  return undefined;
}

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

function getTestName(node: Parser.SyntaxNode): string | null {
  const args = node.childForFieldName("arguments");
  if (!args) return null;

  const firstArg = args.namedChildren[0];
  if (!firstArg) return null;

  if (firstArg.type === "string" || firstArg.type === "template_string") {
    // Strip quotes
    return firstArg.text.replace(/^['"`]|['"`]$/g, "");
  }
  return firstArg.text;
}

// --- Main extractor ---

export function extractTypeScriptSymbols(
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

      case "lexical_declaration": {
        for (const declarator of node.namedChildren) {
          if (declarator.type !== "variable_declarator") continue;

          const name = getNodeName(declarator);
          if (!name) continue;

          const value = declarator.childForFieldName("value");
          if (value && value.type === "arrow_function") {
            const sym = makeSymbol(node, name, "function", filePath, source, repo, parentId);
            const sig = getSignature(value, source);
            if (sig) sym.signature = sig;
            const doc = getDocstring(node, source);
            if (doc) sym.docstring = doc;
            symbols.push(sym);
          } else if (value) {
            const sym = makeSymbol(node, name, "variable", filePath, source, repo, parentId);
            const doc = getDocstring(node, source);
            if (doc) sym.docstring = doc;
            symbols.push(sym);
          }
        }
        // Don't walk children — we already processed declarators
        return;
      }

      case "class_declaration": {
        const name = getNodeName(node) ?? "<anonymous>";
        const sym = makeSymbol(node, name, "class", filePath, source, repo, parentId);
        symbols.push(sym);

        // Walk class body with this class as parent
        for (const child of node.namedChildren) {
          walk(child, sym.id);
        }
        return;
      }

      case "method_definition": {
        const name = getNodeName(node);
        if (name) {
          const sym = makeSymbol(node, name, "method", filePath, source, repo, parentId);
          const sig = getSignature(node, source);
          if (sig) sym.signature = sig;
          symbols.push(sym);
        }
        break;
      }

      case "public_field_definition": {
        const name = getNodeName(node);
        if (name) {
          const sym = makeSymbol(node, name, "field", filePath, source, repo, parentId);
          symbols.push(sym);
        }
        break;
      }

      case "interface_declaration": {
        const name = getNodeName(node);
        if (name) {
          const sym = makeSymbol(node, name, "interface", filePath, source, repo, parentId);
          symbols.push(sym);
        }
        break;
      }

      case "type_alias_declaration": {
        const name = getNodeName(node);
        if (name) {
          const sym = makeSymbol(node, name, "type", filePath, source, repo, parentId);
          symbols.push(sym);
        }
        break;
      }

      case "enum_declaration": {
        const name = getNodeName(node);
        if (name) {
          const sym = makeSymbol(node, name, "enum", filePath, source, repo, parentId);
          symbols.push(sym);
        }
        break;
      }

      case "export_statement": {
        // Unwrap: extract from the inner declaration
        for (const child of node.namedChildren) {
          walk(child, parentId);
        }
        return;
      }

      case "expression_statement": {
        // Check for test calls: describe(...), it(...), test(...)
        const expr = node.namedChildren[0];
        if (expr?.type === "call_expression") {
          const fn = expr.childForFieldName("function");
          if (fn) {
            const fnName = fn.text;
            if (fnName === "describe") {
              const testName = getTestName(expr);
              const name = testName ?? "describe";
              const sym = makeSymbol(node, name, "test_suite", filePath, source, repo, parentId);
              symbols.push(sym);

              // Walk describe body for nested tests
              const args = expr.childForFieldName("arguments");
              if (args) {
                for (const arg of args.namedChildren) {
                  if (arg.type === "arrow_function" || arg.type === "function") {
                    for (const bodyChild of arg.namedChildren) {
                      walk(bodyChild, sym.id);
                    }
                  }
                }
              }
              return;
            }
            if (fnName === "it" || fnName === "test") {
              const testName = getTestName(expr);
              const name = testName ?? fnName;
              const sym = makeSymbol(node, name, "test_case", filePath, source, repo, parentId);
              symbols.push(sym);
              return;
            }
          }
        }
        break;
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
