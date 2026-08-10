import type { Parser } from "web-tree-sitter";
import type { CodeIndex, CodeSymbol } from "../types.js";
import { getParser } from "../parser/parser-manager.js";
import { getCodeIndex } from "./index-tools.js";
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_TRACES,
  DEFAULT_SINK_PATTERNS,
  DEFAULT_SOURCE_PATTERNS,
  buildSinkDescriptors,
  isAllowedPattern,
} from "./taint/taint-model.js";
import type {
  AnalysisState,
  TaintTraceFramework,
  TaintTraceResult,
} from "./taint/taint-model.js";
import {
  analyzeCallableSymbol,
  shouldAnalyzeSymbol,
} from "./taint/taint-analyzer.js";

export type {
  TaintEndpoint,
  TaintHop,
  TaintHopKind,
  TaintTraceFramework,
  TaintTraceMatch,
  TaintTraceResult,
} from "./taint/taint-model.js";

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
