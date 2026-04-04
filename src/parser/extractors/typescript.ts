import type Parser from "web-tree-sitter";
import type { CodeSymbol } from "../../types.js";
import { getNodeName, makeSymbol } from "./_shared.js";

/** Matches top-level SCREAMING_CASE identifiers like MAX_RETRIES, API_URL */
const SCREAMING_CASE_RE = /^[A-Z][A-Z0-9_]+$/;

/** Test lifecycle hook names */
const TEST_HOOK_NAMES = new Set([
  "beforeEach", "afterEach", "beforeAll", "afterAll",
]);

/** Method suffixes on it/test that are still test_case (it.skip, it.each, etc.) */
const TEST_CASE_METHODS = new Set([
  "skip", "todo", "each", "only", "failing", "concurrent",
]);

/** Method suffixes on describe that are still test_suite */
const TEST_SUITE_METHODS = new Set([
  "skip", "only", "each",
]);

/**
 * Parse test-call callee from a call_expression node.
 *
 * Handles:
 *   describe("...", fn)        -> { base: "describe", method: null }
 *   it("...", fn)              -> { base: "it",       method: null }
 *   it.skip("...", fn)         -> { base: "it",       method: "skip" }
 *   it.each([...])("...", fn)  -> { base: "it",       method: "each" }
 *   beforeEach(fn)             -> { base: "beforeEach", method: null }
 */
interface CalleeInfo { base: string; method: string | null }

function parseTestCallee(callExpr: Parser.SyntaxNode): CalleeInfo | null {
  const fn = callExpr.childForFieldName("function");
  if (!fn) return null;

  // Simple call: describe(...), it(...), test(...), beforeEach(...)
  if (fn.type === "identifier") {
    return { base: fn.text, method: null };
  }

  // Member call: it.skip(...), it.todo(...), describe.only(...)
  if (fn.type === "member_expression") {
    const obj = fn.childForFieldName("object");
    const prop = fn.childForFieldName("property");
    if (obj?.type === "identifier" && prop) {
      return { base: obj.text, method: prop.text };
    }
  }

  // Chained call: it.each([...])("name", fn)
  // The outer call_expression has a call_expression child as callee
  if (fn.type === "call_expression") {
    const innerFn = fn.childForFieldName("function");
    if (innerFn?.type === "member_expression") {
      const obj = innerFn.childForFieldName("object");
      const prop = innerFn.childForFieldName("property");
      if (obj?.type === "identifier" && prop) {
        return { base: obj.text, method: prop.text };
      }
    }
  }

  return null;
}

// --- Helpers ---

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

/**
 * Build a trimmed "shell" of a class — keeps field declarations and method
 * signatures but replaces method bodies with `{ … }`.
 * This lets agents see the class shape cheaply (~20 tokens for a 200-line class)
 * while individual methods are still indexed with full source.
 */
