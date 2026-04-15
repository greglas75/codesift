export interface SurpriseScore {
  community_a: string;
  community_b: string;
  structural_score: number;  // actual_edges / expected_edges
  temporal_score: number;    // max jaccard from co_change pairs crossing this boundary
  combined_score: number;    // 0.6 * structural + 0.4 * temporal
  edge_count: number;        // actual cross-boundary edges
  example_files: [string, string];  // one representative file pair
}

export interface CrossEdge {
  from_community: string;
  to_community: string;
  from_file: string;
  to_file: string;
}

export interface CoChangePair {
  file_a: string;
  file_b: string;
  jaccard: number;
}

export interface CommunityInfo {
  name: string;
  files: string[];
  size: number;
}

/**
 * Pure function — computes surprise scores for cross-community boundaries.
 * No async, no MCP infrastructure imports.
 */
export function computeSurpriseScores(
  communities: CommunityInfo[],
  crossEdges: CrossEdge[],
  coChangePairs: CoChangePair[],
  globalDensity: number,
): SurpriseScore[] {
  if (communities.length === 0) return [];

  // Build a lookup: community name → file set
  const communityFiles = new Map<string, Set<string>>();
  const communitySize = new Map<string, number>();
  for (const c of communities) {
    communityFiles.set(c.name, new Set(c.files));
    communitySize.set(c.name, c.size);
  }

  // Canonical pair key: always sort so (A,B) === (B,A)
  function pairKey(a: string, b: string): string {
    return a < b ? `${a}\0${b}` : `${b}\0${a}`;
  }

  // Group cross-edges by canonical community pair
  type EdgeGroup = {
    community_a: string;
    community_b: string;
    edges: CrossEdge[];
  };
  const groups = new Map<string, EdgeGroup>();

  for (const edge of crossEdges) {
    const ca = edge.from_community;
    const cb = edge.to_community;
    if (ca === cb) continue;
    const key = pairKey(ca, cb);
    if (!groups.has(key)) {
      const [a, b] = ca < cb ? [ca, cb] : [cb, ca];
      groups.set(key, { community_a: a!, community_b: b!, edges: [] });
    }
    groups.get(key)!.edges.push(edge);
  }

  const results: SurpriseScore[] = [];

  for (const [, group] of groups) {
    const { community_a, community_b, edges } = group;
    const sizeA = communitySize.get(community_a) ?? 0;
    const sizeB = communitySize.get(community_b) ?? 0;
    const filesA = communityFiles.get(community_a) ?? new Set<string>();
    const filesB = communityFiles.get(community_b) ?? new Set<string>();

    const edgeCount = edges.length;
    const expected = sizeA * sizeB * globalDensity;
    const structuralScore = expected === 0 ? 0 : edgeCount / expected;

    // Find co-change pairs crossing this boundary
    let temporalScore = 0;
    let bestPair: [string, string] | null = null;

    for (const pair of coChangePairs) {
      const aInA = filesA.has(pair.file_a);
      const bInB = filesB.has(pair.file_b);
      const aInB = filesB.has(pair.file_a);
      const bInA = filesA.has(pair.file_b);
      const crossesBoundary = (aInA && bInB) || (aInB && bInA);

      if (crossesBoundary && pair.jaccard > temporalScore) {
        temporalScore = pair.jaccard;
        bestPair = (aInA && bInB)
          ? [pair.file_a, pair.file_b]
          : [pair.file_b, pair.file_a];
      }
    }

    // Fall back to first cross edge if no co-change data
    const exampleFiles: [string, string] = bestPair !== null
      ? bestPair
      : [edges[0]!.from_file, edges[0]!.to_file];

    const combinedScore = 0.6 * structuralScore + 0.4 * temporalScore;

    results.push({
      community_a,
      community_b,
      structural_score: structuralScore,
      temporal_score: temporalScore,
      combined_score: combinedScore,
      edge_count: edgeCount,
      example_files: exampleFiles,
    });
  }

  // Sort by combined_score descending
  results.sort((a, b) => b.combined_score - a.combined_score);

  return results;
}
