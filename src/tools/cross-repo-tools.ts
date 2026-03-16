import { searchSymbols, type SearchSymbolsOptions } from "./search-tools.js";
import { findReferences } from "./symbol-tools.js";
import { listAllRepos } from "./index-tools.js";
import type { SearchResult, Reference } from "../types.js";

export interface CrossRepoSymbolResult {
  repo: string;
  results: SearchResult[];
}

export interface CrossRepoRefResult {
  repo: string;
  references: Reference[];
}

export interface CrossRepoSearchResult {
  symbol_results: CrossRepoSymbolResult[];
  total_matches: number;
  repos_searched: number;
}

export interface CrossRepoRefSearchResult {
  ref_results: CrossRepoRefResult[];
  total_references: number;
  repos_searched: number;
}

/**
 * Search symbols across ALL indexed repos (or a filtered subset).
 * Useful for monorepos and microservice architectures.
 */
export async function crossRepoSearchSymbols(
  query: string,
  options?: SearchSymbolsOptions & {
    repo_pattern?: string | undefined;
  },
): Promise<CrossRepoSearchResult> {
  const repos = await listAllRepos({ compact: false }) as Array<{ name: string }>;

  const repoPattern = options?.repo_pattern;
  const filtered = repoPattern
    ? repos.filter((r) => r.name.includes(repoPattern))
    : repos;

  const symbolResults: CrossRepoSymbolResult[] = [];
  let totalMatches = 0;

  for (const repo of filtered) {
    try {
      const results = await searchSymbols(repo.name, query, options);
      if (results.length > 0) {
        symbolResults.push({ repo: repo.name, results });
        totalMatches += results.length;
      }
    } catch {
      // Repo may have stale index — skip
    }
  }

  return {
    symbol_results: symbolResults,
    total_matches: totalMatches,
    repos_searched: filtered.length,
  };
}

/**
 * Find references to a symbol across ALL indexed repos.
 */
export async function crossRepoFindReferences(
  symbolName: string,
  options?: {
    repo_pattern?: string | undefined;
    file_pattern?: string | undefined;
  },
): Promise<CrossRepoRefSearchResult> {
  const repos = await listAllRepos({ compact: false }) as Array<{ name: string }>;

  const repoPattern = options?.repo_pattern;
  const filtered = repoPattern
    ? repos.filter((r) => r.name.includes(repoPattern))
    : repos;

  const refResults: CrossRepoRefResult[] = [];
  let totalRefs = 0;

  for (const repo of filtered) {
    try {
      const refs = await findReferences(repo.name, symbolName, options?.file_pattern);
      if (refs.length > 0) {
        refResults.push({ repo: repo.name, references: refs });
        totalRefs += refs.length;
      }
    } catch {
      // Skip stale repos
    }
  }

  return {
    ref_results: refResults,
    total_references: totalRefs,
    repos_searched: filtered.length,
  };
}
