import type { Node as TSNode } from "web-tree-sitter";
import { loadPythonFileContext } from "./file-context.js";
import type {
  EvaluationResult,
  PythonLiteralValue,
  ResolutionHop,
  ResolutionState,
} from "./model.js";
import {
  getBindingLine,
  isObjectKey,
  stripPythonString,
  unsupportedNode,
} from "./syntax.js";

async function evaluateValueNode(
  filePath: string,
  node: TSNode,
  state: ResolutionState,
  depth = 0,
): Promise<EvaluationResult> {
  switch (node.type) {
    case "string":
      return {
        resolved: true,
        value_kind: "string",
        value: stripPythonString(node.text),
        value_text: node.text,
        alias_chain: [],
        used_import: false,
      };
    case "integer": {
      const value = Number(node.text.replaceAll("_", ""));
      if (!Number.isSafeInteger(value)) {
        return {
          resolved: false,
          value_text: node.text,
          alias_chain: [],
          used_import: false,
          reason: `Integer literal exceeds JavaScript safe integer range: ${node.text}`,
        };
      }
      return {
        resolved: true,
        value_kind: "integer",
        value,
        value_text: node.text,
        alias_chain: [],
        used_import: false,
      };
    }
    case "float": {
      const value = Number(node.text.replaceAll("_", ""));
      if (!Number.isFinite(value)) {
        return {
          resolved: false,
          value_text: node.text,
          alias_chain: [],
          used_import: false,
          reason: `Float literal is outside the supported finite range: ${node.text}`,
        };
      }
      return {
        resolved: true,
        value_kind: "float",
        value,
        value_text: node.text,
        alias_chain: [],
        used_import: false,
      };
    }
    case "true":
      return {
        resolved: true,
        value_kind: "boolean",
        value: true,
        value_text: node.text,
        alias_chain: [],
        used_import: false,
      };
    case "false":
      return {
        resolved: true,
        value_kind: "boolean",
        value: false,
        value_text: node.text,
        alias_chain: [],
        used_import: false,
      };
    case "none":
      return {
        resolved: true,
        value_kind: "null",
        value: null,
        value_text: node.text,
        alias_chain: [],
        used_import: false,
      };
    case "identifier":
      return await resolveNamedValue(filePath, node.text, state, depth + 1);
    case "list":
    case "tuple": {
      const items: PythonLiteralValue[] = [];
      let usedImport = false;
      const aliasChain: ResolutionHop[] = [];
      for (const child of node.namedChildren) {
        const result = await evaluateValueNode(filePath, child, state, depth);
        aliasChain.push(...result.alias_chain);
        usedImport = usedImport || result.used_import;
        if (!result.resolved || result.value === undefined) {
          return {
            resolved: false,
            value_text: node.text,
            alias_chain: aliasChain,
            used_import: usedImport,
            reason: result.reason ?? `Could not resolve ${child.text}`,
          };
        }
        items.push(result.value);
      }
      return {
        resolved: true,
        value_kind: node.type === "list" ? "list" : "tuple",
        value: items,
        value_text: node.text,
        alias_chain: aliasChain,
        used_import: usedImport,
      };
    }
    case "dictionary": {
      const obj: Record<string, PythonLiteralValue> = {};
      let usedImport = false;
      const aliasChain: ResolutionHop[] = [];
      for (const pair of node.namedChildren) {
        if (pair.type !== "pair") continue;
        const keyNode = pair.namedChildren[0];
        const valueNode = pair.namedChildren[1];
        if (!keyNode || !valueNode) return unsupportedNode(node, aliasChain, usedImport);

        const keyResult = await evaluateValueNode(filePath, keyNode, state, depth);
        const valueResult = await evaluateValueNode(filePath, valueNode, state, depth);
        aliasChain.push(...keyResult.alias_chain, ...valueResult.alias_chain);
        usedImport = usedImport || keyResult.used_import || valueResult.used_import;

        if (!keyResult.resolved || keyResult.value === undefined || !isObjectKey(keyResult.value)) {
          return {
            resolved: false,
            value_text: node.text,
            alias_chain: aliasChain,
            used_import: usedImport,
            reason: keyResult.reason ?? `Unsupported dictionary key: ${keyNode.text}`,
          };
        }
        if (!valueResult.resolved || valueResult.value === undefined) {
          return {
            resolved: false,
            value_text: node.text,
            alias_chain: aliasChain,
            used_import: usedImport,
            reason: valueResult.reason ?? `Could not resolve ${valueNode.text}`,
          };
        }
        obj[String(keyResult.value)] = valueResult.value;
      }
      return {
        resolved: true,
        value_kind: "dict",
        value: obj,
        value_text: node.text,
        alias_chain: aliasChain,
        used_import: usedImport,
      };
    }
    case "parenthesized_expression": {
      const inner = node.namedChildren[0];
      return inner
        ? await evaluateValueNode(filePath, inner, state, depth)
        : unsupportedNode(node, [], false);
    }
    case "unary_operator": {
      const operand = node.namedChildren[0];
      if (!operand) return unsupportedNode(node, [], false);
      const inner = await evaluateValueNode(filePath, operand, state, depth);
      if (!inner.resolved || typeof inner.value !== "number") {
        return {
          resolved: false,
          value_text: node.text,
          alias_chain: inner.alias_chain,
          used_import: inner.used_import,
          reason: inner.reason ?? `Unsupported unary operand: ${operand.text}`,
        };
      }
      const operator = node.text.slice(0, node.text.indexOf(operand.text)).trim();
      if (operator === "-") {
        return {
          resolved: true,
          value_kind: inner.value_kind === "float" ? "float" : "integer",
          value: -inner.value,
          value_text: node.text,
          alias_chain: inner.alias_chain,
          used_import: inner.used_import,
        };
      }
      if (operator === "+") {
        return { ...inner, value_text: node.text };
      }
      if (operator === "~" && inner.value_kind === "integer") {
        const value = Number(~BigInt(inner.value));
        if (Number.isSafeInteger(value)) {
          return {
            resolved: true,
            value_kind: "integer",
            value,
            value_text: node.text,
            alias_chain: inner.alias_chain,
            used_import: inner.used_import,
          };
        }
      }
      return {
        resolved: false,
        value_text: node.text,
        alias_chain: inner.alias_chain,
        used_import: inner.used_import,
        reason: `Unsupported unary operator or operand: ${node.text}`,
      };
    }
    default:
      return unsupportedNode(node, [], false);
  }
}

