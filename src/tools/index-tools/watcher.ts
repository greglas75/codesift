import { join } from "node:path";
import { saveIncremental, removeFileFromIndex } from "../../storage/index-store.js";
import { startWatcher, stopWatcher } from "../../storage/watcher.js";
import { loadConfig } from "../../config.js";
import { onFileChanged as scanOnChanged, onFileDeleted as scanOnDeleted, scanFileForSecrets } from "../secret-scan-shared.js";
import { parseOneFile } from "./parse.js";
import { activeWatchers, bm25Indexes, codeIndexes, embeddingCaches } from "./state.js";

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

  const watcher = await startWatcher(
    rootPath,
    (changedFile) => {
      handleFileChange(rootPath, repoName, indexPath, changedFile).catch(
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[codesift] Watcher error for ${changedFile}: ${message}`);
        },
      );
    },
    (deletedFile) => {
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
      await scanFileForSecrets(fullPath, relativeFile, repoName, result.symbols);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[codesift] Secret scan failed for ${relativeFile}: ${message}`);
    }
  }

  // Invalidate caches — lazy rebuild on next query via getBM25Index()
  bm25Indexes.delete(repoName);
  codeIndexes.delete(repoName);
  embeddingCaches.delete(repoName);
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

  // Invalidate caches — lazy rebuild on next query via getBM25Index()
  bm25Indexes.delete(repoName);
  codeIndexes.delete(repoName);
  embeddingCaches.delete(repoName);
  scanOnDeleted(repoName, relativeFile);

  // Invalidate Hono model cache
  try {
    const { honoCache } = await import("../../cache/hono-cache.js");
    honoCache.invalidate(join(repoRoot, relativeFile));
  } catch {
    // Best-effort
  }
}
