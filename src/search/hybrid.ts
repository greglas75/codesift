import type { SearchResult } from "../types.js";

/**
 * Reciprocal Rank Fusion (RRF) combining BM25 + semantic search results.
 *
 * Formula: score(d) = Σ 1/(k + rank_i(d))
 * where k=60 is the standard RRF constant and rank_i is the rank
 * of document d in result list i (1-based).
 *
 * @param bm25Results - Results from BM25 search, ordered by score
 * @param semanticResults - Results from semantic search, ordered by similarity
 * @param topK - Number of results to return
 * @param k - RRF constant (default 60)
 * @returns Merged results sorted by RRF score
 */
export function hybridRank(
  bm25Results: SearchResult[],
  semanticResults: SearchResult[],
  topK: number,
  k = 60,
): SearchResult[] {
  const scores = new Map<string, number>();
  const symbolLookup = new Map<string, SearchResult>();

  // BM25 ranks (1-based)
  for (let i = 0; i < bm25Results.length; i++) {
    const result = bm25Results[i]!;
    const id = result.symbol.id;
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    if (!symbolLookup.has(id)) {
      symbolLookup.set(id, result);
    }
  }

  // Semantic ranks (1-based)
  for (let i = 0; i < semanticResults.length; i++) {
    const result = semanticResults[i]!;
    const id = result.symbol.id;
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    if (!symbolLookup.has(id)) {
      symbolLookup.set(id, result);
    }
  }

  // Sort by combined RRF score
  const sorted = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK);

  const results: SearchResult[] = [];
  for (const [id, score] of sorted) {
    const original = symbolLookup.get(id);
    if (original) {
      const result: SearchResult = { symbol: original.symbol, score };
      if (original.matches) result.matches = original.matches;
      results.push(result);
    }
  }

  return results;
}
