import type { SymbolKind } from "../types.js";
import { getCodeIndex } from "./index-tools.js";
import { parseFile } from "../parser/parser-manager.js";
import { isTestFileStrict as isTestFile } from "../utils/test-file.js";

// --- Exported types ---

export interface ShapeCluster {
  hash: string;
  root_node_type: string;
  count: number;
  node_count: number;
  shape_preview: string;
  examples: Array<{
    name: string;
    kind: SymbolKind;
    file: string;
    start_line: number;
  }>;
}

export interface FrequencyResult {
  clusters: ShapeCluster[];
  summary: {
    total_symbols_analyzed: number;
    total_nodes_hashed: number;
    total_clusters_found: number;
    clusters_returned: number;
    skipped_no_source: number;
    skipped_truncated: number;
    skipped_below_min: number;
    low_signal: boolean;
  };
}

// --- Hash ---

export function djb2(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

// --- Normalization ---

const IDENTIFIER_TYPES = new Set([
  "identifier", "property_identifier", "type_identifier",
  "shorthand_property_identifier", "shorthand_property_identifier_pattern", "name",
]);
const STRING_TYPES = new Set(["string", "template_string", "string_fragment", "string_content"]);
const NUMBER_TYPES = new Set(["number", "integer", "float"]);
const BOOLEAN_TYPES = new Set(["true", "false"]);

export function normalizeNodeType(nodeType: string, _text: string): string {
  if (IDENTIFIER_TYPES.has(nodeType)) return "_";
  if (STRING_TYPES.has(nodeType)) return "_S";
  if (NUMBER_TYPES.has(nodeType)) return "_N";
  if (BOOLEAN_TYPES.has(nodeType)) return "_B";
  return nodeType;
}

// --- Hash result ---

export interface HashResult {
  hash: number;
  nodeCount: number;
  normalizedPreview: string;
}

export function hashSubtree(root: any): HashResult {
  // Iterative post-order traversal using explicit stack (avoids stack overflow)
  const stack: Array<{ node: any; childIndex: number }> = [{ node: root, childIndex: 0 }];
  const hashMap = new Map<any, { hash: number; count: number }>();

  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    const children: any[] = top.node.namedChildren || [];

    if (top.childIndex < children.length) {
      const child = children[top.childIndex];
      top.childIndex++;
      stack.push({ node: child, childIndex: 0 });
    } else {
      stack.pop();
      const node = top.node;
      const normalized = normalizeNodeType(node.type, node.text || "");

      let hashStr = normalized;
      let count = 1;
      for (const child of children) {
        const childResult = hashMap.get(child);
        if (childResult) {
          hashStr += ":" + childResult.hash.toString(36);
          count += childResult.count;
        }
      }

      hashMap.set(node, { hash: djb2(hashStr), count });
    }
  }

  const rootResult = hashMap.get(root);
  if (!rootResult) return { hash: 0, nodeCount: 0, normalizedPreview: "" };

  // Build normalized preview (depth-limited recursive — safe for display, max depth 10)
  const buildPreview = (node: any, depth: number): string => {
    if (depth > 10) return "...";
    const norm = normalizeNodeType(node.type, node.text || "");
    const childPreviews = (node.namedChildren || [])
      .map((c: any) => buildPreview(c, depth + 1))
      .join(" ");
    return childPreviews ? `${norm}(${childPreviews})` : norm;
  };

  return {
    hash: rootResult.hash,
    nodeCount: rootResult.count,
    normalizedPreview: buildPreview(root, 0).slice(0, 300),
  };
}

// --- Core analysis ---

const ANALYZABLE_KINDS = new Set<SymbolKind>(["function", "method", "class", "component", "hook"]);

interface FrequencyOptions {
  top_n?: number | undefined;
  min_nodes?: number | undefined;
  file_pattern?: string | undefined;
  kind?: string | undefined;
  include_tests?: boolean | undefined;
  token_budget?: number | undefined;
}

