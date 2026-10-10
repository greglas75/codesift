import type { IndexSummary } from "../../storage/sqlite-index-store.js";
import type { SymbolQuery } from "../../storage/sqlite/queries.js";
import type { CodeIndex, CodeSymbol, FileEntry } from "../../types.js";
import { findRepoSymbols, findRepoSymbolsInFiles } from "../index-tools.js";
import { filterCachedSymbols } from "../index-tools/registry.js";

/**
 * What route discovery reads from the index: the file list and the root, plus narrow symbol reads.
 * trace_route used to load the whole index for a handful of lookups by file or name (ADR-004 stage 2)
 * — 13 s and +2.4 GB on a 1.4M-symbol repo before any route was found.
 *
 * Both reads return symbols in index order, so every "first match" a finder takes is the one it took
 * over `index.symbols`.
 */
export interface RouteIndex {
  repo: string;
  root: string;
  files: FileEntry[];
  /** Symbols matching `query`, in index order. */
  find(query: SymbolQuery): Promise<CodeSymbol[]>;
  /** The symbols of these files, in index order. */
  inFiles(files: readonly string[], withSource: boolean): Promise<CodeSymbol[]>;
}

/** A finder accepts either; tests pass loaded fixtures. */
export type RouteIndexInput = CodeIndex | RouteIndex;

function isRouteIndex(index: RouteIndexInput): index is RouteIndex {
  return typeof (index as Partial<RouteIndex>).find === "function";
}

/** Over a loaded index — the same filter the resident index cache answers narrow reads with. */
export function asRouteIndex(index: RouteIndexInput): RouteIndex {
  if (isRouteIndex(index)) return index;
  const { symbols } = index;
  return {
    repo: index.repo,
    root: index.root,
    files: index.files,
    find: async (query) => filterCachedSymbols(symbols, query),
    inFiles: async (files, withSource) => {
      const wanted = new Set(files);
      return filterCachedSymbols(symbols.filter((s) => wanted.has(s.file)), { withSource });
    },
  };
}

/** Over the summary, with each read asked of the store (freshness already settled by the summary). */
export function routeIndexFromSummary(summary: IndexSummary): RouteIndex {
  const repo = summary.repo;
  return {
    repo,
    root: summary.root,
    files: summary.files,
    find: (query) => findRepoSymbols(repo, query, { skipFreshness: true }),
    inFiles: (files, withSource) => findRepoSymbolsInFiles(repo, files, { withSource, skipFreshness: true }),
  };
}
