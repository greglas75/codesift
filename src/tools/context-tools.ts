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

export interface KnowledgeMap {
  modules: KnowledgeMapModule[];
  edges: KnowledgeMapEdge[];
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

  // Collect all import edges by scanning symbol source
  const edges = collectEdges(index, moduleMap);

  // If no focus, return the full graph (limited by depth from roots)
  if (!focus) {
    return {
      modules: [...moduleMap.values()],
      edges,
    };
  }

  // Filter to focus path and neighbors within depth
  return filterToFocus(moduleMap, edges, focus, maxDepth);
}

/**
 * Scan all symbols to collect import edges between modules.
 */
function collectEdges(
  index: CodeIndex,
  moduleMap: Map<string, KnowledgeMapModule>,
): KnowledgeMapEdge[] {
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

  for (const sym of index.symbols) {
    if (!sym.source) continue;

    const importPaths = extractImports(sym.source);
    for (const importPath of importPaths) {
      const resolved = resolveImportPath(sym.file, importPath);
      const targetFile = normalizedPaths.get(resolved);
      if (!targetFile || targetFile === sym.file) continue;

      const edgeKey = `${sym.file}->${targetFile}`;
      if (edgeSet.has(edgeKey)) continue;
      edgeSet.add(edgeKey);

      // Ensure both modules exist in the map
      if (moduleMap.has(sym.file) && moduleMap.has(targetFile)) {
        edges.push({ from: sym.file, to: targetFile });
      }
    }
  }

  return edges;
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

  return { modules: filteredModules, edges: filteredEdges };
}
