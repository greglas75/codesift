/**
 * Louvain community detection — discover code clusters from the import graph.
 */
import { getCodeIndex } from "./index-tools.js";
import { collectImportEdges } from "../utils/import-graph.js";
import type { ImportEdge } from "../utils/import-graph.js";

export interface Community {
  id: number;
  name: string;
  files: string[];
  symbol_count: number;
  internal_edges: number;
  external_edges: number;
  cohesion: number;
}

export interface CommunityResult {
  communities: Community[];
  modularity: number;
  total_files: number;
  algorithm: "louvain";
  resolution: number;
}

/**
 * Louvain method for community detection on an undirected weighted graph.
 * Returns mapping: node → community ID.
 */
function louvain(
  nodes: string[],
  adj: Map<string, Map<string, number>>,
  resolution: number,
): Map<string, number> {
  const community = new Map<string, number>();
  const nodeSet = new Set(nodes);

  // Init: each node in its own community
  let nextId = 0;
  for (const node of nodes) {
    community.set(node, nextId++);
  }

  // Total edge weight
  let totalWeight = 0;
  for (const [, neighbors] of adj) {
    for (const [, w] of neighbors) totalWeight += w;
  }
  totalWeight /= 2; // Each edge counted twice
  if (totalWeight === 0) return community;

  // Degree (sum of edge weights per node)
  const degree = new Map<string, number>();
  for (const node of nodes) {
    let d = 0;
    const neighbors = adj.get(node);
    if (neighbors) for (const [, w] of neighbors) d += w;
    degree.set(node, d);
  }

  // Phase 1: Local moves
  const MAX_PASSES = 20;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let improved = false;

    for (const node of nodes) {
      if (!nodeSet.has(node)) continue;

      const currentComm = community.get(node)!;
      const ki = degree.get(node) ?? 0;
      const neighbors = adj.get(node);
      if (!neighbors) continue;

      // Calculate weight to each neighboring community
      const commWeights = new Map<number, number>();
      for (const [neighbor, w] of neighbors) {
        const nc = community.get(neighbor)!;
        commWeights.set(nc, (commWeights.get(nc) ?? 0) + w);
      }

      // Sum of degrees in current community (excluding this node)
      let sigmaCurrentWithout = 0;
      for (const [n, c] of community) {
        if (c === currentComm && n !== node) sigmaCurrentWithout += degree.get(n) ?? 0;
      }

      const weightToCurrentComm = commWeights.get(currentComm) ?? 0;
      const removeCost = weightToCurrentComm - resolution * ki * sigmaCurrentWithout / (2 * totalWeight);

      let bestComm = currentComm;
      let bestGain = 0;

      for (const [targetComm, weightToTarget] of commWeights) {
        if (targetComm === currentComm) continue;

        let sigmaTarget = 0;
        for (const [n, c] of community) {
          if (c === targetComm) sigmaTarget += degree.get(n) ?? 0;
        }

        const gain = (weightToTarget - resolution * ki * sigmaTarget / (2 * totalWeight)) - removeCost;
        if (gain > bestGain) {
          bestGain = gain;
          bestComm = targetComm;
        }
      }

      if (bestComm !== currentComm) {
        community.set(node, bestComm);
        improved = true;
      }
    }

    if (!improved) break;
  }

  // Renumber communities to be contiguous (0, 1, 2, ...)
  const commMap = new Map<number, number>();
  let nextComm = 0;
  for (const [, c] of community) {
    if (!commMap.has(c)) commMap.set(c, nextComm++);
  }
  for (const [node, c] of community) {
    community.set(node, commMap.get(c)!);
  }

  return community;
}

/**
 * Calculate modularity Q for a partition.
 */
function calculateModularity(
  community: Map<string, number>,
  adj: Map<string, Map<string, number>>,
): number {
  let totalWeight = 0;
  for (const [, neighbors] of adj) {
    for (const [, w] of neighbors) totalWeight += w;
  }
  totalWeight /= 2;
  if (totalWeight === 0) return 0;

  const degree = new Map<string, number>();
  for (const [node, neighbors] of adj) {
    let d = 0;
    for (const [, w] of neighbors) d += w;
    degree.set(node, d);
  }

  let Q = 0;
  for (const [i, neighbors] of adj) {
    for (const [j, Aij] of neighbors) {
      if (community.get(i) !== community.get(j)) continue;
      const ki = degree.get(i) ?? 0;
      const kj = degree.get(j) ?? 0;
      Q += Aij - (ki * kj) / (2 * totalWeight);
    }
  }

  return Q / (2 * totalWeight);
}

/**
 * Auto-name a community from the most specific common path prefix.
 * Falls back to most frequent directory if no unique prefix.
 */
function nameCommunity(files: string[], id: number): string {
  if (files.length === 0) return `community-${id}`;
  if (files.length === 1) {
    const dir = files[0]!.split("/").slice(0, -1).join("/");
    return dir || files[0]!;
  }

  // Find deepest common prefix
  const parts = files.map((f) => f.split("/"));
  const minLen = Math.min(...parts.map((p) => p.length));
  let common = 0;
  for (let i = 0; i < minLen - 1; i++) {
    if (parts.every((p) => p[i] === parts[0]![i])) common = i + 1;
    else break;
  }

  // If common prefix is too short (just "src"), use most frequent subdirectory
  if (common <= 1 && minLen > 2) {
    const dirCounts = new Map<string, number>();
    for (const p of parts) {
      const dir = p.slice(0, Math.min(3, p.length - 1)).join("/");
      dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }
    const topDir = [...dirCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topDir) return topDir[0];
  }

  return common > 0
    ? parts[0]!.slice(0, common).join("/")
    : `community-${id}`;
}

