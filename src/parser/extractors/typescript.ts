import type Parser from "web-tree-sitter";
import type { CodeSymbol } from "../../types.js";
import {
  handleAbstractMethodSignature,
  handleClassLikeDeclaration,
  handleClassStaticBlock,
  handleFieldDefinition,
  handleMethodDefinition,
} from "./typescript-class-nodes.js";
import { handleCjsExport } from "./typescript-cjs-nodes.js";
import {
  handleFunctionDeclaration,
  handleLexicalDeclaration,
} from "./typescript-declaration-nodes.js";
import {
  handleAmbientDeclaration,
  handleExportStatement,
  handleModuleDeclaration,
} from "./typescript-module-nodes.js";
import {
  type WalkNode,
  type TypeScriptExtractorContext,
} from "./typescript-shared.js";
import { handleTestExpressionStatement } from "./typescript-test-nodes.js";
import {
  handleEnumDeclaration,
  handleInterfaceDeclaration,
  handleTypeAliasDeclaration,
} from "./typescript-type-nodes.js";

type NodeAction = (
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  parentId: string | undefined,
  isExported: boolean,
  walk: WalkNode,
) => boolean;

function continueAfter(
  handler: (
    ctx: TypeScriptExtractorContext,
    node: Parser.SyntaxNode,
    parentId: string | undefined,
    isExported: boolean,
    walk: WalkNode,
  ) => void,
): NodeAction {
  return actionAfter(handler, false);
}

function stopAfter(
  handler: (
    ctx: TypeScriptExtractorContext,
    node: Parser.SyntaxNode,
    parentId: string | undefined,
    isExported: boolean,
    walk: WalkNode,
  ) => void,
): NodeAction {
  return actionAfter(handler, true);
}

function actionAfter(
  handler: (
    ctx: TypeScriptExtractorContext,
    node: Parser.SyntaxNode,
    parentId: string | undefined,
    isExported: boolean,
    walk: WalkNode,
  ) => void,
  shouldStop: boolean,
): NodeAction {
  return (ctx, node, parentId, isExported, walk) => {
    handler(ctx, node, parentId, isExported, walk);
    return shouldStop;
  };
}

const NODE_ACTIONS: Record<string, NodeAction> = {
  function_declaration: continueAfter((ctx, node, parentId, isExported) =>
    handleFunctionDeclaration(ctx, node, parentId, isExported)),
  generator_function_declaration: continueAfter((ctx, node, parentId, isExported) =>
    handleFunctionDeclaration(ctx, node, parentId, isExported)),
  function_signature: continueAfter((ctx, node, parentId, isExported) =>
    handleFunctionDeclaration(ctx, node, parentId, isExported)),
  lexical_declaration: stopAfter((ctx, node, parentId, isExported) =>
    handleLexicalDeclaration(ctx, node, parentId, isExported)),
  class_declaration: stopAfter(handleClassLikeDeclaration),
  abstract_class_declaration: stopAfter(handleClassLikeDeclaration),
  class_expression: stopAfter(handleClassLikeDeclaration),
  class: stopAfter(handleClassLikeDeclaration),
  abstract_method_signature: continueAfter((ctx, node, parentId) =>
    handleAbstractMethodSignature(ctx, node, parentId)),
  method_definition: continueAfter((ctx, node, parentId) =>
    handleMethodDefinition(ctx, node, parentId)),
  public_field_definition: continueAfter((ctx, node, parentId) =>
    handleFieldDefinition(ctx, node, parentId)),
  field_definition: continueAfter((ctx, node, parentId) =>
    handleFieldDefinition(ctx, node, parentId)),
  class_static_block: continueAfter((ctx, node, parentId) =>
    handleClassStaticBlock(ctx, node, parentId)),
  interface_declaration: continueAfter((ctx, node, parentId, isExported) =>
    handleInterfaceDeclaration(ctx, node, parentId, isExported)),
  type_alias_declaration: continueAfter((ctx, node, parentId, isExported) =>
    handleTypeAliasDeclaration(ctx, node, parentId, isExported)),
  internal_module: stopAfter(handleModuleDeclaration),
  module: stopAfter(handleModuleDeclaration),
  ambient_declaration: stopAfter((_ctx, node, parentId, isExported, walk) =>
    handleAmbientDeclaration(node, parentId, isExported, walk)),
  enum_declaration: stopAfter((ctx, node, parentId, isExported) =>
    handleEnumDeclaration(ctx, node, parentId, isExported)),
  export_statement: stopAfter((ctx, node, parentId, _isExported, walk) =>
    handleExportStatement(ctx, node, parentId, walk)),
  expression_statement: handleExpressionStatement,
};

function handleExpressionStatement(
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  parentId: string | undefined,
  _isExported: boolean,
  walk: WalkNode,
): boolean {
  const firstChild = node.namedChildren[0];
  if (firstChild?.type === "assignment_expression" && handleCjsExport(ctx, firstChild, node, parentId)) {
    return true;
  }
  return handleTestExpressionStatement(ctx, node, parentId, walk);
}

function walkChildren(
  node: Parser.SyntaxNode,
  parentId: string | undefined,
  isExported: boolean,
  walk: WalkNode,
): void {
  for (const child of node.namedChildren) {
    walk(child, parentId, isExported);
  }
}

function applyExportPostPass(context: TypeScriptExtractorContext): void {
  if (context.localReExported.size === 0 && context.cjsExported.size === 0) return;

  const exportedNames = new Set<string>([...context.localReExported, ...context.cjsExported]);
  for (const sym of context.symbols) {
    if (!sym.is_exported && exportedNames.has(sym.name)) {
      sym.is_exported = true;
    }
  }
}

export function extractTypeScriptSymbols(
  tree: Parser.Tree,
  filePath: string,
  source: string,
  repo: string,
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const context: TypeScriptExtractorContext = {
    source,
    filePath,
    repo,
    symbols,
    localReExported: new Set<string>(),
    cjsExported: new Set<string>(),
    ambientFnSigOverloadCount: new Map<string, number>(),
  };

  function walk(node: Parser.SyntaxNode, parentId?: string, isExported = false): void {
    const action = NODE_ACTIONS[node.type];
    if (action?.(context, node, parentId, isExported, walk)) return;
    walkChildren(node, parentId, isExported, walk);
  }

  if ((tree.rootNode as Parser.SyntaxNode & { hasError: boolean }).hasError) {
    console.warn(`[ts-extractor] grammar errors detected in ${filePath}; some symbols may be incomplete`);
  }

  try {
    walk(tree.rootNode);
  } catch (err) {
    if (err instanceof RangeError && /Maximum call stack/i.test(err.message)) {
      console.warn(`[ts-extractor] stack overflow on ${filePath}; returning ${symbols.length} partial symbols`);
      return symbols;
    }
    throw err;
  }

  applyExportPostPass(context);

  return symbols;
}
