import { findRepoSymbolNames, getIndexSummary } from "../index-tools.js";
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
  const bestCandidates: Array<{ name: string; score: number }> = [];
  for (const name of names) {
    if (bestCandidates.some((candidate) => candidate.name === name)) continue;
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
    bestCandidates.push({ name, score });
    bestCandidates.sort((left, right) =>
      left.score - right.score || left.name.length - right.name.length,
    );
    if (bestCandidates.length > ZERO_HIT_SUGGESTION_CAP) bestCandidates.pop();
  }
  return bestCandidates.map(({ name }) => name);
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
      // The distinct names in order of first appearance — all the vocabulary needs, since a repeated
      // name never changes the suggestions. One grouped query instead of loading the whole index
      // (ADR-004 stage 2): 0.2 s for 258k names out of 1.4M symbols, against 8-13 s.
      const names = await findRepoSymbolNames(repo);
      if (names.length > 0) {
        const suggestions = suggestFromVocabulary(trimmedQuery, names);
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
    if (!repoMetadata) {
      fallback.semantic_coverage = {
        status: "unknown",
        detail: "repo is not in the registry, so the semantic rescue could not be attempted",
      };
    } else {
      const { existsSync } = await import("node:fs");
      const { getEmbeddingPath, embeddingFileExists } = await import("../../storage/embedding-store.js");
      const { getChunkEmbeddingPath } = await import("../../storage/chunk-store.js");
      const hasEmbeddings = embeddingFileExists(getEmbeddingPath(repoMetadata.index_path))
        || existsSync(getChunkEmbeddingPath(repoMetadata.index_path));

      if (!hasEmbeddings) {
        // Silent until now: with no embedding provider configured (or lite mode on a small
        // machine) the semantic pass never runs, and the caller sees a plain empty result.
        fallback.semantic_coverage = {
          status: "repo_not_embedded",
          detail:
            "no embeddings on disk for this repo — the semantic pass did not run, so this " +
            "result says nothing about matches by meaning",
        };
      } else {
        // The wall-clock race resolves to "" on timeout, which is indistinguishable from a
        // genuine no-match unless we mark it.
        const TIMED_OUT = "\u0000timeout";
        const semanticResults = await raceWallClock(
          semanticSearch(repo, trimmedQuery, { top_k: ZERO_HIT_SEMANTIC_TOP_K }),
          ZERO_HIT_SEMANTIC_CAP_MS,
          () => TIMED_OUT,
        );
        if (semanticResults === TIMED_OUT) {
          fallback.semantic_coverage = {
            status: "timed_out",
            detail: `semantic pass exceeded ${ZERO_HIT_SEMANTIC_CAP_MS}ms and was abandoned`,
          };
        } else {
          fallback.semantic_coverage = { status: "searched" };
          if (semanticResults && semanticResults !== "(no results)") {
            fallback.semantic_results = semanticResults;
          }
        }
      }

      fallback.index_freshness = await assessSearchIndexFreshness(repo, repoMetadata);
    }
  } catch (err) {
    // Best-effort, but not silent: an agent that cannot tell "checked" from "could not check"
    // reads an empty result as proof of absence.
    fallback.semantic_coverage ??= {
      status: "unknown",
      detail: `semantic rescue failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return fallback;
}

/** Translate the index-freshness verdict into the shape the search response carries. */
async function assessSearchIndexFreshness(
  repo: string,
  repoMetadata: { last_git_commit?: string },
): Promise<NonNullable<ZeroHitFallbackResult["index_freshness"]>> {
  try {
    const index = await getIndexSummary(repo, { skipFreshness: true });
    if (!index) return { status: "unknown", detail: "no index could be loaded for this repo" };
    const { assessIndexFreshness } = await import("../plan-turn/stale-index.js");
    const freshness = assessIndexFreshness(index, repoMetadata.last_git_commit);
    if (freshness.status === "current") return { status: "current" };
    if (freshness.status === "stale") {
      return {
        status: "stale",
        detail:
          `the index was built at ${freshness.indexedCommit.slice(0, 7)} but HEAD is ` +
          `${freshness.headCommit.slice(0, 7)} — an empty result may just be missing code`,
      };
    }
    const hours = Math.round(freshness.ageMs / 3_600_000);
    return {
      status: "unknown",
      detail:
        `could not verify the index against git (${freshness.basis}); it is ~${hours}h old` +
        (freshness.likelyStale ? " and probably behind the working tree" : ""),
    };
  } catch {
    return { status: "unknown", detail: "index freshness could not be determined" };
  }
}
