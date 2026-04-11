import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type Parser from "web-tree-sitter";
import type { CodeIndex, CodeSymbol } from "../types.js";
import { getParser } from "../parser/parser-manager.js";
import { detectSrcLayout, resolvePythonImport } from "../utils/python-import-resolver.js";
import { getCodeIndex } from "./index-tools.js";

export type TaintTraceFramework = "python-django";
export type TaintHopKind = "assignment" | "call" | "return" | "container" | "attribute";

export interface TaintEndpoint {
  kind: string;
  label: string;
  file: string;
  line: number;
  symbol_name: string;
  code: string;
}

export interface TaintHop {
  kind: TaintHopKind;
  file: string;
  line: number;
  symbol_name: string;
  detail: string;
}

export interface TaintTraceMatch {
  entry_symbol: string;
  entry_file: string;
  source: TaintEndpoint;
  sink: TaintEndpoint;
  hops: TaintHop[];
  confidence: "high" | "medium" | "low";
  heuristic: boolean;
}

export interface TaintTraceResult {
  framework: TaintTraceFramework;
  analyzed_symbols: number;
  source_patterns: string[];
  sink_patterns: string[];
  traces: TaintTraceMatch[];
  truncated: boolean;
}

interface TaintPath {
  source: TaintEndpoint;
  hops: TaintHop[];
  heuristic: boolean;
}

interface CallArgumentInfo {
  node: Parser.SyntaxNode;
  keyword?: string;
  index: number;
}

interface FileImportBinding {
  imported_name: string;
  source_file: string;
  line: number;
}

interface PythonFileContext {
  imports: Map<string, FileImportBinding>;
}

interface CallableContext {
  node: Parser.SyntaxNode;
  parameter_names: string[];
}

interface BlockResult {
  env: TaintEnv;
  return_paths: TaintPath[];
}

interface SinkDescriptor {
  kind: string;
  matches: (calleeText: string) => boolean;
  pickArgs: (args: CallArgumentInfo[]) => CallArgumentInfo[];
}

interface AnalysisState {
  index: CodeIndex;
  pythonParser: Parser;
  symbolsByName: Map<string, CodeSymbol[]>;
  methodsByParent: Map<string, CodeSymbol[]>;
  callableCache: Map<string, CallableContext | null>;
  fileContextCache: Map<string, PythonFileContext | null>;
  defaultSources: string[];
  defaultSinks: string[];
  maxDepth: number;
  maxTraces: number;
  sinkDescriptors: SinkDescriptor[];
  traceKeys: Set<string>;
  traces: TaintTraceMatch[];
  truncated: boolean;
}

type TaintEnv = Map<string, TaintPath[]>;

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_TRACES = 50;

const DEFAULT_SOURCE_PATTERNS = [
  "request.GET",
  "request.POST",
  "request.body",
  "request.data",
  "request.headers",
  "request.COOKIES",
  "request.META",
] as const;

const DEFAULT_SINK_PATTERNS = [
  "redirect",
  "mark_safe",
  "cursor.execute",
  "subprocess",
  "requests",
  "httpx",
  "open",
  "session-write",
] as const;

const KNOWN_SANITIZERS = new Set([
  "escape",
  "conditional_escape",
  "urlquote",
  "quote",
  "quote_plus",
]);

function clonePath(path: TaintPath): TaintPath {
  return {
    source: { ...path.source },
    hops: path.hops.map((hop) => ({ ...hop })),
    heuristic: path.heuristic,
  };
}

function pathKey(path: TaintPath): string {
  return JSON.stringify({
    source: path.source,
    hops: path.hops,
    heuristic: path.heuristic,
  });
}

function dedupePaths(paths: TaintPath[]): TaintPath[] {
  const seen = new Set<string>();
  const result: TaintPath[] = [];
  for (const path of paths) {
    const key = pathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(path);
  }
  return result;
}

function cloneEnv(env: TaintEnv): TaintEnv {
  const next = new Map<string, TaintPath[]>();
  for (const [name, paths] of env.entries()) {
    next.set(name, paths.map(clonePath));
  }
  return next;
}

function mergeEnvs(...envs: TaintEnv[]): TaintEnv {
  const merged = new Map<string, TaintPath[]>();
  for (const env of envs) {
    for (const [name, paths] of env.entries()) {
      const existing = merged.get(name) ?? [];
      merged.set(name, dedupePaths([...existing, ...paths.map(clonePath)]));
    }
  }
  return merged;
}

