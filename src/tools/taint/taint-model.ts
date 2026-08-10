import type { Parser, Node as TSNode } from "web-tree-sitter";
import type { CodeIndex, CodeSymbol } from "../../types.js";

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
  node: TSNode;
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
  node: TSNode;
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

function lineForNode(symbol: CodeSymbol, node: TSNode): number {
  return symbol.start_line + node.startPosition.row;
}

function codeForNode(node: TSNode): string {
  return node.text.split("\n")[0]?.trim() ?? node.text.trim();
}

function getAttributePath(node: TSNode | null | undefined): string | null {
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

function getCallArguments(argsNode: TSNode | null | undefined): CallArgumentInfo[] {
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

function getParameterName(node: TSNode): string | null {
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

function createSourcePath(
  sourceKind: string,
  symbol: CodeSymbol,
  node: TSNode,
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
        const urlArg = args[1] ?? args[0];
        return urlArg ? [urlArg] : [];
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
        const urlArg = args[1] ?? args[0];
        return urlArg ? [urlArg] : [];
      },
    },
    {
      kind: "open",
      matches: (calleeText) => calleeText === "open" || calleeText.endsWith(".open"),
      pickArgs: (args) => args[0] ? [args[0]] : [],
    },
  ];
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
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_TRACES,
  DEFAULT_SINK_PATTERNS,
  DEFAULT_SOURCE_PATTERNS,
  KNOWN_SANITIZERS,
  appendHop,
  buildSinkDescriptors,
  cloneEnv,
  codeForNode,
  computeConfidence,
  createSourcePath,
  dedupePaths,
  findFunctionNode,
  getAttributePath,
  getCallArguments,
  getImportModule,
  getParameterName,
  identifierPaths,
  isAllowedPattern,
  lineForNode,
  mergeEnvs,
};

export type {
  AnalysisState,
  BlockResult,
  CallArgumentInfo,
  CallableContext,
  FileImportBinding,
  PythonFileContext,
  SinkDescriptor,
  TaintEnv,
  TaintPath,
};
