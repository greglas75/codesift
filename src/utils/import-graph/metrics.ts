import { createRequire } from "node:module";
import { DirectedGraph } from "graphology";
import type { ImportEdge } from "./types.js";

// graphology-metrics has no "exports" field; use createRequire so the deep
// path resolves at runtime under both ESM and CJS consumers.
const req = createRequire(import.meta.url);
const pagerank = req("graphology-metrics/centrality/pagerank") as (
  graph: unknown,
) => Record<string, number>;

/** Compute file-level PageRank from import edges. */
export function buildFilePageRank(edges: ImportEdge[]): Map<string, number> {
  if (edges.length === 0) return new Map();
  try {
    const graph = new DirectedGraph();
    for (const edge of edges) {
      if (typeof edge.from !== "string" || typeof edge.to !== "string") continue;
      if (!graph.hasNode(edge.from)) graph.addNode(edge.from);
      if (!graph.hasNode(edge.to)) graph.addNode(edge.to);
      if (edge.from === edge.to) continue;
      if (!graph.hasEdge(edge.from, edge.to)) graph.addEdge(edge.from, edge.to);
    }
    const scores = pagerank(graph);
    return new Map(Object.entries(scores));
  } catch {
    return new Map();
  }
}

/** Build adjacency lists (bidirectional) from import edges. */
export function buildImportAdjacency(
  edges: ImportEdge[],
): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    let fromSet = adjacency.get(edge.from);
    if (!fromSet) {
      fromSet = new Set();
      adjacency.set(edge.from, fromSet);
    }
    fromSet.add(edge.to);

    let toSet = adjacency.get(edge.to);
    if (!toSet) {
      toSet = new Set();
      adjacency.set(edge.to, toSet);
    }
    toSet.add(edge.from);
  }
  return adjacency;
}
