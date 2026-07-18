import { unlink } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { EXTRACTOR_VERSIONS } from "../index-shared.js";
import { loadIndex, loadIndexOrStale } from "../../storage/index-store.js";
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
import { loadConfig } from "../../config.js";
import { ensureIndexFresh } from "./file-indexer.js";
import { indexFolder } from "./folder-indexer.js";
import { activeWatchers, bm25Indexes, codeIndexes, embeddingCaches } from "./state.js";
import type { CodeIndex, RepoMeta } from "../../types.js";

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

  const repoName = getRepoName(gitRoot);
  const config = loadConfig();
  const existing = await getRepo(config.registryPath, repoName);
  if (existing) return;

  console.error(`[codesift] Auto-indexing ${repoName} (first use)...`);
  await indexFolder(gitRoot);
  console.error(`[codesift] Auto-index complete: ${repoName}`);
}

/** True when embeddings are disabled entirely (low-RAM / lite mode). */
function embeddingsDisabled(): boolean {
  const v = process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"];
  return v === "1" || v === "true";
}

/** Resident-embedding RAM budget in MB (default 1024). 0/invalid → default. */
function embeddingMemBudgetBytes(): number {
  const raw = process.env["CODESIFT_MAX_EMBEDDING_MEM_MB"];
  const n = raw ? parseInt(raw, 10) : NaN;
  return (Number.isNaN(n) || n <= 0 ? 1024 : n) * 1024 * 1024;
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
    embeddingLoadCount++;
    const embeddings = await loadEmbeddings(embeddingPath);
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
