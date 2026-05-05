import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type Parser from "web-tree-sitter";
import type { CodeIndex, CodeSymbol } from "../types.js";
import { getParser } from "../parser/parser-manager.js";
import { buildNormalizedPathMap, resolveImportPath } from "../utils/import-graph.js";
import { getCodeIndex } from "./index-tools.js";
import { matchesConstantFilePattern } from "../utils/constant-file-pattern.js";
import type {
  ConstantResolutionMatch,
  ConstantResolutionResult,
  PythonLiteralKind,
  PythonLiteralValue,
  ResolutionHop,
  ResolvedDefaultParameter,
} from "./python-constants-tools.js";

interface AssignmentBinding {
  rhs: Parser.SyntaxNode;
  line: number;
}

interface ImportBinding {
  kind: "named" | "default" | "namespace";
  source_file: string;
  imported_name?: string;
  line: number;
}

interface DefaultExportBinding {
  name?: string;
  node?: Parser.SyntaxNode;
  line: number;
}

interface TypeScriptFileContext {
  source: string;
  tree: Parser.Tree;
  assignments: Map<string, AssignmentBinding>;
  imports: Map<string, ImportBinding>;
  default_export?: DefaultExportBinding;
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
  parser: Parser;
  fileCache: Map<string, TypeScriptFileContext | null>;
  normalizedPathMap: Map<string, string>;
  visited: Set<string>;
  maxDepth: number;
}

const MAX_DEFAULT_DEPTH = 8;
const MAX_TS_RESOLVER_FILE_CACHE = 128;

function trimResolverFileCache(cache: Map<string, TypeScriptFileContext | null>): void {
  while (cache.size > MAX_TS_RESOLVER_FILE_CACHE) {
    const first = cache.keys().next().value as string | undefined;
    if (first === undefined) break;
    cache.delete(first);
  }
}

function isTypeScriptFile(filePath: string): boolean {
  return filePath.endsWith(".ts") || filePath.endsWith(".tsx");
}

