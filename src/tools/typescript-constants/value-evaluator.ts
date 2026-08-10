import type { Node as TSNode } from "web-tree-sitter";
import type {
  PythonLiteralValue,
  ResolutionHop,
} from "../python-constants-tools.js";
import {
  loadTypeScriptFileContext,
  stripTypeScriptString,
} from "./file-context.js";
import type {
  AssignmentBinding,
  DefaultExportBinding,
  EvaluationResult,
  ImportBinding,
  ResolutionState,
} from "./types.js";

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
    reason: `Unsupported TypeScript value node: ${node.type}`,
  };
}

function getBindingLine(binding: AssignmentBinding | ImportBinding | DefaultExportBinding): number {
  return binding.line;
}

function isStaticTemplateString(node: TSNode): boolean {
  return node.type === "template_string"
    && !node.namedChildren.some((child) => child.type === "template_substitution");
}

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
        value: stripTypeScriptString(node.text),
        value_text: node.text,
        alias_chain: [],
        used_import: false,
      };
    case "template_string": {
      if (isStaticTemplateString(node)) {
        return {
          resolved: true,
          value_kind: "string",
          value: stripTypeScriptString(node.text),
          value_text: node.text,
          alias_chain: [],
          used_import: false,
        };
      }
      return unsupportedNode(node, [], false);
    }
    case "number": {
      const raw = node.text;
      const n = Number(raw.replaceAll("_", ""));
      if (!Number.isFinite(n)) {
        return {
          resolved: false,
          value_text: raw,
          alias_chain: [],
          used_import: false,
          reason: `Unsupported numeric literal: ${raw}`,
        };
      }
      const isFloat = raw.includes(".") || raw.includes("e") || raw.includes("E");
      if (!isFloat && !Number.isSafeInteger(n)) {
        return {
          resolved: false,
          value_text: raw,
          alias_chain: [],
          used_import: false,
          reason: "Integer literal outside safe Number range",
        };
      }
      return {
        resolved: true,
        value_kind: isFloat ? "float" : "integer",
        value: n,
        value_text: raw,
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
    case "null":
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
    case "array": {
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
        value_kind: "list",
        value: items,
        value_text: node.text,
        alias_chain: aliasChain,
        used_import: usedImport,
      };
    }
    case "object": {
      const obj = Object.create(null) as Record<string, PythonLiteralValue>;
      let usedImport = false;
      const aliasChain: ResolutionHop[] = [];
      for (const pair of node.namedChildren) {
        if (pair.type !== "pair") return unsupportedNode(pair, aliasChain, usedImport);
        const keyNode = pair.namedChildren[0];
        const valueNode = pair.namedChildren[1];
        if (!keyNode || !valueNode) return unsupportedNode(node, aliasChain, usedImport);

        let keyValue: string;
        if (keyNode.type === "property_identifier") {
          keyValue = keyNode.text;
        } else {
          const keyResult = await evaluateValueNode(filePath, keyNode, state, depth);
          aliasChain.push(...keyResult.alias_chain);
          usedImport = usedImport || keyResult.used_import;
          if (!keyResult.resolved || keyResult.value === undefined || !isObjectKey(keyResult.value)) {
            return {
              resolved: false,
              value_text: node.text,
              alias_chain: aliasChain,
              used_import: usedImport,
              reason: keyResult.reason ?? `Unsupported object key: ${keyNode.text}`,
            };
          }
          keyValue = String(keyResult.value);
        }

        const valueResult = await evaluateValueNode(filePath, valueNode, state, depth);
        aliasChain.push(...valueResult.alias_chain);
        usedImport = usedImport || valueResult.used_import;
        if (!valueResult.resolved || valueResult.value === undefined) {
          return {
            resolved: false,
            value_text: node.text,
            alias_chain: aliasChain,
            used_import: usedImport,
            reason: valueResult.reason ?? `Could not resolve ${valueNode.text}`,
          };
        }
        obj[keyValue] = valueResult.value;
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
      return inner ? await evaluateValueNode(filePath, inner, state, depth) : unsupportedNode(node, [], false);
    }
    case "unary_expression": {
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
      const operator = node.childForFieldName("operator")?.type;
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
      return operator === "+" ? inner : unsupportedNode(node, inner.alias_chain, inner.used_import);
    }
    case "member_expression":
    case "subscript_expression":
      return await evaluateMemberExpression(filePath, node, state, depth);
    default:
      return unsupportedNode(node, [], false);
  }
}

