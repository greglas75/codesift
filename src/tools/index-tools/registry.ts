import { unlink } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { EXTRACTOR_VERSIONS } from "../index-shared.js";
import {
  loadIndex,
  loadIndexOrStale,
  loadIndexSummary,
  summariseIndex,
  collectExtractorVersionMismatches,
} from "../../storage/index-store.js";
import {
  classifyStorageError,
  type IndexSummary,
} from "../../storage/sqlite-index-store.js";
import { IndexStorageError } from "../../storage/sqlite-index-store.js";
import {
  getRepo,
  listRepos as listRegistryRepos,
  removeRepo,
  resolveRegisteredRepoMeta,
  getRepoName,
} from "../../storage/registry.js";
import { stopWatcher } from "../../storage/watcher.js";
import {
  getEmbeddingPath,
  getEmbeddingMetaPath,
  loadEmbeddings,
} from "../../storage/embedding-store.js";
import { getChunkPath, getChunkEmbeddingPath } from "../../storage/chunk-store.js";
import { getGraphPath } from "../../storage/graph-store.js";
import { getSnapshotPath } from "../../storage/hash-snapshot.js";
import { buildBM25Index } from "../../search/bm25.js";
import type { BM25Index } from "../../search/bm25.js";
import { loadConfig, localEmbeddingsDisabled, embeddingMemBudgetBytes } from "../../config.js";
import { ensureIndexFresh } from "./file-indexer.js";
import { indexFolder } from "./folder-indexer.js";
import {
  activeWatchers,
  bm25Indexes,
  codeIndexes,
  embeddingCaches,
  embeddingCacheGenerations,
  embeddingCacheSources,
  cacheEmbeddingIfGenerationCurrent,
} from "./state.js";
import type { CodeIndex, RepoMeta } from "../../types.js";
import { findWorkingTree } from "../../utils/worktree.js";

export interface RepoSummary {
  name: string;
  file_count: number;
  symbol_count: number;
}

export async function listAllRepos(options?: { compact?: boolean; name_contains?: string }): Promise<RepoMeta[] | RepoSummary[] | string[]> {
  const config = loadConfig();
  let repos = await listRegistryRepos(config.registryPath);

  // Filter by name substring (case-insensitive)
  if (options?.name_contains) {
    const filter = options.name_contains.toLowerCase();
    repos = repos.filter((r) => r.name.toLowerCase().includes(filter));
  }

  if (options?.compact === false) return repos;
  // Default: ultra-compact — just repo names (agents only need the identifier)
  return repos.map((r) => r.name);
}

export async function invalidateCache(repoName: string): Promise<boolean> {
  const config = loadConfig();
  const meta = await getRepo(config.registryPath, repoName);
  if (!meta) return false;

  // Stop watcher
  const watcher = activeWatchers.get(repoName);
  if (watcher) {
    await stopWatcher(watcher);
    activeWatchers.delete(repoName);
  }

  // Remove in-memory caches
  bm25Indexes.delete(repoName);
  codeIndexes.delete(repoName);
  embeddingCaches.delete(repoName);

  // Delete index file + embedding files + chunk files
  const embeddingPath = getEmbeddingPath(meta.index_path);
  const embeddingMetaPath = getEmbeddingMetaPath(meta.index_path);
  const chunkPath = getChunkPath(meta.index_path);
  const chunkEmbeddingPath = getChunkEmbeddingPath(meta.index_path);
  const graphStorePath = getGraphPath(meta.index_path);
  const snapshotPath = getSnapshotPath(meta.index_path);
  for (const fp of [meta.index_path, embeddingPath, embeddingMetaPath, chunkPath, chunkEmbeddingPath, graphStorePath, snapshotPath]) {
    try { await unlink(fp); } catch { /* File may not exist */ }
  }

  // Remove from registry
  await removeRepo(config.registryPath, repoName);
  return true;
}

