import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { join, relative, extname, resolve } from "node:path";
import { parseFile } from "../parser/parser-manager.js";
import { extractSymbols } from "../parser/symbol-extractor.js";
import { getLanguageForExtension } from "../parser/parser-manager.js";
import { saveIndex, loadIndex, getIndexPath, saveIncremental } from "../storage/index-store.js";
import { registerRepo, listRepos as listRegistryRepos, getRepo, removeRepo, getRepoName } from "../storage/registry.js";
import { startWatcher, stopWatcher, type FSWatcher } from "../storage/watcher.js";
import { buildBM25Index, type BM25Index } from "../search/bm25.js";
import { loadConfig } from "../config.js";
import type { CodeSymbol, CodeIndex, FileEntry, RepoMeta } from "../types.js";

// Ignore patterns for directory walking (same as watcher)
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage",
  ".codesift", ".next", "__pycache__", ".pytest_cache",
  ".venv", "venv", ".tox", ".mypy_cache", ".turbo",
]);

const MAX_FILE_SIZE = 1_000_000; // 1MB — skip giant files
const PARSE_CONCURRENCY = 8;

// Active watchers and BM25 indexes keyed by repo name
const activeWatchers = new Map<string, FSWatcher>();
const bm25Indexes = new Map<string, BM25Index>();

/**
 * Walk a directory tree, collecting files that can be parsed.
 * Respects .gitignore patterns and skips known non-source directories.
 */
async function walkDirectory(
  rootPath: string,
  includePaths?: string[],
): Promise<string[]> {
  const files: string[] = [];

  async function walk(dirPath: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return; // permission denied, etc.
    }

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) {
          continue;
        }
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        const language = getLanguageForExtension(ext);
        if (!language) continue;

        // Filter by include paths if specified
        if (includePaths && includePaths.length > 0) {
          const relPath = relative(rootPath, fullPath);
          const matches = includePaths.some((p) => relPath.startsWith(p));
          if (!matches) continue;
        }

        // Skip files that are too large
        try {
          const fileStat = await stat(fullPath);
          if (fileStat.size > MAX_FILE_SIZE) continue;
        } catch {
          continue;
        }

        files.push(fullPath);
      }
    }
  }

  await walk(rootPath);
  return files;
}

/**
 * Parse files in parallel batches.
 */
async function parseFiles(
  files: string[],
  repoRoot: string,
  repoName: string,
): Promise<{ symbols: CodeSymbol[]; fileEntries: FileEntry[] }> {
  const allSymbols: CodeSymbol[] = [];
  const fileEntries: FileEntry[] = [];

  // Process in batches for controlled concurrency
  for (let i = 0; i < files.length; i += PARSE_CONCURRENCY) {
    const batch = files.slice(i, i + PARSE_CONCURRENCY);

    const results = await Promise.all(
      batch.map(async (filePath) => {
        try {
          const source = await readFile(filePath, "utf-8");
          const tree = await parseFile(filePath, source);
          if (!tree) return null;

          const relPath = relative(repoRoot, filePath);
          const ext = extname(filePath);
          const language = getLanguageForExtension(ext) ?? "unknown";

          const symbols = extractSymbols(tree, relPath, source, repoName, language);

          const entry: FileEntry = {
            path: relPath,
            language,
            symbol_count: symbols.length,
            last_modified: Date.now(),
          };

          return { symbols, entry };
        } catch {
          return null;
        }
      }),
    );

    for (const result of results) {
      if (result) {
        allSymbols.push(...result.symbols);
        fileEntries.push(result.entry);
      }
    }
  }

  return { symbols: allSymbols, fileEntries };
}

// ---------------------------------------------------------------------------
// Public tool handlers
// ---------------------------------------------------------------------------

export interface IndexFolderResult {
  repo: string;
  root: string;
  file_count: number;
  symbol_count: number;
  duration_ms: number;
}

