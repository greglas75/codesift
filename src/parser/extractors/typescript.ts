import type Parser from "web-tree-sitter";
import type { CodeSymbol, SymbolKind } from "../../types.js";
import { getNodeName, makeSymbol, MAX_SOURCE_LENGTH } from "./_shared.js";

/** Matches top-level SCREAMING_CASE identifiers like MAX_RETRIES, API_URL */
const SCREAMING_CASE_RE = /^[A-Z][A-Z0-9_]+$/;

// --- React detection ---

/** React wrapper functions that indicate a component */
const REACT_WRAPPER_NAMES = new Set(["memo", "forwardRef", "lazy"]);

/** Custom hook naming convention: starts with use + uppercase letter */
const CUSTOM_HOOK_RE = /^use[A-Z]/;

/** Component naming convention: starts with uppercase letter */
const COMPONENT_NAME_RE = /^[A-Z]/;

/** JSX node types that indicate a React component return */
const JSX_TYPES = new Set([
  "jsx_element", "jsx_self_closing_element", "jsx_fragment",
]);

/**
 * Check if a function/arrow body contains a JSX return.
 * For arrow with expression body: check if body IS jsx.
 * For block body: check return_statement descendants for jsx children.
 */
function returnsJSX(node: Parser.SyntaxNode): boolean {
  const body = node.childForFieldName("body");
  if (!body) return false;

  // Arrow with expression body: () => <div/>
  if (JSX_TYPES.has(body.type)) return true;

  // Parenthesized expression body: () => (<div/>)
  if (body.type === "parenthesized_expression") {
    for (const child of body.namedChildren) {
      if (JSX_TYPES.has(child.type)) return true;
    }
  }

  // Block body: check return statements
  const returns = body.descendantsOfType("return_statement");
  for (const ret of returns) {
    for (const child of ret.namedChildren) {
      if (JSX_TYPES.has(child.type)) return true;
      // Parenthesized: return (<div/>)
      if (child.type === "parenthesized_expression") {
        for (const inner of child.namedChildren) {
          if (JSX_TYPES.has(inner.type)) return true;
        }
      }
    }
  }
  return false;
}

/**
 * Check if a call_expression is a React wrapper (memo, forwardRef, lazy).
 * Handles: memo(...), React.memo(...), forwardRef(...), React.forwardRef(...)
 */
function isReactWrapper(callExpr: Parser.SyntaxNode): boolean {
  const fn = callExpr.childForFieldName("function");
  if (!fn) return false;

  // Direct: memo(...), forwardRef(...), lazy(...)
  if (fn.type === "identifier" && REACT_WRAPPER_NAMES.has(fn.text)) return true;

  // Member: React.memo(...), React.forwardRef(...)
  if (fn.type === "member_expression") {
    const prop = fn.childForFieldName("property");
    if (prop && REACT_WRAPPER_NAMES.has(prop.text)) return true;
  }

  return false;
}

/** Get the wrapper function name from a React wrapper call (memo, forwardRef, lazy) */
function getWrapperName(callExpr: Parser.SyntaxNode): string | null {
  const fn = callExpr.childForFieldName("function");
  if (!fn) return null;
  if (fn.type === "identifier") return fn.text;
  if (fn.type === "member_expression") {
    return fn.childForFieldName("property")?.text ?? null;
  }
  return null;
}

/** Extract the inner function from a React wrapper call's arguments */
function getWrappedFunction(callExpr: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const args = callExpr.childForFieldName("arguments");
  if (!args) return null;
  const firstArg = args.namedChildren[0];
  if (!firstArg) return null;
  if (firstArg.type === "arrow_function" || firstArg.type === "function_expression") {
    return firstArg;
  }
  return null;
}

/** React base class names that indicate a class component */
const REACT_COMPONENT_BASES = new Set([
  "Component", "PureComponent",
]);

/**
 * Strip type arguments, expand intersection/union, preserve qualified names.
 * Returns string[] (not string|null) so intersection/union types expand to
 * multiple elements via flatMap at the call site. AC #6 normalization rule:
 *   - identifier → ["Foo"]   (extends Foo — runtime value position)
 *   - type_identifier → ["I"]   (implements I — type position)
 *   - member_expression / nested_type_identifier → ["ns.Base"] (qualified preserved)
 *   - generic_type → recurse into name field, drop type_arguments → ["Box"]
 *   - intersection_type / union_type → flatMap across members → ["A", "B"]
 *
 * IMPORTANT: tree-sitter-typescript parses `extends Foo` as `identifier` NOT
 * `type_identifier`. Without the identifier case, all standard ES6 inheritance
 * is silently dropped (gemini adversarial pre-execute finding).
 */