export async function frequencyAnalysis(
  repo: string,
  options?: FrequencyOptions,
): Promise<FrequencyResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Run index_folder first.`);

  const topN = options?.top_n ?? 30;
  const minNodes = options?.min_nodes ?? 5;
  const includeTests = options?.include_tests ?? false;
  const kinds = options?.kind
    ? new Set(options.kind.split(",").map(s => s.trim()))
    : ANALYZABLE_KINDS;

  let skippedNoSource = 0;
  let skippedTruncated = 0;
  let skippedBelowMin = 0;
  let totalNodesHashed = 0;

  type SymbolRef = { name: string; kind: SymbolKind; file: string; start_line: number };
  const clusterMap = new Map<number, {
    rootNodeType: string;
    nodeCount: number;
    normalizedPreview: string;
    symbols: SymbolRef[];
  }>();

  const filteredSymbols: typeof index.symbols = [];
  for (const sym of index.symbols) {
    if (!kinds.has(sym.kind)) continue;
    if (!includeTests && isTestFile(sym.file)) continue;
    if (options?.file_pattern && !sym.file.includes(options.file_pattern)) continue;
    if (!sym.source) { skippedNoSource++; continue; }
    if (sym.source.endsWith("...")) { skippedTruncated++; continue; }
    filteredSymbols.push(sym);
  }

  for (const sym of filteredSymbols) {
    const tree = await parseFile(sym.file, sym.source!);
    if (!tree) { skippedNoSource++; continue; }

    const result = hashSubtree(tree.rootNode);
    totalNodesHashed += result.nodeCount;

    if (result.nodeCount < minNodes) { skippedBelowMin++; continue; }

    const ref: SymbolRef = { name: sym.name, kind: sym.kind, file: sym.file, start_line: sym.start_line };
    const existing = clusterMap.get(result.hash);
    if (existing) {
      existing.symbols.push(ref);
    } else {
      clusterMap.set(result.hash, {
        rootNodeType: tree.rootNode.type,
        nodeCount: result.nodeCount,
        normalizedPreview: result.normalizedPreview,
        symbols: [ref],
      });
    }
  }

  const allClusters = [...clusterMap.entries()]
    .filter(([_, c]) => c.symbols.length >= 2)
    .sort((a, b) => b[1].symbols.length - a[1].symbols.length);

  const totalClustersFound = allClusters.length;
  const topClusters = allClusters.slice(0, topN);

  const CHARS_PER_TOKEN = 3.5;
  let budgetClusters = topClusters;
  if (options?.token_budget) {
    const summaryTokens = 200;
    let used = summaryTokens;
    const fitted: typeof topClusters = [];
    for (const entry of topClusters) {
      const tok = Math.ceil(JSON.stringify(entry).length / CHARS_PER_TOKEN);
      if (used + tok > options.token_budget) break;
      used += tok;
      fitted.push(entry);
    }
    budgetClusters = fitted;
  }

  const clusters: ShapeCluster[] = budgetClusters.map(([hash, c]) => ({
    hash: (hash >>> 0).toString(16).padStart(8, "0"),
    root_node_type: c.rootNodeType,
    count: c.symbols.length,
    node_count: c.nodeCount,
    shape_preview: c.normalizedPreview.slice(0, 300),
    examples: c.symbols
      .sort((a, b) => a.file.localeCompare(b.file))
      .slice(0, 5),
  }));

  const largestCount = clusters[0]?.count ?? 0;

  return {
    clusters,
    summary: {
      total_symbols_analyzed: filteredSymbols.length,
      total_nodes_hashed: totalNodesHashed,
      total_clusters_found: totalClustersFound,
      clusters_returned: clusters.length,
      skipped_no_source: skippedNoSource,
      skipped_truncated: skippedTruncated,
      skipped_below_min: skippedBelowMin,
      low_signal: filteredSymbols.length < 50 || largestCount < 3,
    },
  };
}
