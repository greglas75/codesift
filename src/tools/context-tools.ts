import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getBM25Index, getCodeIndex } from "./index-tools.js";
import { searchBM25 } from "../search/bm25.js";
import { loadConfig } from "../config.js";
import type { CodeSymbol, CodeIndex } from "../types.js";

export interface AssembleContextResult {
  symbols: CodeSymbol[];
  total_tokens: number;
  truncated: boolean;
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
 * Assemble a context window of relevant code for a query.
 * Uses BM25 search to find the most relevant symbols and accumulates
 * them until the token budget is reached.
 */
export async function assembleContext(
  repo: string,
  query: string,
  tokenBudget?: number,
): Promise<AssembleContextResult> {
  const bm25Index = await getBM25Index(repo);
  if (!bm25Index) {
    throw new Error(`Repository not found: ${repo}`);
  }

  const config = loadConfig();
  const budget = tokenBudget ?? config.defaultTokenBudget;
  const topK = 20;

  const results = searchBM25(bm25Index, query, topK, config.bm25FieldWeights);

  const symbols: CodeSymbol[] = [];
  let totalTokens = 0;
  let truncated = false;

  for (const result of results) {
    const source = result.symbol.source ?? "";
    const tokens = estimateTokens(source);

    if (totalTokens + tokens > budget) {
      truncated = true;
      break;
    }

    symbols.push(result.symbol);
    totalTokens += tokens;
  }

  return { symbols, total_tokens: totalTokens, truncated };
}

// Patterns for detecting import statements across common languages
const IMPORT_PATTERNS = [
  // ES modules: import ... from '...' or import ... from "..."
  /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
  // Dynamic import: import('...')
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // CommonJS: require('...')
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * Extract import paths from a source string.
 * Returns relative paths only (skips node_modules / bare specifiers).
 */
function extractImports(source: string): string[] {
  const imports = new Set<string>();

  for (const pattern of IMPORT_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const importPath = match[1];
      if (importPath && importPath.startsWith(".")) {
        imports.add(importPath);
      }
    }
  }

  return [...imports];
}

/**
 * Normalize an import path relative to the importing file.
 * Resolves "./foo" and "../bar" relative to the importer's directory.
 */
function resolveImportPath(importerFile: string, importPath: string): string {
  const importerDir = importerFile.includes("/")
    ? importerFile.slice(0, importerFile.lastIndexOf("/"))
    : ".";

  const parts = importerDir.split("/");

  for (const segment of importPath.split("/")) {
    if (segment === ".") continue;
    if (segment === "..") {
      parts.pop();
    } else {
      parts.push(segment);
    }
  }

  let resolved = parts.join("/");

  // Strip file extension for matching (imports often omit .ts/.js)
  resolved = resolved.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");

  return resolved;
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
 * Read files from disk and collect import edges between modules.
 * Reads full file content (not just symbol source) to capture top-level imports.
 */
async function collectEdges(
  index: CodeIndex,
  moduleMap: Map<string, KnowledgeMapModule>,
): Promise<KnowledgeMapEdge[]> {
  const edgeSet = new Set<string>();
  const edges: KnowledgeMapEdge[] = [];

  // Build a set of normalized module paths for matching
  const normalizedPaths = new Map<string, string>();
  for (const file of index.files) {
    const normalized = file.path.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
    normalizedPaths.set(normalized, file.path);
    // Also handle index files: "foo/index" -> "foo"
    if (normalized.endsWith("/index")) {
      normalizedPaths.set(normalized.slice(0, -6), file.path);
    }
  }

  for (const file of index.files) {
    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch {
      continue; // File may have been deleted
    }

    const importPaths = extractImports(source);
    for (const importPath of importPaths) {
      const resolved = resolveImportPath(file.path, importPath);
      const targetFile = normalizedPaths.get(resolved);
      if (!targetFile || targetFile === file.path) continue;

      const edgeKey = `${file.path}->${targetFile}`;
      if (edgeSet.has(edgeKey)) continue;
      edgeSet.add(edgeKey);

      if (moduleMap.has(file.path) && moduleMap.has(targetFile)) {
        edges.push({ from: file.path, to: targetFile });
      }
    }
  }

  return edges;
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

  // Filter modules and edges to reachable set
  const filteredModules: KnowledgeMapModule[] = [];
  for (const path of reachable) {
    const mod = moduleMap.get(path);
    if (mod) {
      filteredModules.push(mod);
    }
  }

  const filteredEdges = edges.filter(
    (e) => reachable.has(e.from) && reachable.has(e.to),
  );

  // Filter circular deps to only those involving reachable modules
  const filteredCircular = circularDeps.filter(
    (cd) => cd.cycle.some((path) => reachable.has(path)),
  );

  return { modules: filteredModules, edges: filteredEdges, circular_deps: filteredCircular };
}