function appendHop(
  paths: TaintPath[],
  hop: TaintHop,
  options?: { heuristic?: boolean },
): TaintPath[] {
  return dedupePaths(paths.map((path) => ({
    source: { ...path.source },
    hops: [...path.hops.map((entry) => ({ ...entry })), { ...hop }],
    heuristic: path.heuristic || Boolean(options?.heuristic),
  })));
}

function computeConfidence(path: TaintPath): "high" | "medium" | "low" {
  if (path.heuristic) return "medium";
  if (path.hops.length >= 4) return "medium";
  return "high";
}

function lineForNode(symbol: CodeSymbol, node: Parser.SyntaxNode): number {
  return symbol.start_line + node.startPosition.row;
}

function codeForNode(node: Parser.SyntaxNode): string {
  return node.text.split("\n")[0]?.trim() ?? node.text.trim();
}

function getAttributePath(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  if (node.type === "attribute") {
    const objectNode = node.childForFieldName("object") ?? node.namedChild(0);
    const attributeNode = node.childForFieldName("attribute") ?? node.namedChild(1);
    const objectPath = getAttributePath(objectNode);
    const attributePath = getAttributePath(attributeNode);
    if (!objectPath || !attributePath) return null;
    return `${objectPath}.${attributePath}`;
  }
  return null;
}

function getCallArguments(argsNode: Parser.SyntaxNode | null | undefined): CallArgumentInfo[] {
  if (!argsNode) return [];
  const args: CallArgumentInfo[] = [];
  let index = 0;
  for (const child of argsNode.namedChildren) {
    if (child.type === "keyword_argument") {
      const keywordNode = child.namedChildren[0];
      const valueNode = child.namedChildren[1];
      if (!valueNode) continue;
      const arg: CallArgumentInfo = {
        node: valueNode,
        index,
      };
      if (keywordNode?.text) arg.keyword = keywordNode.text;
      args.push(arg);
      index += 1;
      continue;
    }

    args.push({
      node: child,
      index,
    });
    index += 1;
  }
  return args;
}

