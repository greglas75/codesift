import type { Node as TSNode } from "web-tree-sitter";
import type { CodeSymbol } from "../../types.js";
import {
  KNOWN_SANITIZERS,
  appendHop,
  codeForNode,
  computeConfidence,
  createSourcePath,
  dedupePaths,
  getAttributePath,
  getCallArguments,
  identifierPaths,
  isAllowedPattern,
  lineForNode,
} from "./taint-model.js";
import type {
  AnalysisState,
  BlockResult,
  TaintEnv,
  TaintPath,
  TaintTraceMatch,
} from "./taint-model.js";
import {
  loadCallableContext,
  resolveHelperTarget,
} from "./python-context.js";

type AnalyzeCallable = (
  symbol: CodeSymbol,
  initialEnv: TaintEnv,
  state: AnalysisState,
  context: { entrySymbol: CodeSymbol; depth: number; callStack: string[] },
) => Promise<BlockResult>;

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

function isSessionTarget(node: TSNode): boolean {
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
  sinkNode: TSNode,
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
  node: TSNode,
  symbol: CodeSymbol,
  env: TaintEnv,
  state: AnalysisState,
  context: { entrySymbol: CodeSymbol; depth: number; callStack: string[] },
  analyzeCallable: AnalyzeCallable,
): Promise<TaintPath[]> {
  switch (node.type) {
    case "identifier":
      return identifierPaths(env, node.text);
    case "attribute": {
      const sourceKind = matchesRequestSource(getAttributePath(node));
      if (sourceKind) return [createSourcePath(sourceKind, symbol, node)];

      const objectNode = node.childForFieldName("object") ?? node.namedChild(0);
      if (!objectNode) return [];
      const basePaths = await evaluateExpression(objectNode, symbol, env, state, context, analyzeCallable);
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
        ? await evaluateExpression(baseNode, symbol, env, state, context, analyzeCallable)
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
        paths.push(...await evaluateExpression(child, symbol, env, state, context, analyzeCallable));
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
          paths.push(...await evaluateExpression(valueNode, symbol, env, state, context, analyzeCallable));
        } else {
          paths.push(...await evaluateExpression(child, symbol, env, state, context, analyzeCallable));
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
        paths.push(...await evaluateExpression(child, symbol, env, state, context, analyzeCallable));
      }
      return dedupePaths(paths);
    }
    case "parenthesized_expression": {
      const expression = node.namedChildren[0];
      return expression
        ? await evaluateExpression(expression, symbol, env, state, context, analyzeCallable)
        : [];
    }
    case "conditional_expression": {
      const paths = [];
      for (const child of node.namedChildren) {
        paths.push(...await evaluateExpression(child, symbol, env, state, context, analyzeCallable));
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
        paths: await evaluateExpression(arg.node, symbol, env, state, context, analyzeCallable),
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

          const helperResult = await analyzeCallable(helperTarget, helperEnv, state, {
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

export { addTrace, evaluateExpression, isSessionTarget };
export type { AnalyzeCallable };
