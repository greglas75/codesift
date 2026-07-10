import { getBM25Index, getCodeIndex } from "./index-tools.js";
import { searchBM25 } from "../search/bm25.js";
import { loadConfig } from "../config.js";
import { collectImportEdges } from "../utils/import-graph.js";
import { collectHeritageFileEdges } from "../utils/heritage-edges.js";
import { getGraphPath, loadGraph, saveGraph, computeIndexHash } from "../storage/graph-store.js";
import { getRepo } from "../storage/registry.js";
import type { CodeIndex } from "../types.js";
import type { PersistentGraph } from "../storage/graph-store.js";
import { assembleL0 } from "./context-levels/l0.js";
import { assembleL1 } from "./context-levels/l1.js";
import { assembleL2 } from "./context-levels/l2.js";
import { assembleL3 } from "./context-levels/l3.js";
import type { AssembleContextResult, ContextLevel } from "./context-levels/types.js";

export type { AssembleContextResult, ContextLevel } from "./context-levels/types.js";

export interface KnowledgeMapModule {
  path: string;
  symbol_count: number;
}

export interface KnowledgeMapEdge {
  from: string;
  to: string;
}

export interface CircularDep {
  cycle: string[];   // file paths forming the cycle, e.g. ["a.ts", "b.ts", "a.ts"]
  length: number;    // number of edges in the cycle
}

export interface KnowledgeMap {
  modules: KnowledgeMapModule[];
  edges: KnowledgeMapEdge[];
  circular_deps: CircularDep[];
}

/**
 * Assemble a context window of relevant code for a query.
 * Uses BM25 search to find the most relevant symbols and accumulates
 * them until the token budget is reached.
 *
 * Levels:
 *   L0 = full source (default)
 *   L1 = signatures + docstrings only (~5-10x more symbols per budget)
 *   L2 = file-level summaries (export lists)
 *   L3 = directory overview (file counts + top files)
 */
export async function assembleContext(
  repo: string,
  query: string,
  tokenBudget?: number,
  level?: ContextLevel,
  rerank?: boolean,
): Promise<AssembleContextResult> {
  const bm25Index = await getBM25Index(repo);
  if (!bm25Index) {
    throw new Error(`Repository not found: ${repo}`);
  }

  const config = loadConfig();
  const budget = tokenBudget ?? config.defaultTokenBudget;
  const lvl = level ?? "L0";

  // Search wider for compressed levels (more results fit in budget)
  const topK = lvl === "L0" ? 20 : lvl === "L1" ? 100 : 200;
  let results = searchBM25(bm25Index, query, topK, config.bm25FieldWeights);

  if (rerank && results.length > 1) {
    const { rerankResults } = await import("../search/reranker.js");
    results = await rerankResults(query, results);
  }

  if (lvl === "L0") return assembleL0(results, budget);
  if (lvl === "L1") return assembleL1(results, budget);
  if (lvl === "L2") return assembleL2(results, budget, await getCodeIndex(repo));
  return assembleL3(results, budget);
}

// Import graph utilities moved to src/utils/import-graph.ts

/**
 * Convert a KnowledgeMap into a Mermaid graph TD diagram.
 * Aggregates at directory level for readability.
 * Capped at 30 nodes and 50 edges.
 */
