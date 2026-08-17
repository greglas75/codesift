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
    // Synthetic handlers (framework files with no extracted symbol) carry start_line 1 and never
    // match a real symbol, so this used to `continue` — the route came back with an EMPTY call
    // chain and nothing saying why. Falling back to the handler's own symbol keeps the handler
    // itself in the chain; it simply has no callees to walk.
    const startSymbol = fullSymbol ?? handler.symbol;
    appendCallTree(buildCallTree(startSymbol, adjacency, "callees", 3), 0, accumulator);
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
  // Handlers in one file (GET + POST) walk overlapping callee trees, so the same symbol arrived
  // once per handler that reached it and findDbCalls — which does not dedupe either — emitted the
  // same database call several times. Deduped by identity, not by name: two distinct symbols may
  // share a name.
  const uniqueCallees = [...new Map(calleeSymbols.map((s) => [`${s.file}:${s.name}:${s.start_line}`, s])).values()];
  const result: RouteTraceResult = {
    path,
    handlers,
    call_chain: callChain,
    db_calls: findDbCalls(uniqueCallees),
  };
  await enrichNextjsTrace(result, index, handlers, calleeSymbols);

  return outputFormat === "mermaid"
    ? { mermaid: routeToMermaid(result) }
    : result;
}
