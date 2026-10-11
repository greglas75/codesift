import { join } from "node:path";
import { saveIncremental, removeFileFromIndex } from "../../storage/index-store.js";
import { startWatcher, stopWatcher } from "../../storage/watcher.js";
import { loadConfig } from "../../config.js";
import { onFileChanged as scanOnChanged, onFileDeleted as scanOnDeleted, scanFileForSecrets } from "../secret-scan-shared.js";
import { parseOneFile } from "./parse.js";
import { updateBM25ForFile } from "../../search/bm25.js";
import { activeWatchers, bm25Indexes, codeIndexes, invalidateEmbeddingCaches } from "./state.js";

const DEFAULT_MAX_WATCHERS = 8;

function getMaxWatchers(): number {
  const env = process.env.CODESIFT_MAX_WATCHERS;
  if (env !== undefined) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_MAX_WATCHERS;
}

// Insertion-ordered Map gives us free LRU semantics: re-inserting a key
// moves it to the end, so the first key is the least-recently set up.
const watcherInsertionOrder = new Set<string>();

/** The live watcher's token and root per repo name; see setupWatcher. */
const currentWatcherTokens = new Map<string, { token: object; root: string }>();

/** Whether `token` still belongs to the watcher serving `repoName` (exported for tests). */
export function watcherIsCurrent(repoName: string, token: object): boolean {
  return currentWatcherTokens.get(repoName)?.token === token;
}

/**
 * Called when `repoName` is indexed from `root` without a watcher: a watcher of ANOTHER root under the
 * same name is retired, so its queued events stop editing the name's caches. Same root: left running.
 */
export function retireWatcherOfOtherRoot(repoName: string, root: string): void {
  const current = currentWatcherTokens.get(repoName);
  if (current && current.root !== root) currentWatcherTokens.delete(repoName);
}

/**
 * Replace or create a file watcher for incremental index updates.
 *
 * Enforces a max-active-watchers cap with LRU eviction so that bulk indexing
 * of many repos in one session cannot exhaust the system file table. When the
 * cap is exceeded the oldest watcher is closed; that repo's index becomes
 * stale-on-disk until the next explicit `index_folder` or `index_file`.
 */
export async function setupWatcher(
  rootPath: string,
  repoName: string,
  indexPath: string,
): Promise<void> {
  const existingWatcher = activeWatchers.get(repoName);
  if (existingWatcher) {
    await stopWatcher(existingWatcher);
    watcherInsertionOrder.delete(repoName);
  }

  // Evict oldest watchers until we fit under the cap (with room for the new one)
  const maxWatchers = getMaxWatchers();
  if (maxWatchers === 0) {
    // Caller of indexFolder can also opt out via watch:false; this env is the
    // global kill-switch (e.g. for CI bulk-index jobs).
    return;
  }
  while (watcherInsertionOrder.size >= maxWatchers) {
    const oldest = watcherInsertionOrder.values().next().value;
    if (oldest === undefined) break;
    const oldWatcher = activeWatchers.get(oldest);
    if (oldWatcher) {
      await stopWatcher(oldWatcher).catch(() => { /* best-effort */ });
      activeWatchers.delete(oldest);
    }
    watcherInsertionOrder.delete(oldest);
    console.error(
      `[codesift] watcher cap reached (${maxWatchers}); evicted oldest watcher: ${oldest}`,
    );
  }

  // The token this watcher's callbacks check before acting. Name-keyed caches (bm25Indexes,
  // codeIndexes) belong to whichever tree the name points at NOW; a replaced watcher's debounced events
  // still fire after it is stopped, and used to remove symbols of the same relative path from the new
  // tree's index (the full-suite test flake of 2026-10-11, and a re-rooted repo in the field).
  const token = {};
  currentWatcherTokens.set(repoName, { token, root: rootPath });
  const watcher = await startWatcher(
    rootPath,
    (changedFile) => {
      if (!watcherIsCurrent(repoName, token)) return;
      handleFileChange(rootPath, repoName, indexPath, changedFile).catch(
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[codesift] Watcher error for ${changedFile}: ${message}`);
        },
      );
    },
    (deletedFile) => {
      if (!watcherIsCurrent(repoName, token)) return;
      handleFileDelete(rootPath, repoName, indexPath, deletedFile).catch(
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[codesift] Watcher delete error for ${deletedFile}: ${message}`);
        },
      );
    },
  );
  activeWatchers.set(repoName, watcher);
  watcherInsertionOrder.add(repoName);
}

/**
 * Handle a file change event from the watcher.
 * Re-parses the changed file and updates the index incrementally.
 */
async function handleFileChange(
  repoRoot: string,
  repoName: string,
  indexPath: string,
  relativeFile: string,
): Promise<void> {
  const fullPath = join(repoRoot, relativeFile);

  // Invalidate cached findings so the next scan sees the updated file contents.
  scanOnChanged(repoName, relativeFile);

  // Invalidate negative evidence for this file's subtree
  try {
    const { invalidateNegativeEvidence } = await import("../../storage/session-state.js");
    invalidateNegativeEvidence(repoName, relativeFile);
  } catch {
    // Best-effort — session-state may not be loaded
  }

  // Invalidate Hono model cache for this file (canonicalized absolute path)
  try {
    const { honoCache } = await import("../../cache/hono-cache.js");
    honoCache.invalidate(fullPath);
  } catch {
    // Best-effort — hono-cache may not be loaded
  }

  const result = await parseOneFile(fullPath, repoRoot, repoName);
  if (!result) return;

  await saveIncremental(indexPath, relativeFile, result.symbols, result.entry);

  if (loadConfig().secretScanEnabled) {
    try {
      await scanFileForSecrets(fullPath, relativeFile, repoName, () => result.symbols);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[codesift] Secret scan failed for ${relativeFile}: ${message}`);
    }
  }

  // Swap this file's symbols in place rather than dropping the index — see updateBM25ForFile.
  const cachedBm25 = bm25Indexes.get(repoName);
  if (cachedBm25) {
    updateBM25ForFile(cachedBm25, relativeFile, result.symbols);
  }
  codeIndexes.delete(repoName);
  invalidateEmbeddingCaches(repoName);
}

/**
 * Handle a file deletion event from the watcher.
 * Removes all symbols for the deleted file from the index.
 */
async function handleFileDelete(
  repoRoot: string,
  repoName: string,
  indexPath: string,
  relativeFile: string,
): Promise<void> {
  await removeFileFromIndex(indexPath, relativeFile);

  // A deletion is the same swap with nothing to put back: drop the file's symbols, keep the rest
  // of the index. Dropping the whole index here would make `rm` as expensive as a reindex.
  const cachedBm25 = bm25Indexes.get(repoName);
  if (cachedBm25) {
    updateBM25ForFile(cachedBm25, relativeFile, []);
  }
  codeIndexes.delete(repoName);
  invalidateEmbeddingCaches(repoName);
  scanOnDeleted(repoName, relativeFile);

  // Invalidate Hono model cache
  try {
    const { honoCache } = await import("../../cache/hono-cache.js");
    honoCache.invalidate(join(repoRoot, relativeFile));
  } catch {
    // Best-effort
  }
}