export async function getBM25Index(repoName: string): Promise<BM25Index | null> {
  // Resolve through the case-insensitive registry resolver (mirrors
  // getCodeIndex) so `local/Rewards-API` finds `local/rewards-api` and the
  // freshness check + cache key all use the canonical name. Previously this
  // used exact `getRepo`, so any casing/bare-name mismatch returned null and
  // BM25-backed tools (search_text, search_symbols, find_and_show,
  // search_patterns) errored.
  const config = loadConfig();
  const resolved = await resolveRegisteredRepoMeta(config.registryPath, repoName);
  if (!resolved) return null;
  const { resolvedName, meta } = resolved;

  await ensureIndexFresh(resolvedName);

  const cached = bm25Indexes.get(resolvedName);
  if (cached) return cached;

  const index = await loadIndex(meta.index_path);
  if (!index) return null;

  const bm25 = buildBM25Index(index.symbols);
  bm25Indexes.set(resolvedName, bm25);
  return bm25;
}

/**
 * Get the code index for a repo from disk.
 * Starts watcher if not running (lazy start after server restart).
 */
/**
 * Get the code index for a repo from disk. Auto-refreshes if git HEAD moved.
 */
export async function getCodeIndex(
  repoName: string,
  options?: { skipFreshness?: boolean },
): Promise<CodeIndex | null> {
  const config = loadConfig();
  const resolved = await resolveRegisteredRepoMeta(config.registryPath, repoName);
  if (!resolved) return null;
  const { resolvedName, meta } = resolved;

  if (!options?.skipFreshness) {
    await ensureIndexFresh(resolvedName);
  }

  const cached = codeIndexes.get(resolvedName);
  if (cached) return cached;

  const result = await loadIndexOrStale(meta.index_path, { ...EXTRACTOR_VERSIONS });
  if (!result) return null;
  if (result.status === "unreadable") {
    // Deliberately NOT `return null`. Null here means "this repo has no index", and every tool
    // downstream renders that as an authoritative empty answer. A locked or corrupt store is a
    // fault the caller must see, not a repo with nothing in it.
    //
    // Typed rather than a generic Error, and carrying the code: index_status maps this straight
    // into its `unreadable` field. A generic Error forced it to re-read the store to rediscover
    // what happened — a second hit on an already-struggling database, and a race, since a
    // transient SQLITE_BUSY that cleared between the two reads produced a "fault" nobody could
    // reproduce.
    throw new IndexStorageError(
      `[codesift] index for ${resolvedName} is unreadable (${result.code}): ${result.message}. ` +
        `This is a storage fault, not an empty index — the previous behaviour would have ` +
        `reported "no results". Retry if the code is SQLITE_BUSY; otherwise run index_folder ` +
        `to rebuild ${meta.index_path}.`,
      result.code,
      meta.index_path,
    );
  }
  if (result.status === "stale") {
    const extra = result.mismatch_detail ? ` — ${result.mismatch_detail}` : "";
    console.warn(
      `[codesift] stale index for ${resolvedName}: extractor_version_mismatch ` +
      `(${result.language} expected ${result.expected_version}, got ${result.actual_version})${extra}. ` +
      `Run index_folder to refresh.`,
    );
    return null;
  }

  codeIndexes.set(resolvedName, result.index);
  return result.index;
}

/**
 * Files + metadata for a repo, without constructing its symbols (ADR-004 stage 2).
 *
 * Same resolution, staleness and unreadable semantics as `getCodeIndex` — a storage fault must
 * still surface as a fault here, not as a repo with nothing in it. The difference is only what is
 * built: a full load of the tgm-survey-platform index costs ~1.0 s and 349 MB of heap, effectively
 * all of it symbol objects, and `index_status` — which reports counts it reads from metadata and
 * never touches `index.symbols` — was paying that in full.
 *
 * Returns `IndexSummary`, which has no `symbols` field at all rather than an empty one: a caller
 * that needs symbols must fail to compile, not read an empty array as "this repo has none".
 */
