import { loadConfig } from "../../config.js";
import { resolveRegisteredRepoMeta } from "../../storage/registry.js";
import { findSymbolNames, findSymbolsByRequestedIds, findSymbolsInFiles } from "../../storage/index-store.js";
import { filterByFiles, filterByRequestedIds } from "../../storage/narrow-filters.js";
import type { CodeSymbol } from "../../types.js";
import { ensureIndexFresh } from "./file-indexer.js";
import { codeIndexes } from "./state.js";

/**
 * Tool-layer faces of the two narrow reads `SymbolQuery` does not cover (ADR-004 stage 2).
 *
 * Same shape as `findRepoSymbols` in registry.ts, deliberately: resolve the name the way
 * `getCodeIndex` does, honour `skipFreshness`, and answer from an index that is already resident
 * rather than going back to the database for rows we are holding.
 *
 * Neither function gates on staleness or absence — like `findRepoSymbols`, an unknown repo yields
 * `[]`. A tool that must tell "not indexed" or "stale" apart from "no such symbol" calls
 * `getIndexSummary` first (it is cached on the database's data_version, so the second call is a
 * pragma), and then these with `skipFreshness: true`. That keeps `getCodeIndex`'s exact null
 * semantics without materialising a single symbol to obtain them.
 */
async function resolveIndexPath(
  repoName: string,
  skipFreshness: boolean | undefined,
): Promise<{ resolvedName: string; indexPath: string } | null> {
  const config = loadConfig();
  const resolved = await resolveRegisteredRepoMeta(config.registryPath, repoName);
  if (!resolved) return null;
  if (!skipFreshness) await ensureIndexFresh(resolved.resolvedName);
  return { resolvedName: resolved.resolvedName, indexPath: resolved.meta.index_path };
}

/** Symbols answering to any of `requestedIds` (full or `repo:`-stripped), in index order. */
export async function findRepoSymbolsByRequestedIds(
  repoName: string,
  requestedIds: readonly string[],
  opts: { withSource: boolean; skipFreshness?: boolean },
): Promise<CodeSymbol[]> {
  const target = await resolveIndexPath(repoName, opts.skipFreshness);
  if (!target) return [];
  const cached = codeIndexes.get(target.resolvedName);
  if (cached) return filterByRequestedIds(cached.symbols, requestedIds, opts.withSource);
  return findSymbolsByRequestedIds(target.indexPath, requestedIds, { withSource: opts.withSource });
}

/** Symbols in any of `files`, in index order. */
export async function findRepoSymbolsInFiles(
  repoName: string,
  files: readonly string[],
  opts: { withSource: boolean; skipFreshness?: boolean },
): Promise<CodeSymbol[]> {
  const target = await resolveIndexPath(repoName, opts.skipFreshness);
  if (!target) return [];
  const cached = codeIndexes.get(target.resolvedName);
  if (cached) return filterByFiles(cached.symbols, files, opts.withSource);
  return findSymbolsInFiles(target.indexPath, files, { withSource: opts.withSource });
}

/** Every distinct symbol name, in order of first appearance. */
export async function findRepoSymbolNames(
  repoName: string,
  opts?: { skipFreshness?: boolean },
): Promise<string[]> {
  const target = await resolveIndexPath(repoName, opts?.skipFreshness);
  if (!target) return [];
  const cached = codeIndexes.get(target.resolvedName);
  if (cached) return [...new Set(cached.symbols.map((symbol) => symbol.name))];
  return findSymbolNames(target.indexPath);
}