async function evaluateMemberExpression(
  filePath: string,
  node: TSNode,
  state: ResolutionState,
  depth: number,
): Promise<EvaluationResult> {
  const objectNode = node.childForFieldName("object") ?? node.namedChildren[0];
  const propertyNode = node.childForFieldName("property")
    ?? node.childForFieldName("index")
    ?? node.namedChildren[1];
  if (!objectNode || !propertyNode) return unsupportedNode(node, [], false);

  let key: string;
  if (propertyNode.type === "property_identifier") {
    key = propertyNode.text;
  } else if (propertyNode.type === "string") {
    key = stripTypeScriptString(propertyNode.text);
  } else if (isStaticTemplateString(propertyNode)) {
    key = stripTypeScriptString(propertyNode.text);
  } else {
    return unsupportedNode(node, [], false);
  }

  if (objectNode.type === "identifier") {
    const context = await loadTypeScriptFileContext(state, filePath);
    const imported = context?.imports.get(objectNode.text);
    if (imported?.kind === "namespace") {
      const result = await resolveNamedValue(imported.source_file, key, state, depth + 1);
      return {
        ...result,
        used_import: true,
        alias_chain: [{ name: node.text, file: filePath, line: node.startPosition.row + 1 }, ...result.alias_chain],
      };
    }
  }

  const objectResult = await evaluateValueNode(filePath, objectNode, state, depth);
  if (!objectResult.resolved || typeof objectResult.value !== "object" || objectResult.value === null || Array.isArray(objectResult.value)) {
    return {
      resolved: false,
      value_text: node.text,
      alias_chain: objectResult.alias_chain,
      used_import: objectResult.used_import,
      reason: objectResult.reason ?? `Could not resolve ${objectNode.text}`,
    };
  }

  const resolvedObject = objectResult.value as Record<string, PythonLiteralValue>;
  if (!Object.hasOwn(resolvedObject, key)) {
    return {
      resolved: false,
      value_text: node.text,
      alias_chain: objectResult.alias_chain,
      used_import: objectResult.used_import,
      reason: `Property ${key} not found on resolved object`,
    };
  }
  const propertyValue = resolvedObject[key] as PythonLiteralValue;

  const valueKind = Array.isArray(propertyValue)
    ? "list"
    : propertyValue === null
      ? "null"
      : typeof propertyValue === "string"
        ? "string"
        : typeof propertyValue === "number"
          ? Number.isInteger(propertyValue) ? "integer" : "float"
          : typeof propertyValue === "boolean"
            ? "boolean"
            : "dict";

  return {
    resolved: true,
    value_kind: valueKind,
    value: propertyValue,
    value_text: node.text,
    alias_chain: [...objectResult.alias_chain, { name: node.text, file: filePath, line: node.startPosition.row + 1 }],
    used_import: objectResult.used_import,
  };
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
    const context = await loadTypeScriptFileContext(state, filePath);
    if (!context) {
      return {
        resolved: false,
        value_text: name,
        alias_chain: [],
        used_import: false,
        reason: `Could not load TypeScript file context for ${filePath}`,
      };
    }

    if (name === "default" && context.default_export) {
      if (context.default_export.name) {
        const result = await resolveNamedValue(filePath, context.default_export.name, state, depth + 1);
        return {
          ...result,
          alias_chain: [{ name: "default", file: filePath, line: getBindingLine(context.default_export) }, ...result.alias_chain],
        };
      }
      if (context.default_export.node) {
        const result = await evaluateValueNode(filePath, context.default_export.node, state, depth);
        return {
          ...result,
          alias_chain: [{ name: "default", file: filePath, line: getBindingLine(context.default_export) }, ...result.alias_chain],
        };
      }
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
      if (imported.kind === "namespace") {
        return {
          resolved: false,
          value_text: name,
          alias_chain: [{ name, file: filePath, line: getBindingLine(imported) }],
          used_import: true,
          reason: `Namespace import ${name} requires property access to resolve`,
        };
      }

      const targetName = imported.kind === "default" ? "default" : imported.imported_name;
      if (!targetName) {
        return {
          resolved: false,
          value_text: name,
          alias_chain: [{ name, file: filePath, line: getBindingLine(imported) }],
          used_import: true,
          reason: `Missing imported name for ${name}`,
        };
      }

      const result = await resolveNamedValue(imported.source_file, targetName, state, depth + 1);
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

export {
  computeConfidence,
  evaluateValueNode,
  resolveNamedValue,
};
