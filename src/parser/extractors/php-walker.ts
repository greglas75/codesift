import type { Node as TSNode, Tree as TSTree } from "web-tree-sitter";
import type { CodeSymbol, SymbolKind } from "../../types.js";
import { getNodeName, makeSymbol } from "./_shared.js";
import {
  classifyMethod,
  collectClassExtends,
  collectClassImplements,
  collectTraitUses,
  isTestCaseClass,
} from "./php-class-metadata.js";
import { getDocstring } from "./php-doc.js";
import {
  buildPropertyMeta,
  collectModifiers,
  getPropertyName,
  getSignature,
  parseAttributes,
} from "./php-node-metadata.js";
import {
  emitPromotedConstructorFields,
  type PhpExtractionContext,
  synthesizeDocstringTags,
} from "./php-symbol-builders.js";

type WalkState = {
  parentId?: string;
  parentIsTest: boolean;
};

function symbolOptions(
  parentId: string | undefined,
  docstring: string | undefined,
  meta: Record<string, unknown>,
): NonNullable<Parameters<typeof makeSymbol>[6]> {
  const options: NonNullable<Parameters<typeof makeSymbol>[6]> = { parentId, docstring };
  if (Object.keys(meta).length > 0) options.meta = meta;
  return options;
}

function walkChildren(
  context: PhpExtractionContext,
  node: TSNode,
  state: WalkState,
): void {
  for (const child of node.namedChildren) walkNode(context, child, state);
}

function handleNamespace(
  context: PhpExtractionContext,
  node: TSNode,
  state: WalkState,
): void {
  const name = node.childForFieldName("name")?.text ?? "<anonymous>";
  const symbol = makeSymbol(
    node,
    name,
    "namespace",
    context.filePath,
    context.source,
    context.repo,
    { parentId: state.parentId },
  );
  context.symbols.push(symbol);
  const body = node.childForFieldName("body");
  if (body) walkChildren(context, body, { parentId: symbol.id, parentIsTest: false });
}

function classOptions(
  node: TSNode,
  state: WalkState,
  docstring: string | undefined,
  body: TSNode | null,
): NonNullable<Parameters<typeof makeSymbol>[6]> {
  const modifiers = collectModifiers(node);
  const meta: Record<string, unknown> = {};
  if (modifiers.is_abstract) meta.is_abstract = true;
  if (modifiers.is_final) meta.is_final = true;
  if (modifiers.is_readonly) meta.is_readonly = true;
  const traitUses = collectTraitUses(body);
  if (traitUses.length > 0) meta.uses_traits = traitUses;
  const attributes = parseAttributes(node);
  if (attributes.length > 0) meta.attributes = attributes;

  const options = symbolOptions(state.parentId, docstring, meta);
  const extendsList = collectClassExtends(node);
  const implementsList = collectClassImplements(node);
  if (extendsList.length > 0) options.extends = extendsList;
  if (implementsList.length > 0) options.implements = implementsList;
  return options;
}

function handleClass(
  context: PhpExtractionContext,
  node: TSNode,
  state: WalkState,
): void {
  const isTest = isTestCaseClass(node);
  const docstring = getDocstring(node, context.source);
  const body = node.childForFieldName("body");
  const kind: SymbolKind = isTest ? "test_suite" : "class";
  const symbol = makeSymbol(
    node,
    getNodeName(node) ?? "<anonymous>",
    kind,
    context.filePath,
    context.source,
    context.repo,
    classOptions(node, state, docstring, body),
  );
  context.symbols.push(symbol);
  if (body) walkChildren(context, body, { parentId: symbol.id, parentIsTest: isTest });
  synthesizeDocstringTags(context, node, symbol, docstring);
}

function interfaceOptions(
  node: TSNode,
  state: WalkState,
  docstring: string | undefined,
): NonNullable<Parameters<typeof makeSymbol>[6]> {
  const attributes = parseAttributes(node);
  const meta: Record<string, unknown> = {};
  if (attributes.length > 0) meta.attributes = attributes;
  const options = symbolOptions(state.parentId, docstring, meta);
  const extendsList = collectClassExtends(node);
  if (extendsList.length > 0) options.extends = extendsList;
  return options;
}

function handleInterface(
  context: PhpExtractionContext,
  node: TSNode,
  state: WalkState,
): void {
  const docstring = getDocstring(node, context.source);
  const symbol = makeSymbol(
    node,
    getNodeName(node) ?? "<anonymous>",
    "interface",
    context.filePath,
    context.source,
    context.repo,
    interfaceOptions(node, state, docstring),
  );
  context.symbols.push(symbol);
  const body = node.childForFieldName("body");
  if (body) walkChildren(context, body, { parentId: symbol.id, parentIsTest: false });
  synthesizeDocstringTags(context, node, symbol, docstring);
}

function traitMeta(node: TSNode, body: TSNode | null): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const traitUses = collectTraitUses(body);
  if (traitUses.length > 0) meta.uses_traits = traitUses;
  const attributes = parseAttributes(node);
  if (attributes.length > 0) meta.attributes = attributes;
  return meta;
}

function handleTrait(
  context: PhpExtractionContext,
  node: TSNode,
  state: WalkState,
): void {
  const docstring = getDocstring(node, context.source);
  const body = node.childForFieldName("body");
  const symbol = makeSymbol(
    node,
    getNodeName(node) ?? "<anonymous>",
    "type",
    context.filePath,
    context.source,
    context.repo,
    symbolOptions(state.parentId, docstring, traitMeta(node, body)),
  );
  context.symbols.push(symbol);
  if (body) walkChildren(context, body, { parentId: symbol.id, parentIsTest: false });
  synthesizeDocstringTags(context, node, symbol, docstring);
}