function trimClassBody(node: Parser.SyntaxNode, source: string): string {
  const body = node.childForFieldName("body");
  if (!body) return source.slice(node.startIndex, node.endIndex);

  // Build the class header (everything before the body `{`)
  let result = source.slice(node.startIndex, body.startIndex + 1); // includes opening `{`

  for (const child of body.namedChildren) {
    if (
      child.type === "method_definition" ||
      child.type === "abstract_method_signature"
    ) {
      // Find the statement_block (body) of the method
      const methodBody = child.childForFieldName("body");
      if (methodBody) {
        // Signature = everything before the body, then ` { … }`
        result += "\n  " + source.slice(child.startIndex, methodBody.startIndex).trimEnd() + " { … }";
      } else {
        // Abstract method or no body — include as-is
        result += "\n  " + source.slice(child.startIndex, child.endIndex);
      }
    } else {
      // Fields, decorators, etc. — include as-is
      result += "\n  " + source.slice(child.startIndex, child.endIndex);
    }
  }

  result += "\n}";
  return result;
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
          const sym = makeSymbol(node, name, "function", filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
            signature: getSignature(node, source),
          });
          symbols.push(sym);
        }
        break;
      }

      case "lexical_declaration": {
        // Determine if this is a `const` declaration (vs let/var)
        const isConst = node.children.some(
          (c: Parser.SyntaxNode) => c.type === "const",
        );

        for (const declarator of node.namedChildren) {
          if (declarator.type !== "variable_declarator") continue;

          const name = getNodeName(declarator);
          if (!name) continue;

          const value = declarator.childForFieldName("value");
          if (value && value.type === "arrow_function") {
            const sym = makeSymbol(node, name, "function", filePath, source, repo, {
              parentId,
              docstring: getDocstring(node, source),
              signature: getSignature(value, source),
            });
            symbols.push(sym);
          } else if (value) {
            // SCREAMING_CASE const -> "constant", otherwise -> "variable"
            const kind = isConst && SCREAMING_CASE_RE.test(name) ? "constant" : "variable";
            const sym = makeSymbol(node, name, kind, filePath, source, repo, {
              parentId,
              docstring: getDocstring(node, source),
            });
            symbols.push(sym);
          }
        }
        // Don't walk children — we already processed declarators
        return;
      }

      case "class_declaration":
      case "abstract_class_declaration": {
        const name = getNodeName(node) ?? "<anonymous>";
        const sym = makeSymbol(node, name, "class", filePath, source, repo, {
          parentId,
          docstring: getDocstring(node, source),
        });

        // Walk class body with this class as parent (before trimming so children get full source)
        for (const child of node.namedChildren) {
          walk(child, sym.id);
        }

        // Replace class source with trimmed shell (signatures only, no method bodies)
        sym.source = trimClassBody(node, source);
        symbols.push(sym);
        return;
      }

      case "abstract_method_signature": {
        // abstract doSomething(): void; inside abstract classes
        const name = getNodeName(node);
        if (name) {
          const sym = makeSymbol(node, name, "method", filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
            signature: getSignature(node, source),
          });
          symbols.push(sym);
        }
        break;
      }

      case "method_definition": {
        const name = getNodeName(node);
        if (name) {
          const sym = makeSymbol(node, name, "method", filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
            signature: getSignature(node, source),
          });
          symbols.push(sym);
        }
        break;
      }

      case "public_field_definition": {
        const name = getNodeName(node);
        if (name) {
          const sym = makeSymbol(node, name, "field", filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
          });
          symbols.push(sym);
        }
        break;
      }

      case "interface_declaration": {
        const name = getNodeName(node);
        if (name) {
          const sym = makeSymbol(node, name, "interface", filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
          });
          symbols.push(sym);
        }
        break;
      }

      case "type_alias_declaration": {
        const name = getNodeName(node);
        if (name) {
          const sym = makeSymbol(node, name, "type", filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
          });
          symbols.push(sym);
        }
        break;
      }

      case "enum_declaration": {
        const name = getNodeName(node);
        if (name) {
          const sym = makeSymbol(node, name, "enum", filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
          });
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
        // Also handles member forms: it.skip(...), it.each(...)(...), describe.only(...)
        const expr = node.namedChildren[0];
        if (expr?.type === "call_expression") {
          const callee = parseTestCallee(expr);
          if (callee) {
            const { base, method } = callee;

            // describe() or describe.skip/only/each()
            if (base === "describe" && (method === null || TEST_SUITE_METHODS.has(method))) {
              const testName = getTestName(expr);
              const name = testName ?? "describe";
              const sym = makeSymbol(node, name, "test_suite", filePath, source, repo, {
                parentId,
                docstring: getDocstring(node, source),
              });
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

            // it() / test() or it.skip/each/only/todo/failing/concurrent()
            if (
              (base === "it" || base === "test") &&
              (method === null || TEST_CASE_METHODS.has(method))
            ) {
              const testName = getTestName(expr);
              const name = testName ?? base;
              const sym = makeSymbol(node, name, "test_case", filePath, source, repo, {
                parentId,
                docstring: getDocstring(node, source),
              });
              symbols.push(sym);
              return;
            }

            // Lifecycle hooks: beforeEach(), afterEach(), beforeAll(), afterAll()
            if (TEST_HOOK_NAMES.has(base) && method === null) {
              const sym = makeSymbol(node, base, "test_hook", filePath, source, repo, {
                parentId,
                docstring: getDocstring(node, source),
              });
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
