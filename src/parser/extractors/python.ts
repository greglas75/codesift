import Parser from "web-tree-sitter";
import type { CodeSymbol, SymbolKind } from "../../types.js";
import { tokenizeIdentifier, makeSymbolId } from "../symbol-extractor.js";

const MAX_SOURCE_LENGTH = 5000;

// --- Helpers ---

function getNodeName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode?.text ?? null;
}

/**
 * Python docstrings are the first expression_statement in the body
 * whose child is a string node (triple-quoted or single-quoted).
 */
function getDocstring(node: Parser.SyntaxNode): string | undefined {
  const body = node.childForFieldName("body");
  if (!body) return undefined;

  const firstStatement = body.namedChildren[0];
  if (!firstStatement || firstStatement.type !== "expression_statement") {
    return undefined;
  }

  const expr = firstStatement.namedChildren[0];
  if (!expr || expr.type !== "string") return undefined;

  return expr.text;
}

/**
 * Extract parameter list and optional return type annotation.
 * e.g. "(self, name: str, age: int = 0) -> bool"
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
    sig += " -> " + source.slice(returnType.startIndex, returnType.endIndex);
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
  const docstring = getDocstring(node);

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

/**
 * Check if a class inherits from unittest.TestCase.
 */
function isTestCaseClass(node: Parser.SyntaxNode): boolean {
  const superclasses = node.childForFieldName("superclasses");
  if (!superclasses) return false;

  for (const arg of superclasses.namedChildren) {
    const text = arg.text;
    if (text === "TestCase" || text === "unittest.TestCase") {
      return true;
    }
  }
  return false;
}

/**
 * Check if a function is a pytest fixture (has @pytest.fixture decorator).
 */
function isPytestFixture(decorators: Parser.SyntaxNode[]): boolean {
  for (const dec of decorators) {
    const text = dec.text;
    if (
      text.includes("pytest.fixture") ||
      text.includes("@fixture")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Determine the kind for a function definition, considering test patterns.
 */
function classifyFunction(
  name: string,
  parentId: string | undefined,
  decorators: Parser.SyntaxNode[],
): SymbolKind {
  if (isPytestFixture(decorators)) return "test_hook";
  if (name.startsWith("test_")) return parentId ? "test_case" : "test_case";
  if (parentId) return "method";
  return "function";
}

// --- Main extractor ---

export function extractPythonSymbols(
  tree: Parser.Tree,
  filePath: string,
  source: string,
  repo: string,
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];

  function walk(node: Parser.SyntaxNode, parentId?: string): void {
    switch (node.type) {
      case "function_definition": {
        const name = getNodeName(node);
        if (name) {
          const kind = classifyFunction(name, parentId, []);
          const sym = makeSymbol(node, name, kind, filePath, source, repo, parentId);
          const sig = getSignature(node, source);
          if (sig) sym.signature = sig;
          symbols.push(sym);
        }
        break;
      }

      case "class_definition": {
        const name = getNodeName(node) ?? "<anonymous>";
        const isTestClass = isTestCaseClass(node);
        const kind: SymbolKind = isTestClass ? "test_suite" : "class";
        const sym = makeSymbol(node, name, kind, filePath, source, repo, parentId);
        symbols.push(sym);

        // Walk class body with this class as parent
        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.namedChildren) {
            walk(child, sym.id);
          }
        }
        return;
      }

      case "decorated_definition": {
        // Collect decorator nodes
        const decorators: Parser.SyntaxNode[] = [];
        let innerNode: Parser.SyntaxNode | null = null;

        for (const child of node.namedChildren) {
          if (child.type === "decorator") {
            decorators.push(child);
          } else {
            // The inner definition (function_definition or class_definition)
            innerNode = child;
          }
        }

        if (!innerNode) break;

        if (innerNode.type === "function_definition") {
          const name = getNodeName(innerNode);
          if (name) {
            const kind = classifyFunction(name, parentId, decorators);
            // Use the decorated_definition node for source span (includes decorators)
            const sym = makeSymbol(node, name, kind, filePath, source, repo, parentId);
            const sig = getSignature(innerNode, source);
            if (sig) sym.signature = sig;
            // Docstring comes from the inner function, not the decorated_definition
            const docstring = getDocstring(innerNode);
            if (docstring) sym.docstring = docstring;
            symbols.push(sym);
          }
        } else if (innerNode.type === "class_definition") {
          const name = getNodeName(innerNode) ?? "<anonymous>";
          const isTestClass = isTestCaseClass(innerNode);
          const kind: SymbolKind = isTestClass ? "test_suite" : "class";
          // Use decorated_definition node for source span
          const sym = makeSymbol(node, name, kind, filePath, source, repo, parentId);
          // Docstring comes from the inner class
          const docstring = getDocstring(innerNode);
          if (docstring) sym.docstring = docstring;
          symbols.push(sym);

          // Walk class body with this class as parent
          const body = innerNode.childForFieldName("body");
          if (body) {
            for (const child of body.namedChildren) {
              walk(child, sym.id);
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