function extractHeritageNames(node: Parser.SyntaxNode): string[] {
  if (node.type === "identifier") return [node.text];
  if (node.type === "type_identifier") return [node.text];
  if (node.type === "member_expression" || node.type === "nested_type_identifier") return [node.text];
  if (node.type === "generic_type") {
    const innerType = node.childForFieldName("name") ?? node.namedChildren[0];
    return innerType ? extractHeritageNames(innerType) : [];
  }
  if (node.type === "intersection_type" || node.type === "union_type") {
    return node.namedChildren.flatMap((child) => extractHeritageNames(child));
  }
  return [];
}

/** Walk class_heritage and return separate extends/implements lists. */
function getClassHeritage(node: Parser.SyntaxNode): { extends: string[]; implements: string[] } {
  const extendsList: string[] = [];
  const implementsList: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== "class_heritage") continue;
    for (const clause of child.namedChildren) {
      const target =
        clause.type === "extends_clause" ? extendsList :
        clause.type === "implements_clause" ? implementsList : null;
      if (!target) continue;
      for (const typeNode of clause.namedChildren) {
        target.push(...extractHeritageNames(typeNode));
      }
    }
  }
  return { extends: extendsList, implements: implementsList };
}

/**
 * Check if a class extends React.Component or React.PureComponent.
 * Uses getClassHeritage (shared helper) — NO duplicate AST walk (CQ14).
 */
function isReactClassComponent(node: Parser.SyntaxNode): boolean {
  const { extends: extendsList } = getClassHeritage(node);
  for (const name of extendsList) {
    // "Component" / "PureComponent" — bare identifier match
    if (REACT_COMPONENT_BASES.has(name)) return true;
    // "React.Component" / "React.PureComponent" — qualified match
    const lastDot = name.lastIndexOf(".");
    if (lastDot >= 0 && REACT_COMPONENT_BASES.has(name.slice(lastDot + 1))) return true;
  }
  return false;
}

/**
 * Classify a function/arrow as component, hook, or function.
 * - Hook: name matches use[A-Z]
 * - Component: PascalCase name AND returns JSX
 * - Function: everything else
 */
function classifyReactKind(
  name: string,
  fnNode: Parser.SyntaxNode | null,
): SymbolKind {
  if (CUSTOM_HOOK_RE.test(name)) return "hook";
  if (COMPONENT_NAME_RE.test(name) && fnNode && returnsJSX(fnNode)) return "component";
  return "function";
}

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

function getDecoratorText(node: Parser.SyntaxNode): string {
  return node.text.trim();
}

function collectOwnDecorators(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  return node.namedChildren.filter((child) => child.type === "decorator");
}

function collectLeadingSiblingDecorators(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const decorators: Parser.SyntaxNode[] = [];
  let sibling = node.previousNamedSibling;
  while (sibling && sibling.type === "decorator") {
    decorators.unshift(sibling);
    sibling = sibling.previousNamedSibling;
  }
  return decorators;
}

function getDecorators(node: Parser.SyntaxNode): string[] {
  const decoratorNodes = [
    ...collectOwnDecorators(node),
    ...collectLeadingSiblingDecorators(node),
  ];
  if (decoratorNodes.length === 0) return [];

  const seen = new Set<string>();
  const decorators: string[] = [];
  for (const decorator of decoratorNodes) {
    const text = getDecoratorText(decorator);
    if (seen.has(text)) continue;
    seen.add(text);
    decorators.push(text);
  }
  return decorators;
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
  if (result.length > MAX_SOURCE_LENGTH) {
    return result.slice(0, MAX_SOURCE_LENGTH) + "...";
  }
  return result;
}