function knowledgeMapToMermaid(result: KnowledgeMap): string {
  const lines: string[] = ["graph TD"];
  const MAX_NODES = 30;
  const MAX_EDGES = 50;

  // Aggregate to directory level for readability
  const dirSymbols = new Map<string, number>();
  for (const mod of result.modules) {
    const dir = mod.path.includes("/") ? mod.path.slice(0, mod.path.lastIndexOf("/")) : mod.path;
    dirSymbols.set(dir, (dirSymbols.get(dir) ?? 0) + mod.symbol_count);
  }

  const topDirs = [...dirSymbols.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_NODES);
  const dirSet = new Set(topDirs.map(([d]) => d));

  for (const [dir, syms] of topDirs) {
    const id = dir.replace(/[^a-zA-Z0-9]/g, "_");
    const short = dir.split("/").slice(-2).join("/");
    lines.push(`    ${id}["${short} (${syms} sym)"]`);
  }

  const dirEdges = new Set<string>();
  let edgeCount = 0;
  for (const edge of result.edges) {
    if (edgeCount >= MAX_EDGES) break;
    const fromDir = edge.from.includes("/") ? edge.from.slice(0, edge.from.lastIndexOf("/")) : edge.from;
    const toDir = edge.to.includes("/") ? edge.to.slice(0, edge.to.lastIndexOf("/")) : edge.to;
    if (fromDir === toDir || !dirSet.has(fromDir) || !dirSet.has(toDir)) continue;
    const key = `${fromDir}|${toDir}`;
    if (dirEdges.has(key)) continue;
    dirEdges.add(key);
    const fromId = fromDir.replace(/[^a-zA-Z0-9]/g, "_");
    const toId = toDir.replace(/[^a-zA-Z0-9]/g, "_");
    lines.push(`    ${fromId} --> ${toId}`);
    edgeCount++;
  }

  return lines.join("\n");
}

/**
 * Build a module dependency map for a repository.
 * Parses import statements from each file's symbols to discover edges.
 * Optionally filters to modules matching a focus path.
 */
