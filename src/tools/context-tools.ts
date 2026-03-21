import { getBM25Index, getCodeIndex } from "./index-tools.js";
import { searchBM25 } from "../search/bm25.js";
import { loadConfig } from "../config.js";
import { collectImportEdges } from "../utils/import-graph.js";
import type { CodeSymbol, CodeIndex } from "../types.js";

export type ContextLevel = "L0" | "L1" | "L2" | "L3";

interface SymbolCompact {
  id: string;
  name: string;
  kind: string;
  file: string;
  start_line: number;
  signature?: string;
  docstring?: string;
}

interface FileSummary {
  path: string;
  language: string;
  exports: string[];
  symbol_count: number;
}

interface DirectoryOverview {
  path: string;
  file_count: number;
  symbol_count: number;
  top_files: string[];
}

export interface AssembleContextResult {
  symbols?: CodeSymbol[];
  compact_symbols?: SymbolCompact[];
  file_summaries?: FileSummary[];
  directory_overview?: DirectoryOverview[];
  level: ContextLevel;
  total_tokens: number;
  truncated: boolean;
  result_count: number;
}

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
 * Estimate token count from source text.
 * Rough heuristic: ~4 characters per token.
 */
function estimateTokens(source: string): number {
  return Math.ceil(source.length / 4);
}

/**
 * Compress a symbol to L1 format (signatures only, no source).
 */
function toCompact(sym: CodeSymbol): SymbolCompact {
  const c: SymbolCompact = {
    id: sym.id,
    name: sym.name,
    kind: sym.kind,
    file: sym.file,
    start_line: sym.start_line,
  };
  if (sym.signature) c.signature = sym.signature;
  if (sym.docstring) c.docstring = sym.docstring;
  return c;
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
  const results = searchBM25(bm25Index, query, topK, config.bm25FieldWeights);

  if (lvl === "L0") {
    // Full source — current behavior
    const symbols: CodeSymbol[] = [];
    let totalTokens = 0;
    let truncated = false;

    for (const result of results) {
      const source = result.symbol.source ?? "";
      const tokens = estimateTokens(source);
      if (totalTokens + tokens > budget) { truncated = true; break; }
      symbols.push(result.symbol);
      totalTokens += tokens;
    }

    return { symbols, level: lvl, total_tokens: totalTokens, truncated, result_count: symbols.length };
  }

  if (lvl === "L1") {
    // Signatures only — 5-10x denser
    const compact: SymbolCompact[] = [];
    let totalTokens = 0;
    let truncated = false;

    for (const result of results) {
      const c = toCompact(result.symbol);
      const tokens = estimateTokens(JSON.stringify(c));
      if (totalTokens + tokens > budget) { truncated = true; break; }
      compact.push(c);
      totalTokens += tokens;
    }

    return { compact_symbols: compact, level: lvl, total_tokens: totalTokens, truncated, result_count: compact.length };
  }

  if (lvl === "L2") {
    // File-level summaries
    const fileMap = new Map<string, { lang: string; exports: string[]; count: number }>();
    for (const result of results) {
      const sym = result.symbol;
      let entry = fileMap.get(sym.file);
      if (!entry) {
        entry = { lang: "unknown", exports: [], count: 0 };
        fileMap.set(sym.file, entry);
      }
      entry.exports.push(`${sym.name}(${sym.kind})`);
      entry.count++;
    }

    // Enrich with language from index
    const codeIndex = await getCodeIndex(repo);
    if (codeIndex) {
      for (const f of codeIndex.files) {
        const entry = fileMap.get(f.path);
        if (entry) entry.lang = f.language;
      }
    }

    const summaries: FileSummary[] = [];
    let totalTokens = 0;
    let truncated = false;

    for (const [path, entry] of fileMap) {
      const summary: FileSummary = { path, language: entry.lang, exports: entry.exports, symbol_count: entry.count };
      const tokens = estimateTokens(JSON.stringify(summary));
      if (totalTokens + tokens > budget) { truncated = true; break; }
      summaries.push(summary);
      totalTokens += tokens;
    }

    return { file_summaries: summaries, level: lvl, total_tokens: totalTokens, truncated, result_count: summaries.length };
  }

  // L3 — Directory overview
  const dirMap = new Map<string, { files: Set<string>; symbols: number }>();
  for (const result of results) {
    const file = result.symbol.file;
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
    let entry = dirMap.get(dir);
    if (!entry) { entry = { files: new Set(), symbols: 0 }; dirMap.set(dir, entry); }
    entry.files.add(file);
    entry.symbols++;
  }

  const overviews: DirectoryOverview[] = [];
  let totalTokens = 0;
  let truncated = false;

  for (const [path, entry] of [...dirMap.entries()].sort((a, b) => b[1].symbols - a[1].symbols)) {
    const overview: DirectoryOverview = {
      path,
      file_count: entry.files.size,
      symbol_count: entry.symbols,
      top_files: [...entry.files].slice(0, 3),
    };
    const tokens = estimateTokens(JSON.stringify(overview));
    if (totalTokens + tokens > budget) { truncated = true; break; }
    overviews.push(overview);
    totalTokens += tokens;
  }

  return { directory_overview: overviews, level: "L3", total_tokens: totalTokens, truncated, result_count: overviews.length };
}

// Import graph utilities moved to src/utils/import-graph.ts

/**
 * Build a module dependency map for a repository.
 * Parses import statements from each file's symbols to discover edges.
 * Optionally filters to modules matching a focus path.
 */
export async function getKnowledgeMap(
  repo: string,
  focus?: string,
  depth?: number,
): Promise<KnowledgeMap> {
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

  // Collect all import edges by reading file source from disk
  const edges = await collectEdges(index, moduleMap);

  const circularDeps = findCircularDeps(edges);

  // If no focus, cap output to prevent 25K+ token responses on large repos
  const MAX_UNFOCUSED_MODULES = 100;
  const MAX_UNFOCUSED_EDGES = 300;

  if (!focus) {
    const allModules = [...moduleMap.values()];
    const cappedModules = allModules.length > MAX_UNFOCUSED_MODULES
      ? allModules.sort((a, b) => b.symbol_count - a.symbol_count).slice(0, MAX_UNFOCUSED_MODULES)
      : allModules;
    const cappedModuleSet = new Set(cappedModules.map((m) => m.path));
    const cappedEdges = edges
      .filter((e) => cappedModuleSet.has(e.from) && cappedModuleSet.has(e.to))
      .slice(0, MAX_UNFOCUSED_EDGES);

    return {
      modules: cappedModules,
      edges: cappedEdges,
      circular_deps: circularDeps,
      ...(allModules.length > MAX_UNFOCUSED_MODULES
        ? { truncated: true, total_modules: allModules.length, hint: `Showing top ${MAX_UNFOCUSED_MODULES} by symbol count. Use focus param to narrow.` }
        : {}),
    };
  }

  // Filter to focus path and neighbors within depth
  return filterToFocus(moduleMap, edges, focus, maxDepth, circularDeps);
}

/**
 * Collect import edges between modules using shared import graph utility.
 */
async function collectEdges(
  index: CodeIndex,
  moduleMap: Map<string, KnowledgeMapModule>,
): Promise<KnowledgeMapEdge[]> {
  const importEdges = await collectImportEdges(index);
  return importEdges
    .filter((e) => moduleMap.has(e.from) && moduleMap.has(e.to))
    .map((e) => ({ from: e.from, to: e.to }));
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
