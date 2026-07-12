import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { openSync, closeSync, statSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { EXTRACTOR_VERSIONS } from "../index-shared.js";
import { getSnapshotPath, loadHashSnapshot, saveHashSnapshot, type FileHashSnapshot } from "../../storage/hash-snapshot.js";
import type { CodeIndex } from "../../types.js";
import { parseOneFile } from "./parse.js";

const PARSE_CONCURRENCY = 8;

export async function loadIndexSnapshot(
  indexPath: string,
  repoName: string,
  indexUpdatedAt: number,
): Promise<FileHashSnapshot | null> {
  const snapshot = await loadHashSnapshot(getSnapshotPath(indexPath), repoName);
  if (snapshot && snapshot.created_at !== indexUpdatedAt) {
    console.warn(`[codesift] hash-snapshot older than index — rebuilding (${repoName})`);
    return null;
  }
  return snapshot;
}

export async function saveIndexSnapshot(
  indexPath: string,
  snapshot: FileHashSnapshot,
): Promise<void> {
  await saveHashSnapshot(getSnapshotPath(indexPath), snapshot);
}

/**
 * Decide whether a previously stored index no longer reflects the working
 * tree. Samples up to 256 of its file paths (even stride) and stats them;
 * when at least half are gone the old index is treated as stale. Used by the
 * indexFolder sanity check to break the poisoned-baseline deadlock: an old
 * index bloated with since-deleted trees (.worktrees/, vendored dirs) would
 * otherwise reject every honest reindex as "truncated" forever.
 */
const STALE_SAMPLE_LIMIT = 256;
const STALE_MISSING_FRACTION = 0.5;

export async function isExistingIndexStale(
  existing: CodeIndex,
  rootPath: string,
): Promise<boolean> {
  const paths = existing.files.map((f) => f.path);
  if (paths.length === 0) return true;

  const stride = Math.max(1, Math.floor(paths.length / STALE_SAMPLE_LIMIT));
  const sampled: string[] = [];
  for (let i = 0; i < paths.length && sampled.length < STALE_SAMPLE_LIMIT; i += stride) {
    const p = paths[i];
    if (p) sampled.push(p);
  }

  let missing = 0;
  await Promise.all(sampled.map(async (relPath) => {
    try {
      await stat(join(rootPath, relPath));
    } catch {
      missing++;
    }
  }));

  return missing >= sampled.length * STALE_MISSING_FRACTION;
}

/**
 * Read a file and return the sha1 hex of its UTF-8 content, or null on read
 * failure (deleted mid-walk, permission error). Code-sized files only — same
 * assumption parseOneFile already makes. Non-throwing: callers treat null as
 * "could not hash → fall through to re-parse".
 */
export async function sha1OfFile(absPath: string): Promise<string | null> {
  try {
    const content = await readFile(absPath, "utf-8");
    return createHash("sha1").update(content).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Exported for unit testing only — not part of the public API.
 *
 * Drains a legacy-hash queue: hashes each file, then re-stats to confirm the
 * mtime has not drifted since the decision-time stat. Entries whose mtime
 * drifted (or whose stat fails) are omitted from the returned map so the next
 * run re-parses them rather than reusing symbols against a mismatched sha.
 *
 * @param queue  Items from the legacyHashQueue (relPath + filePath + decision-time mtimeMs).
 * @param hashFn Injectable hash function (default: sha1OfFile). Tests inject a
 *               function that also modifies the file so they can trigger the
 *               TOCTOU drift-detection path without real concurrency.
 * @param statFn Injectable stat function (default: fs.stat). Tests can stub this
 *               to return a post-modification mtime.
 */
export async function drainLegacyHashQueue(
  queue: Array<{ relPath: string; filePath: string; mtimeMs: number }>,
  hashFn: (absPath: string) => Promise<string | null> = sha1OfFile,
  statFn: (absPath: string) => Promise<{ mtimeMs: number }> = (p) =>
    import("node:fs/promises").then((m) => m.stat(p)),
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (let i = 0; i < queue.length; i += PARSE_CONCURRENCY) {
    const batch = queue.slice(i, i + PARSE_CONCURRENCY);
    const shas = await Promise.all(batch.map((q) => hashFn(q.filePath)));
    const stats = await Promise.all(
      batch.map((q) =>
        statFn(q.filePath).then(
          (st) => Math.round(st.mtimeMs),
          () => null,
        ),
      ),
    );
    batch.forEach((q, j) => {
      const currentMtime = stats[j];
      if (currentMtime === null || currentMtime !== q.mtimeMs) {
        // Mtime drifted or file gone — omit so next run re-parses.
        return;
      }
      // Omit on null hash — never persist an empty-string sentinel that a
      // snapshot reader could mistake for a valid sha1.
      if (shas[j]) result[q.relPath] = shas[j]!;
    });
  }
  return result;
}

export const ASTRO_LOCK_FILENAME = "astro-reindex.lock";
export const EXTRACTOR_VERSIONS_FILENAME = "extractor-versions.json";

const LOCK_STALE_MS = 60_000; // 60 seconds

export interface AstroReindexResult {
  reindexed: boolean;
  files_reindexed?: number;
  reason: string;
}

/**
 * Check if the stored astro extractor version matches the current one.
 * If not, re-extract all .astro files with lockfile protection.
 *
 * @param dataDir   The data directory (e.g., ~/.codesift or a test tmpdir)
 * @param repoRoot  The repo root path (for locating .astro files)
 * @param astroFiles  Relative paths to .astro files in the repo
 */
export async function checkAstroExtractorVersion(
  dataDir: string,
  repoRoot: string,
  astroFiles: string[],
): Promise<AstroReindexResult> {
  // Read stored version snapshot
  const versionsPath = join(dataDir, EXTRACTOR_VERSIONS_FILENAME);
  let storedVersions: Record<string, string> = {};
  try {
    const raw = await readFile(versionsPath, "utf-8");
    storedVersions = JSON.parse(raw);
  } catch {
    // File doesn't exist or is invalid — treat as version mismatch
  }

  // Check if astro version matches
  if (storedVersions.astro === EXTRACTOR_VERSIONS.astro) {
    return { reindexed: false, reason: "astro extractor up to date" };
  }

  if (astroFiles.length === 0) {
    // No astro files to re-extract — just update the version snapshot
    await writeVersionSnapshot(dataDir, storedVersions);
    return { reindexed: false, reason: "no astro files to re-extract" };
  }

  // Acquire lockfile
  const lockPath = join(dataDir, ASTRO_LOCK_FILENAME);
  if (!acquireLock(lockPath)) {
    return { reindexed: false, reason: "astro re-index in progress (locked by another process)" };
  }

  try {
    // Re-extract all .astro files
    let count = 0;
    for (const relPath of astroFiles) {
      const absPath = join(repoRoot, relPath);
      try {
        const result = await parseOneFile(absPath, repoRoot, "");
        if (result) {
          count++;
          if (count % 100 === 0) {
            console.error(`[codesift] Astro re-index progress: ${count}/${astroFiles.length} files`);
          }
        }
      } catch {
        // File may have been deleted or is unparseable
      }
    }

    // Write version snapshot atomically
    await writeVersionSnapshot(dataDir, storedVersions);

    return {
      reindexed: true,
      files_reindexed: count,
      reason: `re-extracted ${count} astro files (version ${storedVersions.astro ?? "none"} → ${EXTRACTOR_VERSIONS.astro})`,
    };
  } finally {
    // Release lockfile
    try {
      unlinkSync(lockPath);
    } catch {
      // Lock may have been cleaned up already
    }
  }
}

/**
 * Acquire an exclusive lockfile. Returns true if lock was acquired.
 * If lockfile exists but is stale (mtime > 60s), deletes it and retries once.
 */
function acquireLock(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, "wx");
    closeSync(fd);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      return false;
    }

    // Lock exists — check if stale
    try {
      const lockStat = statSync(lockPath);
      const age = Date.now() - lockStat.mtimeMs;
      if (age > LOCK_STALE_MS) {
        // Stale lock — delete and retry once
        unlinkSync(lockPath);
        try {
          const fd = openSync(lockPath, "wx");
          closeSync(fd);
          return true;
        } catch {
          return false;
        }
      }
    } catch {
      // stat failed — lock was just removed by another process
      return false;
    }

    return false;
  }
}

/**
 * Atomically write the extractor versions snapshot.
 * Uses write-to-tmp + rename for crash safety.
 */
async function writeVersionSnapshot(
  dataDir: string,
  existingVersions: Record<string, string>,
): Promise<void> {
  const versionsPath = join(dataDir, EXTRACTOR_VERSIONS_FILENAME);
  const tmpPath = `${versionsPath}.tmp.${Date.now()}`;
  const snapshot = { ...existingVersions, astro: EXTRACTOR_VERSIONS.astro };
  writeFileSync(tmpPath, JSON.stringify(snapshot), "utf-8");
  renameSync(tmpPath, versionsPath);
}