export async function getKnowledgeMap(
  repo: string,
  focus?: string,
  depth?: number,
  outputFormat?: "json" | "mermaid",
): Promise<KnowledgeMap | { mermaid: string }> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository not found: ${repo}`);
  }

  const maxDepth = depth ?? 3;

  // Build module list from files
  const moduleMap = new Map<string, KnowledgeMapModule>();
  for (const file of index.files) {
    moduleMap.set(file.path, {
      path: file.path,
      symbol_count: file.symbol_count,
    });
  }

  // Collect all import edges by reading file source from disk (may use cached graph)
  const collected = await collectEdges(index, moduleMap);
  const edges = collected.edges;

  const circularDeps = collected.cachedCircularDeps ?? findCircularDeps(edges);

  // Persist graph with circular deps if freshly computed
  if (collected._graphMeta && !collected.cachedCircularDeps) {
    const { graphPath, indexHash, importEdges, heritageEdges } = collected._graphMeta;
    const inDeg = new Map<string, number>();
    const outDeg = new Map<string, number>();
    for (const e of edges) {
      outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
      inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
    }
    const graph: PersistentGraph = {
      index_hash: indexHash,
      computed_at: Date.now(),
      edges: [
        ...importEdges.map((e) => ({ from: e.from, to: e.to, kind: "imports" as const })),
        ...heritageEdges.map((e) => ({
          from: e.from,
          to: e.to,
          kind: e.kind,
        })),
      ],
      modules: index.files.map((f) => ({
        path: f.path,
        symbol_count: f.symbol_count,
        in_degree: inDeg.get(f.path) ?? 0,
        out_degree: outDeg.get(f.path) ?? 0,
      })),
      circular_deps: circularDeps.map((cd) => cd.cycle),
    };
    saveGraph(graphPath, graph).catch(() => {});
  }

  // Cap output to prevent huge responses on large repos
  const MAX_UNFOCUSED_MODULES = 30;
  const MAX_UNFOCUSED_EDGES = 80;

  if (!focus) {
    const allModules = [...moduleMap.values()];
    const cappedModules = allModules.length > MAX_UNFOCUSED_MODULES
      ? allModules.sort((a, b) => b.symbol_count - a.symbol_count).slice(0, MAX_UNFOCUSED_MODULES)
      : allModules;
    const cappedModuleSet = new Set(cappedModules.map((m) => m.path));
    const cappedEdges = edges
      .filter((e) => cappedModuleSet.has(e.from) && cappedModuleSet.has(e.to))
      .slice(0, MAX_UNFOCUSED_EDGES);

    const result: KnowledgeMap = {
      modules: cappedModules,
      edges: cappedEdges,
      circular_deps: circularDeps,
      ...(allModules.length > MAX_UNFOCUSED_MODULES
        ? { truncated: true, total_modules: allModules.length, hint: `Showing top ${MAX_UNFOCUSED_MODULES} by symbol count. Use focus param to narrow.` }
        : {}),
    };

    if (outputFormat === "mermaid") return { mermaid: knowledgeMapToMermaid(result) };
    return result;
  }

  // Filter to focus path and neighbors within depth
  const result = filterToFocus(moduleMap, edges, focus, maxDepth, circularDeps);
  if (outputFormat === "mermaid") return { mermaid: knowledgeMapToMermaid(result) };
  return result;
}

/**
 * Collect import edges between modules using shared import graph utility.
 * Uses persistent graph cache when available to avoid recomputing edges.
 */
interface CollectedEdges {
  edges: KnowledgeMapEdge[];
  /** Circular deps from cache — null if freshly computed (caller must compute) */
  cachedCircularDeps: CircularDep[] | null;
  /** Graph path + hash for deferred save (null if no registry meta) */
  _graphMeta: {
    graphPath: string;
    indexHash: string;
    importEdges: Array<{ from: string; to: string }>;
    heritageEdges: Array<{ from: string; to: string; kind: "extends" | "implements" }>;
  } | null;
}

function dedupeKnowledgeEdges(...groups: KnowledgeMapEdge[][]): KnowledgeMapEdge[] {
  const seen = new Set<string>();
  const out: KnowledgeMapEdge[] = [];
  for (const group of groups) {
    for (const e of group) {
      const key = `${e.from}|${e.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

async function collectEdges(
  index: CodeIndex,
  moduleMap: Map<string, KnowledgeMapModule>,
): Promise<CollectedEdges> {
  // Try loading cached graph
  const config = loadConfig();
  const meta = await getRepo(config.registryPath, index.repo);
  if (meta) {
    const graphPath = getGraphPath(meta.index_path);
    const indexHash = computeIndexHash(index.files);
    const cached = await loadGraph(graphPath, indexHash);
    if (cached) {
      const importKm = cached.edges
        .filter(
          (e) =>
            (e.kind === "imports" || e.kind === "extends" || e.kind === "implements") &&
            moduleMap.has(e.from) &&
            moduleMap.has(e.to),
        )
        .map((e) => ({ from: e.from, to: e.to }));
      const heritageKm = collectHeritageFileEdges(index)
        .filter((e) => moduleMap.has(e.from) && moduleMap.has(e.to))
        .map((e) => ({ from: e.from, to: e.to }));
      const edges = dedupeKnowledgeEdges(importKm, heritageKm);
      const cachedCircularDeps = cached.circular_deps.length > 0
        ? cached.circular_deps.map((cycle) => ({ cycle, length: cycle.length - 1 }))
        : null;
      return { edges, cachedCircularDeps, _graphMeta: null };
    }

    // Compute fresh
    const importEdges = await collectImportEdges(index);
    const importKm = importEdges
      .filter((e) => moduleMap.has(e.from) && moduleMap.has(e.to))
      .map((e) => ({ from: e.from, to: e.to }));
    const heritageEdges = collectHeritageFileEdges(index).filter(
      (e) => moduleMap.has(e.from) && moduleMap.has(e.to),
    );
    const heritageKm = heritageEdges.map((e) => ({ from: e.from, to: e.to }));
    const edges = dedupeKnowledgeEdges(importKm, heritageKm);

    return {
      edges,
      cachedCircularDeps: null,
      _graphMeta: { graphPath, indexHash, importEdges, heritageEdges },
    };
  }

  // Fallback: no meta available
  const importEdges = await collectImportEdges(index);
  const importKm = importEdges
    .filter((e) => moduleMap.has(e.from) && moduleMap.has(e.to))
    .map((e) => ({ from: e.from, to: e.to }));
  const heritageEdges = collectHeritageFileEdges(index).filter(
    (e) => moduleMap.has(e.from) && moduleMap.has(e.to),
  );
  const heritageKm = heritageEdges.map((e) => ({ from: e.from, to: e.to }));
  const edges = dedupeKnowledgeEdges(importKm, heritageKm);
  return { edges, cachedCircularDeps: null, _graphMeta: null };
}

/**
 * Find circular dependencies using DFS cycle detection.
 * Returns unique cycles (normalized so shortest path is first).
 */
function findCircularDeps(edges: KnowledgeMapEdge[]): CircularDep[] {
  // Build directed adjacency list
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    let list = adj.get(edge.from);
    if (!list) {
      list = [];
      adj.set(edge.from, list);
    }
    list.push(edge.to);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const cycles: CircularDep[] = [];
  const seenCycleKeys = new Set<string>();

  const MAX_CYCLES = 50; // Cap to avoid blowup on large graphs

  function dfs(node: string): void {
    if (cycles.length >= MAX_CYCLES) return;
    color.set(node, GRAY);

    for (const neighbor of adj.get(node) ?? []) {
      if (cycles.length >= MAX_CYCLES) return;
      const neighborColor = color.get(neighbor) ?? WHITE;

      if (neighborColor === GRAY) {
        // Back edge found — extract cycle
        const cycle: string[] = [neighbor];
        let current: string | null | undefined = node;
        while (current && current !== neighbor) {
          cycle.push(current);
          current = parent.get(current);
        }
        cycle.push(neighbor); // close the cycle
        cycle.reverse();

        // Normalize: rotate so lexicographically smallest is first
        const minIdx = cycle.slice(0, -1).reduce(
          (mi, _, i, arr) => (arr[i]! < arr[mi]! ? i : mi), 0,
        );
        const normalized = [...cycle.slice(minIdx, -1), ...cycle.slice(0, minIdx), cycle[minIdx]!];
        const key = normalized.join(" -> ");

        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key);
          cycles.push({ cycle: normalized, length: normalized.length - 1 });
        }
      } else if (neighborColor === WHITE) {
        parent.set(neighbor, node);
        dfs(neighbor);
      }
    }

    color.set(node, BLACK);
  }

  for (const node of adj.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      parent.set(node, null);
      dfs(node);
    }
  }

  // Sort by cycle length (shortest first — most actionable)
  cycles.sort((a, b) => a.length - b.length);
  return cycles;
}

