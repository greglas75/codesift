import type { Node as TSNode } from "web-tree-sitter";
import { stripActionQuotes, walkAll } from "./ast.js";

export function isZObjectCall(call: TSNode): boolean {
  if (call.type !== "call_expression") return false;
  const callable = call.childForFieldName("function");
  if (!callable || callable.type !== "member_expression") return false;
  return callable.childForFieldName("object")?.text === "z"
    && callable.childForFieldName("property")?.text === "object";
}

function isFileInstanceCall(node: TSNode): boolean {
  if (node.type !== "call_expression") return false;
  const callable = node.childForFieldName("function");
  if (!callable || callable.type !== "member_expression") return false;
  if (callable.childForFieldName("object")?.text !== "z") return false;
  if (callable.childForFieldName("property")?.text !== "instanceof") return false;
  return node.childForFieldName("arguments")?.namedChildren[0]?.text === "File";
}

function containsFileField(value: TSNode): boolean {
  let found = false;
  walkAll(value, (node) => {
    if (!found && isFileInstanceCall(node)) found = true;
  });
  return found;
}

export function extractZodObjectFields(zodCall: TSNode): {
  fields: string[];
  hasFileField: boolean;
} {
  const fields: string[] = [];
  let hasFileField = false;
  const args = zodCall.childForFieldName("arguments");
  const objectNode = args?.namedChildren.find((node) => node.type === "object");
  if (!objectNode) return { fields, hasFileField };

  for (const pair of objectNode.namedChildren) {
    if (pair.type !== "pair") continue;
    const key = pair.childForFieldName("key");
    const value = pair.childForFieldName("value");
    if (!key) continue;
    fields.push(stripActionQuotes(key.text));
    if (value && containsFileField(value)) hasFileField = true;
  }
  return { fields, hasFileField };
}
