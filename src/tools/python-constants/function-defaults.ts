import type { CodeSymbol } from "../../types.js";
import { getParser } from "../../parser/parser-manager.js";
import type {
  ConstantResolutionMatch,
  ResolvedDefaultParameter,
  ResolutionState,
} from "./model.js";
import {
  computeConfidence,
  findFunctionNode,
  getDefaultParameterParts,
} from "./syntax.js";
import { evaluateValueNode } from "./value-resolver.js";

async function resolveFunctionDefaults(
  symbol: CodeSymbol,
  state: ResolutionState,
): Promise<ConstantResolutionMatch> {
  if (!symbol.source) {
    return {
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

  const parser = await getParser("python");
  if (!parser) {
    return {
      symbol_name: symbol.name,
      symbol_kind: symbol.kind,
      file: symbol.file,
      line: symbol.start_line,
      resolved: false,
      confidence: "low",
      alias_chain: [],
      reason: "Python parser unavailable",
    };
  }

  const tree = parser.parse(symbol.source);
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
  const fnNode = findFunctionNode(tree.rootNode);
  if (!fnNode) {
    return {
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

export { resolveFunctionDefaults };
