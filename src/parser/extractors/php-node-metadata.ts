import type { Node as TSNode } from "web-tree-sitter";
import { parsePhpDocVar } from "./php-doc.js";

export type PhpModifiers = {
  visibility?: "public" | "private" | "protected";
  is_static?: boolean;
  is_abstract?: boolean;
  is_final?: boolean;
  is_readonly?: boolean;
};

export type PhpAttribute = { name: string; args?: string };

type BooleanModifier = Exclude<keyof PhpModifiers, "visibility">;

const MODIFIER_TYPE_FLAGS: Partial<Record<string, BooleanModifier>> = {
  static_modifier: "is_static",
  abstract_modifier: "is_abstract",
  final_modifier: "is_final",
  readonly_modifier: "is_readonly",
};

const MODIFIER_TEXT_FLAGS: Partial<Record<string, BooleanModifier>> = {
  static: "is_static",
  abstract: "is_abstract",
  final: "is_final",
  readonly: "is_readonly",
};

export function getSignature(node: TSNode, source: string): string | undefined {
  const parameters = node.childForFieldName("parameters");
  if (!parameters) return undefined;

  let signature = source.slice(parameters.startIndex, parameters.endIndex);
  const returnType = node.childForFieldName("return_type");
  if (returnType) {
    signature += `: ${source.slice(returnType.startIndex, returnType.endIndex)}`;
  }
  return signature;
}

export function collectModifiers(node: TSNode): PhpModifiers {
  const modifiers: PhpModifiers = {};
  for (const child of node.namedChildren) {
    const text = child.text.trim();
    if (child.type === "visibility_modifier") {
      if (text === "public" || text === "private" || text === "protected") {
        modifiers.visibility = text;
      }
      continue;
    }
    const flag =
      MODIFIER_TYPE_FLAGS[child.type] ??
      (child.type === "modifier" ? MODIFIER_TEXT_FLAGS[text] : undefined);
    if (flag) modifiers[flag] = true;
  }
  return modifiers;
}

function walkAttributeList(list: TSNode, attributes: PhpAttribute[]): void {
  for (const group of list.namedChildren) {
    if (group.type !== "attribute_group" && group.type !== "attribute") continue;
    const attributeNodes =
      group.type === "attribute_group"
        ? group.namedChildren.filter((child) => child.type === "attribute")
        : [group];
    for (const attribute of attributeNodes) {
      const nameNode = attribute.namedChildren.find(
        (child) => child.type === "name" || child.type === "qualified_name",
      );
      if (!nameNode) continue;
      const argumentsNode = attribute.namedChildren.find((child) => child.type === "arguments");
      const entry: PhpAttribute = { name: nameNode.text };
      if (argumentsNode) {
        entry.args = argumentsNode.text.replace(/^\(/, "").replace(/\)$/, "").trim();
      }
      attributes.push(entry);
    }
  }
}

export function parseAttributes(node: TSNode): PhpAttribute[] {
  const attributes: PhpAttribute[] = [];
  let previous = node.previousNamedSibling;
  while (previous?.type === "attribute_list") {
    walkAttributeList(previous, attributes);
    previous = previous.previousNamedSibling;
  }
  for (const child of node.namedChildren) {
    if (child.type === "attribute_list") walkAttributeList(child, attributes);
  }
  return attributes;
}

export function getPropertyName(node: TSNode): string | null {
  const property = node.namedChildren.find((child) => child.type === "property_element");
  const variable = property?.namedChildren.find((child) => child.type === "variable_name");
  const name = variable?.namedChildren.find((child) => child.type === "name");
  return name ? `$${name.text}` : null;
}

const TYPE_NODE_NAMES = new Set([
  "primitive_type",
  "named_type",
  "optional_type",
  "union_type",
  "intersection_type",
  "disjunctive_normal_form_type",
]);

export function getInlineType(node: TSNode): string | undefined {
  return node.namedChildren.find((child) => TYPE_NODE_NAMES.has(child.type))?.text.trim();
}

export function buildPropertyMeta(
  node: TSNode,
  docstring: string | undefined,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const modifiers = collectModifiers(node);
  if (modifiers.visibility) meta.visibility = modifiers.visibility;
  if (modifiers.is_static) meta.is_static = true;
  if (modifiers.is_readonly) meta.is_readonly = true;

  const inlineType = getInlineType(node);
  const docType = parsePhpDocVar(docstring);
  if (inlineType) {
    meta.type = inlineType;
    meta.type_source = "inline";
  } else if (docType) {
    meta.type = docType;
    meta.type_source = "phpdoc";
  }

  const attributes = parseAttributes(node);
  if (attributes.length > 0) meta.attributes = attributes;
  return meta;
}
