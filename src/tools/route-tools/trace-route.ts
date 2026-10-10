import type { CallNode, CodeSymbol } from "../../types.js";
import { nativeGraphFor } from "../graph-native.js";
import { adjacencyFor, buildCallTree, nativeCallTreeFrom } from "../graph-tools.js";
import { getCodeIndex, getIndexSummary } from "../index-tools.js";
import { collectRouteHandlers } from "./handler-discovery.js";
import { enrichNextjsTrace } from "./next-trace.js";
import { routeToMermaid } from "./route-mermaid.js";
import { routeIndexFromSummary, type RouteIndex } from "./route-index.js";
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

const TRACE_DEPTH = 3;

/**
 * Callee trees of the start symbols: over the native call graph when there is one (no index in
 * memory, the same walk as `buildCallTree`), otherwise — or if the graph is released or the store
 * changed mid-walk — over the loaded index, as before.
 */
async function calleeTrees(repo: string, starts: CodeSymbol[]): Promise<CallNode[]> {
  const graph = await nativeGraphFor(repo, false, false);
  if (graph) {
    try {
      const trees: CallNode[] = [];
      for (const start of starts) {
        const tree = await nativeCallTreeFrom(graph, start, "callees", TRACE_DEPTH, true);
        if (!tree) throw new Error("no tree");
        trees.push(tree);
      }
      return trees;
    } catch {
      // fall through to the TypeScript path
    }
  }
  const index = await getCodeIndex(repo, { skipFreshness: true });
  if (!index) throw new Error(`Repository "${repo}" not found.`);
  const adjacency = await adjacencyFor(repo, index.symbols, false);
  return starts.map((start) => buildCallTree(start, adjacency, "callees", TRACE_DEPTH));
}

async function traceHandlerCalls(repo: string, index: RouteIndex, handlers: RouteHandler[]): Promise<TraceAccumulator> {
  const starts: CodeSymbol[] = [];
  for (const handler of handlers) {
    const named = await index.find({ file: handler.symbol.file, name: handler.symbol.name, withSource: true });
    const fullSymbol = named.find((symbol) => symbol.start_line === handler.symbol.start_line);
    // Synthetic handlers (framework files with no extracted symbol) carry start_line 1 and never
    // match a real symbol, so this used to `continue` — the route came back with an EMPTY call
    // chain and nothing saying why. Falling back to the handler's own symbol keeps the handler
    // itself in the chain; it simply has no callees to walk.
    starts.push(fullSymbol ?? handler.symbol);
  }

  const accumulator: TraceAccumulator = { callChain: [], calleeSymbols: [] };
  for (const tree of await calleeTrees(repo, starts)) appendCallTree(tree, 0, accumulator);
  return accumulator;
}

/** Trace an HTTP route from framework handler through callees and DB operations. */
export async function traceRoute(
  repo: string,
  path: string,
  outputFormat?: "json" | "mermaid",
): Promise<RouteTraceResult | { mermaid: string }> {
  // The summary runs the freshness check; handlers and callees are narrow reads (ADR-004 stage 2).
  const summary = await getIndexSummary(repo);
  if (!summary) throw new Error(`Repository "${repo}" not found.`);
  const index = routeIndexFromSummary(summary);

  const handlers = await collectRouteHandlers(repo, index, path);
  if (handlers.length === 0) {
    return { path, handlers: [], call_chain: [], db_calls: [] };
  }

  const { callChain, calleeSymbols } = await traceHandlerCalls(repo, index, handlers);
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
