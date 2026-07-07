import type Parser from "web-tree-sitter";
import type { SymbolKind } from "../../types.js";
import { classifyReactKind } from "./typescript-react.js";
import {
  getDocstring,
  getNodeName,
  getSignature,
  makeSymbol,
  SCREAMING_CASE_RE,
  type TypeScriptExtractorContext,
} from "./typescript-shared.js";

interface CjsTarget {
  kind: "module_exports" | "exports";
  property: string | null;
}

type ModuleExportsHandler = (
  ctx: TypeScriptExtractorContext,
  rhs: Parser.SyntaxNode,
  stmt: Parser.SyntaxNode,
  parentId: string | undefined,
) => boolean;

const MODULE_EXPORT_HANDLERS: Record<string, ModuleExportsHandler> = {
  identifier: (ctx, rhs) => {
    ctx.cjsExported.add(rhs.text);
    return true;
  },
  object: (ctx, rhs, _stmt, parentId) => {
    recordObjectModuleExports(ctx, rhs, parentId);
    return true;
  },
  arrow_function: emitDefaultCjsExport,
  function_expression: emitDefaultCjsExport,
  class_expression: emitDefaultCjsExport,
};

function parseCjsLhs(
  lhs: Parser.SyntaxNode,
): CjsTarget | null {
  if (lhs.type !== "member_expression") return null;
  const obj = lhs.childForFieldName("object");
  const prop = lhs.childForFieldName("property");
  if (!obj || !prop) return null;
  return parseDirectCjsTarget(obj, prop) ?? parseNestedModuleExportsTarget(obj, prop);
}

function parseDirectCjsTarget(obj: Parser.SyntaxNode, prop: Parser.SyntaxNode): CjsTarget | null {
  if (obj.type === "identifier" && obj.text === "exports") {
    return { kind: "exports", property: prop.text };
  }
  if (obj.type === "identifier" && obj.text === "module" && prop.text === "exports") {
    return { kind: "module_exports", property: null };
  }
  return null;
}

function parseNestedModuleExportsTarget(obj: Parser.SyntaxNode, prop: Parser.SyntaxNode): CjsTarget | null {
  if (obj.type !== "member_expression") return null;
  const innerObj = obj.childForFieldName("object");
  const innerProp = obj.childForFieldName("property");
  if (
    innerObj?.type === "identifier" && innerObj.text === "module" &&
    innerProp?.text === "exports"
  ) {
    return { kind: "module_exports", property: prop.text };
  }
  return null;
}

function cjsValueKind(value: Parser.SyntaxNode, name: string): SymbolKind {
  if (value.type === "arrow_function" || value.type === "function_expression") {
    return classifyReactKind(name, value);
  }
  if (value.type === "class_expression") return "class";
  if (SCREAMING_CASE_RE.test(name)) return "constant";
  return "variable";
}

export function handleCjsExport(
  ctx: TypeScriptExtractorContext,
  assign: Parser.SyntaxNode,
  stmt: Parser.SyntaxNode,
  parentId: string | undefined,
): boolean {
  const lhs = assign.childForFieldName("left");
  const rhs = assign.childForFieldName("right");
  if (!lhs || !rhs) return false;

  const target = parseCjsLhs(lhs);
  if (!target) return false;

  if (target.property) {
    return emitNamedCjsProperty(ctx, target.property, rhs, stmt, parentId);
  }

  return MODULE_EXPORT_HANDLERS[rhs.type]?.(ctx, rhs, stmt, parentId) ?? false;
}

function emitNamedCjsProperty(
  ctx: TypeScriptExtractorContext,
  name: string,
  rhs: Parser.SyntaxNode,
  stmt: Parser.SyntaxNode,
  parentId: string | undefined,
): boolean {
  ctx.symbols.push(makeSymbol(stmt, name, cjsValueKind(rhs, name), ctx.filePath, ctx.source, ctx.repo, {
    parentId,
    docstring: getDocstring(stmt, ctx.source),
    signature: isFunctionLikeValue(rhs) ? getSignature(rhs, ctx.source) : undefined,
    is_exported: true,
  }));
  ctx.cjsExported.add(name);
  return true;
}

function recordObjectModuleExports(
  ctx: TypeScriptExtractorContext,
  objectNode: Parser.SyntaxNode,
  parentId: string | undefined,
): void {
  for (const member of objectNode.namedChildren) {
    if (member.type === "shorthand_property_identifier") {
      ctx.cjsExported.add(member.text);
    } else if (member.type === "pair") {
      recordObjectPairExport(ctx, member, parentId);
    }
  }
}

function recordObjectPairExport(
  ctx: TypeScriptExtractorContext,
  member: Parser.SyntaxNode,
  parentId: string | undefined,
): void {
  const keyNode = member.childForFieldName("key");
  const valNode = member.childForFieldName("value");
  if (!keyNode || !valNode) return;

  const keyName = keyNode.text.replace(/^['"`]|['"`]$/g, "");
  if (valNode.type === "identifier") {
    ctx.cjsExported.add(valNode.text);
    ctx.cjsExported.add(keyName);
  } else if (isFunctionLikeValue(valNode)) {
    emitObjectPairFunctionExport(ctx, member, keyName, valNode, parentId);
  }
}

function emitObjectPairFunctionExport(
  ctx: TypeScriptExtractorContext,
  member: Parser.SyntaxNode,
  keyName: string,
  valNode: Parser.SyntaxNode,
  parentId: string | undefined,
): void {
  ctx.symbols.push(makeSymbol(member, keyName, classifyReactKind(keyName, valNode), ctx.filePath, ctx.source, ctx.repo, {
    parentId,
    signature: getSignature(valNode, ctx.source),
    is_exported: true,
  }));
}

function emitDefaultCjsExport(
  ctx: TypeScriptExtractorContext,
  rhs: Parser.SyntaxNode,
  stmt: Parser.SyntaxNode,
  parentId: string | undefined,
): boolean {
  ctx.symbols.push(makeSymbol(stmt, "default", "default_export", ctx.filePath, ctx.source, ctx.repo, {
    parentId,
    signature: isFunctionLikeValue(rhs) ? getSignature(rhs, ctx.source) : undefined,
    is_exported: true,
  }));
  return true;
}

function isFunctionLikeValue(value: Parser.SyntaxNode): boolean {
  return value.type === "arrow_function" || value.type === "function_expression";
}

export function extractObjectLiteralMethods(
  objectNode: Parser.SyntaxNode,
  parentId: string,
  ctx: TypeScriptExtractorContext,
): void {
  for (const child of objectNode.namedChildren) {
    if (child.type === "method_definition") {
      const methodName = getNodeName(child);
      if (!methodName) continue;
      ctx.symbols.push(makeSymbol(child, methodName, "method", ctx.filePath, ctx.source, ctx.repo, {
        parentId,
        signature: getSignature(child, ctx.source),
      }));
      continue;
    }
    if (child.type === "pair") {
      const keyNode = child.childForFieldName("key");
      const valNode = child.childForFieldName("value");
      if (!keyNode || !valNode) continue;
      if (valNode.type !== "arrow_function" && valNode.type !== "function_expression") continue;
      const methodName = keyNode.text.replace(/^['"`]|['"`]$/g, "");
      const kind = classifyReactKind(methodName, valNode);
      ctx.symbols.push(makeSymbol(child, methodName, kind === "function" ? "method" : kind, ctx.filePath, ctx.source, ctx.repo, {
        parentId,
        signature: getSignature(valNode, ctx.source),
      }));
    }
  }
}