export async function getIndexSummary(
  repoName: string,
  options?: { skipFreshness?: boolean },
): Promise<IndexSummary | null> {
  const config = loadConfig();
  const resolved = await resolveRegisteredRepoMeta(config.registryPath, repoName);
  if (!resolved) return null;
  const { resolvedName, meta } = resolved;

  if (!options?.skipFreshness) {
    await ensureIndexFresh(resolvedName);
  }

  // A full index already in memory answers this for free; going back to the database would be
  // slower than projecting what we are holding.
  //
  // The staleness check below is deliberately NOT repeated here, and this mirrors `getCodeIndex`
  // exactly: `codeIndexes` is written in one place only (the tail of `getCodeIndex`), and only
  // after `loadIndexOrStale` reported `ok` — so a cached entry is version-validated by
  // construction. `EXTRACTOR_VERSIONS` is a module constant and cannot drift inside a process,
  // so there is no window in which a cached index becomes stale. Two independent reviewers read
  // this shortcut as a missing check, which is why it is spelled out rather than left implicit.
  const cached = codeIndexes.get(resolvedName);
  if (cached) return summariseIndex(cached);

  try {
    const summary = await loadIndexSummary(meta.index_path);
    if (summary === null) return null;
    // Staleness parity with getCodeIndex — via the SAME function its path uses.
    //
    // The first version called `isExtractorVersionCurrent`, which looks equivalent and is not: it
    // short-circuits `if (!index.extractor_version) return false`, whereas
    // `collectExtractorVersionMismatches` only flags a language it can actually see among
    // `files`. An index with no `extractor_version` whose files are entirely in languages absent
    // from EXTRACTOR_VERSIONS (go, rust, markdown, sql, prisma) therefore loaded fine through
    // `getCodeIndex` and came back null here — and `index_status`'s fallback probe re-runs
    // `loadIndexOrStale`, which also says "ok", so it matched neither the stale nor the
    // unreadable branch and fell through to a bare `{indexed:false}` with no diagnostic at all.
    // A correctly-indexed repo reported as never-indexed, confidently and silently.
    const mismatches = collectExtractorVersionMismatches(summary, { ...EXTRACTOR_VERSIONS });
    if (mismatches.length > 0) {
      // Log parity too: getCodeIndex warns here, and without this the server log simply goes
      // dark for a stale repo whose only traffic is index_status.
      const first = mismatches[0]!;
      console.warn(
        `[codesift] stale index for ${resolvedName}: extractor_version_mismatch ` +
        `(${first.language} expected ${first.expected}, got ${first.actual}). ` +
        `Run index_folder to refresh.`,
      );
      return null;
    }
    return summary;
  } catch (err) {
    const code = classifyStorageError(err);
    if (code === null) throw err;
    // Mirrors getCodeIndex: null means "no index", and a locked or corrupt store is not that.
    //
    // The underlying detail belongs in `message`, not only in `cause`: `index_status` copies
    // `err.message` verbatim into `unreadable.message`, the one field whose entire job is telling
    // an agent WHAT went wrong. Reporting only the classified code there would say "something is
    // broken" where the old path said which thing — a strictly worse diagnostic from a change
    // whose point was to lose nothing.
    const detail = err instanceof Error ? err.message : String(err);
    throw new IndexStorageError(
      `[codesift] index for ${resolvedName} is unreadable (${code}): ${detail}. This is a storage ` +
        `fault, not an empty index. Retry if the code is SQLITE_BUSY; otherwise run index_folder ` +
        `to rebuild ${meta.index_path}.`,
      code,
      meta.index_path,
      { cause: err },
    );
  }
}

/**
 * Walk up from dir until a .git directory is found. Returns the git root or null.
 */
