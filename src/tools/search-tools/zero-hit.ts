import { getCodeIndex } from "../index-tools.js";
import { loadConfig } from "../../config.js";
import { raceWallClock } from "../../utils/wall-clock.js";
import {
  ZERO_HIT_EDIT_DISTANCE_MAX,
  ZERO_HIT_MIN_QUERY_LEN,
  ZERO_HIT_SEMANTIC_CAP_MS,
  ZERO_HIT_SEMANTIC_TOP_K,
  ZERO_HIT_SUGGESTION_CAP,
} from "./constants.js";
import { semanticSearch } from "./semantic-search.js";
import type { ZeroHitFallbackResult } from "./types.js";

function boundedEditDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMinimum = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      if (current[j]! < rowMinimum) rowMinimum = current[j]!;
    }
    if (rowMinimum > max) return max + 1;
    previous = current;
  }
  return previous[b.length]!;
}

function suggestFromVocabulary(query: string, names: Iterable<string>): string[] {
  const normalizedQuery = query.toLowerCase();
  const scored: Array<{ name: string; score: number }> = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const normalizedName = name.toLowerCase();
    if (normalizedName === normalizedQuery) continue;
    let score: number;
    if (normalizedName.includes(normalizedQuery) || normalizedQuery.includes(normalizedName)) {
      score = Math.abs(normalizedName.length - normalizedQuery.length);
    } else {
      const distance = boundedEditDistance(normalizedQuery, normalizedName, ZERO_HIT_EDIT_DISTANCE_MAX);
      if (distance > ZERO_HIT_EDIT_DISTANCE_MAX) continue;
      score = 10 + distance;
    }
    scored.push({ name, score });
  }
  scored.sort((left, right) => left.score - right.score || left.name.length - right.name.length);
  return scored.slice(0, ZERO_HIT_SUGGESTION_CAP).map(({ name }) => name);
}

export async function zeroHitFallback(
  repo: string,
  query: string,
): Promise<ZeroHitFallbackResult> {
  const fallback: ZeroHitFallbackResult = {};
  const trimmedQuery = query.trim();
  if (trimmedQuery.length < ZERO_HIT_MIN_QUERY_LEN) return fallback;

  if (!/\s/.test(trimmedQuery)) {
    try {
      const index = await getCodeIndex(repo);
      if (index) {
        const suggestions = suggestFromVocabulary(
          trimmedQuery,
          index.symbols.map((symbol) => symbol.name),
        );
        if (suggestions.length > 0) fallback.suggestions = suggestions;
      }
    } catch {
      // Vocabulary suggestions are best-effort.
    }
  }

  try {
    const config = loadConfig();
    const { getRepo } = await import("../../storage/registry.js");
    const repoMetadata = await getRepo(config.registryPath, repo);
    if (repoMetadata) {
      const { existsSync } = await import("node:fs");
      const { getEmbeddingPath } = await import("../../storage/embedding-store.js");
      const { getChunkEmbeddingPath } = await import("../../storage/chunk-store.js");
      const hasEmbeddings = existsSync(getEmbeddingPath(repoMetadata.index_path))
        || existsSync(getChunkEmbeddingPath(repoMetadata.index_path));
      if (hasEmbeddings) {
        const semanticResults = await raceWallClock(
          semanticSearch(repo, trimmedQuery, { top_k: ZERO_HIT_SEMANTIC_TOP_K }),
          ZERO_HIT_SEMANTIC_CAP_MS,
          () => "",
        );
        if (semanticResults && semanticResults !== "(no results)") {
          fallback.semantic_results = semanticResults;
        }
      }
    }
  } catch {
    // Semantic rescue is best-effort.
  }

  return fallback;
}
