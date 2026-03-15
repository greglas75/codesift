import { readFile, stat, unlink, rm, mkdir as mkdirAsync } from "node:fs/promises";
import { join, relative, extname, resolve, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { parseFile } from "../parser/parser-manager.js";
import { extractSymbols, extractMarkdownSymbols, extractPrismaSymbols } from "../parser/symbol-extractor.js";
import { getLanguageForExtension } from "../parser/parser-manager.js";
import { saveIndex, loadIndex, getIndexPath, saveIncremental } from "../storage/index-store.js";
import { registerRepo, listRepos as listRegistryRepos, getRepo, removeRepo, getRepoName } from "../storage/registry.js";
import { startWatcher, stopWatcher, type FSWatcher } from "../storage/watcher.js";
import { buildBM25Index, type BM25Index } from "../search/bm25.js";
import { buildSymbolText, createEmbeddingProvider } from "../search/semantic.js";
import { loadEmbeddings, saveEmbeddings, saveEmbeddingMeta, getEmbeddingPath, getEmbeddingMetaPath, batchEmbed } from "../storage/embedding-store.js";
import { saveChunks, saveChunkEmbeddings, loadChunkEmbeddings, getChunkPath, getChunkEmbeddingPath } from "../storage/chunk-store.js";
import { chunkFile } from "../search/chunker.js";
import { loadConfig } from "../config.js";
import { validateGitUrl, validateGitRef } from "../utils/git-validation.js";
import { walkDirectory } from "../utils/walk.js";
import type { CodeSymbol, CodeIndex, FileEntry, RepoMeta } from "../types.js";

const PARSE_CONCURRENCY = 8;

// Active watchers and in-memory indexes keyed by repo name
const activeWatchers = new Map<string, FSWatcher>();
const bm25Indexes = new Map<string, BM25Index>();
const embeddingCaches = new Map<string, Map<string, Float32Array>>();

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
          const relPath = relative(repoRoot, filePath);
          const ext = extname(filePath);
          const language = getLanguageForExtension(ext) ?? "unknown";

          let symbols: CodeSymbol[];

          // Markdown and Prisma use custom parsers (no tree-sitter grammar)
          if (language === "markdown") {
            symbols = extractMarkdownSymbols(source, relPath, repoName);
          } else if (language === "prisma") {
            symbols = extractPrismaSymbols(source, relPath, repoName);
          } else {
            const tree = await parseFile(filePath, source);
            if (!tree) return null;
            symbols = extractSymbols(tree, relPath, source, repoName, language);
          }

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
  const files = await walkDirectory(rootPath, {
    includePaths: options?.include_paths,
    fileFilter: (ext) => !!getLanguageForExtension(ext),
  });

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

  // Embed symbols if an embedding provider is configured (non-fatal if it fails)
  if (config.embeddingProvider) {
    const embeddingPath = getEmbeddingPath(indexPath);
    const metaPath = getEmbeddingMetaPath(indexPath);
    try {
      const provider = createEmbeddingProvider(config.embeddingProvider, config);
      const symbolTexts = new Map(symbols.map((s) => [s.id, buildSymbolText(s)]));
      const existing = await loadEmbeddings(embeddingPath);
      const embeddings = await batchEmbed(symbolTexts, existing, provider.embed.bind(provider), config.embeddingBatchSize);
      await saveEmbeddings(embeddingPath, embeddings);
      await saveEmbeddingMeta(metaPath, {
        model: provider.model,
        provider: config.embeddingProvider,
        dimensions: provider.dimensions,
        symbol_count: embeddings.size,
        updated_at: Date.now(),
      });
      embeddingCaches.set(repoName, embeddings);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[codesift] Embedding failed for ${repoName}: ${message}`);
      // Non-fatal — BM25 search still works
    }
  }

  // Embed file chunks if an embedding provider is configured (non-fatal if it fails)
  if (config.embeddingProvider) {
    const chunkPath = getChunkPath(indexPath);
    const chunkEmbeddingPath = getChunkEmbeddingPath(indexPath);
    try {
      const provider = createEmbeddingProvider(config.embeddingProvider, config);

      // Build chunks for all indexed files
      const allChunks: import("../types.js").CodeChunk[] = [];
      for (const entry of fileEntries) {
        const fullPath = join(rootPath, entry.path);
        try {
          const content = await readFile(fullPath, "utf-8");
          const fileChunks = chunkFile(entry.path, content, repoName);
          allChunks.push(...fileChunks);
        } catch {
          // Skip unreadable files
        }
      }

      if (allChunks.length > 0) {
        // Load existing chunk embeddings to avoid re-embedding unchanged chunks
        const existingChunkEmbeddings = await loadChunkEmbeddings(chunkEmbeddingPath) ?? new Map<string, Float32Array>();
        const chunkTexts = new Map(allChunks.map((c) => [c.id, c.text]));

        const chunkEmbeddings = await batchEmbed(
          chunkTexts,
          existingChunkEmbeddings,
          provider.embed.bind(provider),
          96,
        );

        await saveChunks(chunkPath, allChunks);
        await saveChunkEmbeddings(chunkEmbeddingPath, chunkEmbeddings);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[codesift] Chunk embedding failed for ${repoName}: ${message}`);
      // Non-fatal — symbol-level and BM25 search still work
    }
  }

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
 * Clone a remote git repository and index it.
 * Clones into ~/.codesift/repos/{name}. If already cloned, pulls latest.
 */
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
    execFileSync("git", args, { stdio: "pipe", timeout: 120_000 });
  } else {
    // Pull latest changes
    try {
      if (options?.branch) {
        execFileSync("git", ["-C", cloneTarget, "checkout", options.branch], {
          stdio: "pipe",
          timeout: 30_000,
        });
      }
      execFileSync("git", ["-C", cloneTarget, "pull", "--ff-only"], {
        stdio: "pipe",
        timeout: 60_000,
      });
    } catch {
      // Pull may fail if detached HEAD — force fresh clone
      await rm(cloneTarget, { recursive: true, force: true });
      const args = ["clone", "--depth", "1"];
      if (options?.branch) args.push("--branch", options.branch);
      args.push("--", url, cloneTarget);
      execFileSync("git", args, { stdio: "pipe", timeout: 120_000 });
    }
  }

  // Index the cloned repo (no watcher for remote repos)
  return indexFolder(cloneTarget, {
    include_paths: options?.include_paths,
    watch: false,
  });
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
    const ext = extname(relativeFile);
    const language = getLanguageForExtension(ext) ?? "unknown";

    let symbols: CodeSymbol[];

    // Markdown and Prisma use custom parsers (no tree-sitter grammar)
    if (language === "markdown") {
      symbols = extractMarkdownSymbols(source, relativeFile, repoName);
    } else if (language === "prisma") {
      symbols = extractPrismaSymbols(source, relativeFile, repoName);
    } else {
      const tree = await parseFile(fullPath, source);
      if (!tree) return;
      symbols = extractSymbols(tree, relativeFile, source, repoName, language);
    }

    const fileEntry: FileEntry = {
      path: relativeFile,
      language,
      symbol_count: symbols.length,
      last_modified: Date.now(),
    };
    await saveIncremental(indexPath, relativeFile, symbols, fileEntry);

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

  // Remove in-memory caches
  bm25Indexes.delete(repoName);
  embeddingCaches.delete(repoName);

  // Delete index file + embedding files + chunk files
  const embeddingPath = getEmbeddingPath(meta.index_path);
  const embeddingMetaPath = getEmbeddingMetaPath(meta.index_path);
  const chunkPath = getChunkPath(meta.index_path);
  const chunkEmbeddingPath = getChunkEmbeddingPath(meta.index_path);
  for (const fp of [meta.index_path, embeddingPath, embeddingMetaPath, chunkPath, chunkEmbeddingPath]) {
    try { await unlink(fp); } catch { /* File may not exist */ }
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

/**
 * Get the in-memory embedding cache for a repo.
 * Loads from disk if not cached. Returns null if no embeddings file exists.
 */
export async function getEmbeddingCache(
  repoName: string,
): Promise<Map<string, Float32Array> | null> {
  const cached = embeddingCaches.get(repoName);
  if (cached) return cached;

  const config = loadConfig();
  const meta = await getRepo(config.registryPath, repoName);
  if (!meta) return null;

  const embeddingPath = getEmbeddingPath(meta.index_path);
  const embeddings = await loadEmbeddings(embeddingPath);
  if (embeddings.size === 0) return null;

  embeddingCaches.set(repoName, embeddings);
  return embeddings;
}
