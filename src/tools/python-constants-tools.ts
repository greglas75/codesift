import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type Parser from "web-tree-sitter";
import type { CodeIndex, CodeSymbol } from "../types.js";
import { getParser } from "../parser/parser-manager.js";
import { resolvePythonImport, detectSrcLayout } from "../utils/python-import-resolver.js";
import { getCodeIndex } from "./index-tools.js";

export type PythonLiteralKind =
  | "string"
  | "integer"
  | "float"
  | "boolean"
  | "null"
  | "list"
  | "tuple"
  | "dict";

export interface PythonLiteralObject {
  [key: string]: PythonLiteralValue;
}

export type PythonLiteralValue =
  | string
  | number
  | boolean
  | null
  | PythonLiteralValue[]
  | PythonLiteralObject;

export interface ResolutionHop {
  name: string;
  file: string;
  line: number;
}

export interface ResolvedDefaultParameter {
  name: string;
  resolved: boolean;
  value_kind?: PythonLiteralKind;
  value?: PythonLiteralValue;
  value_text: string;
  confidence: "high" | "medium" | "low";
  alias_chain: ResolutionHop[];
  reason?: string;
}

export interface ConstantResolutionMatch {
  symbol_name: string;
  symbol_kind: CodeSymbol["kind"];
  file: string;
  line: number;
  resolved: boolean;
  value_kind?: PythonLiteralKind;
  value?: PythonLiteralValue;
  value_text?: string;
  default_parameters?: ResolvedDefaultParameter[];
  confidence: "high" | "medium" | "low";
  alias_chain: ResolutionHop[];
  reason?: string;
}

export interface ConstantResolutionResult {
  query: string;
  matches: ConstantResolutionMatch[];
}

interface AssignmentBinding {
  rhs: Parser.SyntaxNode;
  line: number;
}

interface ImportBinding {
  imported_name: string;
  source_file: string;
  line: number;
}

interface PythonFileContext {
  source: string;
  tree: Parser.Tree;
  assignments: Map<string, AssignmentBinding>;
  imports: Map<string, ImportBinding>;
}

interface EvaluationResult {
  resolved: boolean;
  value_kind?: PythonLiteralKind;
  value?: PythonLiteralValue;
  value_text: string;
  alias_chain: ResolutionHop[];
  used_import: boolean;
  reason?: string;
}

interface ResolutionState {
  index: CodeIndex;
  fileCache: Map<string, PythonFileContext | null>;
  visited: Set<string>;
  maxDepth: number;
}

const MAX_DEFAULT_DEPTH = 8;

