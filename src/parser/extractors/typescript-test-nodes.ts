import type Parser from "web-tree-sitter";
import {
  getDocstring,
  makeSymbol,
  type TypeScriptExtractorContext,
  type WalkNode,
} from "./typescript-shared.js";

const TEST_HOOK_NAMES = new Set([
  "beforeEach", "afterEach", "beforeAll", "afterAll",
]);

const TEST_CASE_METHODS = new Set([
  "skip", "todo", "each", "only", "failing", "concurrent",
]);

const TEST_SUITE_METHODS = new Set([
  "skip", "only", "each",
]);

interface CalleeInfo { base: string; method: string | null }

function parseTestCallee(callExpr: Parser.SyntaxNode): CalleeInfo | null {
  const fn = callExpr.childForFieldName("function");
  if (!fn) return null;

  if (fn.type === "identifier") {
    return { base: fn.text, method: null };
  }

  if (fn.type === "member_expression") {
    const obj = fn.childForFieldName("object");
    const prop = fn.childForFieldName("property");
    if (obj?.type === "identifier" && prop) {
      return { base: obj.text, method: prop.text };
    }
  }

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

function getTestName(node: Parser.SyntaxNode): string | null {
  const args = node.childForFieldName("arguments");
  if (!args) return null;

  const firstArg = args.namedChildren[0];
  if (!firstArg) return null;

  if (firstArg.type === "string" || firstArg.type === "template_string") {
    return firstArg.text.replace(/^['"`]|['"`]$/g, "");
  }
  return firstArg.text;
}

export function handleTestExpressionStatement(
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  parentId: string | undefined,
  walk: WalkNode,
): boolean {
  const expr = node.namedChildren[0];
  if (expr?.type !== "call_expression") return false;

  const callee = parseTestCallee(expr);
  if (!callee) return false;
  return emitTestSuite(ctx, node, expr, callee, parentId, walk)
    || emitTestCase(ctx, node, expr, callee, parentId)
    || emitTestHook(ctx, node, callee, parentId);
}

function emitTestSuite(
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  expr: Parser.SyntaxNode,
  callee: CalleeInfo,
  parentId: string | undefined,
  walk: WalkNode,
): boolean {
  if (callee.base !== "describe" || !isAllowedMethod(callee.method, TEST_SUITE_METHODS)) return false;

  const name = getTestName(expr) ?? "describe";
  const sym = makeSymbol(node, name, "test_suite", ctx.filePath, ctx.source, ctx.repo, {
    parentId,
    docstring: getDocstring(node, ctx.source),
  });
  ctx.symbols.push(sym);
  walkTestSuiteBody(expr, sym.id, walk);
  return true;
}

function emitTestCase(
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  expr: Parser.SyntaxNode,
  callee: CalleeInfo,
  parentId: string | undefined,
): boolean {
  if (!isTestCaseBase(callee.base) || !isAllowedMethod(callee.method, TEST_CASE_METHODS)) return false;

  const name = getTestName(expr) ?? callee.base;
  ctx.symbols.push(makeSymbol(node, name, "test_case", ctx.filePath, ctx.source, ctx.repo, {
    parentId,
    docstring: getDocstring(node, ctx.source),
  }));
  return true;
}

function emitTestHook(
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  callee: CalleeInfo,
  parentId: string | undefined,
): boolean {
  if (callee.method !== null || !TEST_HOOK_NAMES.has(callee.base)) return false;

  ctx.symbols.push(makeSymbol(node, callee.base, "test_hook", ctx.filePath, ctx.source, ctx.repo, {
    parentId,
    docstring: getDocstring(node, ctx.source),
  }));
  return true;
}

function walkTestSuiteBody(expr: Parser.SyntaxNode, parentId: string, walk: WalkNode): void {
  const args = expr.childForFieldName("arguments");
  if (!args) return;

  for (const arg of args.namedChildren) {
    if (!isSuiteBodyFunction(arg)) continue;
    for (const bodyChild of arg.namedChildren) {
      walk(bodyChild, parentId);
    }
  }
}

function isSuiteBodyFunction(node: Parser.SyntaxNode): boolean {
  return node.type === "arrow_function" || node.type === "function";
}

function isAllowedMethod(method: string | null, allowed: Set<string>): boolean {
  return method === null || allowed.has(method);
}

function isTestCaseBase(base: string): boolean {
  return base === "it" || base === "test";
}