function getEnumBackingType(node: TSNode): string | undefined {
  return node.namedChildren
    .find((child) => child.type === "primitive_type")
    ?.text.trim();
}

function enumOptions(
  context: PhpExtractionContext,
  node: TSNode,
  state: WalkState,
): NonNullable<Parameters<typeof makeSymbol>[6]> {
  const meta: Record<string, unknown> = {};
  const backingType = getEnumBackingType(node);
  if (backingType) meta.backed_type = backingType;
  const attributes = parseAttributes(node);
  if (attributes.length > 0) meta.attributes = attributes;
  const options = symbolOptions(state.parentId, getDocstring(node, context.source), meta);
  const implementsList = collectClassImplements(node);
  if (implementsList.length > 0) options.implements = implementsList;
  return options;
}

function enumBody(node: TSNode): TSNode | null {
  return (
    node.childForFieldName("body") ??
    node.namedChildren.find((child) => child.type === "enum_declaration_list") ??
    null
  );
}

function handleEnum(
  context: PhpExtractionContext,
  node: TSNode,
  state: WalkState,
): void {
  const symbol = makeSymbol(
    node,
    getNodeName(node) ?? "<anonymous>",
    "enum",
    context.filePath,
    context.source,
    context.repo,
    enumOptions(context, node, state),
  );
  context.symbols.push(symbol);
  const body = enumBody(node);
  if (body) walkChildren(context, body, { parentId: symbol.id, parentIsTest: false });
}

function handleFunction(
  context: PhpExtractionContext,
  node: TSNode,
  state: WalkState,
): void {
  const name = getNodeName(node);
  if (!name) return;
  context.symbols.push(
    makeSymbol(node, name, "function", context.filePath, context.source, context.repo, {
      parentId: state.parentId,
      docstring: getDocstring(node, context.source),
      signature: getSignature(node, context.source),
    }),
  );
}

function methodOptions(
  context: PhpExtractionContext,
  node: TSNode,
  state: WalkState,
  docstring: string | undefined,
): NonNullable<Parameters<typeof makeSymbol>[6]> {
  const modifiers = collectModifiers(node);
  const attributes = parseAttributes(node);
  const meta: Record<string, unknown> = {};
  if (modifiers.visibility) meta.visibility = modifiers.visibility;
  if (modifiers.is_static) meta.is_static = true;
  if (modifiers.is_abstract) meta.is_abstract = true;
  if (modifiers.is_final) meta.is_final = true;
  if (attributes.length > 0) meta.attributes = attributes;
  const options = symbolOptions(state.parentId, docstring, meta);
  options.signature = getSignature(node, context.source);
  return options;
}

function handleMethod(
  context: PhpExtractionContext,
  node: TSNode,
  state: WalkState,
): void {
  const name = getNodeName(node);
  if (!name) return;
  const docstring = getDocstring(node, context.source);
  context.symbols.push(
    makeSymbol(
      node,
      name,
      classifyMethod(name, state.parentIsTest, docstring),
      context.filePath,
      context.source,
      context.repo,
      methodOptions(context, node, state, docstring),
    ),
  );
  if (name === "__construct" && state.parentId) {
    emitPromotedConstructorFields(context, node, state.parentId);
  }
}

function handleProperty(
  context: PhpExtractionContext,
  node: TSNode,
  state: WalkState,
): void {
  const name = getPropertyName(node);
  if (!name) return;
  const docstring = getDocstring(node, context.source);
  const meta = buildPropertyMeta(node, docstring);
  context.symbols.push(
    makeSymbol(
      node,
      name,
      "field",
      context.filePath,
      context.source,
      context.repo,
      symbolOptions(state.parentId, docstring, meta),
    ),
  );
}

function handleConstants(
  context: PhpExtractionContext,
  node: TSNode,
  state: WalkState,
): void {
  for (const element of node.namedChildren) {
    if (element.type !== "const_element") continue;
    const name = element.namedChildren.find((child) => child.type === "name")?.text;
    if (!name) continue;
    context.symbols.push(
      makeSymbol(element, name, "constant", context.filePath, context.source, context.repo, {
        parentId: state.parentId,
        docstring: getDocstring(node, context.source),
      }),
    );
  }
}

function handleEnumCase(
  context: PhpExtractionContext,
  node: TSNode,
  state: WalkState,
): void {
  const name = getNodeName(node);
  if (!name) return;
  context.symbols.push(
    makeSymbol(node, name, "constant", context.filePath, context.source, context.repo, {
      parentId: state.parentId,
    }),
  );
}

type NodeHandler = (
  context: PhpExtractionContext,
  node: TSNode,
  state: WalkState,
) => void;

const NODE_HANDLERS: Partial<Record<string, NodeHandler>> = {
  namespace_definition: handleNamespace,
  class_declaration: handleClass,
  interface_declaration: handleInterface,
  trait_declaration: handleTrait,
  enum_declaration: handleEnum,
  function_definition: handleFunction,
  method_declaration: handleMethod,
  property_declaration: handleProperty,
  const_declaration: handleConstants,
  enum_case: handleEnumCase,
};

function walkNode(context: PhpExtractionContext, node: TSNode, state: WalkState): void {
  const handler = NODE_HANDLERS[node.type];
  if (handler) {
    handler(context, node, state);
    return;
  }
  walkChildren(context, node, state);
}

export function extractPhpSymbols(
  tree: TSTree,
  filePath: string,
  source: string,
  repo: string,
): CodeSymbol[] {
  const context: PhpExtractionContext = { symbols: [], filePath, source, repo };
  walkNode(context, tree.rootNode, { parentIsTest: false });
  return context.symbols;
}