async function findGitRoot(dir: string): Promise<string | null> {
  let current = resolve(dir);
  while (true) {
    try {
      await stat(join(current, ".git"));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/**
 * Called at server startup. If the CWD is inside a git repo that isn't indexed yet,
 * index it automatically in the background so tools work without manual setup.
 */
export async function autoIndexCurrentRepo(cwd: string): Promise<void> {
  const gitRoot = await findGitRoot(cwd);
  if (!gitRoot) return;

  const config = loadConfig();

  // A linked worktree has its OWN `.git`, so findGitRoot stops there and every
  // task branch looked like a brand-new repository. Each got a full index and,
  // far more expensively, a full embedding pass — for content that is usually
  // IDENTICAL to the checkout it came from. Measured here:
  // `backlog-wave-1-integration` had 1,799 files indexed and differed from main
  // by ZERO; `backlog-vision-log-policy` 1,792 files and 3. Across the machine,
  // 1,585 of 1,895 registry entries pointed at worktrees that no longer exist,
  // holding gigabytes of embeddings for directories that cannot be read.
  //
  // Auto-indexing is the convenience path, so it now defers to the parent
  // checkout, whose index already covers this content. An explicit
  // `index_folder(path=<worktree>)` is untouched — a worktree you are actually
  // working in is worth its own index, and hint H19 is what says so.
  const tree = findWorkingTree(gitRoot);
  if (tree?.linked && tree.mainRoot) {
    const parentName = getRepoName(tree.mainRoot);
    const parent = await getRepo(config.registryPath, parentName);
    if (parent) {
      console.error(
        `[codesift] ${gitRoot} is a worktree of ${parentName}, which is already indexed — `
        + "skipping auto-index. Run index_folder(path=…) explicitly if this tree needs its own.",
      );
      return;
    }
    // Parent not indexed: index THAT instead. It covers the worktree's content
    // and every sibling worktree, where indexing this one covers only itself.
    console.error(`[codesift] Auto-indexing parent checkout ${parentName} (first use)...`);
    await indexFolder(tree.mainRoot);
    console.error(`[codesift] Auto-index complete: ${parentName}`);
    return;
  }

  const repoName = getRepoName(gitRoot);
  const existing = await getRepo(config.registryPath, repoName);
  if (existing) return;

  console.error(`[codesift] Auto-indexing ${repoName} (first use)...`);
  await indexFolder(gitRoot);
  console.error(`[codesift] Auto-index complete: ${repoName}`);
}

/**
 * True when the local embedding cache should not be populated (lite mode).
 * Single source of truth in config.ts — RAM-aware (auto-lite on small machines)
 * and env-overridable. Kept as a thin local alias so call sites read cleanly.
 */
function embeddingsDisabled(): boolean {
  return localEmbeddingsDisabled();
}

function embeddingMapBytes(m: Map<string, Float32Array>): number {
  let b = 0;
  for (const v of m.values()) b += v.byteLength;
  return b;
}

/**
 * Evict least-recently-used repo embeddings while total resident bytes exceed
 * the budget. `embeddingCaches` insertion order is the LRU order (getter
 * re-inserts on hit). `pinned` (the repo being served right now) is never
 * evicted mid-query. Bytes are summed from the live maps (source of truth) so
 * the many `.delete` call sites can't drift an accounting counter.
 */
function evictEmbeddingCachesOverBudget(pinned: string): void {
  const budget = embeddingMemBudgetBytes();
  const sizes = new Map<string, number>();
  let total = 0;
  for (const [k, m] of embeddingCaches) {
    const b = embeddingMapBytes(m);
    sizes.set(k, b);
    total += b;
  }
  if (total <= budget) return;
  for (const k of [...embeddingCaches.keys()]) {
    if (total <= budget) break;
    if (k === pinned) continue;
    embeddingCaches.delete(k);
    embeddingCacheSources.delete(k);
    total -= sizes.get(k) ?? 0;
  }
}

/** Test-only: repo names currently resident in the embedding cache (LRU order, oldest first). */
export function _cachedEmbeddingReposForTesting(): string[] {
  return [...embeddingCaches.keys()];
}

/**
 * In-flight embedding loads, keyed by repo. Two MCP sessions (e.g. two editor
 * windows on one `codesift serve` daemon) that first-access the same repo
 * concurrently must trigger ONE disk load, not one per session — otherwise a
 * GB-scale load runs N times in parallel. Concurrent callers await the same
 * promise; the entry clears once the load settles.
 */
const embeddingLoadsInFlight = new Map<string, Promise<Map<string, Float32Array> | null>>();

/** Count of actual disk loads (test-only) — proves load-once across sessions. */
let embeddingLoadCount = 0;
export function _embeddingLoadCountForTesting(): number {
  return embeddingLoadCount;
}
export function _resetEmbeddingLoadCountForTesting(): void {
  embeddingLoadCount = 0;
}

/**
 * Get the in-memory embedding cache for a repo.
 * Loads from disk if not cached. Returns null if no embeddings file exists,
 * or if embeddings are disabled (lite mode). Bounds resident RAM via LRU, and
 * dedupes concurrent first-access so the load runs exactly once per repo.
 */
/**
 * Chunk embeddings, cached exactly like symbol embeddings.
 *
 * `loadChunkEmbeddings` had NO cache and NO budget and was called on EVERY semantic query — the
 * single largest measured cost in the system. Measured 2026-08-09 on a warm 439.0 MB / 26,975-chunk
 * file: 958 / 1,104 / 1,208 ms per query with a +686 MB RSS spike each time, which is 87% of a
 * semantic query's wall clock. The cosine similarity the query actually exists to compute is 2%.
 * Re-parsing the same gigabyte on every question is not a format problem, so it is fixed before any
 * format changes.
 *
 * Deliberately the SAME map, keyed `<repo>:chunks`, rather than a second cache: the RAM budget is a
 * statement about total resident embedding bytes, and chunk vectors are embedding bytes. Two
 * independent budgets would each be satisfied while together doubling the footprint.
 */
export async function getChunkEmbeddingCache(
  repoName: string,
  resolvedEmbeddingPath?: string,
): Promise<Map<string, Float32Array> | null> {
  if (embeddingsDisabled()) return null;
  let activeEmbeddingPath = resolvedEmbeddingPath;
  if (!activeEmbeddingPath) {
    const config = loadConfig();
    const meta = await getRepo(config.registryPath, repoName);
    if (!meta) return null;
    const {
      getChunkPath,
      getChunkEmbeddingPath,
      resolveChunkIndexPaths,
    } = await import("../../storage/chunk-store.js");
    activeEmbeddingPath = (await resolveChunkIndexPaths(
      getChunkPath(meta.index_path),
      getChunkEmbeddingPath(meta.index_path),
    )).embeddings;
  }
  const cacheKey = `${repoName}:chunks`;

  const cached = embeddingCaches.get(cacheKey);
  if (cached && embeddingCacheSources.get(cacheKey) === activeEmbeddingPath) {
    embeddingCaches.delete(cacheKey);
    embeddingCaches.set(cacheKey, cached);
    return cached;
  }
  if (cached) {
    embeddingCaches.delete(cacheKey);
    embeddingCacheSources.delete(cacheKey);
  }

  const generation = embeddingCacheGenerations.get(cacheKey) ?? 0;
  const loadKey = `${cacheKey}\0${activeEmbeddingPath}\0${generation}`;
  const inFlight = embeddingLoadsInFlight.get(loadKey);
  if (inFlight) return inFlight;

  const loadPromise = (async (): Promise<Map<string, Float32Array> | null> => {
    const config = loadConfig();
    const meta = await getRepo(config.registryPath, repoName);
    if (!meta) return null;

    // Same model-mismatch rule as the symbol path: vectors from another model are not stale, they
    // are incomparable, and every downstream path drops them silently into "nothing matched".
    const { getEmbeddingMetaPath, loadEmbeddingMeta } = await import("../../storage/embedding-store.js");
    const { expectedEmbeddingModel } = await import("../../search/semantic.js");
    const embMeta = await loadEmbeddingMeta(getEmbeddingMetaPath(meta.index_path));
    if (embMeta && config.embeddingProvider) {
      const want = expectedEmbeddingModel(config.embeddingProvider, config.localModel, config.ollamaModel);
      if (embMeta.model !== want) return null;
    }

    const { loadChunkEmbeddings, getChunkEmbeddingPath } = await import("../../storage/chunk-store.js");
    embeddingLoadCount++;
    const loaded = await loadChunkEmbeddings(
      getChunkEmbeddingPath(meta.index_path),
      embeddingMemBudgetBytes(),
      activeEmbeddingPath,
    );
    if (!loaded || loaded.size === 0) return null;
    // A completed re-index may invalidate this key while its previous file is
    // still being read. Never let that stale result repopulate the cache.
    const cachedCurrentGeneration = cacheEmbeddingIfGenerationCurrent(
      cacheKey,
      generation,
      loaded,
      activeEmbeddingPath,
    );
    if (cachedCurrentGeneration) evictEmbeddingCachesOverBudget(cacheKey);
    // A generation bump only prevents stale cache publication. The caller
    // explicitly requested this immutable snapshot, so its loaded data remains
    // valid for that query even when a newer generation became active meanwhile.
    return loaded;
  })();

  embeddingLoadsInFlight.set(loadKey, loadPromise);
  try {
    return await loadPromise;
  } finally {
    embeddingLoadsInFlight.delete(loadKey);
  }
}

export async function getEmbeddingCache(
  repoName: string,
): Promise<Map<string, Float32Array> | null> {
  // Lite mode: never hold embeddings in RAM (semantic falls back to BM25).
  if (embeddingsDisabled()) return null;

  const cached = embeddingCaches.get(repoName);
  if (cached) {
    // LRU touch: move to most-recently-used end.
    embeddingCaches.delete(repoName);
    embeddingCaches.set(repoName, cached);
    return cached;
  }

  // Coalesce concurrent first-access onto one load.
  const inFlight = embeddingLoadsInFlight.get(repoName);
  if (inFlight) return inFlight;

  const loadPromise = (async (): Promise<Map<string, Float32Array> | null> => {
    const config = loadConfig();
    const meta = await getRepo(config.registryPath, repoName);
    if (!meta) return null;

    const embeddingPath = getEmbeddingPath(meta.index_path);

    // Embeddings from a DIFFERENT model are not merely stale — they are
    // incomparable, and every downstream path drops them silently (unequal
    // vector lengths → skipped / similarity 0), so semantic search returns an
    // empty result that looks like "nothing matched". Across this machine that
    // was 266 of 336 repos and 72 GB of embeddings that could never produce a
    // single hit, held over from an OpenAI key that is no longer configured.
    //
    // Treat a model change as cache invalidation, mirroring the existing
    // per-language extractor_version rule. Checking the tiny meta file first
    // also avoids reading (and briefly holding) a GB-scale ndjson we cannot use.
    const { getEmbeddingMetaPath, loadEmbeddingMeta } = await import("../../storage/embedding-store.js");
    const { expectedEmbeddingModel } = await import("../../search/semantic.js");
    const embMeta = await loadEmbeddingMeta(getEmbeddingMetaPath(meta.index_path));
    if (embMeta && config.embeddingProvider) {
      const want = expectedEmbeddingModel(config.embeddingProvider, config.localModel, config.ollamaModel);
      if (embMeta.model !== want) {
        console.error(
          `[codesift] ${repoName}: embeddings were built with "${embMeta.model}" but the active ` +
            `provider uses "${want}" — not loading them (they cannot be compared). ` +
            `Re-index to rebuild embeddings with the current model.`,
        );
        return null;
      }
    }

    embeddingLoadCount++;
    // Bound the load to the RAM budget. A repo whose embeddings exceed it is not
    // loaded at all (loadEmbeddings returns empty) — semantic degrades to BM25 for
    // THAT repo instead of ballooning the process to the file's full size (5+ GB).
    const embeddings = await loadEmbeddings(embeddingPath, embeddingMemBudgetBytes());
    if (embeddings.size === 0) return null;

    // Pin-on-access: this repo is the one being served, so eviction never drops
    // it out from under the load/query that just requested it.
    embeddingCaches.set(repoName, embeddings);
    evictEmbeddingCachesOverBudget(repoName);
    return embeddings;
  })();

  embeddingLoadsInFlight.set(repoName, loadPromise);
  try {
    return await loadPromise;
  } finally {
    embeddingLoadsInFlight.delete(repoName);
  }
}
