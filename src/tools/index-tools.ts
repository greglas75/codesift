import { stat, rm, mkdir as mkdirAsync } from "node:fs/promises";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { validateGitUrl, validateGitRef } from "../utils/git-validation.js";
import { loadConfig } from "../config.js";
import { stopWatcher } from "../storage/watcher.js";
import { indexFolder, resetIndexFolderRedundancyForTesting, type IndexFolderResult } from "./index-tools/folder-indexer.js";
import { indexFile, clearLastIndexedStateForTesting, ensureIndexFresh, resetFreshnessCache } from "./index-tools/file-indexer.js";
import { listAllRepos, invalidateCache, getBM25Index, getCodeIndex, getEmbeddingCache, autoIndexCurrentRepo, _cachedEmbeddingReposForTesting, _embeddingLoadCountForTesting, _resetEmbeddingLoadCountForTesting, type RepoSummary } from "./index-tools/registry.js";
import { embedSymbols } from "./index-tools/parse.js";
import { drainLegacyHashQueue, ASTRO_LOCK_FILENAME, EXTRACTOR_VERSIONS_FILENAME, checkAstroExtractorVersion, type AstroReindexResult } from "./index-tools/snapshots.js";
import { activeWatchers, bm25Indexes, codeIndexes, embeddingCaches } from "./index-tools/state.js";

const GIT_CLONE_TIMEOUT_MS = 120_000;
const GIT_CHECKOUT_TIMEOUT_MS = 30_000;
const GIT_PULL_TIMEOUT_MS = 60_000;

export {
  indexFolder,
  resetIndexFolderRedundancyForTesting,
  indexFile,
  clearLastIndexedStateForTesting,
  ensureIndexFresh,
  resetFreshnessCache,
  listAllRepos,
  invalidateCache,
  getBM25Index,
  getCodeIndex,
  getEmbeddingCache,
  autoIndexCurrentRepo,
  _cachedEmbeddingReposForTesting,
  _embeddingLoadCountForTesting,
  _resetEmbeddingLoadCountForTesting,
  embedSymbols,
  drainLegacyHashQueue,
  ASTRO_LOCK_FILENAME,
  EXTRACTOR_VERSIONS_FILENAME,
  checkAstroExtractorVersion,
};
export type { IndexFolderResult, RepoSummary, AstroReindexResult };

export async function indexRepo(
  url: string,
  options?: {
    branch?: string | undefined;
    include_paths?: string[] | undefined;
  },
): Promise<IndexFolderResult> {
  validateGitUrl(url);
  if (options?.branch) {
    validateGitRef(options.branch);
  }

  const config = loadConfig();
  const reposDir = join(config.dataDir, "repos");

  // Ensure repos directory exists (R-2: git clone requires parent to exist)
  await mkdirAsync(reposDir, { recursive: true });

  // Derive repo name from URL: "https://github.com/user/repo.git" → "repo"
  const urlBasename = basename(url).replace(/\.git$/, "");
  const cloneTarget = join(reposDir, urlBasename);

  // Check if already cloned — pull instead of clone
  let needsClone = true;
  try {
    const s = await stat(join(cloneTarget, ".git"));
    if (s.isDirectory()) {
      needsClone = false;
    }
  } catch {
    // Directory doesn't exist — will clone
  }

  // R-1: Use execFileSync (array form) to prevent shell injection.
  // execSync with string interpolation allows $(cmd) expansion in URLs.
  if (needsClone) {
    const args = ["clone", "--depth", "1"];
    if (options?.branch) args.push("--branch", options.branch);
    args.push("--", url, cloneTarget);
    execFileSync("git", args, { stdio: "pipe", timeout: GIT_CLONE_TIMEOUT_MS });
  } else {
    // Pull latest changes
    try {
      if (options?.branch) {
        execFileSync("git", ["-C", cloneTarget, "checkout", options.branch], {
          stdio: "pipe",
          timeout: GIT_CHECKOUT_TIMEOUT_MS,
        });
      }
      execFileSync("git", ["-C", cloneTarget, "pull", "--ff-only"], {
        stdio: "pipe",
        timeout: GIT_PULL_TIMEOUT_MS,
      });
    } catch (err: unknown) {
      // Pull may fail if detached HEAD — force fresh clone
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[codesift] Git pull failed for ${urlBasename}, re-cloning: ${message}`);
      await rm(cloneTarget, { recursive: true, force: true });
      const args = ["clone", "--depth", "1"];
      if (options?.branch) args.push("--branch", options.branch);
      args.push("--", url, cloneTarget);
      execFileSync("git", args, { stdio: "pipe", timeout: GIT_CLONE_TIMEOUT_MS });
    }
  }

  // Index the cloned repo (no watcher for remote repos)
  return indexFolder(cloneTarget, {
    include_paths: options?.include_paths,
    watch: false,
  });
}

/**
 * Maximum number of repos with active file watchers. Each chokidar watcher
 * holds at minimum a native FSEvents/inotify handle plus an fd per recursive
 * stream; in practice, bulk indexing dozens of repos with default watcher
 * behavior has exhausted the macOS system file table (ENFILE). Capping the
 * pool plus LRU eviction keeps fd usage bounded while still giving the
 * user-active repo (last touched) live incremental updates.
 *
 * Override via CODESIFT_MAX_WATCHERS env var. Set to 0 to disable watchers
 * entirely (suitable for CI / batch index runs).
 */

/** Stop every active watcher and clear the in-memory index caches. Exported
 *  for testing — afterAll teardown of integration tests that index temp dirs
 *  must call this before `rm -rf`-ing the temp dir, otherwise the chokidar
 *  watcher races the rm and emits ENOTEMPTY/ENOENT noise that shows up as
 *  file-level test failures even when every test inside passed. */
export async function stopAllWatchersForTesting(): Promise<void> {
  const watchers = [...activeWatchers.values()];
  activeWatchers.clear();
  await Promise.all(watchers.map((w) => stopWatcher(w).catch(() => {})));
  bm25Indexes.clear();
  codeIndexes.clear();
  embeddingCaches.clear();
  resetFreshnessCache();
}
