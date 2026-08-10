import type { Node as TSNode } from "web-tree-sitter";
import type { CodeSymbol } from "../../types.js";
import type {
  ConstantResolutionMatch,
  ResolvedDefaultParameter,
} from "../python-constants-tools.js";
import type { ResolutionState } from "./types.js";
import {
  computeConfidence,
  evaluateValueNode,
  resolveNamedValue,
} from "./value-evaluator.js";

function findCallableNode(node: TSNode): TSNode | null {
  if (node.type === "function_declaration" || node.type === "arrow_function" || node.type === "method_definition") {
    return node;
  }
  for (const child of node.namedChildren) {
    const found = findCallableNode(child);
    if (found) return found;
  }
  return null;
}

function getDefaultParameterParts(node: TSNode): { name: string; valueNode: TSNode } | null {
  if (node.type !== "required_parameter" && node.type !== "optional_parameter") {
    return null;
  }
  if (!node.text.includes("=")) return null;

  const children = node.namedChildren;
  if (children.length < 2) return null;

  const nameNode = children[0];
  const valueNode = children[children.length - 1];
  if (!nameNode || !valueNode || nameNode.type !== "identifier") return null;

  return {
    name: nameNode.text,
    valueNode,
  };
}

async function resolveConstantSymbol(
  symbol: CodeSymbol,
  state: ResolutionState,
): Promise<ConstantResolutionMatch> {
  const result = await resolveNamedValue(symbol.file, symbol.name, state, 0);
  const match: ConstantResolutionMatch = {
    language: "typescript",
    symbol_name: symbol.name,
    symbol_kind: symbol.kind,
    file: symbol.file,
    line: symbol.start_line,
    resolved: result.resolved,
    value_text: result.value_text,
    confidence: computeConfidence(result.resolved, result.alias_chain, result.used_import),
    alias_chain: result.alias_chain,
  };
  if (result.value_kind !== undefined) match.value_kind = result.value_kind;
  if (result.value !== undefined) match.value = result.value;
  if (result.reason !== undefined) match.reason = result.reason;
  return match;
}

async function resolveFunctionDefaults(
  symbol: CodeSymbol,
  state: ResolutionState,
): Promise<ConstantResolutionMatch> {
  if (!symbol.source) {
    return {
      language: "typescript",
      symbol_name: symbol.name,
      symbol_kind: symbol.kind,
      file: symbol.file,
      line: symbol.start_line,
      resolved: false,
      confidence: "low",
      alias_chain: [],
      reason: `No source captured for ${symbol.name}`,
    };
  }

  const tree = state.parser.parse(symbol.source);
  if (!tree) {
    return {
      symbol_name: symbol.name,
      symbol_kind: symbol.kind,
      file: symbol.file,
      line: symbol.start_line,
      resolved: false,
      confidence: "low",
      alias_chain: [],
      reason: `Could not parse source for ${symbol.name}`,
    };
  }
  const fnNode = findCallableNode(tree.rootNode);
  if (!fnNode) {
    return {
      language: "typescript",
      symbol_name: symbol.name,
      symbol_kind: symbol.kind,
      file: symbol.file,
      line: symbol.start_line,
      resolved: false,
      confidence: "low",
      alias_chain: [],
      reason: `Could not parse function defaults for ${symbol.name}`,
    };
  }

  const params = fnNode.childForFieldName("parameters");
  const defaultParameters: ResolvedDefaultParameter[] = [];

  if (params) {
    for (const child of params.namedChildren) {
      const parts = getDefaultParameterParts(child);
      if (!parts) continue;
      const result = await evaluateValueNode(symbol.file, parts.valueNode, state);
      const entry: ResolvedDefaultParameter = {
        name: parts.name,
        resolved: result.resolved,
        value_text: result.value_text,
        confidence: computeConfidence(result.resolved, result.alias_chain, result.used_import),
        alias_chain: result.alias_chain,
      };
      if (result.value_kind !== undefined) entry.value_kind = result.value_kind;
      if (result.value !== undefined) entry.value = result.value;
      if (result.reason !== undefined) entry.reason = result.reason;
      defaultParameters.push(entry);
    }
  }

  const resolved = defaultParameters.length > 0 && defaultParameters.every((entry) => entry.resolved);
  const flattenedChain = defaultParameters.flatMap((entry) => entry.alias_chain);

  const match: ConstantResolutionMatch = {
    language: "typescript",
    symbol_name: symbol.name,
    symbol_kind: symbol.kind,
    file: symbol.file,
    line: symbol.start_line,
    resolved,
    default_parameters: defaultParameters,
    confidence: computeConfidence(
      resolved,
      flattenedChain,
      defaultParameters.some((entry) => entry.alias_chain.length > 0 && entry.confidence !== "high"),
    ),
    alias_chain: flattenedChain,
  };
  if (defaultParameters.length === 0) {
    match.reason = "Function has no default parameters";
  }
  return match;
}

export {
  resolveConstantSymbol,
  resolveFunctionDefaults,
};
