import type Parser from "web-tree-sitter";
import type { CodeSymbol, SymbolKind } from "../../types.js";
import { makeSymbol } from "./_shared.js";
import { getAnnotations } from "./kotlin-ast-helpers.js";
const TEST_ANNOTATIONS = new Set(["Test", "ParameterizedTest", "RepeatedTest"]);
const HOOK_ANNOTATIONS = new Set([
  "BeforeEach", "AfterEach", "BeforeAll", "AfterAll",
  "Before", "After", "BeforeClass", "AfterClass",
]);

/**
 * Kotest spec superclasses. A class extending any of these becomes a
 * `test_suite` and its constructor-argument lambda body is walked to find
 * DSL test declarations.
 */
const KOTEST_SPEC_CLASSES = new Set([
  "FunSpec", "DescribeSpec", "StringSpec", "BehaviorSpec",
  "ShouldSpec", "WordSpec", "FeatureSpec", "ExpectSpec",
  "AnnotationSpec", "FreeSpec",
]);

/**
 * Kotest DSL call identifiers that mark a `test_case`. Each appears as the
 * callee of a `call_expression` in the spec body (e.g. `test("name") { ... }`,
 * `it("name") { ... }`, `describe("name") { ... }`).
 */
const KOTEST_DSL_KEYWORDS = new Set([
  "test", "it", "describe", "context", "should",
  "given", "when", "then", "feature", "scenario", "expect",
  "xtest", "xit", "xdescribe", "xcontext", // skipped variants
]);

/**
 * Detects whether a class extends a Kotest spec via `delegation_specifiers`.
 * Returns the `lambda_literal` node inside the spec's constructor call so the
 * caller can walk it for DSL test declarations. Returns null if the class
 * doesn't extend a Kotest spec.
 */
export function findKotestSpecLambda(
  node: Parser.SyntaxNode,
): Parser.SyntaxNode | null {
  const delegation = node.namedChildren.find(
    (c) => c.type === "delegation_specifiers",
  );
  if (!delegation) return null;

  for (const spec of delegation.namedChildren) {
    if (spec.type !== "delegation_specifier") continue;
    const ctor = spec.namedChildren.find(
      (c) => c.type === "constructor_invocation",
    );
    if (!ctor) continue;
    const userType = ctor.namedChildren.find((c) => c.type === "user_type");
    if (!userType) continue;
    const ident = userType.namedChildren.find((c) => c.type === "identifier");
    if (!ident || !KOTEST_SPEC_CLASSES.has(ident.text)) continue;

    const valueArgs = ctor.namedChildren.find(
      (c) => c.type === "value_arguments",
    );
    if (!valueArgs) return null;
    const valueArg = valueArgs.namedChildren.find(
      (c) => c.type === "value_argument",
    );
    if (!valueArg) return null;
    const lambda = valueArg.namedChildren.find(
      (c) => c.type === "lambda_literal",
    );
    return lambda ?? null;
  }
  return null;
}

/**
 * Extracts a Kotest DSL test name from a `call_expression` node. Returns the
 * string literal argument for the two recognized patterns and null otherwise.
 *
 * Pattern A (FunSpec/DescribeSpec/BehaviorSpec): `test("name") { ... }` —
 *   AST: call_expression > [call_expression(identifier=keyword, value_arguments(string)), annotated_lambda]
 *
 * Pattern B (StringSpec): `"name" { ... }` —
 *   AST: call_expression > [string_literal, annotated_lambda]
 */
function extractKotestTestName(
  call: Parser.SyntaxNode,
): string | null {
  // Must have an annotated_lambda child to be a DSL test declaration with body.
  const hasLambda = call.namedChildren.some(
    (c) => c.type === "annotated_lambda",
  );
  if (!hasLambda) return null;

  // Pattern B: StringSpec inline — first child is a string_literal.
  const firstChild = call.namedChildren[0];
  if (firstChild && firstChild.type === "string_literal") {
    return unquoteStringLiteral(firstChild);
  }

  // Pattern A: inner call_expression with DSL keyword as callee.
  if (firstChild && firstChild.type === "call_expression") {
    const callee = firstChild.namedChildren.find(
      (c) => c.type === "identifier",
    );
    if (!callee) return null;
    // Strip backticks from escaped identifiers (e.g. `when`).
    const keyword = callee.text.replace(/^`|`$/g, "");
    if (!KOTEST_DSL_KEYWORDS.has(keyword)) return null;

    const args = firstChild.namedChildren.find(
      (c) => c.type === "value_arguments",
    );
    if (!args) return null;
    const firstArg = args.namedChildren.find((c) => c.type === "value_argument");
    if (!firstArg) return null;
    const strLit = firstArg.namedChildren.find(
      (c) => c.type === "string_literal",
    );
    if (!strLit) return null;
    return unquoteStringLiteral(strLit);
  }

  return null;
}

function unquoteStringLiteral(node: Parser.SyntaxNode): string {
  // Prefer the inner string_content child when present (avoids the outer quotes).
  const content = node.namedChildren.find((c) => c.type === "string_content");
  if (content) return content.text;
  // Fallback: strip surrounding quotes from raw text.
  return node.text.replace(/^"|"$/g, "");
}

/**
 * Walks a Kotest DSL lambda body and emits a `test_case` symbol for each
 * recognized call_expression (test/it/describe/etc.). Recurses into nested
 * DSL lambdas so given → when → then / describe → it produces one symbol per
 * level.
 */
export function walkKotestLambda(
  lambda: Parser.SyntaxNode,
  parentId: string,
  filePath: string,
  source: string,
  repo: string,
  symbols: CodeSymbol[],
): void {
  for (const child of lambda.namedChildren) {
    if (child.type !== "call_expression") {
      // Recurse into blocks that may contain more DSL calls.
      for (const grand of child.namedChildren) {
        if (grand.type === "call_expression") {
          walkKotestCall(grand, parentId, filePath, source, repo, symbols);
        }
      }
      continue;
    }
    walkKotestCall(child, parentId, filePath, source, repo, symbols);
  }
}

function walkKotestCall(
  call: Parser.SyntaxNode,
  parentId: string,
  filePath: string,
  source: string,
  repo: string,
  symbols: CodeSymbol[],
): void {
  const testName = extractKotestTestName(call);
  if (!testName) return;

  const sym = makeSymbol(call, testName, "test_case", filePath, source, repo, {
    parentId,
  });
  symbols.push(sym);

  // Recurse into the annotated_lambda body so nested DSL levels produce
  // their own test_case symbols.
  const annotatedLambda = call.namedChildren.find(
    (c) => c.type === "annotated_lambda",
  );
  if (!annotatedLambda) return;
  const innerLambda = annotatedLambda.namedChildren.find(
    (c) => c.type === "lambda_literal",
  );
  if (!innerLambda) return;
  walkKotestLambda(innerLambda, sym.id, filePath, source, repo, symbols);
}

/**
 * Determines if a function is a test or test hook based on annotations.
 */
export function getTestKind(node: Parser.SyntaxNode): SymbolKind | null {
  const annotations = getAnnotations(node);
  for (const ann of annotations) {
    if (TEST_ANNOTATIONS.has(ann)) return "test_case";
    if (HOOK_ANNOTATIONS.has(ann)) return "test_hook";
  }
  return null;
}