async function resolveNamedValue(
  filePath: string,
  name: string,
  state: ResolutionState,
  depth: number,
): Promise<EvaluationResult> {
  if (depth > state.maxDepth) {
    return {
      resolved: false,
      value_text: name,
      alias_chain: [],
      used_import: false,
      reason: `Max resolution depth (${state.maxDepth}) exceeded`,
    };
  }

  const visitKey = `${filePath}:${name}`;
  if (state.visited.has(visitKey)) {
    return {
      resolved: false,
      value_text: name,
      alias_chain: [],
      used_import: false,
      reason: `Cycle detected while resolving ${name}`,
    };
  }

  state.visited.add(visitKey);
  try {
    const context = await loadPythonFileContext(state.index, filePath, state.fileCache);
    if (!context) {
      return {
        resolved: false,
        value_text: name,
        alias_chain: [],
        used_import: false,
        reason: `Could not load Python file context for ${filePath}`,
      };
    }

    const assignment = context.assignments.get(name);
    if (assignment) {
      const result = await evaluateValueNode(filePath, assignment.rhs, state, depth);
      return {
        ...result,
        alias_chain: [{ name, file: filePath, line: getBindingLine(assignment) }, ...result.alias_chain],
      };
    }

    const imported = context.imports.get(name);
    if (imported) {
      const result = await resolveNamedValue(imported.source_file, imported.imported_name, state, depth + 1);
      return {
        ...result,
        used_import: true,
        alias_chain: [{ name, file: filePath, line: getBindingLine(imported) }, ...result.alias_chain],
      };
    }

    return {
      resolved: false,
      value_text: name,
      alias_chain: [],
      used_import: false,
      reason: `No resolvable binding found for ${name} in ${filePath}`,
    };
  } finally {
    state.visited.delete(visitKey);
  }
}

export { evaluateValueNode, resolveNamedValue };
