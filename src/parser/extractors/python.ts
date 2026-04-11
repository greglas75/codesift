import type Parser from "web-tree-sitter";
import type { CodeSymbol, SymbolKind } from "../../types.js";
import { getNodeName, makeSymbol } from "./_shared.js";

// --- Helpers ---

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
 * Extract the list of superclass expressions from a class_definition.
 * Returns the text of each positional argument in the superclass list,
 * skipping keyword arguments (e.g. `metaclass=ABCMeta`).
 */
function getSuperclasses(classNode: Parser.SyntaxNode): string[] {
  const superclasses = classNode.childForFieldName("superclasses");
  if (!superclasses) return [];

  const result: string[] = [];
  for (const arg of superclasses.namedChildren) {
    // Skip keyword arguments like `metaclass=ABCMeta`
    if (arg.type === "keyword_argument") continue;
    result.push(arg.text);
  }
  return result;
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
 * `decorators` is only populated from the `decorated_definition` branch;
 * plain `function_definition` nodes never have decorators.
 */
function classifyFunction(
  name: string,
  parentId: string | undefined,
  decorators: Parser.SyntaxNode[],
): SymbolKind {
  if (decorators.length > 0 && isPytestFixture(decorators)) return "test_hook";
  if (name.startsWith("test_")) return "test_case";
  if (parentId) return "method";
  return "function";
}

const SCREAMING_CASE_RE = /^[A-Z][A-Z0-9_]*$/;
const DUNDER_RE = /^__\w+__$/;

/**
 * Parse the right-hand side of `__all__ = ...` to extract literal string
 * members and detect dynamic expressions.
 *
 * Returns:
 *   { members: string[], computed: boolean }
 * where `members` contains all string literals found, and `computed` is true
 * if the RHS is anything other than a plain list/tuple of string literals
 * (e.g. `BASE + ["X"]`, `list(...)`, conditional assignment).
 */
function parseAllAssignment(rhs: Parser.SyntaxNode): {
  members: string[];
  computed: boolean;
} {
  // Direct list or tuple literal — walk children for strings
  if (rhs.type === "list" || rhs.type === "tuple") {
    const members: string[] = [];
    let computed = false;
    for (const element of rhs.namedChildren) {
      if (element.type === "string") {
        // Strip optional prefix (b/r/f/u/br/rb) and quotes (single, double, triple)
        const text = element.text;
        const stripped = text.replace(/^[bruf]*('{3}|"{3}|['"])|'{3}|"{3}|['"]$/gi, "");
        members.push(stripped);
      } else {
        computed = true;
      }
    }
    return { members, computed };
  }

  // Anything else (binary_operator, call, etc.) — dynamic expression.
  // Walk descendants for any string literals to preserve partial data.
  const members: string[] = [];
  const stack: Parser.SyntaxNode[] = [rhs];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === "string") {
      const stripped = n.text.replace(/^['"]|['"]$/g, "");
      members.push(stripped);
      continue;
    }
    for (const child of n.namedChildren) stack.push(child);
  }
  return { members, computed: true };
}

/**
 * Extract decorator source text from a decorator node (e.g. "@property",
 * "@app.route('/users')", "@dataclass(frozen=True)"). Returns the leading
 * "@" plus the expression text, trimmed.
 */
function getDecoratorText(decoratorNode: Parser.SyntaxNode): string {
  return decoratorNode.text.trim();
}

/**
 * Classify a decorator list into structured metadata. Handles the well-known
 * Python decorators that affect symbol semantics: @abstractmethod, @dataclass,
 * @<name>.setter/deleter/getter for property accessors.
 */
function classifyDecorators(decorators: string[]): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const d of decorators) {
    if (d === "@abstractmethod" || d.startsWith("@abstractmethod(")) {
      meta.is_abstract = true;
    }
    if (d === "@dataclass" || d.startsWith("@dataclass(")) {
      if (d.includes("frozen=True")) meta.dataclass_frozen = true;
    }
    const accessorMatch = d.match(/^@\w+\.(setter|deleter|getter)\b/);
    if (accessorMatch) {
      meta.property_accessor = accessorMatch[1];
    }
  }
  return meta;
}

/**
 * Detect whether a function_definition node represents an async function.
 * Belt-and-suspenders: handle both `async_function_definition` node type
 * (older grammars) and `async` keyword child on `function_definition`.
 */
function isAsyncFunction(node: Parser.SyntaxNode): boolean {
  if (node.type === "async_function_definition") return true;
  // tree-sitter-python 0.23+ represents async via an unnamed `async` child
  // before `def`. Walk all children (including unnamed) to find it.
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === "async") return true;
  }
  return false;
}

// --- Main extractor ---

const MAX_WALK_DEPTH = 200;