function getSignature(
  node: Parser.SyntaxNode,
  source: string,
): string | undefined {
  const params = node.childForFieldName("parameters");
  if (!params) return undefined;

  let sig = "";
  // Generics: `<T extends Foo, U = string>` — prepend before parameters when present.
  const typeParams = node.childForFieldName("type_parameters");
  if (typeParams) {
    sig += source.slice(typeParams.startIndex, typeParams.endIndex);
  }
  sig += source.slice(params.startIndex, params.endIndex);

  // return_type field already includes the leading `:` (it points to a
  // type_annotation node containing colon + type) — no `: ` prefix here.
  const returnType = node.childForFieldName("return_type");
  if (returnType) {
    sig += source.slice(returnType.startIndex, returnType.endIndex);
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

/**
 * Recognize the LHS of a CommonJS exports assignment.
 *
 * Returns:
 *   { kind: "module_exports", property: null }            for `module.exports = ...`
 *   { kind: "module_exports", property: "foo" }           for `module.exports.foo = ...`
 *   { kind: "exports", property: "foo" }                  for `exports.foo = ...`
 *   null                                                  for any other LHS
 */
function parseCjsLhs(
  lhs: Parser.SyntaxNode,
): { kind: "module_exports" | "exports"; property: string | null } | null {
  if (lhs.type !== "member_expression") return null;
  const obj = lhs.childForFieldName("object");
  const prop = lhs.childForFieldName("property");
  if (!obj || !prop) return null;

  // exports.foo
  if (obj.type === "identifier" && obj.text === "exports") {
    return { kind: "exports", property: prop.text };
  }

  // module.exports = ...
  if (obj.type === "identifier" && obj.text === "module" && prop.text === "exports") {
    return { kind: "module_exports", property: null };
  }

  // module.exports.foo = ...
  if (obj.type === "member_expression") {
    const innerObj = obj.childForFieldName("object");
    const innerProp = obj.childForFieldName("property");
    if (
      innerObj?.type === "identifier" && innerObj.text === "module" &&
      innerProp?.text === "exports"
    ) {
      return { kind: "module_exports", property: prop.text };
    }
  }

  return null;
}

/** Pick a SymbolKind for the RHS of a CJS property assignment. */
function cjsValueKind(value: Parser.SyntaxNode, name: string): SymbolKind {
  if (value.type === "arrow_function" || value.type === "function_expression") {
    return classifyReactKind(name, value);
  }
  if (value.type === "class_expression") return "class";
  if (SCREAMING_CASE_RE.test(name)) return "constant";
  return "variable";
}

/**
 * Handle a CommonJS exports assignment. Returns true when the assignment was
 * recognized as a CJS export pattern (caller should `return` and skip default
 * walking), false when the assignment is unrelated.
 *
 * Behavior:
 *   - `module.exports = identifier`        → defer: tag matching symbol in post-pass
 *   - `module.exports = { foo, bar }`      → defer shorthand keys; emit pair-with-fn keys
 *   - `module.exports = arrow|function|class` → emit `default_export` symbol
 *   - `module.exports.foo = expr`          → emit `foo` symbol with is_exported=true
 *   - `exports.foo = expr`                 → emit `foo` symbol with is_exported=true
 */
function handleCjsExport(
  assign: Parser.SyntaxNode,
  stmt: Parser.SyntaxNode,
  parentId: string | undefined,
  source: string,
  filePath: string,
  repo: string,
  out: CodeSymbol[],
  cjsExported: Set<string>,
): boolean {
  const lhs = assign.childForFieldName("left");
  const rhs = assign.childForFieldName("right");
  if (!lhs || !rhs) return false;

  const target = parseCjsLhs(lhs);
  if (!target) return false;

  // module.exports.<X> / exports.<X>  → emit a fresh exported symbol for X
  if (target.property) {
    const name = target.property;
    const kind = cjsValueKind(rhs, name);
    out.push(makeSymbol(stmt, name, kind, filePath, source, repo, {
      parentId,
      docstring: getDocstring(stmt, source),
      signature: (rhs.type === "arrow_function" || rhs.type === "function_expression")
        ? getSignature(rhs, source) : undefined,
      is_exported: true,
    }));
    cjsExported.add(name);
    return true;
  }

  // module.exports = ...
  switch (rhs.type) {
    case "identifier": {
      // Defer to post-pass: tag the matching declaration.
      cjsExported.add(rhs.text);
      return true;
    }
    case "object": {
      for (const member of rhs.namedChildren) {
        if (member.type === "shorthand_property_identifier") {
          cjsExported.add(member.text);
        } else if (member.type === "pair") {
          const keyNode = member.childForFieldName("key");
          const valNode = member.childForFieldName("value");
          if (!keyNode || !valNode) continue;
          const keyName = keyNode.text.replace(/^['"`]|['"`]$/g, "");
          if (valNode.type === "identifier") {
            // { foo: someFn } — defer; tag someFn AND keyName both as exported.
            cjsExported.add(valNode.text);
            cjsExported.add(keyName);
          } else if (valNode.type === "arrow_function" || valNode.type === "function_expression") {
            // { handler: () => {} } — emit a fresh exported symbol under keyName
            const kind = classifyReactKind(keyName, valNode);
            out.push(makeSymbol(member, keyName, kind, filePath, source, repo, {
              parentId,
              signature: getSignature(valNode, source),
              is_exported: true,
            }));
          }
        }
      }
      return true;
    }
    case "arrow_function":
    case "function_expression":
    case "class_expression": {
      // Anonymous default export: `module.exports = () => {}`
      out.push(makeSymbol(stmt, "default", "default_export", filePath, source, repo, {
        parentId,
        signature: (rhs.type === "arrow_function" || rhs.type === "function_expression")
          ? getSignature(rhs, source) : undefined,
        is_exported: true,
      }));
      return true;
    }
    default:
      // Unknown RHS shape (call_expression, member_expression, etc.) —
      // not a recognized CJS pattern, fall through to default handling.
      return false;
  }
}

/**
 * Extract method-shaped members from an object literal `{ foo() {}, bar: () => {} }`.
 * Mutates `symbols` in place so the caller (lexical_declaration handler) can keep
 * its short-circuit `return` without losing object-method visibility.
 *
 * Handles two shapes commonly used as JS controller / handler objects:
 *   - method shorthand:  { create() { ... } }            → method_definition
 *   - arrow assignment:  { onClick: () => {...} }        → pair(arrow_function)
 *   - function value:    { handler: function(){...} }    → pair(function_expression)
 */
function extractObjectLiteralMethods(
  objectNode: Parser.SyntaxNode,
  parentId: string,
  source: string,
  filePath: string,
  repo: string,
  out: CodeSymbol[],
): void {
  for (const child of objectNode.namedChildren) {
    if (child.type === "method_definition") {
      const methodName = getNodeName(child);
      if (!methodName) continue;
      out.push(makeSymbol(child, methodName, "method", filePath, source, repo, {
        parentId,
        signature: getSignature(child, source),
      }));
      continue;
    }
    if (child.type === "pair") {
      const keyNode = child.childForFieldName("key");
      const valNode = child.childForFieldName("value");
      if (!keyNode || !valNode) continue;
      if (valNode.type !== "arrow_function" && valNode.type !== "function_expression") continue;
      const methodName = keyNode.text.replace(/^['"`]|['"`]$/g, "");
      // Honor React conventions even on object members (e.g. an exported
      // hooks object): use[A-Z] → hook, PascalCase + JSX → component.
      const kind = classifyReactKind(methodName, valNode);
      out.push(makeSymbol(child, methodName, kind === "function" ? "method" : kind, filePath, source, repo, {
        parentId,
        signature: getSignature(valNode, source),
      }));
    }
  }
}

// --- Main extractor ---

/** True if the declaration has an `export` keyword child (modifier-based export). */
function hasExportModifier(node: Parser.SyntaxNode): boolean {
  for (const child of node.children) {
    if (child.type === "export") return true;
  }
  return false;
}

export function extractTypeScriptSymbols(
  tree: Parser.Tree,
  filePath: string,
  source: string,
  repo: string,
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const localReExported = new Set<string>();
  // CommonJS exports — names referenced by `module.exports = X` or
  // `module.exports = { foo, bar }`. Resolved in a post-pass against
  // already-emitted symbols so a `function foo(){}` declared earlier in the
  // file gets its `is_exported` flag set when the exports assignment is seen.
  const cjsExported = new Set<string>();

  function walk(node: Parser.SyntaxNode, parentId?: string, isExported = false): void {
    switch (node.type) {
      case "function_declaration":
      case "generator_function_declaration": {
        const name = getNodeName(node);
        if (name) {
          // React detection: hook (useX) or component (PascalCase + JSX return)
          const kind = classifyReactKind(name, node);
          const decorators = getDecorators(node);
          const exported = isExported || hasExportModifier(node);
          const isGenerator = node.type === "generator_function_declaration";
          const sym = makeSymbol(node, name, kind, filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
            signature: getSignature(node, source),
            decorators: decorators.length > 0 ? decorators : undefined,
            is_exported: exported ? true : undefined,
            meta: isGenerator ? { generator: true } : undefined,
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
        const exported = isExported || hasExportModifier(node);

        for (const declarator of node.namedChildren) {
          if (declarator.type !== "variable_declarator") continue;

          const name = getNodeName(declarator);
          if (!name) continue;

          const value = declarator.childForFieldName("value");
          if (value && value.type === "arrow_function") {
            // React detection: hook or component
            const kind = classifyReactKind(name, value);
            const sym = makeSymbol(node, name, kind, filePath, source, repo, {
              parentId,
              docstring: getDocstring(node, source),
              signature: getSignature(value, source),
              is_exported: exported ? true : undefined,
            });
            symbols.push(sym);
          } else if (value && value.type === "call_expression" && isReactWrapper(value)) {
            // React wrapper: const X = React.memo(() => <div/>), forwardRef(), lazy()
            const wrapperName = getWrapperName(value);
            const innerFn = getWrappedFunction(value);
            let kind: SymbolKind = "function";
            if (CUSTOM_HOOK_RE.test(name)) {
              kind = "hook";
            } else if (COMPONENT_NAME_RE.test(name)) {
              // lazy() always returns a component; memo/forwardRef need inner JSX check
              if (wrapperName === "lazy" || (innerFn && returnsJSX(innerFn))) {
                kind = "component";
              }
            }
            const sym = makeSymbol(node, name, kind, filePath, source, repo, {
              parentId,
              docstring: getDocstring(node, source),
              signature: innerFn ? getSignature(innerFn, source) : undefined,
              is_exported: exported ? true : undefined,
            });
            symbols.push(sym);
          } else if (value) {
            // SCREAMING_CASE const -> "constant", otherwise -> "variable"
            const kind = isConst && SCREAMING_CASE_RE.test(name) ? "constant" : "variable";
            const sym = makeSymbol(node, name, kind, filePath, source, repo, {
              parentId,
              docstring: getDocstring(node, source),
              is_exported: exported ? true : undefined,
            });
            symbols.push(sym);

            // Object literal: extract methods so `const ctrl = { create() {} }`
            // surfaces `create` as a method parented to `ctrl`. Common in
            // older Node.js / Express controllers and config objects.
            if (value.type === "object") {
              extractObjectLiteralMethods(value, sym.id, source, filePath, repo, symbols);
            }
          }
        }
        // Don't walk children — we already processed declarators
        return;
      }

      case "class_declaration":
      case "abstract_class_declaration": {
        const name = getNodeName(node) ?? "<anonymous>";
        // React class component: class Foo extends Component / React.Component / PureComponent
        const kind = isReactClassComponent(node) ? "component" as SymbolKind : "class" as SymbolKind;
        const decorators = getDecorators(node);
        const exported = isExported || hasExportModifier(node);
        const heritage = getClassHeritage(node);
        const sym = makeSymbol(node, name, kind, filePath, source, repo, {
          parentId,
          docstring: getDocstring(node, source),
          decorators: decorators.length > 0 ? decorators : undefined,
          extends: heritage.extends.length > 0 ? heritage.extends : undefined,
          implements: heritage.implements.length > 0 ? heritage.implements : undefined,
          is_exported: exported ? true : undefined,
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
          const decorators = getDecorators(node);
          const sym = makeSymbol(node, name, "method", filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
            signature: getSignature(node, source),
            decorators: decorators.length > 0 ? decorators : undefined,
          });
          symbols.push(sym);
        }
        break;
      }

      case "method_definition": {
        const name = getNodeName(node);
        if (name) {
          const decorators = getDecorators(node);
          const sym = makeSymbol(node, name, "method", filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
            signature: getSignature(node, source),
            decorators: decorators.length > 0 ? decorators : undefined,
          });
          symbols.push(sym);
        }
        break;
      }

      case "public_field_definition":
      case "field_definition": {
        // public_field_definition: TS class fields (with modifiers)
        // field_definition: JS class fields (incl. private #name, static)
        // The `name` field works for both; tree-sitter-javascript exposes the
        // identifier (or private_property_identifier) under `property` for JS,
        // but childForFieldName("name") falls back to "property" via getNodeName.
        const nameNode = node.childForFieldName("name") ?? node.childForFieldName("property");
        const name = nameNode?.text;
        if (name) {
          const decorators = getDecorators(node);
          const sym = makeSymbol(node, name, "field", filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
            decorators: decorators.length > 0 ? decorators : undefined,
          });
          symbols.push(sym);
        }
        break;
      }

      case "class_static_block": {
        // class Foo { static { ... } } — JS 2022, no name. Emit as a method
        // named "<static>" so it shows up under the class in outlines without
        // colliding with user-named methods.
        const sym = makeSymbol(node, "<static>", "method", filePath, source, repo, {
          parentId,
          docstring: getDocstring(node, source),
        });
        symbols.push(sym);
        break;
      }

      case "interface_declaration": {
        const name = getNodeName(node);
        if (name) {
          const exported = isExported || hasExportModifier(node);
          const sym = makeSymbol(node, name, "interface", filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
            is_exported: exported ? true : undefined,
          });
          symbols.push(sym);
        }
        break;
      }

      case "type_alias_declaration": {
        const name = getNodeName(node);
        if (name) {
          const exported = isExported || hasExportModifier(node);
          const sym = makeSymbol(node, name, "type", filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
            is_exported: exported ? true : undefined,
          });
          symbols.push(sym);
        }
        break;
      }

      case "enum_declaration": {
        const name = getNodeName(node);
        if (name) {
          const exported = isExported || hasExportModifier(node);
          const sym = makeSymbol(node, name, "enum", filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
            is_exported: exported ? true : undefined,
          });
          symbols.push(sym);

          // Walk enum_body to emit members as `constant` parented to the enum.
          // children: enum_assignment (named member with value) | property_identifier
          const body = node.childForFieldName("body");
          if (body) {
            for (const child of body.namedChildren) {
              let memberName: string | null = null;
              if (child.type === "enum_assignment") {
                memberName = getNodeName(child);
              } else if (child.type === "property_identifier") {
                memberName = child.text;
              }
              if (memberName) {
                symbols.push(makeSymbol(child, memberName, "constant", filePath, source, repo, {
                  parentId: sym.id,
                }));
              }
            }
          }
        }
        return; // body already walked; do not let default child-walk re-enter
      }

      case "export_statement": {
        const source_field = node.childForFieldName("source");
        if (source_field) {
          // Re-export from module: `export { X as Y } from "./m"` or `export * as ns from "./m"`
          for (const child of node.namedChildren) {
            if (child.type === "export_clause") {
              for (const spec of child.namedChildren) {
                if (spec.type === "export_specifier") {
                  const aliasNode = spec.childForFieldName("alias");
                  const nameNode = spec.childForFieldName("name");
                  const emitName = (aliasNode ?? nameNode)?.text;
                  if (emitName) {
                    symbols.push(makeSymbol(spec, emitName, "variable", filePath, source, repo, {
                      parentId,
                      is_exported: true,
                    }));
                  }
                }
              }
            } else if (child.type === "namespace_export") {
              // export * as ns from "./m"
              for (const c of child.namedChildren) {
                if (c.type === "identifier") {
                  symbols.push(makeSymbol(child, c.text, "namespace", filePath, source, repo, {
                    parentId,
                    is_exported: true,
                  }));
                }
              }
            }
          }
          return;
        }
        // Local re-export `export { X }` — collect names for post-pass
        for (const child of node.namedChildren) {
          if (child.type === "export_clause") {
            for (const spec of child.namedChildren) {
              if (spec.type === "export_specifier") {
                const nameNode = spec.childForFieldName("name");
                if (nameNode) localReExported.add(nameNode.text);
              }
            }
          }
        }
        // Walk children with isExported=true so wrapped declarations get tagged
        for (const child of node.namedChildren) {
          walk(child, parentId, true);
        }
        return;
      }

      case "expression_statement": {
        // CommonJS export detection (JS-only in practice — TS files use ESM):
        //   module.exports = X
        //   module.exports = { foo, bar }
        //   module.exports.foo = expr
        //   exports.foo = expr
        // Order matters: check CJS before test-call branch since both peek at
        // namedChildren[0]; CJS is `assignment_expression` and tests are
        // `call_expression` so they're disjoint and either can return early.
        const firstChild = node.namedChildren[0];
        if (firstChild?.type === "assignment_expression") {
          const handled = handleCjsExport(
            firstChild, node, parentId, source, filePath, repo, symbols, cjsExported,
          );
          if (handled) return;
        }

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
      walk(child, parentId, isExported);
    }
  }

  walk(tree.rootNode);

  // Post-pass: local re-exports `export { X }` and CommonJS exports both
  // mark prior-declared symbols as exported. Merged into a single Set so we
  // walk the symbol list at most once.
  if (localReExported.size > 0 || cjsExported.size > 0) {
    const exportedNames = new Set<string>([...localReExported, ...cjsExported]);
    for (const sym of symbols) {
      if (!sym.is_exported && exportedNames.has(sym.name)) {
        sym.is_exported = true;
      }
    }
  }

  return symbols;
}
