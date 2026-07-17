import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { EXTRACTOR_VERSIONS } from "../index-shared.js";
import { getLanguageForExtension } from "../../parser/parser-manager.js";
import { saveIndex, loadIndex, getIndexPath } from "../../storage/index-store.js";
import { clearTsconfigCache } from "../../utils/tsconfig-paths.js";
import {
  registerRepo,
  listRepos as listRegistryRepos,
  removeRepo,
  getRepoName,
  updateRepoMeta,
} from "../../storage/registry.js";
import { buildBM25Index } from "../../search/bm25.js";
import { loadConfig } from "../../config.js";
import { walkDirectory } from "../../utils/walk.js";
import { HASH_SNAPSHOT_VERSION, type FileHashSnapshot } from "../../storage/hash-snapshot.js";
import type { CodeIndex, CodeSymbol, FileEntry, RepoMeta } from "../../types.js";
import { activeWatchers, bm25Indexes, codeIndexes, lastFullIndexAt } from "./state.js";
import { parseFiles, propagateDirtySignatures, embedSymbols, embedChunks } from "./parse.js";
import { drainLegacyHashQueue, loadIndexSnapshot, saveIndexSnapshot, sha1OfFile } from "./snapshots.js";
import { setupWatcher } from "./watcher.js";
import { validateAndMergeFolderWalk } from "./folder-merge.js";
import type { IndexFolderResult } from "./types.js";

export type { IndexFolderResult } from "./types.js";

const INDEX_FOLDER_REDUNDANT_WINDOW_MS = 60_000;
const DEFAULT_MAX_FILES = 50_000;