export function extractPythonSymbols(
  tree: Parser.Tree,
  filePath: string,
  source: string,
  repo: string,
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];

  function walk(node: Parser.SyntaxNode, parentId?: string, depth = 0): void {
    // Safety: bound recursion depth on pathologically deep files
    if (depth > MAX_WALK_DEPTH) {
      console.warn(
        `[python-extractor] MAX_WALK_DEPTH (${MAX_WALK_DEPTH}) hit at ${filePath}:${node.startPosition.row + 1} — deeper symbols dropped`,
      );
      return;
    }
    switch (node.type) {
      case "expression_statement": {
        const inner = node.namedChildren[0];
        if (!inner) break;
        if (inner.type !== "assignment") break;

        const lhs = inner.childForFieldName("left");
        const rhs = inner.childForFieldName("right");
        const typeAnnot = inner.childForFieldName("type");
        if (!lhs) break;
        if (lhs.type !== "identifier") break;

        const name = lhs.text;

        // Class-level field (parentId set): any annotated assignment is a field.
        // Plain assignments are also fields if the class is a dataclass, but
        // detecting dataclass context mid-walk is hard — treat annotated
        // assignments as fields (covers dataclass/TypedDict/Pydantic cases).
        if (parentId) {
          if (typeAnnot) {
            const sym = makeSymbol(node, name, "field", filePath, source, repo, {
              parentId,
            });
            symbols.push(sym);
          }
          return;
        }

        // Module-level __all__ export list
        if (name === "__all__") {
          const meta: Record<string, unknown> = {};
          if (rhs) {
            const { members, computed } = parseAllAssignment(rhs);
            meta.all_members = members;
            if (computed) meta.all_computed = true;
          }
          const sym = makeSymbol(node, name, "constant", filePath, source, repo, {
            meta,
          });
          symbols.push(sym);
          return;
        }

        // Module-level SCREAMING_CASE constants
        if (SCREAMING_CASE_RE.test(name)) {
          const sym = makeSymbol(node, name, "constant", filePath, source, repo, {});
          symbols.push(sym);
          return;
        }
        break;
      }
      case "async_function_definition":
      case "function_definition": {
        const name = getNodeName(node);
        if (name) {
          const kind = classifyFunction(name, parentId, []);
          const is_async = isAsyncFunction(node);
          const meta: Record<string, unknown> = {};
          if (DUNDER_RE.test(name)) meta.is_dunder = true;
          const sym = makeSymbol(node, name, kind, filePath, source, repo, {
            parentId,
            docstring: getDocstring(node),
            signature: getSignature(node, source),
            is_async,
            meta,
          });
          symbols.push(sym);
          // Walk function body to catch nested classes/functions
          const body = node.childForFieldName("body");
          if (body) {
            for (const child of body.namedChildren) {
              walk(child, sym.id, depth + 1);
            }
          }
        }
        return;
      }

      case "class_definition": {
        const name = getNodeName(node) ?? "<anonymous>";
        const isTestClass = isTestCaseClass(node);
        const kind: SymbolKind = isTestClass ? "test_suite" : "class";
        const superclasses = getSuperclasses(node);
        const sym = makeSymbol(node, name, kind, filePath, source, repo, {
          parentId,
          docstring: getDocstring(node),
          extends: superclasses,
        });
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
        const decoratorNodes: Parser.SyntaxNode[] = [];
        let innerNode: Parser.SyntaxNode | null = null;

        for (const child of node.namedChildren) {
          if (child.type === "decorator") {
            decoratorNodes.push(child);
          } else {
            // The inner definition (function_definition or class_definition)
            innerNode = child;
          }
        }

        if (!innerNode) break;

        const decoratorTexts = decoratorNodes.map(getDecoratorText);
        const decoratorMeta = classifyDecorators(decoratorTexts);

        if (
          innerNode.type === "function_definition"
          || innerNode.type === "async_function_definition"
        ) {
          const name = getNodeName(innerNode);
          if (name) {
            const kind = classifyFunction(name, parentId, decoratorNodes);
            const is_async = isAsyncFunction(innerNode);
            const meta = { ...decoratorMeta };
            if (DUNDER_RE.test(name)) meta.is_dunder = true;
            // Use the decorated_definition node for source span (includes decorators)
            // Docstring comes from the inner function, not the decorated_definition
            const sym = makeSymbol(node, name, kind, filePath, source, repo, {
              parentId,
              docstring: getDocstring(innerNode),
              signature: getSignature(innerNode, source),
              is_async,
              decorators: decoratorTexts,
              meta,
            });
            symbols.push(sym);
            // Walk function body for nested classes/functions
            const body = innerNode.childForFieldName("body");
            if (body) {
              for (const child of body.namedChildren) {
                walk(child, parentId, depth + 1);
              }
            }
          }
        } else if (innerNode.type === "class_definition") {
          const name = getNodeName(innerNode) ?? "<anonymous>";
          const isTestClass = isTestCaseClass(innerNode);
          const kind: SymbolKind = isTestClass ? "test_suite" : "class";
          const superclasses = getSuperclasses(innerNode);
          // Use decorated_definition node for source span
          // Docstring comes from the inner class
          const sym = makeSymbol(node, name, kind, filePath, source, repo, {
            parentId,
            docstring: getDocstring(innerNode),
            decorators: decoratorTexts,
            extends: superclasses,
            meta: decoratorMeta,
          });
          symbols.push(sym);

          // Walk class body with this class as parent
          const body = innerNode.childForFieldName("body");
          if (body) {
            for (const child of body.namedChildren) {
              walk(child, sym.id, depth + 1);
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
      walk(child, parentId, depth + 1);
    }
  }

  let partial = false;
  try {
    walk(tree.rootNode);
  } catch (err: unknown) {
    // Never throw from the extractor — on unexpected failure, return whatever
    // symbols were collected so far, flagged as partial.
    partial = true;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[python-extractor] walk failed for ${filePath} (${symbols.length} symbols collected, partial): ${message}`,
    );
  }

  // Tag partial results so callers can detect incomplete extraction
  if (partial && symbols.length > 0) {
    const first = symbols[0]!;
    if (!first.meta) (first as unknown as Record<string, unknown>).meta = {};
    (first.meta as Record<string, unknown>).partial_extraction = true;
  }
  return symbols;
}