/**
 * Filter the graph to only modules matching the focus path
 * and their neighbors up to maxDepth hops.
 */
function filterToFocus(
  moduleMap: Map<string, KnowledgeMapModule>,
  edges: KnowledgeMapEdge[],
  focus: string,
  maxDepth: number,
  circularDeps: CircularDep[] = [],
): KnowledgeMap {
  // Build adjacency lists (bidirectional for neighbor traversal)
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

  // Find seed modules matching the focus path
  const seeds = new Set<string>();
  for (const [path] of moduleMap) {
    if (path.includes(focus)) {
      seeds.add(path);
    }
  }

  // BFS from seeds up to maxDepth
  const reachable = new Set<string>(seeds);
  let frontier = [...seeds];

  for (let d = 0; d < maxDepth; d++) {
    const nextFrontier: string[] = [];
    for (const node of frontier) {
      const neighbors = adjacency.get(node);
      if (!neighbors) continue;
      for (const neighbor of neighbors) {
        if (!reachable.has(neighbor)) {
          reachable.add(neighbor);
          nextFrontier.push(neighbor);
        }
      }
    }
    if (nextFrontier.length === 0) break;
    frontier = nextFrontier;
  }

  // Filter modules and edges to reachable set, with caps
  const MAX_FOCUSED_MODULES = 200;
  const MAX_FOCUSED_EDGES = 500;

  let filteredModules: KnowledgeMapModule[] = [];
  for (const path of reachable) {
    const mod = moduleMap.get(path);
    if (mod) filteredModules.push(mod);
  }

  if (filteredModules.length > MAX_FOCUSED_MODULES) {
    filteredModules = filteredModules
      .sort((a, b) => b.symbol_count - a.symbol_count)
      .slice(0, MAX_FOCUSED_MODULES);
  }

  const filteredModuleSet = new Set(filteredModules.map((m) => m.path));
  let filteredEdges = edges.filter(
    (e) => filteredModuleSet.has(e.from) && filteredModuleSet.has(e.to),
  );
  if (filteredEdges.length > MAX_FOCUSED_EDGES) {
    filteredEdges = filteredEdges.slice(0, MAX_FOCUSED_EDGES);
  }

  // Filter circular deps to only those involving reachable modules
  const filteredCircular = circularDeps.filter(
    (cd) => cd.cycle.some((path) => reachable.has(path)),
  );

  return { modules: filteredModules, edges: filteredEdges, circular_deps: filteredCircular };
}
