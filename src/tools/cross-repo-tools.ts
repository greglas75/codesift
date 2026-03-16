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
  errors: Array<{ repo: string; error: string }>;
}

export interface CrossRepoRefSearchResult {
  ref_results: CrossRepoRefResult[];
  total_references: number;
  repos_searched: number;
  errors: Array<{ repo: string; error: string }>;
}

/**
 * Run a search function across all indexed repos (or a filtered subset).
 * Collects results and errors separately — never silently swallows failures.
 */
async function searchAcrossRepos<T>(
  repoPattern: string | undefined,
  searchFn: (repoName: string) => Promise<T[]>,
): Promise<{ results: Array<{ repo: string; items: T[] }>; errors: Array<{ repo: string; error: string }>; reposSearched: number }> {
  const repos = await listAllRepos({ compact: false });
  const repoList = Array.isArray(repos) ? repos : [];

  const filtered = repoPattern
    ? repoList.filter((r) => r.name.includes(repoPattern))
    : repoList;

  const results: Array<{ repo: string; items: T[] }> = [];
  const errors: Array<{ repo: string; error: string }> = [];

  for (const repo of filtered) {
    try {
      const items = await searchFn(repo.name);
      if (items.length > 0) {
        results.push({ repo: repo.name, items });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ repo: repo.name, error: message });
    }
  }

  return { results, errors, reposSearched: filtered.length };
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
  const { results, errors, reposSearched } = await searchAcrossRepos<SearchResult>(
    options?.repo_pattern,
    (repoName) => searchSymbols(repoName, query, options),
  );

  return {
    symbol_results: results.map(({ repo, items }) => ({ repo, results: items })),
    total_matches: results.reduce((sum, r) => sum + r.items.length, 0),
    repos_searched: reposSearched,
    errors,
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
  const { results, errors, reposSearched } = await searchAcrossRepos<Reference>(
    options?.repo_pattern,
    (repoName) => findReferences(repoName, symbolName, options?.file_pattern),
  );

  return {
    ref_results: results.map(({ repo, items }) => ({ repo, references: items })),
    total_references: results.reduce((sum, r) => sum + r.items.length, 0),
    repos_searched: reposSearched,
    errors,
  };
}
