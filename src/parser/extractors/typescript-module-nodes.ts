import type Parser from "web-tree-sitter";
import { returnsJSX } from "./typescript-react.js";
import {
  getDocstring,
  getNodeName,
  getSignature,
  hasExportModifier,
  makeSymbol,
  unwrapParentheses,
  type TypeScriptExtractorContext,
  type WalkNode,
} from "./typescript-shared.js";

const ANONYMOUS_DEFAULT_NODE_TYPES = new Set([
  "function_expression",
  "class",
  "class_declaration",
  "class_expression",
  "function_declaration",
  "generator_function_declaration",
  "arrow_function",
]);

export function handleModuleDeclaration(
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  parentId: string | undefined,
  isExported: boolean,
  walk: WalkNode,
): void {
  const nsName = readModuleName(node);
  if (nsName === null) return;

  const exported = isExported || hasExportModifier(node);
  const sym = makeSymbol(node, nsName, "namespace", ctx.filePath, ctx.source, ctx.repo, {
    parentId,
    docstring: getDocstring(node, ctx.source),
    is_exported: exported ? true : undefined,
  });
  ctx.symbols.push(sym);
  walkModuleBody(node, sym.id, exported, walk);
}

function readModuleName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  if (nameNode) return stripQuotedName(nameNode);

  for (const child of node.namedChildren) {
    if (child.type === "identifier" || child.type === "string") {
      return stripQuotedName(child);
    }
  }
  return null;
}

function stripQuotedName(node: Parser.SyntaxNode): string {
  return node.type === "string" ? node.text.replace(/^['"`]|['"`]$/g, "") : node.text;
}

function walkModuleBody(
  node: Parser.SyntaxNode,
  parentId: string,
  exported: boolean,
  walk: WalkNode,
): void {
  const body = node.childForFieldName("body")
    ?? node.namedChildren.find((c) => c.type === "statement_block");
  if (!body) return;

  for (const child of body.namedChildren) {
    walk(child, parentId, exported);
  }
}

export function handleAmbientDeclaration(
  node: Parser.SyntaxNode,
  parentId: string | undefined,
  isExported: boolean,
  walk: WalkNode,
): void {
  const ambientExported = isExported || hasExportModifier(node);
  for (const child of node.namedChildren) {
    const isStringNamedModule = child.type === "module"
      && (child.childForFieldName("name")?.type === "string"
          || child.namedChildren.some((c) => c.type === "string"));
    walk(child, parentId, ambientExported || isStringNamedModule);
  }
}

export function handleExportStatement(
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  parentId: string | undefined,
  walk: WalkNode,
): void {
  if (node.childForFieldName("source")) {
    emitExternalReExportSymbols(ctx, node, parentId);
    return;
  }

  collectLocalReExports(ctx, node);
  if (tryEmitAnonymousDefaultExport(ctx, node, parentId, walk)) return;
  walkExportChildren(node, parentId, walk);
}

function emitExternalReExportSymbols(
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  parentId: string | undefined,
): void {
  for (const child of node.namedChildren) {
    if (child.type === "export_clause") {
      emitExportSpecifiers(ctx, child, parentId);
    } else if (child.type === "namespace_export") {
      emitNamespaceExport(ctx, child, parentId);
    }
  }
}

function emitExportSpecifiers(
  ctx: TypeScriptExtractorContext,
  exportClause: Parser.SyntaxNode,
  parentId: string | undefined,
): void {
  for (const spec of exportClause.namedChildren) {
    if (spec.type !== "export_specifier") continue;
    const aliasNode = spec.childForFieldName("alias");
    const nameNode = spec.childForFieldName("name");
    const emitName = (aliasNode ?? nameNode)?.text;
    if (!emitName) continue;

    ctx.symbols.push(makeSymbol(spec, emitName, "variable", ctx.filePath, ctx.source, ctx.repo, {
      parentId,
      is_exported: true,
    }));
  }
}

function emitNamespaceExport(
  ctx: TypeScriptExtractorContext,
  namespaceExport: Parser.SyntaxNode,
  parentId: string | undefined,
): void {
  for (const child of namespaceExport.namedChildren) {
    if (child.type !== "identifier") continue;
    ctx.symbols.push(makeSymbol(namespaceExport, child.text, "namespace", ctx.filePath, ctx.source, ctx.repo, {
      parentId,
      is_exported: true,
    }));
  }
}

function collectLocalReExports(ctx: TypeScriptExtractorContext, node: Parser.SyntaxNode): void {
  for (const child of node.namedChildren) {
    if (child.type !== "export_clause") continue;
    for (const spec of child.namedChildren) {
      if (spec.type !== "export_specifier") continue;
      const nameNode = spec.childForFieldName("name");
      if (nameNode) ctx.localReExported.add(nameNode.text);
    }
  }
}

function tryEmitAnonymousDefaultExport(
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  parentId: string | undefined,
  walk: WalkNode,
): boolean {
  if (!node.children.some((c) => c.type === "default")) return false;

  for (const child of node.namedChildren) {
    const inner = unwrapParentheses(child);
    if (!isAnonymousDefaultCandidate(inner)) continue;
    const sym = makeAnonymousDefaultSymbol(ctx, inner, parentId);
    ctx.symbols.push(sym);
    walk(inner, sym.id, true);
    return true;
  }
  return false;
}

function isAnonymousDefaultCandidate(node: Parser.SyntaxNode): boolean {
  return ANONYMOUS_DEFAULT_NODE_TYPES.has(node.type) && !getNodeName(node);
}

function makeAnonymousDefaultSymbol(
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  parentId: string | undefined,
) {
  const meta: Record<string, unknown> = {};
  if (returnsJSX(node)) meta.is_react_component = true;
  return makeSymbol(node, "default", "default_export", ctx.filePath, ctx.source, ctx.repo, {
    parentId,
    is_exported: true,
    signature: isClassNode(node) ? undefined : getSignature(node, ctx.source),
    meta: Object.keys(meta).length > 0 ? meta : undefined,
  });
}

function isClassNode(node: Parser.SyntaxNode): boolean {
  return node.type === "class" || node.type === "class_declaration" || node.type === "class_expression";
}

function walkExportChildren(
  node: Parser.SyntaxNode,
  parentId: string | undefined,
  walk: WalkNode,
): void {
  for (const child of node.namedChildren) {
    walk(child, parentId, true);
  }
}
