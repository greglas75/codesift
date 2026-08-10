import type { CallNode, CodeIndex, CodeSymbol } from "../../types.js";
import { buildAdjacencyIndex, buildCallTree } from "../graph-tools.js";
import { getCodeIndex } from "../index-tools.js";
import { collectRouteHandlers } from "./handler-discovery.js";
import { enrichNextjsTrace } from "./next-trace.js";
import { routeToMermaid } from "./route-mermaid.js";
import { findDbCalls } from "./trace-analysis.js";
import type { RouteHandler, RouteTraceResult } from "./types.js";

interface TraceAccumulator {
  callChain: RouteTraceResult["call_chain"];
  calleeSymbols: CodeSymbol[];
}

function appendCallTree(node: CallNode, depth: number, accumulator: TraceAccumulator): void {
  accumulator.callChain.push({
    name: node.symbol.name,
    file: node.symbol.file,
    kind: node.symbol.kind,
    depth,
  });
  accumulator.calleeSymbols.push(node.symbol);
  for (const child of node.children) {
    appendCallTree(child, depth + 1, accumulator);
  }
}

function traceHandlerCalls(index: CodeIndex, handlers: RouteHandler[]): TraceAccumulator {
  const accumulator: TraceAccumulator = { callChain: [], calleeSymbols: [] };
  const adjacency = buildAdjacencyIndex(index.symbols, false);

  for (const handler of handlers) {
    const fullSymbol = index.symbols.find(
      (symbol) =>
        symbol.file === handler.symbol.file &&
        symbol.name === handler.symbol.name &&
        symbol.start_line === handler.symbol.start_line,
    );
    if (!fullSymbol) continue;
    appendCallTree(buildCallTree(fullSymbol, adjacency, "callees", 3), 0, accumulator);
  }
  return accumulator;
}

/** Trace an HTTP route from framework handler through callees and DB operations. */
export async function traceRoute(
  repo: string,
  path: string,
  outputFormat?: "json" | "mermaid",
): Promise<RouteTraceResult | { mermaid: string }> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const handlers = await collectRouteHandlers(repo, index, path);
  if (handlers.length === 0) {
    return { path, handlers: [], call_chain: [], db_calls: [] };
  }

  const { callChain, calleeSymbols } = traceHandlerCalls(index, handlers);
  const result: RouteTraceResult = {
    path,
    handlers,
    call_chain: callChain,
    db_calls: findDbCalls(calleeSymbols),
  };
  await enrichNextjsTrace(result, index, handlers, calleeSymbols);

  return outputFormat === "mermaid"
    ? { mermaid: routeToMermaid(result) }
    : result;
}