function stripTypeScriptString(text: string): string {
  const match = text.match(/^(['"`])([\s\S]*)\1$/);
  if (match) return match[2] ?? "";
  return text;
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
    reason: `Unsupported TypeScript value node: ${node.type}`,
  };
}

function getBindingLine(binding: AssignmentBinding | ImportBinding | DefaultExportBinding): number {
  return binding.line;
}

function getStringLiteralText(node: Parser.SyntaxNode): string {
  const fragment = node.namedChildren.find((child) => child.type === "string_fragment");
  if (fragment) return fragment.text;
  return stripTypeScriptString(node.text);
}

function collectVariableDeclarators(
  node: Parser.SyntaxNode,
  assignments: Map<string, AssignmentBinding>,
): void {
  for (const child of node.namedChildren) {
    if (child.type !== "variable_declarator") continue;
    const nameNode = child.childForFieldName("name") ?? child.namedChildren[0];
    const valueNode = child.childForFieldName("value") ?? child.namedChildren[1];
    if (!nameNode || !valueNode || nameNode.type !== "identifier") continue;
    assignments.set(nameNode.text, {
      rhs: valueNode,
      line: child.startPosition.row + 1,
    });
  }
}

function collectImportBindings(
  node: Parser.SyntaxNode,
  importerFile: string,
  normalizedPaths: Map<string, string>,
  imports: Map<string, ImportBinding>,
): void {
  const stringNode = node.namedChildren.find((child) => child.type === "string");
  if (!stringNode) return;

  const rawPath = getStringLiteralText(stringNode);
  if (!rawPath.startsWith(".")) return;

  const normalized = resolveImportPath(importerFile, rawPath);
  const resolvedFile = normalizedPaths.get(normalized);
  if (!resolvedFile || !isTypeScriptFile(resolvedFile)) return;

  const importClause = node.namedChildren.find((child) => child.type === "import_clause");
  if (!importClause) return;

  for (const child of importClause.namedChildren) {
    if (child.type === "identifier") {
      imports.set(child.text, {
        kind: "default",
        source_file: resolvedFile,
        line: node.startPosition.row + 1,
      });
      continue;
    }

    if (child.type === "named_imports") {
      for (const specifier of child.namedChildren) {
        if (specifier.type !== "import_specifier") continue;
        const importedNode = specifier.namedChildren[0];
        const localNode = specifier.namedChildren[1] ?? importedNode;
        if (!importedNode || !localNode || localNode.type !== "identifier" || importedNode.type !== "identifier") continue;
        imports.set(localNode.text, {
          kind: "named",
          imported_name: importedNode.text,
          source_file: resolvedFile,
          line: node.startPosition.row + 1,
        });
      }
      continue;
    }

    if (child.type === "namespace_import") {
      const localNode = child.namedChildren.find((entry) => entry.type === "identifier");
      if (!localNode) continue;
      imports.set(localNode.text, {
        kind: "namespace",
        source_file: resolvedFile,
        line: node.startPosition.row + 1,
      });
    }
  }
}

function extractDefaultExport(node: Parser.SyntaxNode): DefaultExportBinding | undefined {
  if (!node.text.startsWith("export default")) return undefined;

  const inner = node.namedChildren[0];
  if (!inner) {
    return {
      line: node.startPosition.row + 1,
    };
  }

  if (inner.type === "function_declaration" || inner.type === "class_declaration") {
    const nameNode = inner.childForFieldName("name") ?? inner.namedChildren[0];
    if (nameNode?.type === "identifier") {
      return {
        name: nameNode.text,
        line: node.startPosition.row + 1,
      };
    }
  }

  if (inner.type === "lexical_declaration") {
    const declarator = inner.namedChildren.find((child) => child.type === "variable_declarator");
    const nameNode = declarator?.childForFieldName("name") ?? declarator?.namedChildren[0];
    if (nameNode?.type === "identifier") {
      return {
        name: nameNode.text,
        line: node.startPosition.row + 1,
      };
    }
  }

  return {
    node: inner,
    line: node.startPosition.row + 1,
  };
}

async function loadTypeScriptFileContext(
  state: ResolutionState,
  filePath: string,
): Promise<TypeScriptFileContext | null> {
  const cache = state.fileCache;
  const cached = cache.get(filePath);
  if (cached !== undefined) return cached;

  if (!isTypeScriptFile(filePath)) {
    cache.set(filePath, null);
    return null;
  }

  let source: string;
  try {
    source = await readFile(join(state.index.root, filePath), "utf-8");
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err
      ? String((err as NodeJS.ErrnoException).code)
      : "";
    if (code !== "ENOENT") throw err;
    cache.set(filePath, null);
    return null;
  }

  const tree = state.parser.parse(source);
  const assignments = new Map<string, AssignmentBinding>();
  const imports = new Map<string, ImportBinding>();
  const normalizedPaths = state.normalizedPathMap;
  let defaultExport: DefaultExportBinding | undefined;

  for (const node of tree.rootNode.namedChildren) {
    if (node.type === "lexical_declaration") {
      collectVariableDeclarators(node, assignments);
      continue;
    }

    if (node.type === "import_statement") {
      collectImportBindings(node, filePath, normalizedPaths, imports);
      continue;
    }

    if (node.type === "export_statement") {
      const inner = node.namedChildren[0];
      if (inner?.type === "lexical_declaration") {
        collectVariableDeclarators(inner, assignments);
      }
      const exportBinding = extractDefaultExport(node);
      if (exportBinding) defaultExport = exportBinding;
    }
  }

  const context: TypeScriptFileContext = {
    source,
    tree,
    assignments,
    imports,
  };
  if (defaultExport) context.default_export = defaultExport;

  cache.set(filePath, context);
  trimResolverFileCache(cache);
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
        value: stripTypeScriptString(node.text),
        value_text: node.text,
        alias_chain: [],
        used_import: false,
      };
    case "template_string": {
      if (node.namedChildren.length === 0) {
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
      const n = Number(raw);
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
      return await resolveNamedValue(filePath, node.text, state, 0);
    case "array": {
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
        value_kind: "list",
        value: items,
        value_text: node.text,
        alias_chain: aliasChain,
        used_import: usedImport,
      };
    }
    case "object": {
      const obj: Record<string, PythonLiteralValue> = {};
      let usedImport = false;
      const aliasChain: ResolutionHop[] = [];
      for (const pair of node.namedChildren) {
        if (pair.type !== "pair") continue;
        const keyNode = pair.namedChildren[0];
        const valueNode = pair.namedChildren[1];
        if (!keyNode || !valueNode) return unsupportedNode(node, aliasChain, usedImport);

        let keyValue: string;
        if (keyNode.type === "property_identifier") {
          keyValue = keyNode.text;
        } else {
          const keyResult = await evaluateValueNode(filePath, keyNode, state);
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

        const valueResult = await evaluateValueNode(filePath, valueNode, state);
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
      return inner ? await evaluateValueNode(filePath, inner, state) : unsupportedNode(node, [], false);
    }
    case "unary_expression": {
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
    case "member_expression":
      return await evaluateMemberExpression(filePath, node, state);
    default:
      return unsupportedNode(node, [], false);
  }
}

async function evaluateMemberExpression(
  filePath: string,
  node: Parser.SyntaxNode,
  state: ResolutionState,
): Promise<EvaluationResult> {
  const objectNode = node.childForFieldName("object") ?? node.namedChildren[0];
  const propertyNode = node.childForFieldName("property") ?? node.namedChildren[1];
  if (!objectNode || !propertyNode) return unsupportedNode(node, [], false);

  if (objectNode.type === "identifier" && propertyNode.type === "property_identifier") {
    const context = await loadTypeScriptFileContext(state, filePath);
    const imported = context?.imports.get(objectNode.text);
    if (imported?.kind === "namespace") {
      const result = await resolveNamedValue(imported.source_file, propertyNode.text, state, 1);
      return {
        ...result,
        used_import: true,
        alias_chain: [{ name: node.text, file: filePath, line: node.startPosition.row + 1 }, ...result.alias_chain],
      };
    }
  }

  const objectResult = await evaluateValueNode(filePath, objectNode, state);
  if (!objectResult.resolved || typeof objectResult.value !== "object" || objectResult.value === null || Array.isArray(objectResult.value)) {
    return {
      resolved: false,
      value_text: node.text,
      alias_chain: objectResult.alias_chain,
      used_import: objectResult.used_import,
      reason: objectResult.reason ?? `Could not resolve ${objectNode.text}`,
    };
  }

  const key = propertyNode.text;
  const propertyValue = (objectResult.value as Record<string, PythonLiteralValue>)[key];
  if (propertyValue === undefined) {
    return {
      resolved: false,
      value_text: node.text,
      alias_chain: objectResult.alias_chain,
      used_import: objectResult.used_import,
      reason: `Property ${key} not found on resolved object`,
    };
  }

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
        const result = await evaluateValueNode(filePath, context.default_export.node, state);
        return {
          ...result,
          alias_chain: [{ name: "default", file: filePath, line: getBindingLine(context.default_export) }, ...result.alias_chain],
        };
      }
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

function findCallableNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (node.type === "function_declaration" || node.type === "arrow_function" || node.type === "method_definition") {
    return node;
  }
  for (const child of node.namedChildren) {
    const found = findCallableNode(child);
    if (found) return found;
  }
  return null;
}

function getDefaultParameterParts(node: Parser.SyntaxNode): { name: string; valueNode: Parser.SyntaxNode } | null {
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

export async function resolveTypeScriptConstantValue(
  repo: string,
  symbolName: string,
  options?: {
    file_pattern?: string;
    max_depth?: number;
    /** When set, skips a second getCodeIndex (multi-language orchestrator). */
    index?: CodeIndex;
  },
): Promise<ConstantResolutionResult> {
  const index = options?.index ?? await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found.`);
  }

  const parser = await getParser("typescript");
  if (!parser) {
    throw new Error("TypeScript parser unavailable");
  }

  const candidates = index.symbols
    .filter((symbol) => isTypeScriptFile(symbol.file))
    .filter((symbol) => symbol.name === symbolName)
    .filter((symbol) => matchesConstantFilePattern(symbol.file, options?.file_pattern))
    .filter((symbol) => ["constant", "variable", "function", "method", "hook", "component"].includes(symbol.kind))
    .sort((a, b) => a.file.localeCompare(b.file) || a.start_line - b.start_line);

  const state: ResolutionState = {
    index,
    parser,
    fileCache: new Map(),
    normalizedPathMap: buildNormalizedPathMap(index),
    visited: new Set(),
    maxDepth: options?.max_depth ?? MAX_DEFAULT_DEPTH,
  };

  const matches: ConstantResolutionMatch[] = [];
  for (const candidate of candidates) {
    if (candidate.kind === "constant" || candidate.kind === "variable") {
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
