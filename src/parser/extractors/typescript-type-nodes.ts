import type Parser from "web-tree-sitter";
import {
  getDocstring,
  getNodeName,
  hasExportModifier,
  makeSymbol,
  type TypeScriptExtractorContext,
} from "./typescript-shared.js";

export function handleInterfaceDeclaration(
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  parentId: string | undefined,
  isExported: boolean,
): void {
  emitNamedTypeSymbol(ctx, node, parentId, isExported, "interface");
}

export function handleTypeAliasDeclaration(
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  parentId: string | undefined,
  isExported: boolean,
): void {
  emitNamedTypeSymbol(ctx, node, parentId, isExported, "type");
}

function emitNamedTypeSymbol(
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  parentId: string | undefined,
  isExported: boolean,
  kind: "interface" | "type",
): void {
  const name = getNodeName(node);
  if (!name) return;

  const exported = isExported || hasExportModifier(node);
  ctx.symbols.push(makeSymbol(node, name, kind, ctx.filePath, ctx.source, ctx.repo, {
    parentId,
    docstring: getDocstring(node, ctx.source),
    is_exported: exported ? true : undefined,
  }));
}

export function handleEnumDeclaration(
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  parentId: string | undefined,
  isExported: boolean,
): void {
  const name = getNodeName(node);
  if (!name) return;

  const exported = isExported || hasExportModifier(node);
  const sym = makeSymbol(node, name, "enum", ctx.filePath, ctx.source, ctx.repo, {
    parentId,
    docstring: getDocstring(node, ctx.source),
    is_exported: exported ? true : undefined,
  });
  ctx.symbols.push(sym);

  const body = node.childForFieldName("body");
  if (!body) return;
  for (const child of body.namedChildren) {
    let memberName: string | null = null;
    if (child.type === "enum_assignment") {
      memberName = getNodeName(child);
    } else if (child.type === "property_identifier") {
      memberName = child.text;
    }
    if (memberName) {
      ctx.symbols.push(makeSymbol(child, memberName, "constant", ctx.filePath, ctx.source, ctx.repo, {
        parentId: sym.id,
      }));
    }
  }
}
