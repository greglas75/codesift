import { getCodeIndex } from "./index-tools.js";

export interface FlowChainResult {
  root: string;
  file: string;
  start_line: number;
  operators: string[];
  operator_count: number;
  has_terminal: boolean;
  warnings: string[];
}

const FLOW_OPERATORS = new Set([
  "map", "mapNotNull", "mapLatest", "transform", "transformLatest",
  "flatMapConcat", "flatMapMerge", "flatMapLatest",
  "filter", "filterNotNull", "filterNot", "filterIsInstance",
  "distinctUntilChanged", "distinctUntilChangedBy", "debounce", "sample",
  "take", "takeWhile", "drop", "dropWhile",
  "combine", "zip", "merge", "onStart", "onEmpty",
  "onEach", "onCompletion", "catch", "retry", "retryWhen",
  "flowOn", "buffer", "conflate", "cancellable",
  "collect", "collectLatest", "first", "firstOrNull", "single",
  "singleOrNull", "toList", "toSet", "fold", "reduce", "count",
  "stateIn", "shareIn", "asLiveData", "asFlow",
]);

const FLOW_TERMINAL_OPERATORS = new Set([
  "collect", "collectLatest", "first", "firstOrNull", "single",
  "singleOrNull", "toList", "toSet", "fold", "reduce", "count",
]);

function collectFlowOperators(source: string): string[] {
  const operators: string[] = [];
  const operatorPattern = /\.(\w+)\s*[({]/g;
  let operatorMatch: RegExpExecArray | null;
  while ((operatorMatch = operatorPattern.exec(source)) !== null) {
    const operator = operatorMatch[1]!;
    if (FLOW_OPERATORS.has(operator)) operators.push(operator);
  }
  return operators;
}

function collectFlowWarnings(source: string, operators: string[]): string[] {
  const warnings: string[] = [];
  if ((operators.includes("collect") || operators.includes("collectLatest"))
    && !operators.includes("catch")) {
    warnings.push(
      ".collect without .catch — exceptions in the upstream flow propagate to the collector and crash the coroutine",
    );
  }
  if (!operators.includes("stateIn")) return warnings;
  const stateInIndex = /\.stateIn\s*[({]/.exec(source)?.index ?? -1;
  const stateInContext = source.slice(stateInIndex, stateInIndex + 200);
  if (stateInIndex !== -1
    && !/\bscope\b|\bviewModelScope\b|\blifecycleScope\b|\bcoroutineScope\b/i.test(stateInContext)) {
    warnings.push(
      ".stateIn without a lifecycle scope parameter — the StateFlow will never complete, causing a memory leak unless bound to viewModelScope/lifecycleScope",
    );
  }
  return warnings;
}

/** Trace the known operators and common hazards in a Kotlin Flow chain. */
export async function traceFlowChain(
  repo: string,
  symbolName: string,
): Promise<FlowChainResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const symbol = index.symbols.find((candidate) => candidate.name === symbolName);
  if (!symbol) throw new Error(`Symbol "${symbolName}" not found.`);
  const source = symbol.source ?? "";

  const operators = collectFlowOperators(source);
  if (operators.length === 0) {
    throw new Error(`"${symbolName}" has no Flow operator chain detected.`);
  }

  const hasTerminal = operators.some((operator) => FLOW_TERMINAL_OPERATORS.has(operator));
  const warnings = collectFlowWarnings(source, operators);

  return {
    root: symbol.name,
    file: symbol.file,
    start_line: symbol.start_line,
    operators,
    operator_count: operators.length,
    has_terminal: hasTerminal,
    warnings,
  };
}
