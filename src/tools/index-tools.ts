import { readFile, stat, unlink, rm, mkdir as mkdirAsync } from "node:fs/promises";
import { join, relative, extname, resolve, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseFile } from "../parser/parser-manager.js";
import { extractSymbols, extractMarkdownSymbols, extractPrismaSymbols, extractAstroSymbols } from "../parser/symbol-extractor.js";
import { getLanguageForExtension } from "../parser/parser-manager.js";
import { saveIndex, loadIndex, getIndexPath, saveIncremental, removeFileFromIndex } from "../storage/index-store.js";
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
import type { CodeSymbol, CodeIndex, FileEntry, RepoMeta, CodeChunk } from "../types.js";

const PARSE_CONCURRENCY = 8;
const CHUNK_EMBEDDING_BATCH_SIZE = 96;
const GIT_CLONE_TIMEOUT_MS = 120_000;
const GIT_CHECKOUT_TIMEOUT_MS = 30_000;
const GIT_PULL_TIMEOUT_MS = 60_000;

// Active watchers and in-memory indexes keyed by repo name
const activeWatchers = new Map<string, FSWatcher>();
const bm25Indexes = new Map<string, BM25Index>();
const embeddingCaches = new Map<string, Map<string, Float32Array>>();

/**
 * Parse a single file and extract its symbols + metadata.
 * Returns null if the file cannot be parsed.
 */