const MAX_MERMAID_COMMUNITIES = 15;
const MAX_MERMAID_FILES_PER = 5;

function communityToMermaid(result: CommunityResult, edges: ImportEdge[]): string {
  const lines: string[] = ["graph LR"];
  const comms = result.communities.slice(0, MAX_MERMAID_COMMUNITIES);

  const fileToCommunity = new Map<string, number>();
  for (const c of comms) {
    for (const f of c.files) {
      if (!f.startsWith("...")) fileToCommunity.set(f, c.id);
    }
  }

  for (const c of comms) {
    const safeId = `c${c.id}`;
    const label = `${c.name} (${c.files.length} files)`;
    lines.push(`    subgraph ${safeId}["${label}"]`);
    const showFiles = c.files.filter((f) => !f.startsWith("...")).slice(0, MAX_MERMAID_FILES_PER);
    for (const f of showFiles) {
      const short = f.split("/").pop()?.replace(/\.\w+$/, "") ?? f;
      const nodeId = (safeId + "_" + short).replace(/[^a-zA-Z0-9_]/g, "_");
      lines.push(`        ${nodeId}["${short}"]`);
    }
    lines.push("    end");
  }

  const crossEdges = new Set<string>();
  for (const edge of edges) {
    const fromC = fileToCommunity.get(edge.from);
    const toC = fileToCommunity.get(edge.to);
    if (fromC !== undefined && toC !== undefined && fromC !== toC) {
      const key = fromC < toC ? `c${fromC}-->c${toC}` : `c${toC}-->c${fromC}`;
      if (!crossEdges.has(key)) {
        crossEdges.add(key);
        lines.push(`    c${Math.min(fromC, toC)} --> c${Math.max(fromC, toC)}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Detect code communities using Louvain algorithm on the import graph.
 */
export async function detectCommunities(
  repo: string,
  focus?: string,
  resolution?: number,
  outputFormat?: "json" | "mermaid",
): Promise<CommunityResult | { mermaid: string }> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  // Filter files by focus; cap without focus to prevent 66K tok responses
  const MAX_UNFOCUSED_FILES = 500;
  const MAX_COMMUNITIES = 20;
  let files = focus
    ? index.files.filter((f) => f.path.includes(focus))
    : index.files;

  if (!focus && files.length > MAX_UNFOCUSED_FILES) {
    // Keep files with most symbols (most architecturally relevant)
    files = [...files].sort((a, b) => b.symbol_count - a.symbol_count).slice(0, MAX_UNFOCUSED_FILES);
  }

  const fileSet = new Set(files.map((f) => f.path));
  const edges = await collectImportEdges(index, fileSet);

  // Build weighted undirected adjacency
  const adj = new Map<string, Map<string, number>>();
  for (const node of fileSet) adj.set(node, new Map());
  for (const edge of edges) {
    if (!fileSet.has(edge.from) || !fileSet.has(edge.to)) continue;
    const fromAdj = adj.get(edge.from)!;
    fromAdj.set(edge.to, (fromAdj.get(edge.to) ?? 0) + 1);
    const toAdj = adj.get(edge.to)!;
    toAdj.set(edge.from, (toAdj.get(edge.from) ?? 0) + 1);
  }

  const res = resolution ?? 1.0;
  const communityMap = louvain([...fileSet], adj, res);
  const modularity = calculateModularity(communityMap, adj);

  // Group files by community
  const groups = new Map<number, string[]>();
  for (const [file, comm] of communityMap) {
    let list = groups.get(comm);
    if (!list) { list = []; groups.set(comm, list); }
    list.push(file);
  }

  // Symbol count per file
  const symCountByFile = new Map<string, number>();
  for (const f of index.files) symCountByFile.set(f.path, f.symbol_count);

  // Build community objects
  const communities: Community[] = [];
  for (const [id, communityFiles] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const fileSetComm = new Set(communityFiles);
    let internal = 0;
    let external = 0;
    for (const edge of edges) {
      const fromIn = fileSetComm.has(edge.from);
      const toIn = fileSetComm.has(edge.to);
      if (fromIn && toIn) internal++;
      else if (fromIn || toIn) external++;
    }

    const MAX_FILES_PER_COMMUNITY = 20;
    const sortedFiles = communityFiles.sort();
    communities.push({
      id,
      name: nameCommunity(communityFiles, id),
      files: sortedFiles.length > MAX_FILES_PER_COMMUNITY
        ? [...sortedFiles.slice(0, MAX_FILES_PER_COMMUNITY), `... +${sortedFiles.length - MAX_FILES_PER_COMMUNITY} more`]
        : sortedFiles,
      symbol_count: communityFiles.reduce((sum, f) => sum + (symCountByFile.get(f) ?? 0), 0),
      internal_edges: internal,
      external_edges: external,
      cohesion: internal + external > 0 ? internal / (internal + external) : 0,
    });
  }

  // Cap communities output
  const cappedCommunities = communities.slice(0, MAX_COMMUNITIES);

  const result: CommunityResult = {
    communities: cappedCommunities,
    modularity: Math.round(modularity * 1000) / 1000,
    total_files: files.length,
    ...(communities.length > MAX_COMMUNITIES
      ? { truncated: true, total_communities: communities.length }
      : {}),
    algorithm: "louvain",
    resolution: res,
  };

  if (outputFormat === "mermaid") {
    return { mermaid: communityToMermaid(result, edges) };
  }

  return result;
}