export async function indexFolder(
  folderPath: string,
  options?: {
    incremental?: boolean | undefined;
    include_paths?: string[] | undefined;
    watch?: boolean | undefined;
  },
): Promise<IndexFolderResult> {
  const config = loadConfig();
  const startTime = Date.now();

  const rootPath = resolve(folderPath);
  const repoName = getRepoName(rootPath);
  const indexPath = getIndexPath(config.dataDir, rootPath);

  // Check for incremental update
  if (options?.incremental) {
    const existing = await loadIndex(indexPath);
    if (existing) {
      // For now, incremental just returns existing stats.
      // Full incremental support comes via file watcher.
      return {
        repo: repoName,
        root: rootPath,
        file_count: existing.file_count,
        symbol_count: existing.symbol_count,
        duration_ms: Date.now() - startTime,
      };
    }
  }

  // Walk directory and collect parseable files
  const files = await walkDirectory(rootPath, options?.include_paths);

  // Parse all files and extract symbols
  const { symbols, fileEntries } = await parseFiles(files, rootPath, repoName);

  // Build and cache BM25 index
  const bm25 = buildBM25Index(symbols);
  bm25Indexes.set(repoName, bm25);

  // Build code index
  const codeIndex: CodeIndex = {
    repo: repoName,
    root: rootPath,
    symbols,
    files: fileEntries,
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: symbols.length,
    file_count: fileEntries.length,
  };

  // Save index to disk
  await saveIndex(indexPath, codeIndex);

  // Register in the global registry
  const meta: RepoMeta = {
    name: repoName,
    root: rootPath,
    index_path: indexPath,
    symbol_count: symbols.length,
    file_count: fileEntries.length,
    updated_at: Date.now(),
  };
  await registerRepo(config.registryPath, meta);

  // Start file watcher for incremental updates (unless disabled)
  const shouldWatch = options?.watch !== false;
  if (shouldWatch) {
    const existingWatcher = activeWatchers.get(repoName);
    if (existingWatcher) {
      await stopWatcher(existingWatcher);
    }

    const watcher = startWatcher(rootPath, (changedFile) => {
      handleFileChange(rootPath, repoName, indexPath, changedFile).catch(
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[codesift] Watcher error for ${changedFile}: ${message}`);
        },
      );
    });
    activeWatchers.set(repoName, watcher);
  }

  return {
    repo: repoName,
    root: rootPath,
    file_count: fileEntries.length,
    symbol_count: symbols.length,
    duration_ms: Date.now() - startTime,
  };
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

  try {
    const source = await readFile(fullPath, "utf-8");
    const tree = await parseFile(fullPath, source);
    if (!tree) return;

    const ext = extname(relativeFile);
    const language = getLanguageForExtension(ext) ?? "unknown";
    const symbols = extractSymbols(tree, relativeFile, source, repoName, language);

    await saveIncremental(indexPath, relativeFile, symbols);

    // Rebuild in-memory BM25 index
    const index = await loadIndex(indexPath);
    if (index) {
      bm25Indexes.set(repoName, buildBM25Index(index.symbols));
    }
  } catch {
    // File may have been deleted between event and read — ignore
  }
}

export async function listAllRepos(): Promise<RepoMeta[]> {
  const config = loadConfig();
  return listRegistryRepos(config.registryPath);
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

  // Remove BM25 index from memory
  bm25Indexes.delete(repoName);

  // Delete index file
  try {
    await unlink(meta.index_path);
  } catch {
    // File may not exist
  }

  // Remove from registry
  await removeRepo(config.registryPath, repoName);
  return true;
}

/**
 * Get the in-memory BM25 index for a repo.
 * Loads from disk if not cached.
 */
export async function getBM25Index(repoName: string): Promise<BM25Index | null> {
  const cached = bm25Indexes.get(repoName);
  if (cached) return cached;

  const config = loadConfig();
  const meta = await getRepo(config.registryPath, repoName);
  if (!meta) return null;

  const index = await loadIndex(meta.index_path);
  if (!index) return null;

  const bm25 = buildBM25Index(index.symbols);
  bm25Indexes.set(repoName, bm25);
  return bm25;
}

/**
 * Get the code index for a repo from disk.
 */
export async function getCodeIndex(repoName: string): Promise<CodeIndex | null> {
  const config = loadConfig();
  const meta = await getRepo(config.registryPath, repoName);
  if (!meta) return null;

  return loadIndex(meta.index_path);
}