function getParameterName(node: Parser.SyntaxNode): string | null {
  switch (node.type) {
    case "identifier":
      return node.text;
    case "default_parameter":
    case "typed_parameter":
    case "typed_default_parameter":
    case "list_splat_pattern":
    case "dictionary_splat_pattern":
      return node.namedChildren[0]?.text ?? null;
    default:
      return null;
  }
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

function createSourcePath(
  sourceKind: string,
  symbol: CodeSymbol,
  node: Parser.SyntaxNode,
): TaintPath {
  return {
    source: {
      kind: sourceKind,
      label: node.text,
      file: symbol.file,
      line: lineForNode(symbol, node),
      symbol_name: symbol.name,
      code: codeForNode(node),
    },
    hops: [],
    heuristic: false,
  };
}

function identifierPaths(env: TaintEnv, name: string): TaintPath[] {
  return (env.get(name) ?? []).map(clonePath);
}

function isAllowedPattern(allowed: string[], kind: string, label: string): boolean {
  if (allowed.length === 0) return true;
  return allowed.some((pattern) =>
    pattern === kind
    || label === pattern
    || label.includes(pattern)
    || kind.includes(pattern),
  );
}

function buildSinkDescriptors(): SinkDescriptor[] {
  return [
    {
      kind: "redirect",
      matches: (calleeText) =>
        calleeText === "redirect"
        || calleeText.endsWith(".redirect")
        || calleeText === "HttpResponseRedirect"
        || calleeText === "HttpResponsePermanentRedirect",
      pickArgs: (args) => args[0] ? [args[0]] : [],
    },
    {
      kind: "mark_safe",
      matches: (calleeText) => calleeText === "mark_safe" || calleeText.endsWith(".mark_safe"),
      pickArgs: (args) => args[0] ? [args[0]] : [],
    },
    {
      kind: "cursor.execute",
      matches: (calleeText) => calleeText === "cursor.execute" || calleeText.endsWith(".execute"),
      pickArgs: (args) => args[0] ? [args[0]] : [],
    },
    {
      kind: "subprocess",
      matches: (calleeText) =>
        calleeText.startsWith("subprocess.")
        || calleeText.endsWith(".Popen")
        || calleeText.endsWith(".run")
        || calleeText.endsWith(".call")
        || calleeText.endsWith(".check_call")
        || calleeText.endsWith(".check_output"),
      pickArgs: (args) => args[0] ? [args[0]] : [],
    },
    {
      kind: "requests",
      matches: (calleeText) =>
        calleeText.startsWith("requests.")
        || calleeText.includes(".requests.")
        || calleeText.startsWith("httpx.")
        || calleeText.includes(".httpx."),
      pickArgs: (args) => {
        if (args.length === 0) return [];
        const urlKeyword = args.find((arg) => arg.keyword === "url");
        if (urlKeyword) return [urlKeyword];
        return args[1] ? [args[1]] : [args[0]!];
      },
    },
    {
      kind: "httpx",
      matches: (calleeText) =>
        calleeText.startsWith("httpx.")
        || calleeText.includes(".httpx."),
      pickArgs: (args) => {
        if (args.length === 0) return [];
        const urlKeyword = args.find((arg) => arg.keyword === "url");
        if (urlKeyword) return [urlKeyword];
        return args[1] ? [args[1]] : [args[0]!];
      },
    },
    {
      kind: "open",
      matches: (calleeText) => calleeText === "open" || calleeText.endsWith(".open"),
      pickArgs: (args) => args[0] ? [args[0]] : [],
    },
  ];
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

async function loadFileContext(
  state: AnalysisState,
  filePath: string,
): Promise<PythonFileContext | null> {
  const cached = state.fileContextCache.get(filePath);
  if (cached !== undefined) return cached;

  let source: string;
  try {
    source = await readFile(join(state.index.root, filePath), "utf-8");
  } catch {
    state.fileContextCache.set(filePath, null);
    return null;
  }

  const tree = state.pythonParser.parse(source);
  const files = state.index.files.map((entry) => entry.path);
  const srcLayout = detectSrcLayout(files);
  const imports = new Map<string, FileImportBinding>();

  for (const node of tree.rootNode.namedChildren) {
    if (node.type !== "import_from_statement") continue;
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

  const context: PythonFileContext = { imports };
  state.fileContextCache.set(filePath, context);
  return context;
}

function hasPotentialSource(symbol: CodeSymbol): boolean {
  return symbol.source?.includes("request.") ?? false;
}

function hasPotentialSink(symbol: CodeSymbol): boolean {
  const source = symbol.source ?? "";
  return source.includes("mark_safe")
    || source.includes("redirect(")
    || source.includes(".execute(")
    || source.includes("subprocess.")
    || source.includes("requests.")
    || source.includes("httpx.")
    || source.includes("open(")
    || source.includes("request.session");
}

async function loadCallableContext(
  symbol: CodeSymbol,
  state: AnalysisState,
): Promise<CallableContext | null> {
  const cached = state.callableCache.get(symbol.id);
  if (cached !== undefined) return cached;
  if (!symbol.source) {
    state.callableCache.set(symbol.id, null);
    return null;
  }

  const tree = state.pythonParser.parse(symbol.source);
  const functionNode = findFunctionNode(tree.rootNode);
  if (!functionNode) {
    state.callableCache.set(symbol.id, null);
    return null;
  }

  const paramsNode = functionNode.childForFieldName("parameters");
  const parameterNames = paramsNode
    ? paramsNode.namedChildren
      .map(getParameterName)
      .filter((name): name is string => Boolean(name))
    : [];

  const context: CallableContext = {
    node: functionNode,
    parameter_names: parameterNames,
  };
  state.callableCache.set(symbol.id, context);
  return context;
}

function resolveSelfMethod(
  currentSymbol: CodeSymbol,
  propertyName: string,
  state: AnalysisState,
): CodeSymbol | null {
  if (!currentSymbol.parent) return null;
  const methods = state.methodsByParent.get(currentSymbol.parent) ?? [];
  return methods.find((symbol) => symbol.name === propertyName) ?? null;
}

async function resolveHelperTarget(
  currentSymbol: CodeSymbol,
  calleeNode: Parser.SyntaxNode,
  state: AnalysisState,
): Promise<CodeSymbol | null> {
  const calleeText = getAttributePath(calleeNode) ?? calleeNode.text;
  if (calleeNode.type === "identifier") {
    const sameFile = (state.symbolsByName.get(calleeText) ?? [])
      .filter((symbol) =>
        symbol.file === currentSymbol.file
        && symbol.id !== currentSymbol.id
        && (symbol.kind === "function" || symbol.kind === "class" || symbol.kind === "method")
      );
    if (sameFile.length === 1) return sameFile[0]!;

    const fileContext = await loadFileContext(state, currentSymbol.file);
    const imported = fileContext?.imports.get(calleeText);
    if (imported) {
      const importedMatch = (state.symbolsByName.get(imported.imported_name) ?? [])
        .find((symbol) => symbol.file === imported.source_file);
      if (importedMatch) return importedMatch;
    }

    const unique = (state.symbolsByName.get(calleeText) ?? [])
      .filter((symbol) => symbol.file.endsWith(".py") && symbol.id !== currentSymbol.id)
      .filter((symbol) => symbol.kind === "function" || symbol.kind === "method" || symbol.kind === "class");
    if (unique.length === 1) return unique[0]!;
    return null;
  }

  if (calleeNode.type === "attribute") {
    const objectNode = calleeNode.childForFieldName("object") ?? calleeNode.namedChild(0);
    const propertyNode = calleeNode.childForFieldName("attribute") ?? calleeNode.namedChild(1);
    const objectName = getAttributePath(objectNode);
    const propertyName = propertyNode?.text;

    if ((objectName === "self" || objectName === "cls") && propertyName) {
      return resolveSelfMethod(currentSymbol, propertyName, state);
    }

    const importedModule = objectName ? (await loadFileContext(state, currentSymbol.file))?.imports.get(objectName) : null;
    if (importedModule && propertyName) {
      const candidates = state.symbolsByName.get(propertyName) ?? [];
      const importedMatch = candidates.find((symbol) => symbol.file === importedModule.source_file);
      if (importedMatch) return importedMatch;
    }
  }

  return null;
}

function matchesRequestSource(attributePath: string | null): string | null {
  if (!attributePath) return null;
  if (attributePath === "request.GET" || attributePath.startsWith("request.GET.")) return "request.GET";
  if (attributePath === "request.POST" || attributePath.startsWith("request.POST.")) return "request.POST";
  if (attributePath === "request.body") return "request.body";
  if (attributePath === "request.data" || attributePath.startsWith("request.data.")) return "request.data";
  if (attributePath === "request.headers" || attributePath.startsWith("request.headers.")) return "request.headers";
  if (attributePath === "request.COOKIES" || attributePath.startsWith("request.COOKIES.")) return "request.COOKIES";
  if (attributePath === "request.META" || attributePath.startsWith("request.META.")) return "request.META";
  return null;
}

function isSessionTarget(node: Parser.SyntaxNode): boolean {
  if (node.type === "attribute") {
    const path = getAttributePath(node);
    return path === "request.session";
  }
  if (node.type === "subscript") {
    const base = node.childForFieldName("value") ?? node.namedChild(0);
    return getAttributePath(base) === "request.session";
  }
  return false;
}

function sinkTraceKey(trace: TaintTraceMatch): string {
  return JSON.stringify({
    entry_symbol: trace.entry_symbol,
    entry_file: trace.entry_file,
    source: trace.source,
    sink: trace.sink,
    hops: trace.hops,
    heuristic: trace.heuristic,
  });
}

function addTrace(
  state: AnalysisState,
  entrySymbol: CodeSymbol,
  currentSymbol: CodeSymbol,
  sinkKind: string,
  sinkNode: Parser.SyntaxNode,
  paths: TaintPath[],
): void {
  if (state.truncated) return;

  for (const path of paths) {
    if (state.traces.length >= state.maxTraces) {
      state.truncated = true;
      return;
    }

    const trace: TaintTraceMatch = {
      entry_symbol: entrySymbol.name,
      entry_file: entrySymbol.file,
      source: { ...path.source },
      sink: {
        kind: sinkKind,
        label: sinkNode.text,
        file: currentSymbol.file,
        line: lineForNode(currentSymbol, sinkNode),
        symbol_name: currentSymbol.name,
        code: codeForNode(sinkNode),
      },
      hops: path.hops.map((hop) => ({ ...hop })),
      confidence: computeConfidence(path),
      heuristic: path.heuristic,
    };

    const key = sinkTraceKey(trace);
    if (state.traceKeys.has(key)) continue;
    state.traceKeys.add(key);
    state.traces.push(trace);
  }
}

async function evaluateExpression(
  node: Parser.SyntaxNode,
  symbol: CodeSymbol,
  env: TaintEnv,
  state: AnalysisState,
  context: { entrySymbol: CodeSymbol; depth: number; callStack: string[] },
): Promise<TaintPath[]> {
  switch (node.type) {
    case "identifier":
      return identifierPaths(env, node.text);
    case "attribute": {
      const sourceKind = matchesRequestSource(getAttributePath(node));
      if (sourceKind) return [createSourcePath(sourceKind, symbol, node)];

      const objectNode = node.childForFieldName("object") ?? node.namedChild(0);
      if (!objectNode) return [];
      const basePaths = await evaluateExpression(objectNode, symbol, env, state, context);
      if (basePaths.length === 0) return [];
      return appendHop(basePaths, {
        kind: "attribute",
        file: symbol.file,
        line: lineForNode(symbol, node),
        symbol_name: symbol.name,
        detail: `attribute access ${node.text}`,
      });
    }
    case "subscript": {
      const baseNode = node.childForFieldName("value") ?? node.namedChild(0);
      const sourceKind = matchesRequestSource(getAttributePath(baseNode));
      if (sourceKind) return [createSourcePath(sourceKind, symbol, node)];

      const basePaths = baseNode
        ? await evaluateExpression(baseNode, symbol, env, state, context)
        : [];
      if (basePaths.length === 0) return [];
      return appendHop(basePaths, {
        kind: "container",
        file: symbol.file,
        line: lineForNode(symbol, node),
        symbol_name: symbol.name,
        detail: `container access ${node.text}`,
      });
    }
    case "string": {
      const interpolated = node.namedChildren
        .filter((child) => child.type === "interpolation")
        .flatMap((child) => child.namedChildren);
      if (interpolated.length === 0) return [];
      const paths = [];
      for (const child of interpolated) {
        paths.push(...await evaluateExpression(child, symbol, env, state, context));
      }
      if (paths.length === 0) return [];
      return appendHop(paths, {
        kind: "container",
        file: symbol.file,
        line: lineForNode(symbol, node),
        symbol_name: symbol.name,
        detail: `formatted string ${node.text}`,
      });
    }
    case "list":
    case "tuple":
    case "dictionary":
    case "set": {
      const paths = [];
      for (const child of node.namedChildren) {
        if (child.type === "pair") {
          const valueNode = child.namedChildren[1];
          if (!valueNode) continue;
          paths.push(...await evaluateExpression(valueNode, symbol, env, state, context));
        } else {
          paths.push(...await evaluateExpression(child, symbol, env, state, context));
        }
      }
      if (paths.length === 0) return [];
      return appendHop(paths, {
        kind: "container",
        file: symbol.file,
        line: lineForNode(symbol, node),
        symbol_name: symbol.name,
        detail: `container literal ${node.text}`,
      });
    }
    case "binary_operator":
    case "boolean_operator":
    case "comparison_operator": {
      const paths = [];
      for (const child of node.namedChildren) {
        paths.push(...await evaluateExpression(child, symbol, env, state, context));
      }
      return dedupePaths(paths);
    }
    case "parenthesized_expression":
      return node.namedChildren[0]
        ? await evaluateExpression(node.namedChildren[0]!, symbol, env, state, context)
        : [];
    case "conditional_expression": {
      const paths = [];
      for (const child of node.namedChildren) {
        paths.push(...await evaluateExpression(child, symbol, env, state, context));
      }
      return dedupePaths(paths);
    }
    case "call": {
      const calleeNode = node.childForFieldName("function") ?? node.namedChild(0);
      const argsNode = node.childForFieldName("arguments") ?? node.namedChild(1);
      const callArgs = getCallArguments(argsNode);
      const calleeText = getAttributePath(calleeNode) ?? calleeNode?.text ?? "";
      const sourceKind = matchesRequestSource(calleeText);
      if (sourceKind && calleeText.endsWith(".get")) {
        return [createSourcePath(sourceKind, symbol, node)];
      }

      const evaluatedArgs = await Promise.all(callArgs.map(async (arg) => ({
        arg,
        paths: await evaluateExpression(arg.node, symbol, env, state, context),
      })));

      for (const descriptor of state.sinkDescriptors) {
        if (!descriptor.matches(calleeText)) continue;
        if (!isAllowedPattern(state.defaultSinks, descriptor.kind, calleeText)) continue;
        const selectedArgs = descriptor.pickArgs(callArgs);
        const taintedArgs = selectedArgs.flatMap((selected) =>
          evaluatedArgs
            .filter((entry) => entry.arg.index === selected.index)
            .flatMap((entry) => entry.paths),
        );
        if (taintedArgs.length > 0) {
          addTrace(state, context.entrySymbol, symbol, descriptor.kind, node, dedupePaths(taintedArgs));
        }
      }

      const calleeLeaf = calleeText.split(".").pop() ?? calleeText;
      if (KNOWN_SANITIZERS.has(calleeLeaf)) return [];

      const taintedInputs = evaluatedArgs
        .filter((entry) => entry.paths.length > 0)
        .map((entry) => entry);
      if (taintedInputs.length === 0) return [];

      const helperTarget = calleeNode
        ? await resolveHelperTarget(symbol, calleeNode, state)
        : null;
      if (helperTarget && context.depth < state.maxDepth && !context.callStack.includes(helperTarget.id)) {
        const helperContext = await loadCallableContext(helperTarget, state);
        if (helperContext) {
          const helperEnv = new Map<string, TaintPath[]>();
          for (const entry of taintedInputs) {
            const paramName = helperContext.parameter_names[entry.arg.index];
            if (!paramName) continue;
            helperEnv.set(paramName, appendHop(entry.paths, {
              kind: "call",
              file: symbol.file,
              line: lineForNode(symbol, node),
              symbol_name: symbol.name,
              detail: `call ${calleeText} -> parameter ${paramName}`,
            }));
          }

          const helperResult = await analyzeCallableSymbol(helperTarget, helperEnv, state, {
            entrySymbol: context.entrySymbol,
            depth: context.depth + 1,
            callStack: [...context.callStack, helperTarget.id],
          });
          if (helperResult.return_paths.length > 0) {
            return appendHop(helperResult.return_paths, {
              kind: "call",
              file: symbol.file,
              line: lineForNode(symbol, node),
              symbol_name: symbol.name,
              detail: `return from ${calleeText}`,
            });
          }
          return [];
        }
      }

      return appendHop(
        taintedInputs.flatMap((entry) => entry.paths),
        {
          kind: "call",
          file: symbol.file,
          line: lineForNode(symbol, node),
          symbol_name: symbol.name,
          detail: `heuristic propagation through ${calleeText}`,
        },
        { heuristic: true },
      );
    }
    default:
      return [];
  }
}

async function analyzeAssignment(
  assignmentNode: Parser.SyntaxNode,
  symbol: CodeSymbol,
  env: TaintEnv,
  state: AnalysisState,
  context: { entrySymbol: CodeSymbol; depth: number; callStack: string[] },
): Promise<TaintEnv> {
  const lhs = assignmentNode.childForFieldName("left") ?? assignmentNode.namedChild(0);
  const rhs = assignmentNode.childForFieldName("right") ?? assignmentNode.namedChild(1);
  const nextEnv = cloneEnv(env);
  if (!lhs || !rhs) return nextEnv;

  const rhsPaths = await evaluateExpression(rhs, symbol, env, state, context);
  if (rhsPaths.length === 0) return nextEnv;

  if (lhs.type === "identifier") {
    nextEnv.set(lhs.text, appendHop(rhsPaths, {
      kind: "assignment",
      file: symbol.file,
      line: lineForNode(symbol, assignmentNode),
      symbol_name: symbol.name,
      detail: `${lhs.text} = ${rhs.text}`,
    }));
    return nextEnv;
  }

  if (isSessionTarget(lhs) && isAllowedPattern(state.defaultSinks, "session-write", lhs.text)) {
    addTrace(state, context.entrySymbol, symbol, "session-write", assignmentNode, rhsPaths);
  }

  return nextEnv;
}

async function analyzeConditionalLike(
  node: Parser.SyntaxNode,
  symbol: CodeSymbol,
  env: TaintEnv,
  state: AnalysisState,
  context: { entrySymbol: CodeSymbol; depth: number; callStack: string[] },
): Promise<BlockResult> {
  const conditionNodes = node.namedChildren.filter((child) => child.type !== "block" && child.type !== "else_clause" && child.type !== "elif_clause");
  for (const condition of conditionNodes) {
    await evaluateExpression(condition, symbol, env, state, context);
  }

  const branchResults: BlockResult[] = [];
  let hasElseLike = false;
  for (const child of node.namedChildren) {
    if (child.type === "block") {
      branchResults.push(await analyzeBlock(child, symbol, cloneEnv(env), state, context));
      continue;
    }
    if (child.type === "elif_clause") {
      hasElseLike = true;
      branchResults.push(await analyzeConditionalLike(child, symbol, cloneEnv(env), state, context));
      continue;
    }
    if (child.type === "else_clause") {
      hasElseLike = true;
      const elseBlock = child.namedChildren.find((grandchild) => grandchild.type === "block");
      if (elseBlock) branchResults.push(await analyzeBlock(elseBlock, symbol, cloneEnv(env), state, context));
    }
  }

  const baseEnvs = hasElseLike ? [] : [env];
  return {
    env: mergeEnvs(...baseEnvs, ...branchResults.map((entry) => entry.env)),
    return_paths: dedupePaths(branchResults.flatMap((entry) => entry.return_paths)),
  };
}

async function analyzeLoopLike(
  node: Parser.SyntaxNode,
  symbol: CodeSymbol,
  env: TaintEnv,
  state: AnalysisState,
  context: { entrySymbol: CodeSymbol; depth: number; callStack: string[] },
): Promise<BlockResult> {
  for (const child of node.namedChildren) {
    if (child.type === "block") continue;
    await evaluateExpression(child, symbol, env, state, context);
  }

  const blockResults: BlockResult[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== "block") continue;
    blockResults.push(await analyzeBlock(child, symbol, cloneEnv(env), state, context));
  }

  return {
    env: mergeEnvs(env, ...blockResults.map((entry) => entry.env)),
    return_paths: dedupePaths(blockResults.flatMap((entry) => entry.return_paths)),
  };
}

async function analyzeStatement(
  node: Parser.SyntaxNode,
  symbol: CodeSymbol,
  env: TaintEnv,
  state: AnalysisState,
  context: { entrySymbol: CodeSymbol; depth: number; callStack: string[] },
): Promise<BlockResult> {
  switch (node.type) {
    case "expression_statement": {
      const inner = node.namedChildren[0];
      if (!inner) return { env, return_paths: [] };
      if (inner.type === "assignment") {
        return {
          env: await analyzeAssignment(inner, symbol, env, state, context),
          return_paths: [],
        };
      }
      await evaluateExpression(inner, symbol, env, state, context);
      return { env, return_paths: [] };
    }
    case "return_statement": {
      const valueNode = node.namedChildren[0];
      if (!valueNode) return { env, return_paths: [] };
      const valuePaths = await evaluateExpression(valueNode, symbol, env, state, context);
      if (valuePaths.length === 0) return { env, return_paths: [] };
      return {
        env,
        return_paths: appendHop(valuePaths, {
          kind: "return",
          file: symbol.file,
          line: lineForNode(symbol, node),
          symbol_name: symbol.name,
          detail: `return ${valueNode.text}`,
        }),
      };
    }
    case "if_statement":
    case "elif_clause":
      return await analyzeConditionalLike(node, symbol, env, state, context);
    case "for_statement":
    case "while_statement":
    case "with_statement":
    case "try_statement":
      return await analyzeLoopLike(node, symbol, env, state, context);
    case "pass_statement":
    case "break_statement":
    case "continue_statement":
      return { env, return_paths: [] };
    case "function_definition":
    case "async_function_definition":
    case "class_definition":
    case "decorated_definition":
      return { env, return_paths: [] };
    default: {
      for (const child of node.namedChildren) {
        if (child.type === "block") {
          await analyzeBlock(child, symbol, cloneEnv(env), state, context);
        } else {
          await evaluateExpression(child, symbol, env, state, context);
        }
      }
      return { env, return_paths: [] };
    }
  }
}

async function analyzeBlock(
  blockNode: Parser.SyntaxNode,
  symbol: CodeSymbol,
  env: TaintEnv,
  state: AnalysisState,
  context: { entrySymbol: CodeSymbol; depth: number; callStack: string[] },
): Promise<BlockResult> {
  let currentEnv = cloneEnv(env);
  let returnPaths: TaintPath[] = [];

  for (const child of blockNode.namedChildren) {
    if (state.truncated) break;
    const result = await analyzeStatement(child, symbol, currentEnv, state, context);
    currentEnv = result.env;
    if (result.return_paths.length > 0) {
      returnPaths = dedupePaths([...returnPaths, ...result.return_paths]);
    }
  }

  return {
    env: currentEnv,
    return_paths: returnPaths,
  };
}

async function analyzeCallableSymbol(
  symbol: CodeSymbol,
  initialEnv: TaintEnv,
  state: AnalysisState,
  context: { entrySymbol: CodeSymbol; depth: number; callStack: string[] },
): Promise<BlockResult> {
  const callableContext = await loadCallableContext(symbol, state);
  if (!callableContext) {
    return { env: initialEnv, return_paths: [] };
  }

  const bodyNode = callableContext.node.childForFieldName("body");
  if (!bodyNode) {
    return { env: initialEnv, return_paths: [] };
  }

  return await analyzeBlock(bodyNode, symbol, initialEnv, state, context);
}

function shouldAnalyzeSymbol(symbol: CodeSymbol, filePattern?: string): boolean {
  if (!symbol.file.endsWith(".py")) return false;
  if (filePattern && !symbol.file.includes(filePattern)) return false;
  if (!symbol.source) return false;
  if (symbol.kind !== "function" && symbol.kind !== "method") return false;
  return hasPotentialSource(symbol) || hasPotentialSink(symbol);
}

function buildState(index: CodeIndex, pythonParser: Parser, options?: {
  source_patterns?: string[];
  sink_patterns?: string[];
  max_depth?: number;
  max_traces?: number;
}): AnalysisState {
  const symbolsByName = new Map<string, CodeSymbol[]>();
  const methodsByParent = new Map<string, CodeSymbol[]>();

  for (const symbol of index.symbols) {
    const named = symbolsByName.get(symbol.name) ?? [];
    named.push(symbol);
    symbolsByName.set(symbol.name, named);

    if (symbol.parent && symbol.kind === "method") {
      const methods = methodsByParent.get(symbol.parent) ?? [];
      methods.push(symbol);
      methodsByParent.set(symbol.parent, methods);
    }
  }

  return {
    index,
    pythonParser,
    symbolsByName,
    methodsByParent,
    callableCache: new Map(),
    fileContextCache: new Map(),
    defaultSources: options?.source_patterns?.length
      ? [...options.source_patterns]
      : [...DEFAULT_SOURCE_PATTERNS],
    defaultSinks: options?.sink_patterns?.length
      ? [...options.sink_patterns]
      : [...DEFAULT_SINK_PATTERNS],
    maxDepth: options?.max_depth ?? DEFAULT_MAX_DEPTH,
    maxTraces: options?.max_traces ?? DEFAULT_MAX_TRACES,
    sinkDescriptors: buildSinkDescriptors(),
    traceKeys: new Set(),
    traces: [],
    truncated: false,
  };
}

export async function taintTrace(
  repo: string,
  options?: {
    framework?: TaintTraceFramework;
    file_pattern?: string;
    source_patterns?: string[];
    sink_patterns?: string[];
    max_depth?: number;
    max_traces?: number;
  },
): Promise<TaintTraceResult> {
  const framework = options?.framework ?? "python-django";
  if (framework !== "python-django") {
    throw new Error(`taint_trace is not implemented for framework "${framework}" yet.`);
  }

  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found.`);
  }

  const pythonParser = await getParser("python");
  if (!pythonParser) {
    throw new Error("Python parser unavailable");
  }

  const state = buildState(index, pythonParser, options);
  const candidates = index.symbols
    .filter((symbol) => shouldAnalyzeSymbol(symbol, options?.file_pattern))
    .sort((a, b) => a.file.localeCompare(b.file) || a.start_line - b.start_line);

  for (const symbol of candidates) {
    if (state.truncated) break;
    await analyzeCallableSymbol(symbol, new Map(), state, {
      entrySymbol: symbol,
      depth: 0,
      callStack: [symbol.id],
    });
  }

  const filtered = state.traces.filter((trace) =>
    isAllowedPattern(state.defaultSources, trace.source.kind, trace.source.label)
    && isAllowedPattern(state.defaultSinks, trace.sink.kind, trace.sink.label),
  );

  return {
    framework,
    analyzed_symbols: candidates.length,
    source_patterns: [...state.defaultSources],
    sink_patterns: [...state.defaultSinks],
    traces: filtered,
    truncated: state.truncated,
  };
}
