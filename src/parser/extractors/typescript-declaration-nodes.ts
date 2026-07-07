import type Parser from "web-tree-sitter";
import type { SymbolKind } from "../../types.js";
import { extractObjectLiteralMethods } from "./typescript-cjs-nodes.js";
import {
  classifyReactKind,
  getWrappedFunction,
  getWrapperName,
  isComponentName,
  isHookName,
  isReactWrapper,
  returnsJSX,
} from "./typescript-react.js";
import {
  getDecorators,
  getDocstring,
  getNodeName,
  getSignature,
  hasAsyncModifier,
  hasExportModifier,
  makeSymbol,
  SCREAMING_CASE_RE,
  type TypeScriptExtractorContext,
} from "./typescript-shared.js";

export function handleFunctionDeclaration(
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  parentId: string | undefined,
  isExported: boolean,
): void {
  const name = getNodeName(node);
  if (!name) return;

  const kind = classifyReactKind(name, node);
  const decorators = getDecorators(node);
  const exported = isExported || hasExportModifier(node);
  const isAsync = hasAsyncModifier(node);
  const isGenerator = node.type === "generator_function_declaration";
  const meta: Record<string, unknown> = {};
  if (isGenerator) meta.generator = true;
  if (node.type === "function_signature") {
    const okey = `${parentId ?? ""}:${name}`;
    const next = (ctx.ambientFnSigOverloadCount.get(okey) ?? 0) + 1;
    ctx.ambientFnSigOverloadCount.set(okey, next);
    if (next > 1) meta.overload_index = next - 1;
  }
  ctx.symbols.push(makeSymbol(node, name, kind, ctx.filePath, ctx.source, ctx.repo, {
    parentId,
    docstring: getDocstring(node, ctx.source),
    signature: getSignature(node, ctx.source),
    decorators: decorators.length > 0 ? decorators : undefined,
    is_async: isAsync ? true : undefined,
    is_exported: exported ? true : undefined,
    meta: Object.keys(meta).length > 0 ? meta : undefined,
  }));
}

export function handleLexicalDeclaration(
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  parentId: string | undefined,
  isExported: boolean,
): void {
  const state: LexicalState = {
    ctx,
    node,
    parentId,
    exported: isExported || hasExportModifier(node),
    isConst: node.children.some((c: Parser.SyntaxNode) => c.type === "const"),
  };

  for (const declarator of node.namedChildren) {
    emitVariableDeclarator(state, declarator);
  }
}

interface LexicalState {
  ctx: TypeScriptExtractorContext;
  node: Parser.SyntaxNode;
  parentId: string | undefined;
  exported: boolean;
  isConst: boolean;
}

function emitVariableDeclarator(state: LexicalState, declarator: Parser.SyntaxNode): void {
  if (declarator.type !== "variable_declarator") return;

  const name = getNodeName(declarator);
  if (!name) return;

  const value = declarator.childForFieldName("value");
  if (value?.type === "arrow_function") {
    emitArrowFunctionVariable(state, name, value);
    return;
  }
  if (value?.type === "call_expression" && isReactWrapper(value)) {
    emitReactWrappedVariable(state, name, value);
    return;
  }
  emitPlainVariable(state, name, value);
}

function emitArrowFunctionVariable(
  state: LexicalState,
  name: string,
  value: Parser.SyntaxNode,
): void {
  const isAsync = hasAsyncModifier(value);
  state.ctx.symbols.push(makeSymbol(state.node, name, classifyReactKind(name, value), state.ctx.filePath, state.ctx.source, state.ctx.repo, {
    parentId: state.parentId,
    docstring: getDocstring(state.node, state.ctx.source),
    signature: getSignature(value, state.ctx.source),
    is_async: isAsync ? true : undefined,
    is_exported: state.exported ? true : undefined,
  }));
}

function emitReactWrappedVariable(
  state: LexicalState,
  name: string,
  value: Parser.SyntaxNode,
): void {
  const innerFn = getWrappedFunction(value);
  state.ctx.symbols.push(makeSymbol(state.node, name, reactWrapperKind(name, value, innerFn), state.ctx.filePath, state.ctx.source, state.ctx.repo, {
    parentId: state.parentId,
    docstring: getDocstring(state.node, state.ctx.source),
    signature: innerFn ? getSignature(innerFn, state.ctx.source) : undefined,
    is_exported: state.exported ? true : undefined,
  }));
}

function reactWrapperKind(
  name: string,
  value: Parser.SyntaxNode,
  innerFn: Parser.SyntaxNode | null,
): SymbolKind {
  if (isHookName(name)) return "hook";
  if (!isComponentName(name)) return "function";

  const wrapperName = getWrapperName(value);
  return wrapperName === "lazy" || (innerFn !== null && returnsJSX(innerFn))
    ? "component"
    : "function";
}

function emitPlainVariable(
  state: LexicalState,
  name: string,
  value: Parser.SyntaxNode | null,
): void {
  const sym = makeSymbol(state.node, name, variableKind(state, name), state.ctx.filePath, state.ctx.source, state.ctx.repo, {
    parentId: state.parentId,
    docstring: getDocstring(state.node, state.ctx.source),
    is_exported: state.exported ? true : undefined,
  });
  state.ctx.symbols.push(sym);

  if (value?.type === "object") {
    extractObjectLiteralMethods(value, sym.id, state.ctx);
  }
}

function variableKind(state: LexicalState, name: string): SymbolKind {
  return state.isConst && SCREAMING_CASE_RE.test(name) ? "constant" : "variable";
}