function getDefaultMaxFiles(): number {
  const envVal = process.env.CODESIFT_MAX_FILES;
  if (envVal) {
    const parsed = Number.parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_FILES;
}

/** Test-only — clear short-circuit state. */
export function resetIndexFolderRedundancyForTesting(): void {
  lastFullIndexAt.clear();
}

export async function indexFolder(
  folderPath: string,
  options?: {
    incremental?: boolean | undefined;
    include_paths?: string[] | undefined;
    watch?: boolean | undefined;
    /**
     * Cap on files indexed in a single pass. When the walker hits this, it
     * returns partial results with a warning rather than blowing through
     * memory. Default: DEFAULT_MAX_FILES (or CODESIFT_MAX_FILES env var).
     */
    max_files?: number | undefined;
    /**
     * Bypass the watcher-active short-circuit (see lastFullIndexAt). Used by
     * indexRepo for fresh clones where defensive reindex is correct.
     */
    force?: boolean | undefined;
  },
): Promise<IndexFolderResult> {
  if (!folderPath || typeof folderPath !== "string") {
    throw new Error("folderPath is required and must be a non-empty string");
  }

  const rootPath = resolve(folderPath);
  const repoName = getRepoName(rootPath);

  // Short-circuit: if a watcher is already keeping the index for this root
  // live and we re-indexed recently, return a skipped status instead of
  // walking the filesystem again.
  if (!options?.force) {
    const lastTs = lastFullIndexAt.get(rootPath);
    const watcher = activeWatchers.get(repoName);
    if (watcher && lastTs && Date.now() - lastTs < INDEX_FOLDER_REDUNDANT_WINDOW_MS) {
      return {
        repo: repoName,
        root: rootPath,
        file_count: 0,
        symbol_count: 0,
        duration_ms: 0,
        status: "skipped",
        reason: "watcher active, recent index",
        last_indexed: new Date(lastTs).toISOString(),
        hint: "pass force=true to override",
      };
    }
  }

  // Clear tsconfig path resolver cache so config edits between runs take effect.
  // The two-level cache (configCache + dirToConfigCache) is module-level and
  // would otherwise serve stale alias mappings if a user edited tsconfig.json
  // between successive index_folder calls within the same MCP server process.
  clearTsconfigCache();

  const config = loadConfig();
  const startTime = Date.now();

  const indexPath = getIndexPath(config.dataDir, rootPath);

  // Read .codesiftignore for user-defined exclude patterns
  let excludePatterns: string[] | undefined;
  try {
    const ignoreContent = await readFile(join(rootPath, ".codesiftignore"), "utf-8");
    excludePatterns = ignoreContent
      .split("\n")
      .map((line) => line.replace(/#.*$/, "").trim())
      .filter((line) => line.length > 0);
    if (excludePatterns.length === 0) excludePatterns = undefined;
  } catch {
    // .codesiftignore not found — proceed without patterns
  }

  // Walk directory and collect parseable files. maxFiles caps unbounded walks
  // (huge monorepos, vendored data sets) before they OOM the process — see
  // DEFAULT_MAX_FILES rationale above.
  const maxFiles = options?.max_files ?? getDefaultMaxFiles();
  const files = await walkDirectory(rootPath, {
    includePaths: options?.include_paths,
    excludePatterns,
    maxFiles,
    fileFilter: (ext, name) => !!getLanguageForExtension(ext) || (name?.startsWith(".env") ?? false),
  });
  const hitFileLimit = files.length >= maxFiles;
  if (hitFileLimit) {
    console.error(
      `[codesift] index_folder: ${rootPath} hit max_files=${maxFiles}; ` +
      `partial index. Pass include_paths to scope the walk or raise max_files.`,
    );
  }

  // mtime-based incremental: skip files unchanged since last index
  const existing = await loadIndex(indexPath);
  const mtimeMap = new Map<string, number>();
  if (existing) {
    for (const f of existing.files) {
      if (f.mtime_ms) mtimeMap.set(f.path, f.mtime_ms);
    }
  }

  // Load and validate the persistent hash snapshot paired with the existing index.
  const oldSnapshot = existing
    ? await loadIndexSnapshot(indexPath, repoName, existing.updated_at)
    : null;

  const filesToParse: string[] = [];
  const keptSymbols: CodeSymbol[] = [];
  const keptEntries: FileEntry[] = [];

  // sha1 of every file in the NEW index, by relPath. Populated for reused files
  // here (from the old snapshot when present, else hashed-now for convergence)
  // and for parsed files after parseFiles resolves.
  const newSnapshotFiles: Record<string, string> = {};

  // CRITICAL-1: reused files whose sha1 must be (re)computed because the old
  // snapshot lacks it (legacy snapshot-less index, or stale snapshot discarded
  // above). Collected here and hashed AFTER the loop in PARSE_CONCURRENCY
  // batches instead of one serial await per file inside the loop — on a first
  // run after upgrade against a many-thousand-file repo the serial version cost
  // thousands of sequential awaits. Behavior is identical, wall-clock is
  // parallelized.
  //
  // mtimeMs: the mtime observed at decision time (the moment we confirmed
  // mtime === prevMtime and placed the file in the queue). We re-stat after
  // hashing to detect any concurrent modification that landed between the two
  // operations. If the mtime drifted, we omit the file from newSnapshotFiles
  // entirely — the missing sha causes the next cold run to re-parse, avoiding
  // a snapshot that pairs new-content sha against old (reused) symbols.
  const legacyHashQueue: Array<{ relPath: string; filePath: string; mtimeMs: number }> = [];

  // PERF: pre-build per-file lookups ONCE before the reuse loop. Both reuse
  // branches need (a) the existing index's symbols for a given relPath and (b)
  // its FileEntry. Doing `existing.symbols.filter(s => s.file === relPath)` /
  // `existing.files.find(f => f.path === relPath)` per file is O(files ×
  // symbols) and O(files²) respectively — quadratic, and on a many-thousand
  // file/symbol repo that dominated the reuse-heavy fast path. A single pass
  // builds Map lookups each branch hits in O(1). Built only when there's an
  // existing index to reuse from.
  const symbolsByFile = new Map<string, CodeSymbol[]>();
  const fileEntryByPath = new Map<string, FileEntry>();
  if (existing) {
    for (const sym of existing.symbols) {
      const list = symbolsByFile.get(sym.file);
      if (list) list.push(sym);
      else symbolsByFile.set(sym.file, [sym]);
    }
    for (const fe of existing.files) {
      fileEntryByPath.set(fe.path, fe);
    }
  }

  if (mtimeMap.size > 0) {
    const { stat } = await import("node:fs/promises");
    for (const filePath of files) {
      const relPath = relative(rootPath, filePath);
      const prevMtime = mtimeMap.get(relPath);
      if (prevMtime !== undefined) {
        const fileEntry = fileEntryByPath.get(relPath);
        // Force re-parse if file is marked stale (callee signature changed)
        if (fileEntry?.stale) {
          filesToParse.push(filePath);
          continue;
        }
        try {
          const st = await stat(filePath);
          if (Math.round(st.mtimeMs) === prevMtime) {
            // Fast path: mtime unchanged → reuse symbols without hashing.
            const fileSymbols = symbolsByFile.get(relPath) ?? [];
            if (fileEntry) {
              keptSymbols.push(...fileSymbols);
              keptEntries.push(fileEntry);
              // Carry the sha1 forward: reuse from old snapshot if present,
              // else DEFER hashing so legacy (snapshot-less) indexes converge
              // to a complete snapshot after one run — without paying a serial
              // hash per file inside this loop.
              const carried = oldSnapshot?.files[relPath];
              if (carried !== undefined) {
                newSnapshotFiles[relPath] = carried;
              } else {
                legacyHashQueue.push({ relPath, filePath, mtimeMs: Math.round(st.mtimeMs) });
              }
              continue;
            }
          } else {
            // mtime changed — hash decides reuse vs re-parse. This catches
            // touch/checkout that bumped mtime without changing content.
            const snapSha = oldSnapshot?.files[relPath];
            if (snapSha !== undefined && fileEntry && !fileEntry.stale) {
              const currentSha = await sha1OfFile(filePath);
              if (currentSha !== null && currentSha === snapSha) {
                const fileSymbols = symbolsByFile.get(relPath) ?? [];
                keptSymbols.push(...fileSymbols);
                // FIX: the file's mtime changed but content is identical (touch /
                // checkout no-op rewrite). Reuse the symbols, but DON'T carry the
                // stale FileEntry verbatim — its mtime_ms still holds the OLD
                // mtime, so every future run would see mtime !== prevMtime and
                // re-hash this file forever, permanently degrading it off the
                // mtime fast path. Clone the entry with mtime_ms bumped to the
                // CURRENT stat's mtime so the next run takes the cheap fast path.
                keptEntries.push({ ...fileEntry, mtime_ms: Math.round(st.mtimeMs) });
                newSnapshotFiles[relPath] = currentSha;
                continue;
              }
            }
          }
        } catch { /* file may have been deleted — reparse */ }
      }
      filesToParse.push(filePath);
    }
  } else {
    filesToParse.push(...files);
  }

  // Drain the deferred legacy-hash queue (CRITICAL-1): files reused via the
  // mtime fast path that had no carried sha1 (legacy snapshot-less index, or a
  // stale snapshot discarded by the guard above). See drainLegacyHashQueue for
  // the TOCTOU guard details — entries whose mtime drifted between decision
  // time and hash time are omitted so the next run re-parses rather than
  // reusing symbols against a mismatched sha.
  if (legacyHashQueue.length > 0) {
    const drained = await drainLegacyHashQueue(legacyHashQueue);
    Object.assign(newSnapshotFiles, drained);
  }

  // Parse only changed/new files
  const { symbols: parsedSymbols, fileEntries: parsedEntries, shas: parsedShas } = await parseFiles(filesToParse, rootPath, repoName);
  const symbols = [...keptSymbols, ...parsedSymbols];
  const fileEntries = [...keptEntries, ...parsedEntries];

  // Record sha1s for the files that were actually parsed (changed/new).
  // CRITICAL-1 (TOCTOU): these hashes come straight from parseOneFile — they
  // are the sha1 of the EXACT source string that produced the symbols, so the
  // snapshot can never pair old symbols with a newer file's sha. Only entries
  // that survived parseFiles (parseOneFile returned non-null) have a sha here,
  // keeping the snapshot in lockstep with fileEntries. The previous post-parse
  // double-read loop is gone — one fewer full read per parsed file.
  for (const entry of parsedEntries) {
    const sha = parsedShas[entry.path];
    if (sha !== undefined) newSnapshotFiles[entry.path] = sha;
  }

  // Dirty propagation: detect signature changes and mark caller files stale
  if (existing && filesToParse.length > 0 && filesToParse.length < files.length) {
    const staleFiles = propagateDirtySignatures(existing.symbols, symbols, fileEntries);
    if (staleFiles.size > 0) {
      console.error(`[codesift] Dirty propagation: ${staleFiles.size} caller files marked stale`);
    }
  }

  // Invalidate code index cache (BM25 is rebuilt below from the FINAL symbol
  // set — possibly merged with out-of-scope existing symbols, see merge block).
  codeIndexes.delete(repoName);

  const mergeResult = await validateAndMergeFolderWalk({
    existing,
    fileEntries,
    symbols,
    newSnapshotFiles,
    oldSnapshot,
    rootPath,
    repoName,
    startTime,
    maxFiles,
    hitFileLimit,
    includePaths: options?.include_paths,
  });
  if (!("mergedSymbols" in mergeResult)) return mergeResult;
  const { mergedSymbols, mergedEntries, mergedSnapshotFiles } = mergeResult;

  // Build and cache BM25 index from the FINAL (possibly merged) symbol set.
  // Built here (not before the guard) so a rejected_partial early-return leaves
  // the previous in-memory BM25 index intact rather than swapping in a partial.
  const bm25 = buildBM25Index(mergedSymbols);
  bm25Indexes.set(repoName, bm25);

  // Resolve workspaces (Task 7) — runs before persistence so collectImportEdges
  // and other downstream consumers see the populated `workspaces` field.
  // Gated behind CODESIFT_DISABLE_MONOREPO=1 kill switch (spec D-FB).
  let workspaces: import("../../types.js").Workspace[] | undefined;
  if (process.env.CODESIFT_DISABLE_MONOREPO !== "1") {
    try {
      const { resolveWorkspaces } = await import("../../storage/workspace-resolver.js");
      const resolved = await resolveWorkspaces(rootPath);
      if (resolved) workspaces = resolved.workspaces;
    } catch {
      // Resolver should never throw, but guard belt-and-braces — flat-repo
      // mode is the safe fallback.
    }
  }

  // Build and save code index from the FINAL (possibly merged) sets.
  const codeIndex: CodeIndex = {
    repo: repoName,
    root: rootPath,
    symbols: mergedSymbols,
    files: mergedEntries,
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: mergedSymbols.length,
    file_count: mergedEntries.length,
    extractor_version: { ...EXTRACTOR_VERSIONS },
    ...(workspaces ? { workspaces } : {}),
  };
  await saveIndex(indexPath, codeIndex);

  // Persist the hash snapshot AFTER the index lands (mirrors registerRepo
  // ordering) and only on the success path — the rejected_partial branch
  // returned earlier, leaving the previous snapshot intact. Non-fatal: the
  // snapshot is a reuse-optimization cache; a write failure just costs a full
  // re-parse next run, so we warn and continue.
  try {
    const newSnapshot: FileHashSnapshot = {
      version: HASH_SNAPSHOT_VERSION,
      repo: repoName,
      // CRITICAL-2 (created_at race): use the EXACT timestamp serialized into
      // the index, not a fresh Date.now(). A watcher's saveIncremental that
      // lands between saveIndex and this write would otherwise leave the
      // snapshot OLDER than created_at, blinding the staleness guard above. By
      // anchoring to codeIndex.updated_at, snapshot.created_at === the index's
      // updated_at on a fresh write, so any later incremental strictly advances
      // index.updated_at past it and the guard fires correctly.
      created_at: codeIndex.updated_at,
      files: mergedSnapshotFiles,
    };
    await saveIndexSnapshot(indexPath, newSnapshot);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[codesift] hash-snapshot save failed for ${repoName} (non-fatal): ${msg}`);
  }

  // Embed symbols and chunks in background (non-fatal, don't block MCP response)
  // Large repos (71K symbols) can take minutes — fire-and-forget to prevent timeout
  embedSymbols(mergedSymbols, indexPath, repoName, config)
    .then(() => embedChunks(mergedEntries, rootPath, repoName, indexPath, config, mergedSymbols))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[codesift] Background embedding failed for ${repoName}: ${msg}`);
    });

  // Register in the global registry. If a stale entry exists with the same
  // root but a different name (e.g. `local/workspace` from before the git
  // origin auto-detect landed), drop it so `list_repos` doesn't show ghosts.
  const existingRepos = await listRegistryRepos(config.registryPath);
  for (const stale of existingRepos) {
    if (stale.root === rootPath && stale.name !== repoName) {
      await removeRepo(config.registryPath, stale.name);
      console.error(`[codesift] Migrated registry: ${stale.name} -> ${repoName} (same root)`);
    }
  }

  const meta: RepoMeta = {
    name: repoName,
    root: rootPath,
    index_path: indexPath,
    symbol_count: mergedSymbols.length,
    file_count: mergedEntries.length,
    updated_at: Date.now(),
  };
  await registerRepo(config.registryPath, meta);

  // Capture git HEAD for auto-refresh tracking
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: rootPath, encoding: "utf-8", timeout: 5000,
    }).trim();
    await updateRepoMeta(config.registryPath, repoName, { last_git_commit: head });
  } catch {
    // Not a git repo — skip
  }

  // Start file watcher for incremental updates (unless disabled)
  if (options?.watch !== false) {
    await setupWatcher(rootPath, repoName, indexPath);
  }

  // Auto-enable framework-specific tool bundles (NestJS, etc.)
  // Lazy import to avoid circular dep: index-tools → register-tools → tool handlers → index-tools
  try {
    const { detectFrameworks } = await import("../../utils/framework-detect.js");
    const { enableFrameworkToolBundle } = await import("../../register-tools.js");
    const tempIndex = { root: rootPath, files: mergedEntries, symbols: mergedSymbols } as CodeIndex;
    const frameworks = detectFrameworks(tempIndex);
    for (const fw of frameworks) {
      const enabled = enableFrameworkToolBundle(fw);
      if (enabled.length > 0) {
        console.error(`[codesift] auto-enabled ${enabled.length} ${fw} tools for ${repoName}: ${enabled.join(", ")}`);
      }
    }
  } catch {
    // Non-fatal — framework auto-enable is a convenience feature
  }

  // Record completion timestamp so subsequent re-runs can short-circuit when
  // the watcher is keeping the index fresh.
  lastFullIndexAt.set(rootPath, Date.now());

  return {
    repo: repoName,
    root: rootPath,
    file_count: mergedEntries.length,
    symbol_count: mergedSymbols.length,
    duration_ms: Date.now() - startTime,
  };
}
