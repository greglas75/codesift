import type { Node as TSNode } from "web-tree-sitter";
import type {
  AssignmentBinding,
  EvaluationResult,
  ImportBinding,
  PythonLiteralValue,
  ResolutionHop,
} from "./model.js";

function parsePythonString(text: string): { value: string } | { reason: string } {
  const match = text.match(/^([rRuUbBfF]*)("""|'''|"|')([\s\S]*)\2$/);
  if (!match) {
    return { reason: `Unsupported Python string literal: ${text}` };
  }

  const prefix = (match[1] ?? "").toLowerCase();
  const value = match[3] ?? "";
  if (prefix.includes("f") || prefix.includes("b")) {
    return { reason: `Unsupported Python string literal prefix: ${prefix}` };
  }
  if (prefix.includes("r")) return { value };
  if (value.includes("\\")) {
    return { reason: `Unsupported Python string literal escape sequence: ${text}` };
  }
  return { value };
}

function isObjectKey(value: PythonLiteralValue): value is string | number | boolean | null {
  return typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
    || value === null;
}

function computeConfidence(resolved: boolean, aliasChain: ResolutionHop[], usedImport: boolean): "high" | "medium" | "low" {
  if (!resolved) return usedImport || aliasChain.length > 1 ? "low" : "medium";
  if (usedImport || aliasChain.length > 2) return "medium";
  return "high";
}

function unsupportedNode(node: TSNode, aliasChain: ResolutionHop[], usedImport: boolean): EvaluationResult {
  return {
    resolved: false,
    value_text: node.text,
    alias_chain: aliasChain,
    used_import: usedImport,
    reason: `Unsupported Python value node: ${node.type}`,
  };
}

function getBindingLine(binding: AssignmentBinding | ImportBinding): number {
  return binding.line;
}

function findFunctionNode(node: TSNode): TSNode | null {
  if (node.type === "function_definition" || node.type === "async_function_definition") {
    return node;
  }
  for (const child of node.namedChildren) {
    const found = findFunctionNode(child);
    if (found) return found;
  }
  return null;
}

function getDefaultParameterParts(node: TSNode): { name: string; valueNode: TSNode } | null {
  if (node.type !== "default_parameter" && node.type !== "typed_default_parameter") {
    return null;
  }

  const children = node.namedChildren;
  if (children.length < 2) return null;

  const nameNode = children[0];
  const valueNode = children[children.length - 1];
  if (!nameNode || !valueNode) return null;

  return {
    name: nameNode.text,
    valueNode,
  };
}

function getImportModule(node: TSNode): { module: string; level: number } {
  const moduleNode = node.childForFieldName("module_name");
  if (!moduleNode) return { module: "", level: 0 };

  if (moduleNode.type === "relative_import") {
    let level = 0;
    for (let i = 0; i < moduleNode.childCount; i++) {
      const child = moduleNode.child(i);
      if (!child) continue;
      if (child.type === "import_prefix") {
        level += (child.text.match(/\./g) ?? []).length;
      } else if (child.type === ".") {
        level += 1;
      }
    }
    const dotted = moduleNode.namedChildren.find((child) => child.type === "dotted_name");
    return { module: dotted?.text ?? "", level };
  }

  return { module: moduleNode.text, level: 0 };
}

export {
  computeConfidence,
  findFunctionNode,
  getBindingLine,
  getDefaultParameterParts,
  getImportModule,
  isObjectKey,
  parsePythonString,
  unsupportedNode,
};