function stripPythonString(text: string): string {
  const match = text.match(/^[rRuUbBfF]*('{3}|"{3}|'|")([\s\S]*?)\1$/);
  if (match) return match[2] ?? "";
  return text.replace(/^['"]|['"]$/g, "");
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

function unsupportedNode(node: Parser.SyntaxNode, aliasChain: ResolutionHop[], usedImport: boolean): EvaluationResult {
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

function findFunctionNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (node.type === "function_definition" || node.type === "async_function_definition") {
    return node;
  }
  for (const child of node.namedChildren) {
    const found = findFunctionNode(child);
    if (found) return found;
  }
  return null;
}

function getDefaultParameterParts(node: Parser.SyntaxNode): { name: string; valueNode: Parser.SyntaxNode } | null {
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

function getImportModule(node: Parser.SyntaxNode): { module: string; level: number } {
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

async function loadPythonFileContext(
  index: CodeIndex,
  filePath: string,
  cache: Map<string, PythonFileContext | null>,
): Promise<PythonFileContext | null> {
  const cached = cache.get(filePath);
  if (cached !== undefined) return cached;

  if (!filePath.endsWith(".py")) {
    cache.set(filePath, null);
    return null;
  }

  const parser = await getParser("python");
  if (!parser) {
    cache.set(filePath, null);
    return null;
  }

  let source: string;
  try {
    source = await readFile(join(index.root, filePath), "utf-8");
  } catch {
    cache.set(filePath, null);
    return null;
  }

  const tree = parser.parse(source);
  const files = index.files.map((entry) => entry.path);
  const srcLayout = detectSrcLayout(files);
  const assignments = new Map<string, AssignmentBinding>();
  const imports = new Map<string, ImportBinding>();

  for (const node of tree.rootNode.namedChildren) {
    if (node.type === "expression_statement") {
      const inner = node.namedChildren[0];
      if (inner?.type === "assignment") {
        const lhs = inner.childForFieldName("left");
        const rhs = inner.childForFieldName("right");
        if (lhs?.type === "identifier" && rhs) {
          assignments.set(lhs.text, {
            rhs,
            line: node.startPosition.row + 1,
          });
        }
      }
      continue;
    }

    if (node.type === "import_from_statement") {
      const { module, level } = getImportModule(node);
      const resolvedFile = resolvePythonImport({ module, level }, filePath, files, srcLayout);
      if (!resolvedFile) continue;

      for (const child of node.namedChildren) {
        if (child.type === "aliased_import") {
          const importedNode = child.namedChildren[0];
          const aliasNode = child.namedChildren[1];
          if (importedNode && aliasNode) {
            imports.set(aliasNode.text, {
              imported_name: importedNode.text,
              source_file: resolvedFile,
              line: node.startPosition.row + 1,
            });
          }
          continue;
        }

        if (child.type === "dotted_name") {
          const importedName = child.text;
          const localName = importedName.split(".").pop() ?? importedName;
          imports.set(localName, {
            imported_name: importedName,
            source_file: resolvedFile,
            line: node.startPosition.row + 1,
          });
        }
      }
    }
  }

  const context: PythonFileContext = {
    source,
    tree,
    assignments,
    imports,
  };
  cache.set(filePath, context);
  return context;
}

async function evaluateValueNode(
  filePath: string,
  node: Parser.SyntaxNode,
  state: ResolutionState,
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
    case "integer":
      return {
        resolved: true,
        value_kind: "integer",
        value: Number(node.text),
        value_text: node.text,
        alias_chain: [],
        used_import: false,
      };
    case "float":
      return {
        resolved: true,
        value_kind: "float",
        value: Number(node.text),
        value_text: node.text,
        alias_chain: [],
        used_import: false,
      };
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
      return await resolveNamedValue(filePath, node.text, state, 0);
    case "list":
    case "tuple": {
      const items: PythonLiteralValue[] = [];
      let usedImport = false;
      const aliasChain: ResolutionHop[] = [];
      for (const child of node.namedChildren) {
        const result = await evaluateValueNode(filePath, child, state);
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

        const keyResult = await evaluateValueNode(filePath, keyNode, state);
        const valueResult = await evaluateValueNode(filePath, valueNode, state);
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
      return inner ? await evaluateValueNode(filePath, inner, state) : unsupportedNode(node, [], false);
    }
    case "unary_operator": {
      const operand = node.namedChildren[0];
      if (!operand) return unsupportedNode(node, [], false);
      const inner = await evaluateValueNode(filePath, operand, state);
      if (!inner.resolved || typeof inner.value !== "number") {
        return {
          resolved: false,
          value_text: node.text,
          alias_chain: inner.alias_chain,
          used_import: inner.used_import,
          reason: inner.reason ?? `Unsupported unary operand: ${operand.text}`,
        };
      }
      if (node.text.startsWith("-")) {
        return {
          resolved: true,
          value_kind: inner.value_kind === "float" ? "float" : "integer",
          value: -inner.value,
          value_text: node.text,
          alias_chain: inner.alias_chain,
          used_import: inner.used_import,
        };
      }
      return inner;
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
      const result = await evaluateValueNode(filePath, assignment.rhs, state);
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

async function resolveConstantSymbol(
  symbol: CodeSymbol,
  state: ResolutionState,
): Promise<ConstantResolutionMatch> {
  const result = await resolveNamedValue(symbol.file, symbol.name, state, 0);
  const match: ConstantResolutionMatch = {
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

export async function resolveConstantValue(
  repo: string,
  symbolName: string,
  options?: {
    file_pattern?: string;
    max_depth?: number;
  },
): Promise<ConstantResolutionResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found.`);
  }

  const candidates = index.symbols
    .filter((symbol) => symbol.file.endsWith(".py"))
    .filter((symbol) => symbol.name === symbolName)
    .filter((symbol) => !options?.file_pattern || symbol.file.includes(options.file_pattern))
    .filter((symbol) => symbol.kind === "constant" || symbol.kind === "function" || symbol.kind === "method")
    .sort((a, b) => a.file.localeCompare(b.file) || a.start_line - b.start_line);

  const state: ResolutionState = {
    index,
    fileCache: new Map(),
    visited: new Set(),
    maxDepth: options?.max_depth ?? MAX_DEFAULT_DEPTH,
  };

  const matches: ConstantResolutionMatch[] = [];
  for (const candidate of candidates) {
    if (candidate.kind === "constant") {
      matches.push(await resolveConstantSymbol(candidate, state));
    } else {
      matches.push(await resolveFunctionDefaults(candidate, state));
    }
  }

  return {
    query: symbolName,
    matches,
  };
}
