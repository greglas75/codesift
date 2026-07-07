import type Parser from "web-tree-sitter";
import type { SymbolKind } from "../../types.js";
import { extendsListIndicatesReactComponent } from "./typescript-react.js";
import {
  getDecorators,
  getDocstring,
  getNodeName,
  getSignature,
  hasAsyncModifier,
  hasExportModifier,
  makeSymbol,
  truncateSourceShell,
  type TypeScriptExtractorContext,
  type WalkNode,
} from "./typescript-shared.js";

function extractHeritageNames(node: Parser.SyntaxNode): string[] {
  if (node.type === "identifier") return [node.text];
  if (node.type === "type_identifier") return [node.text];
  if (node.type === "member_expression" || node.type === "nested_type_identifier") {
    return [node.text.replace(/\s+/g, "")];
  }
  if (node.type === "generic_type") {
    const innerType = node.childForFieldName("name") ?? node.namedChildren[0];
    return innerType ? extractHeritageNames(innerType) : [];
  }
  if (node.type === "intersection_type" || node.type === "union_type") {
    return node.namedChildren.flatMap((child) => extractHeritageNames(child));
  }
  return [];
}

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

function trimClassBody(node: Parser.SyntaxNode, source: string): string {
  const body = node.childForFieldName("body");
  if (!body) return source.slice(node.startIndex, node.endIndex);

  let result = source.slice(node.startIndex, body.startIndex + 1);

  for (const child of body.namedChildren) {
    if (
      child.type === "method_definition" ||
      child.type === "abstract_method_signature"
    ) {
      const methodBody = child.childForFieldName("body");
      if (methodBody) {
        result += "\n  " + source.slice(child.startIndex, methodBody.startIndex).trimEnd() + " { … }";
      } else {
        result += "\n  " + source.slice(child.startIndex, child.endIndex);
      }
    } else {
      result += "\n  " + source.slice(child.startIndex, child.endIndex);
    }
  }

  result += "\n}";
  return truncateSourceShell(result);
}

const MODIFIER_KEYWORD_TOKENS = new Set([
  "static", "abstract", "readonly", "declare", "accessor",
]);

function getModifiers(node: Parser.SyntaxNode): string[] {
  const mods: string[] = [];
  for (const child of node.children) {
    if (MODIFIER_KEYWORD_TOKENS.has(child.type)) {
      mods.push(child.type);
    } else if (child.type === "accessibility_modifier") {
      mods.push(child.text);
    } else if (child.type === "override_modifier") {
      mods.push("override");
    }
  }
  return mods;
}

function getAccessorKind(node: Parser.SyntaxNode): "get" | "set" | "accessor" | undefined {
  for (const child of node.children) {
    if (child.type === "get") return "get";
    if (child.type === "set") return "set";
    if (child.type === "accessor") return "accessor";
  }
  return undefined;
}

function ensureAbstractRecorded(modifiers: string[]): void {
  if (modifiers.includes("abstract")) return;
  if (modifiers.length === 0) modifiers.unshift("abstract");
  else modifiers.push("abstract");
}

interface ClassMemberInfo {
  decorators: string[];
  meta: Record<string, unknown>;
  isAsync: boolean;
}

function getClassMemberInfo(node: Parser.SyntaxNode, forceAbstract = false): ClassMemberInfo {
  const decorators = getDecorators(node);
  const modifiers = getModifiers(node);
  if (forceAbstract) ensureAbstractRecorded(modifiers);

  const accessorKind = getAccessorKind(node);
  const meta: Record<string, unknown> = {};
  if (modifiers.length > 0) meta.modifiers = modifiers;
  if (accessorKind) meta.accessor_kind = accessorKind;

  return {
    decorators,
    meta,
    isAsync: hasAsyncModifier(node),
  };
}

function pushMethodSymbol(
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  parentId: string | undefined,
  name: string,
  forceAbstract = false,
): void {
  const info = getClassMemberInfo(node, forceAbstract);
  ctx.symbols.push(makeSymbol(node, name, "method", ctx.filePath, ctx.source, ctx.repo, {
    parentId,
    docstring: getDocstring(node, ctx.source),
    signature: getSignature(node, ctx.source),
    decorators: info.decorators.length > 0 ? info.decorators : undefined,
    is_async: info.isAsync ? true : undefined,
    meta: Object.keys(info.meta).length > 0 ? info.meta : undefined,
  }));
}

function pushFieldSymbol(
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  parentId: string | undefined,
  name: string,
): void {
  const info = getClassMemberInfo(node);
  ctx.symbols.push(makeSymbol(node, name, "field", ctx.filePath, ctx.source, ctx.repo, {
    parentId,
    docstring: getDocstring(node, ctx.source),
    decorators: info.decorators.length > 0 ? info.decorators : undefined,
    meta: Object.keys(info.meta).length > 0 ? info.meta : undefined,
  }));
}

export function handleClassLikeDeclaration(
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  parentId: string | undefined,
  isExported: boolean,
  walk: WalkNode,
): void {
  const resolvedName = getNodeName(node);
  const name = resolvedName && resolvedName.length > 0 ? resolvedName : "<anonymous>";
  const decorators = getDecorators(node);
  const exported = isExported || hasExportModifier(node);
  const heritage = getClassHeritage(node);
  const kind = extendsListIndicatesReactComponent(heritage.extends)
    ? ("component" as SymbolKind)
    : ("class" as SymbolKind);
  const sym = makeSymbol(node, name, kind, ctx.filePath, ctx.source, ctx.repo, {
    parentId,
    docstring: getDocstring(node, ctx.source),
    decorators: decorators.length > 0 ? decorators : undefined,
    extends: heritage.extends.length > 0 ? heritage.extends : undefined,
    implements: heritage.implements.length > 0 ? heritage.implements : undefined,
    is_exported: exported ? true : undefined,
  });

  for (const child of node.namedChildren) {
    walk(child, sym.id);
  }

  sym.source = trimClassBody(node, ctx.source);
  ctx.symbols.push(sym);
}

export function handleAbstractMethodSignature(
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  parentId: string | undefined,
): void {
  const name = getNodeName(node);
  if (!name) return;
  pushMethodSymbol(ctx, node, parentId, name, true);
}

export function handleMethodDefinition(
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  parentId: string | undefined,
): void {
  const name = getNodeName(node);
  if (!name) return;
  pushMethodSymbol(ctx, node, parentId, name);
}

export function handleFieldDefinition(
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  parentId: string | undefined,
): void {
  const nameNode = node.childForFieldName("name") ?? node.childForFieldName("property");
  const name = nameNode?.text;
  if (!name) return;
  pushFieldSymbol(ctx, node, parentId, name);
}

export function handleClassStaticBlock(
  ctx: TypeScriptExtractorContext,
  node: Parser.SyntaxNode,
  parentId: string | undefined,
): void {
  ctx.symbols.push(makeSymbol(node, "<static>", "method", ctx.filePath, ctx.source, ctx.repo, {
    parentId,
    docstring: getDocstring(node, ctx.source),
  }));
}