async function parseOneFile(
  filePath: string,
  repoRoot: string,
  repoName: string,
): Promise<{ symbols: CodeSymbol[]; entry: FileEntry } | null> {
  try {
    const stat = await import("node:fs/promises").then((fs) => fs.stat(filePath));
    const source = await readFile(filePath, "utf-8");
    const relPath = relative(repoRoot, filePath);
    const ext = extname(filePath);
    const language = getLanguageForExtension(ext) ?? "unknown";

    let symbols: CodeSymbol[];

    if (language === "markdown") {
      symbols = extractMarkdownSymbols(source, relPath, repoName);
    } else if (language === "prisma") {
      symbols = extractPrismaSymbols(source, relPath, repoName);
    } else if (language === "astro") {
      symbols = extractAstroSymbols(source, relPath, repoName);
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
      mtime_ms: Math.round(stat.mtimeMs),
    };

    return { symbols, entry };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[codesift] Failed to parse ${relative(repoRoot, filePath)}: ${message}`);
    return null;
  }
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

  for (let i = 0; i < files.length; i += PARSE_CONCURRENCY) {
    const batch = files.slice(i, i + PARSE_CONCURRENCY);
    const results = await Promise.all(
      batch.map((filePath) => parseOneFile(filePath, repoRoot, repoName)),
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
// Dirty propagation — mark caller files stale when a callee signature changes
// ---------------------------------------------------------------------------

/**
 * Compute a hash of a symbol's public interface (name + kind + signature).
 * Body changes don't trigger propagation — only signature changes.
 */
function computeSignatureHash(sym: CodeSymbol): string {
  const key = `${sym.name}|${sym.kind}|${sym.signature ?? ""}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * Detect signature changes and mark caller files as stale.
 * Returns the set of files marked stale.
 */
function propagateDirtySignatures(
  oldSymbols: CodeSymbol[],
  newSymbols: CodeSymbol[],
  fileEntries: FileEntry[],
): Set<string> {
  // Build old signature hashes
  const oldHashes = new Map<string, string>();
  for (const sym of oldSymbols) {
    oldHashes.set(sym.id, computeSignatureHash(sym));
  }

  // Find symbols with changed signatures
  const changedSymbolFiles = new Set<string>();
  for (const sym of newSymbols) {
    const oldHash = oldHashes.get(sym.id);
    if (oldHash && oldHash !== computeSignatureHash(sym)) {
      changedSymbolFiles.add(sym.file);
    }
  }

  if (changedSymbolFiles.size === 0) return new Set();

  // Find files that import from changed files (1 level of callers)
  // Use a simple heuristic: check if any symbol source mentions a changed file's name
  const changedBasenames = new Set<string>();
  for (const f of changedSymbolFiles) {
    const base = f.split("/").pop()?.replace(/\.\w+$/, "");
    if (base) changedBasenames.add(base);
  }

  const staleFiles = new Set<string>();
  for (const sym of newSymbols) {
    if (changedSymbolFiles.has(sym.file)) continue; // Don't mark the changed file itself
    if (!sym.source) continue;
    for (const base of changedBasenames) {
      if (sym.source.includes(base)) {
        staleFiles.add(sym.file);
        break;
      }
    }
  }

  // Mark stale in file entries (clear mtime so next index re-parses them)
  for (const entry of fileEntries) {
    if (staleFiles.has(entry.path)) {
      entry.stale = true;
      delete entry.mtime_ms; // Force re-parse on next indexFolder
    }
  }

  return staleFiles;
}

/**
 * Embed symbols using the configured embedding provider.
 * Non-fatal — BM25 search still works if embedding fails.
 */
async function embedSymbols(
  symbols: CodeSymbol[],
  indexPath: string,
  repoName: string,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  if (!config.embeddingProvider) return;

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
  }
}

/**
 * Read files in parallel batches and split each into chunks.
 */
async function readAndChunkFiles(
  fileEntries: FileEntry[],
  rootPath: string,
  repoName: string,
): Promise<CodeChunk[]> {
  const allChunks: CodeChunk[] = [];
  for (let i = 0; i < fileEntries.length; i += PARSE_CONCURRENCY) {
    const batch = fileEntries.slice(i, i + PARSE_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (entry) => {
        const fullPath = join(rootPath, entry.path);
        try {
          const content = await readFile(fullPath, "utf-8");
          return chunkFile(entry.path, content, repoName);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[codesift] Failed to read ${entry.path} for chunking: ${message}`);
          return [];
        }
      }),
    );
    for (const chunks of batchResults) {
      allChunks.push(...chunks);
    }
  }
  return allChunks;
}

/**
 * Embed file chunks using the configured embedding provider.
 * Non-fatal — symbol-level and BM25 search still work if this fails.
 */
async function embedChunks(
  fileEntries: FileEntry[],
  rootPath: string,
  repoName: string,
  indexPath: string,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  if (!config.embeddingProvider) return;

  const chunkPath = getChunkPath(indexPath);
  const chunkEmbeddingPath = getChunkEmbeddingPath(indexPath);
  try {
    const provider = createEmbeddingProvider(config.embeddingProvider, config);
    const existingChunkEmbeddings = await loadChunkEmbeddings(chunkEmbeddingPath) ?? new Map<string, Float32Array>();
    const allChunks = await readAndChunkFiles(fileEntries, rootPath, repoName);

    if (allChunks.length > 0) {
      const chunkTexts = new Map(allChunks.map((c) => [c.id, c.text]));
      const chunkEmbeddings = await batchEmbed(
        chunkTexts,
        existingChunkEmbeddings,
        provider.embed.bind(provider),
        CHUNK_EMBEDDING_BATCH_SIZE,
      );
      await saveChunks(chunkPath, allChunks);
      await saveChunkEmbeddings(chunkEmbeddingPath, chunkEmbeddings);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[codesift] Chunk embedding failed for ${repoName}: ${message}`);
  }
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
  if (!folderPath || typeof folderPath !== "string") {
    throw new Error("folderPath is required and must be a non-empty string");
  }

  const config = loadConfig();
  const startTime = Date.now();

  const rootPath = resolve(folderPath);
  const repoName = getRepoName(rootPath);
  const indexPath = getIndexPath(config.dataDir, rootPath);

  // Walk directory and collect parseable files
  const files = await walkDirectory(rootPath, {
    includePaths: options?.include_paths,
    fileFilter: (ext) => !!getLanguageForExtension(ext),
  });

  // mtime-based incremental: skip files unchanged since last index
  const existing = await loadIndex(indexPath);
  const mtimeMap = new Map<string, number>();
  if (existing) {
    for (const f of existing.files) {
      if (f.mtime_ms) mtimeMap.set(f.path, f.mtime_ms);
    }
  }

  const filesToParse: string[] = [];
  const keptSymbols: CodeSymbol[] = [];
  const keptEntries: FileEntry[] = [];

  if (mtimeMap.size > 0) {
    const { stat } = await import("node:fs/promises");
    for (const filePath of files) {
      const relPath = relative(rootPath, filePath);
      const prevMtime = mtimeMap.get(relPath);
      if (prevMtime !== undefined) {
        const fileEntry = existing!.files.find((f) => f.path === relPath);
        // Force re-parse if file is marked stale (callee signature changed)
        if (fileEntry?.stale) {
          filesToParse.push(filePath);
          continue;
        }
        try {
          const st = await stat(filePath);
          if (Math.round(st.mtimeMs) === prevMtime) {
            // File unchanged — keep existing symbols
            const fileSymbols = existing!.symbols.filter((s) => s.file === relPath);
            if (fileEntry) {
              keptSymbols.push(...fileSymbols);
              keptEntries.push(fileEntry);
              continue;
            }
          }
        } catch { /* file may have been deleted — reparse */ }
      }
      filesToParse.push(filePath);
    }
  } else {
    filesToParse.push(...files);
  }

  // Parse only changed/new files
  const { symbols: parsedSymbols, fileEntries: parsedEntries } = await parseFiles(filesToParse, rootPath, repoName);
  const symbols = [...keptSymbols, ...parsedSymbols];
  const fileEntries = [...keptEntries, ...parsedEntries];

  // Dirty propagation: detect signature changes and mark caller files stale
  if (existing && filesToParse.length > 0 && filesToParse.length < files.length) {
    const staleFiles = propagateDirtySignatures(existing.symbols, symbols, fileEntries);
    if (staleFiles.size > 0) {
      console.error(`[codesift] Dirty propagation: ${staleFiles.size} caller files marked stale`);
    }
  }

  // Build and cache BM25 index
  const bm25 = buildBM25Index(symbols);
  bm25Indexes.set(repoName, bm25);

  // Build and save code index
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
  await saveIndex(indexPath, codeIndex);

  // Embed symbols and chunks (non-fatal if either fails)
  await embedSymbols(symbols, indexPath, repoName, config);
  await embedChunks(fileEntries, rootPath, repoName, indexPath, config);

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
  if (options?.watch !== false) {
    await setupWatcher(rootPath, repoName, indexPath);
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
 * Replace or create a file watcher for incremental index updates.
 */
async function setupWatcher(
  rootPath: string,
  repoName: string,
  indexPath: string,
): Promise<void> {
  const existingWatcher = activeWatchers.get(repoName);
  if (existingWatcher) {
    await stopWatcher(existingWatcher);
  }

  const watcher = startWatcher(
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
      handleFileDelete(repoName, indexPath, deletedFile).catch(
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[codesift] Watcher delete error for ${deletedFile}: ${message}`);
        },
      );
    },
  );
  activeWatchers.set(repoName, watcher);
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
  const result = await parseOneFile(fullPath, repoRoot, repoName);
  if (!result) return;

  await saveIncremental(indexPath, relativeFile, result.symbols, result.entry);

  // Rebuild in-memory BM25 index
  const index = await loadIndex(indexPath);
  if (index) {
    bm25Indexes.set(repoName, buildBM25Index(index.symbols));
  }

  // Invalidate embedding cache so semantic search picks up changes on next query
  embeddingCaches.delete(repoName);
}

/**
 * Handle a file deletion event from the watcher.
 * Removes all symbols for the deleted file from the index.
 */
async function handleFileDelete(
  repoName: string,
  indexPath: string,
  relativeFile: string,
): Promise<void> {
  await removeFileFromIndex(indexPath, relativeFile);

  // Rebuild in-memory BM25 index
  const index = await loadIndex(indexPath);
  if (index) {
    bm25Indexes.set(repoName, buildBM25Index(index.symbols));
  }

  // Invalidate embedding cache
  embeddingCaches.delete(repoName);
}

export interface RepoSummary {
  name: string;
  file_count: number;
  symbol_count: number;
}

export async function listAllRepos(options?: { compact?: boolean }): Promise<RepoMeta[] | RepoSummary[] | string[]> {
  const config = loadConfig();
  const repos = await listRegistryRepos(config.registryPath);
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
 * Re-index a single file instantly. Finds the repo by matching the file
 * path against indexed repo roots. Updates symbols, BM25 index, and
 * invalidates embedding cache — no full repo walk needed.
 */
export async function indexFile(filePath: string): Promise<{
  repo: string;
  file: string;
  symbol_count: number;
  duration_ms: number;
  skipped?: boolean;
}> {
  const absPath = resolve(filePath);
  const config = loadConfig();
  const repos = await listRegistryRepos(config.registryPath);

  // Find the most specific repo root that contains this file
  const matchingRepo = repos
    .filter((r) => absPath.startsWith(r.root + "/") || absPath === r.root)
    .sort((a, b) => b.root.length - a.root.length)[0];

  if (!matchingRepo) {
    throw new Error(`No indexed repo contains "${absPath}". Run index_folder first.`);
  }

  const startTime = Date.now();
  const relPath = relative(matchingRepo.root, absPath);

  // mtime check — skip if unchanged
  const existing = await loadIndex(matchingRepo.index_path);
  if (existing) {
    const prevEntry = existing.files.find((f) => f.path === relPath);
    if (prevEntry?.mtime_ms) {
      const st = await stat(absPath);
      if (Math.round(st.mtimeMs) === prevEntry.mtime_ms) {
        return {
          repo: matchingRepo.name,
          file: relPath,
          symbol_count: prevEntry.symbol_count,
          duration_ms: Date.now() - startTime,
          skipped: true,
        };
      }
    }
  }

  const result = await parseOneFile(absPath, matchingRepo.root, matchingRepo.name);
  if (!result) {
    throw new Error(`Failed to parse "${relPath}"`);
  }

  await saveIncremental(matchingRepo.index_path, relPath, result.symbols, result.entry);

  // Rebuild in-memory BM25 index
  const index = await loadIndex(matchingRepo.index_path);
  if (index) {
    bm25Indexes.set(matchingRepo.name, buildBM25Index(index.symbols));
  }
  embeddingCaches.delete(matchingRepo.name);

  return {
    repo: matchingRepo.name,
    file: relPath,
    symbol_count: result.symbols.length,
    duration_ms: Date.now() - startTime,
  };
}

/**
 * Get the in-memory BM25 index for a repo.
 * Loads from disk if not cached. Starts watcher if not running.
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
 * Starts watcher if not running (lazy start after server restart).
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
