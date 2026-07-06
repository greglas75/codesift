import { readFile, stat, unlink, rm, mkdir as mkdirAsync } from "node:fs/promises";
import { join, relative, resolve, basename, dirname } from "node:path";
import { openSync, closeSync, statSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EXTRACTOR_VERSIONS } from "./index-shared.js";
import { extractMarkdownSymbols, extractPrismaSymbols, extractAstroSymbols, extractConversationSymbols } from "../parser/symbol-extractor.js";
import { runTreeSitterParse } from "../parser/parser-pool.js";
import { extractSqlSymbols, stripJinjaTokens } from "../parser/extractors/sql.js";
import { getLanguageForExtension, getLanguageForPath } from "../parser/parser-manager.js";
import { saveIndex, loadIndex, loadIndexOrStale, getIndexPath, saveIncremental, removeFileFromIndex } from "../storage/index-store.js";
import { clearTsconfigCache } from "../utils/tsconfig-paths.js";
import { registerRepo, listRepos as listRegistryRepos, getRepo, removeRepo, getRepoName, updateRepoMeta, resolveRegisteredRepoMeta } from "../storage/registry.js";
import { startWatcher, stopWatcher, type FSWatcher } from "../storage/watcher.js";
import { buildBM25Index, type BM25Index } from "../search/bm25.js";
import { buildSymbolText, createEmbeddingProvider } from "../search/semantic.js";
import { loadEmbeddings, saveEmbeddings, saveEmbeddingMeta, getEmbeddingPath, getEmbeddingMetaPath, batchEmbed } from "../storage/embedding-store.js";
import { saveChunks, saveChunkEmbeddings, loadChunkEmbeddings, getChunkPath, getChunkEmbeddingPath } from "../storage/chunk-store.js";
import { chunkFile, chunkBySymbols } from "../search/chunker.js";
import { loadConfig } from "../config.js";
import { validateGitUrl, validateGitRef } from "../utils/git-validation.js";
import { walkDirectory } from "../utils/walk.js";
import type { CodeSymbol, CodeIndex, FileEntry, RepoMeta, CodeChunk } from "../types.js";
import { onFileChanged as scanOnChanged, onFileDeleted as scanOnDeleted, scanFileForSecrets } from "./secret-scan-shared.js";
import { getGraphPath } from "../storage/graph-store.js";
import { getSnapshotPath, loadHashSnapshot, saveHashSnapshot, HASH_SNAPSHOT_VERSION, type FileHashSnapshot } from "../storage/hash-snapshot.js";

const PARSE_CONCURRENCY = 8;
const CHUNK_EMBEDDING_BATCH_SIZE = 96;
const GIT_CLONE_TIMEOUT_MS = 120_000;
const GIT_CHECKOUT_TIMEOUT_MS = 30_000;
const GIT_PULL_TIMEOUT_MS = 60_000;

/**
 * Default cap on files returned by walkDirectory during indexFolder. Without
 * this, repos with hundreds of thousands of code files (large CMS, monorepos,
 * vendored data sets) accumulate symbols in memory and OOM the Node process,
 * which manifests to MCP clients as a "Connection closed" error mid-index.
 *
 * 50_000 covers every project we've seen in practice; the largest indexed
 * monorepo (tgm-survey-platform) is around 5_000 files. Override via the
 * MCP `max_files` argument or CODESIFT_MAX_FILES env var when a legitimately
 * larger repo needs full coverage.
 */
const DEFAULT_MAX_FILES = 50_000;

function getDefaultMaxFiles(): number {
  const envVal = process.env.CODESIFT_MAX_FILES;
  if (envVal) {
    const parsed = Number.parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_FILES;
}

// Active watchers and in-memory indexes keyed by repo name
const activeWatchers = new Map<string, FSWatcher>();
const bm25Indexes = new Map<string, BM25Index>();
const codeIndexes = new Map<string, CodeIndex>();
const embeddingCaches = new Map<string, Map<string, Float32Array>>();

// Tracks last successful full indexFolder run keyed by absolute rootPath, used
// to short-circuit redundant scans while a watcher is keeping the index live.
// Populated at the end of every indexFolder call that completes normally.
const lastFullIndexAt = new Map<string, number>();

/**
 * Window during which a re-run of indexFolder against the same root is treated
 * as redundant when a watcher is active. Telemetry showed 35 calls > 30s and a
 * 786s outlier — these are agents defensively re-indexing repos the watcher is
 * already maintaining. 60s matches the "fresh enough" threshold used elsewhere.
 */
const INDEX_FOLDER_REDUNDANT_WINDOW_MS = 60_000;

/** Test-only — clear short-circuit state between cases. */
export function resetIndexFolderRedundancyForTesting(): void {
  lastFullIndexAt.clear();
}

/**
 * Parse a single file and extract its symbols + metadata.
 * Returns null if the file cannot be parsed.
 */
async function parseOneFile(
  filePath: string,
  repoRoot: string,
  repoName: string,
): Promise<{ symbols: CodeSymbol[]; entry: FileEntry; sha1: string } | null> {
  try {
    const stat = await import("node:fs/promises").then((fs) => fs.stat(filePath));
    const source = await readFile(filePath, "utf-8");
    // CRITICAL-1 (TOCTOU parse↔hash): hash the EXACT source string we parse,
    // here — never via a post-parse re-read. A re-read can observe a different
    // on-disk version if the file is modified between parse and hash, pairing
    // OLD symbols with a NEW sha so future runs permanently reuse mismatched
    // symbols. The sha is NOT persisted inside FileEntry; callers thread it
    // into the hash snapshot (and it saves one extra full read per parsed file).
    const fileSha1 = createHash("sha1").update(source).digest("hex");
    const relPath = relative(repoRoot, filePath);
    const baseName = filePath.split("/").pop() ?? "";
    // Use full-path resolver so multi-dot suffixes like `.gradle.kts` beat
    // single-extension lookups (which would otherwise map to plain Kotlin).
    const language = getLanguageForPath(filePath)
      ?? (baseName.startsWith(".env") ? "config" : "unknown");

    let symbols: CodeSymbol[];
    let effectiveLanguage = language;

    if (language === "markdown") {
      symbols = extractMarkdownSymbols(source, relPath, repoName);
    } else if (language === "prisma") {
      symbols = extractPrismaSymbols(source, relPath, repoName);
    } else if (language === "astro") {
      symbols = extractAstroSymbols(source, relPath, repoName);
    } else if (language === "conversation") {
      symbols = extractConversationSymbols(source, relPath, repoName);
    } else if (language === "sql") {
      // SQL: regex extractor, no tree-sitter. Detect Jinja/dbt templates.
      const hasJinja = /\{\{|\{%|\{#/.test(source);
      if (hasJinja) {
        const stripped = stripJinjaTokens(source);
        symbols = extractSqlSymbols(stripped, relPath, repoName, source);
        effectiveLanguage = "sql-jinja";
      } else {
        symbols = extractSqlSymbols(source, relPath, repoName);
      }
    } else if (language === "config" || language === "text_stub") {
      // text_stub: Swift/Dart/Scala/etc. — indexed as FileEntry but no symbol
      // extraction until a tree-sitter grammar + extractor is added.
      // search_text (ripgrep path) and scan_secrets still work on these files.
      symbols = [];
    } else {
      // Tree-sitter languages (TS/JS/Python/Go/Rust/Java/Ruby/PHP/CSS/Kotlin):
      // dispatch to the worker pool. Synchronously-hung WASM parses kill the
      // worker (terminated on timeout) instead of the MCP server itself.
      // See src/parser/parser-pool.ts for details.
      try {
        symbols = await runTreeSitterParse({ filePath, source, language, relPath, repoName });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[codesift] worker parse failed for ${relPath}: ${message}`);
        return null;
      }
    }

    const entry: FileEntry = {
      path: relPath,
      language: effectiveLanguage,
      symbol_count: symbols.length,
      last_modified: Date.now(),
      mtime_ms: Math.round(stat.mtimeMs),
    };

    return { symbols, entry, sha1: fileSha1 };
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
): Promise<{ symbols: CodeSymbol[]; fileEntries: FileEntry[]; shas: Record<string, string> }> {
  const allSymbols: CodeSymbol[] = [];
  const fileEntries: FileEntry[] = [];
  // CRITICAL-1: sha1 of the exact parsed source, keyed by relPath. Carried out
  // of parseOneFile so the snapshot never re-reads (and never races) the file.
  const shas: Record<string, string> = {};

  for (let i = 0; i < files.length; i += PARSE_CONCURRENCY) {
    const batch = files.slice(i, i + PARSE_CONCURRENCY);
    const results = await Promise.all(
      batch.map((filePath) => parseOneFile(filePath, repoRoot, repoName)),
    );

    for (const result of results) {
      if (result) {
        allSymbols.push(...result.symbols);
        fileEntries.push(result.entry);
        shas[result.entry.path] = result.sha1;
      }
    }
  }

  return { symbols: allSymbols, fileEntries, shas };
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
export async function embedSymbols(
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
    const embeddings = await batchEmbed(symbolTexts, existing, (texts) => provider.embed(texts, "document"), config.embeddingBatchSize, repoName);
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
  symbols?: CodeSymbol[],
): Promise<CodeChunk[]> {
  const allChunks: CodeChunk[] = [];
  for (let i = 0; i < fileEntries.length; i += PARSE_CONCURRENCY) {
    const batch = fileEntries.slice(i, i + PARSE_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (entry) => {
        const fullPath = join(rootPath, entry.path);
        try {
          const content = await readFile(fullPath, "utf-8");
          if (symbols) {
            const fileSymbols = symbols
              .filter((s) => s.file === entry.path)
              .map((s) => ({ name: s.name, start_line: s.start_line, end_line: s.end_line }));
            return chunkBySymbols(entry.path, content, repoName, fileSymbols);
          }
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
  symbols?: CodeSymbol[],
): Promise<void> {
  if (!config.embeddingProvider) return;

  const chunkPath = getChunkPath(indexPath);
  const chunkEmbeddingPath = getChunkEmbeddingPath(indexPath);
  try {
    const provider = createEmbeddingProvider(config.embeddingProvider, config);
    const existingChunkEmbeddings = await loadChunkEmbeddings(chunkEmbeddingPath) ?? new Map<string, Float32Array>();
    const allChunks = await readAndChunkFiles(fileEntries, rootPath, repoName, symbols);

    if (allChunks.length > 0) {
      const chunkTexts = new Map(allChunks.map((c) => [c.id, c.text]));
      const chunkEmbeddings = await batchEmbed(
        chunkTexts,
        existingChunkEmbeddings,
        (texts) => provider.embed(texts, "document"),
        CHUNK_EMBEDDING_BATCH_SIZE,
        `${repoName}:chunks`,
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
  /**
   * Set when the call did not persist a fresh index:
   * - "skipped" — short-circuited because a watcher is keeping the index live.
   * - "rejected_partial" — new walk found <50% of the previous file count and
   *   the previous index still matches what's on disk, so the new (likely
   *   truncated) result was discarded. file_count/symbol_count echo the KEPT
   *   old index. Follow `hint` to force a rebuild if the shrink is expected.
   */
  status?: "skipped" | "rejected_partial";
  reason?: string;
  last_indexed?: string;
  hint?: string;
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

async function isExistingIndexStale(
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
async function sha1OfFile(absPath: string): Promise<string | null> {
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

  // Persistent hash snapshot (Task 6): relPath → sha1 from the previous index.
  // mtime stays the cheap pre-filter (unchanged mtime → reuse without hashing,
  // the fastest path). When mtime *changed*, the snapshot sha1 lets us still
  // reuse symbols for touch/checkout no-op rewrites that bumped mtime without
  // changing content — something mtime-only logic could never catch.
  // null when absent/corrupt/version-or-repo-mismatch → degrade to full parse.
  const snapshotPath = getSnapshotPath(indexPath);
  let oldSnapshot = existing
    ? await loadHashSnapshot(snapshotPath, repoName)
    : null;

  // Staleness guard (Task 6, CRITICAL-2): an incremental saveIncremental /
  // removeFileFromIndex advances index.updated_at WITHOUT touching the
  // snapshot. If saveIndex landed but the subsequent snapshot save failed (or
  // an incremental edit ran after the last full index), the on-disk snapshot
  // is OLDER than the index and its SHAs may no longer match the indexed
  // symbols — carrying them forward (fast path) or sha-matching against them
  // (changed path) would produce wrong reuse on revert+touch sequences. When
  // the snapshot predates the index, discard it: the legacy hash-now
  // convergence path below repopulates a fresh, correct snapshot this run.
  // Guard uses strict inequality (!==), not <. The fresh-write contract is
  // snapshot.created_at === index.updated_at exactly (created_at is anchored to
  // codeIndex.updated_at, not a fresh Date.now()). So ANY mismatch — older OR
  // newer — means the snapshot is not the one paired with this index and must
  // be discarded. A FUTURE created_at (e.g. a snapshot written against a later,
  // since-rolled-back index, or clock skew) is just as untrustworthy as a stale
  // one: its SHAs may not match the indexed symbols.
  if (oldSnapshot && existing && oldSnapshot.created_at !== existing.updated_at) {
    console.warn(
      `[codesift] hash-snapshot older than index — rebuilding (${repoName})`,
    );
    oldSnapshot = null;
  }

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

  // Sanity check: don't overwrite a complete index with a partial one
  // (WASM crash or walk failure can produce truncated results).
  //
  // IMPORTANT: skip the guard when the walk was explicitly narrowed — either
  // max_files was hit (truncated at cap) or include_paths scoped the walk to a
  // subdirectory. In both cases the small result count is EXPECTED and rejecting
  // it would be a false positive (the "1139 vs 9512" bug class). For unrestricted
  // walks the guard stays as-is, protecting against genuine silent truncations.
  //
  // CRITICAL (T7 correctness fix): skipping the guard is necessary but NOT
  // sufficient. A scoped/capped walk only SEES a narrow slice of the repo; if we
  // persisted that slice as the WHOLE index we would wipe every out-of-scope
  // file's symbols from index+snapshot (worse than the guard's old reject,
  // which at least preserved the prior index). So for scoped/capped walks with
  // an existing index we MERGE: keep out-of-scope existing entries verbatim and
  // overlay the walk's results. See the merge block below.
  //
  // "max_files hit" detection: files.length === effective maxFiles. This is the
  // only signal walkDirectory exposes (it sets limitReached internally but does
  // not surface it on the return value). A 1-in-a-million exact-count false
  // positive (repo has exactly maxFiles parseable files) is accepted — the
  // guard skip is conservative (allows write), not destructive.
  const DROP_THRESHOLD = 0.5; // Reject if new index has <50% of old file count
  const walkExplicitlyCapped = hitFileLimit;
  const walkExplicitlyScoped =
    options?.include_paths !== undefined && options.include_paths.length > 0;
  // MIN_GUARD_FILES: the unrestricted guard only arms above this existing
  // file_count (`existing.file_count > 50` below). The scoped-granularity guard
  // mirrors that shape against the in-scope subset so a tiny scope can't be
  // rejected on noise. Single source of truth so both guards stay in lockstep.
  const MIN_GUARD_FILES = 50;
  if (walkExplicitlyCapped || walkExplicitlyScoped) {
    // ROUND-2 FIX (scoped-granularity guard): the unrestricted guard is skipped
    // for scoped/capped walks because a small *overall* result is expected. But
    // that skip was total — a scoped walk that aborts mid-enumeration (WASM
    // crash, transient FS error, an over-broad exclude) silently truncates the
    // IN-SCOPE slice, and the merge below treats every unwalked in-scope file as
    // a deletion → wipes it from index+snapshot. So for a purely SCOPED (uncapped)
    // walk we re-arm a guard against the IN-SCOPE subset: if the walk enumerated
    // far fewer in-scope files than the existing index held in that same scope,
    // AND those files are still on disk, the enumeration was truncated → reject
    // before any merge/save, leaving the old index+snapshot intact.
    //
    // Capped walks are intentionally EXEMPT: a cap means unseen ≠ deleted (the
    // merge preserves all unwalked files), so there is no truncation to detect —
    // nothing in-scope is dropped. A walk that is BOTH scoped and capped also
    // takes capped semantics (preserve everything unwalked), so the same
    // exemption applies — no in-scope file can be lost.
    if (walkExplicitlyScoped && !walkExplicitlyCapped && existing) {
      const includePaths = options!.include_paths!;
      const inScopeRel = (relPath: string): boolean =>
        includePaths.some((p) => relPath.startsWith(p)); // mirror walkDirectory
      const existingInScope = existing.files.filter((fe) => inScopeRel(fe.path));
      // All walked files are in scope by construction (walkDirectory honored
      // includePaths), so walkedInScope is simply the walk's file count.
      const walkedInScope = fileEntries.length;
      if (
        existingInScope.length > MIN_GUARD_FILES &&
        walkedInScope < existingInScope.length * DROP_THRESHOLD
      ) {
        // Auto-heal analog (in-scope): the shrink may be a genuine mass deletion
        // within the scope, not a truncated walk. Sample the existing in-scope
        // paths on disk (mirrors isExistingIndexStale, but restricted to the
        // scope) — if most are gone, accept the merge.
        const inScopePaths = existingInScope.map((fe) => fe.path);
        const stride = Math.max(1, Math.floor(inScopePaths.length / STALE_SAMPLE_LIMIT));
        const sampled: string[] = [];
        for (let i = 0; i < inScopePaths.length && sampled.length < STALE_SAMPLE_LIMIT; i += stride) {
          const p = inScopePaths[i];
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
        const mostGone = missing >= sampled.length * STALE_MISSING_FRACTION;
        if (mostGone) {
          console.error(
            `[codesift] Scoped sanity auto-heal for ${repoName}: walked ` +
            `${walkedInScope} of ${existingInScope.length} in-scope files but ` +
            `most sampled in-scope paths no longer exist on disk. Accepting ` +
            `scoped merge (legit in-scope mass deletion).`,
          );
        } else {
          console.error(
            `[codesift] SCOPED SANITY CHECK FAILED for ${repoName}: scoped walk ` +
            `under-enumerated — walked ${walkedInScope} of ${existingInScope.length} ` +
            `in-scope files, which still exist on disk. Keeping old index.`,
          );
          return {
            repo: repoName,
            root: rootPath,
            file_count: existing.file_count,
            symbol_count: existing.symbol_count,
            duration_ms: Date.now() - startTime,
            status: "rejected_partial",
            reason: `scoped walk under-enumerated: walked ${walkedInScope} of ${existingInScope.length} in-scope files (still on disk) — kept old index, nothing was re-registered`,
            hint: "If the in-scope shrink is expected (deleted files, new excludes), run invalidate_cache then index_folder to rebuild from scratch.",
          };
        }
      }
    }
    const detail = walkExplicitlyCapped
      ? `max_files=${maxFiles} hit (${files.length} files returned)`
      : `include_paths=[${options!.include_paths!.join(", ")}]`;
    console.error(`[codesift] sanity guard skipped: walk explicitly capped/scoped (${detail})`);
  } else if (existing && fileEntries.length < existing.file_count * DROP_THRESHOLD && existing.file_count > MIN_GUARD_FILES) {
    // The shrink can also mean the OLD index is the bogus one: an earlier
    // walker may have swept since-deleted trees (.worktrees/, vendored dirs),
    // permanently inflating the baseline so every honest reindex looks
    // truncated and gets rejected forever. Disambiguate by sampling the old
    // index's paths: if most of them no longer exist on disk, the old index
    // is stale dead weight — accept the new result instead of keeping it.
    if (await isExistingIndexStale(existing, rootPath)) {
      console.error(
        `[codesift] Sanity check auto-heal for ${repoName}: old index has ` +
        `${existing.file_count} files but most sampled paths no longer exist ` +
        `on disk. Accepting new index (${fileEntries.length} files).`,
      );
    } else {
      console.error(
        `[codesift] SANITY CHECK FAILED for ${repoName}: ` +
        `new index has ${fileEntries.length} files vs ${existing.file_count} previously. ` +
        `Keeping old index. Use invalidate_cache + index_folder to force reindex.`,
      );
      return {
        repo: repoName,
        root: rootPath,
        file_count: existing.file_count,
        symbol_count: existing.symbol_count,
        duration_ms: Date.now() - startTime,
        status: "rejected_partial",
        reason: `new walk found ${fileEntries.length} files, <50% of the ${existing.file_count} previously indexed — kept old index, nothing was re-registered`,
        hint: "If the shrink is expected (deleted trees, new excludes), run invalidate_cache then index_folder to rebuild from scratch.",
      };
    }
  }

  // ── MERGE-persist for scoped/capped walks (T7 correctness fix) ────────────
  // A scoped (include_paths) or capped (max_files-hit) walk only enumerated a
  // slice of the repo. Persisting that slice verbatim would delete every
  // out-of-scope file's symbols from index+snapshot. When an existing index is
  // present we instead MERGE: preserve out-of-scope existing entries/symbols/
  // shas and overlay the walk's results.
  //
  //  - include_paths scoped (and NOT capped): "scope" = files whose relPath is
  //    under any include root (mirror walkDirectory's relPath.startsWith(p)
  //    test EXACTLY). Out-of-scope existing files are preserved verbatim;
  //    in-scope existing files NOT in the walk set W are dropped (genuine
  //    in-scope deletions — the walk fully enumerated the scope).
  //  - capped (max_files hit): scope is UNDEFINED — the cap means an unseen
  //    file is not necessarily deleted. Preserve ALL existing entries not in W,
  //    overlay W. (If a capped walk also passed include_paths, the cap makes the
  //    in-scope enumeration incomplete too, so we still only trust W and
  //    preserve everything else — capped semantics win.)
  //
  // First run (no existing index) with a scoped/capped walk → save what we have
  // (current behavior, documented): there is nothing to preserve.
  let mergedSymbols = symbols;
  let mergedEntries = fileEntries;
  let mergedSnapshotFiles = newSnapshotFiles;
  if ((walkExplicitlyCapped || walkExplicitlyScoped) && existing) {
    const walkedPaths = new Set(fileEntries.map((fe) => fe.path));
    // A capped walk has undefined scope (unseen ≠ deleted), so it preserves
    // everything not walked. A purely scoped (uncapped) walk additionally drops
    // in-scope-but-unwalked files, since the walk fully enumerated the scope.
    const includePaths = options?.include_paths;
    const inScope = (relPath: string): boolean => {
      if (walkExplicitlyCapped) return false; // cap → never treat as deletable
      if (!includePaths || includePaths.length === 0) return false;
      // Mirror walkDirectory's include-path filter exactly.
      return includePaths.some((p) => relPath.startsWith(p));
    };

    const preservedEntries: FileEntry[] = [];
    const preservedFilePaths = new Set<string>();
    for (const fe of existing.files) {
      if (walkedPaths.has(fe.path)) continue; // walk result wins for these
      if (inScope(fe.path)) continue; // in-scope + not walked = deleted-in-scope
      preservedEntries.push(fe);
      preservedFilePaths.add(fe.path);
    }
    const preservedSymbols = existing.symbols.filter((s) =>
      preservedFilePaths.has(s.file),
    );

    mergedEntries = [...preservedEntries, ...fileEntries];
    mergedSymbols = [...preservedSymbols, ...symbols];

    // Snapshot: preserve out-of-scope shas, overlay walked ones.
    mergedSnapshotFiles = {};
    if (oldSnapshot) {
      for (const relPath of preservedFilePaths) {
        const sha = oldSnapshot.files[relPath];
        if (sha !== undefined) mergedSnapshotFiles[relPath] = sha;
      }
    }
    Object.assign(mergedSnapshotFiles, newSnapshotFiles);
  }

  // Build and cache BM25 index from the FINAL (possibly merged) symbol set.
  // Built here (not before the guard) so a rejected_partial early-return leaves
  // the previous in-memory BM25 index intact rather than swapping in a partial.
  const bm25 = buildBM25Index(mergedSymbols);
  bm25Indexes.set(repoName, bm25);

  // Resolve workspaces (Task 7) — runs before persistence so collectImportEdges
  // and other downstream consumers see the populated `workspaces` field.
  // Gated behind CODESIFT_DISABLE_MONOREPO=1 kill switch (spec D-FB).
  let workspaces: import("../types.js").Workspace[] | undefined;
  if (process.env.CODESIFT_DISABLE_MONOREPO !== "1") {
    try {
      const { resolveWorkspaces } = await import("../storage/workspace-resolver.js");
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
    await saveHashSnapshot(snapshotPath, newSnapshot);
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
    const { detectFrameworks } = await import("../utils/framework-detect.js");
    const { enableFrameworkToolBundle } = await import("../register-tools.js");
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
async function setupWatcher(
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
    const { invalidateNegativeEvidence } = await import("../storage/session-state.js");
    invalidateNegativeEvidence(repoName, relativeFile);
  } catch {
    // Best-effort — session-state may not be loaded
  }

  // Invalidate Hono model cache for this file (canonicalized absolute path)
  try {
    const { honoCache } = await import("../cache/hono-cache.js");
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
    const { honoCache } = await import("../cache/hono-cache.js");
    honoCache.invalidate(join(repoRoot, relativeFile));
  } catch {
    // Best-effort
  }
}

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

/**
 * In-process record of the last indexed state per absolute file path.
 *
 * Telemetry (30d, 2026-06): 750 consecutive duplicate index_file calls at
 * avg 3.7s each (~47 min of agent wall-clock). Two causes: (1) duplicate
 * hook registrations firing index_file twice per edit, and (2) a race where
 * call N+1's on-disk mtime pre-check read the index before call N's
 * serialized saveIncremental landed, forcing a full re-parse + full-index
 * save. This map short-circuits both in-process in ~1ms (mtime first, then
 * content hash for touch/no-op rewrites) without loading the on-disk index.
 */
const lastIndexedState = new Map<string, { mtimeMs: number; contentHash: string; symbolCount: number }>();

/** Test hook — clear the in-process last-indexed state. */
export function clearLastIndexedStateForTesting(): void {
  lastIndexedState.clear();
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
  secrets_warning?: string;
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

  // If the changed file is a TS/JS config that drives path resolution, drop
  // caches so incremental indexing picks up new `paths` / `extends`.
  {
    const cfg = basename(absPath).toLowerCase();
    if (
      (cfg.startsWith("tsconfig") || cfg.startsWith("jsconfig")) &&
      cfg.endsWith(".json")
    ) {
      clearTsconfigCache();
    }
  }

  // In-process short-circuit: mtime, then content hash. Both avoid loading
  // the on-disk index entirely (the expensive part on large repos).
  const st = await stat(absPath);
  const mem = lastIndexedState.get(absPath);
  if (mem && Math.round(st.mtimeMs) === mem.mtimeMs) {
    return {
      repo: matchingRepo.name,
      file: relPath,
      symbol_count: mem.symbolCount,
      duration_ms: Date.now() - startTime,
      skipped: true,
    };
  }
  const content = await readFile(absPath, "utf-8").catch(() => null);
  const contentHash = content !== null ? createHash("sha1").update(content).digest("hex") : null;
  if (mem && contentHash !== null && contentHash === mem.contentHash) {
    // Touched / rewritten with identical content — refresh mtime, skip work.
    mem.mtimeMs = Math.round(st.mtimeMs);
    return {
      repo: matchingRepo.name,
      file: relPath,
      symbol_count: mem.symbolCount,
      duration_ms: Date.now() - startTime,
      skipped: true,
    };
  }

  // On-disk mtime check — first touch of this file in this process (CLI
  // hook invocations, fresh server). Skips files unchanged since the last
  // full index, and seeds the in-process state for subsequent calls.
  if (!mem) {
    const existing = await loadIndex(matchingRepo.index_path);
    if (existing) {
      const prevEntry = existing.files.find((f) => f.path === relPath);
      if (prevEntry?.mtime_ms && Math.round(st.mtimeMs) === prevEntry.mtime_ms) {
        if (contentHash !== null) {
          lastIndexedState.set(absPath, {
            mtimeMs: Math.round(st.mtimeMs),
            contentHash,
            symbolCount: prevEntry.symbol_count,
          });
        }
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

  if (contentHash !== null) {
    lastIndexedState.set(absPath, {
      mtimeMs: Math.round(st.mtimeMs),
      contentHash,
      symbolCount: result.symbols.length,
    });
  }

  let secretFindingsCount = 0;
  if (config.secretScanEnabled) {
    try {
      secretFindingsCount = (
        await scanFileForSecrets(absPath, relPath, matchingRepo.name, result.symbols)
      ).length;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[codesift] Secret scan failed for ${relPath}: ${message}`);
    }
  }

  // Invalidate caches — lazy rebuild on next query via getBM25Index()
  bm25Indexes.delete(matchingRepo.name);
  codeIndexes.delete(matchingRepo.name);
  embeddingCaches.delete(matchingRepo.name);

  let secretsWarning: string | undefined;
  if (secretFindingsCount > 0) {
    secretsWarning = `\u26A0 ${secretFindingsCount} potential secret(s) detected`;
  }

  return {
    repo: matchingRepo.name,
    file: relPath,
    symbol_count: result.symbols.length,
    duration_ms: Date.now() - startTime,
    ...(secretsWarning ? { secrets_warning: secretsWarning } : {}),
  };
}

// ---------------------------------------------------------------------------
// Git-based auto-refresh — transparent freshness check before index access
// ---------------------------------------------------------------------------

const freshnessChecked = new Map<string, number>();
const FRESHNESS_INTERVAL_MS = 60_000;
const MAX_DIFF_FILES = 50;

/**
 * Ensure the index for a repo is fresh relative to git HEAD.
 * Throttled to once per minute per repo. Reindexes changed files if HEAD moved.
 * No-op for non-git repos.
 */
export async function ensureIndexFresh(repoName: string): Promise<{
  status: "fresh" | "refreshed" | "skipped";
  files_updated?: number;
}> {
  const lastCheck = freshnessChecked.get(repoName);
  if (lastCheck && Date.now() - lastCheck < FRESHNESS_INTERVAL_MS) {
    return { status: "fresh" };
  }

  const config = loadConfig();
  const meta = await getRepo(config.registryPath, repoName);
  if (!meta) return { status: "skipped" };

  let currentCommit: string;
  try {
    currentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: meta.root, encoding: "utf-8", timeout: 5000,
    }).trim();
  } catch {
    freshnessChecked.set(repoName, Date.now());
    return { status: "skipped" };
  }

  if (meta.last_git_commit === currentCommit) {
    freshnessChecked.set(repoName, Date.now());
    return { status: "fresh" };
  }

  // HEAD moved — find changed files
  let changedFiles: string[] = [];
  if (meta.last_git_commit) {
    try {
      const diff = execFileSync("git", [
        "diff", "--name-only", "--diff-filter=ACMR",
        `${meta.last_git_commit}..${currentCommit}`,
      ], {
        cwd: meta.root, encoding: "utf-8", timeout: 10_000,
      });
      changedFiles = diff.trim().split("\n").filter(Boolean);
    } catch {
      // Stored commit gone (rebase/squash) — will do full incremental
      changedFiles = [];
    }
  }

  if (changedFiles.length > 0 && changedFiles.length <= MAX_DIFF_FILES) {
    for (const file of changedFiles) {
      try {
        await indexFile(join(meta.root, file));
      } catch {
        // File deleted or unparseable — skip
      }
    }
  } else if (changedFiles.length > MAX_DIFF_FILES || !meta.last_git_commit) {
    await indexFolder(meta.root, { incremental: true, watch: false });
  }

  await updateRepoMeta(config.registryPath, repoName, {
    last_git_commit: currentCommit,
    updated_at: Date.now(),
  });

  bm25Indexes.delete(repoName);
  codeIndexes.delete(repoName);
  embeddingCaches.delete(repoName);

  freshnessChecked.set(repoName, Date.now());
  return { status: "refreshed", files_updated: changedFiles.length };
}

/** Reset freshness throttle cache. Exported for testing. */
export function resetFreshnessCache(): void {
  freshnessChecked.clear();
}

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
  freshnessChecked.clear();
}

// ---------------------------------------------------------------------------
// Index access — with auto-refresh
// ---------------------------------------------------------------------------

/**
 * Get the in-memory BM25 index for a repo.
 * Loads from disk if not cached. Auto-refreshes if git HEAD moved.
 */
export async function getBM25Index(repoName: string): Promise<BM25Index | null> {
  await ensureIndexFresh(repoName);

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

// ---------------------------------------------------------------------------
// Astro extractor version check + lockfile re-index
// ---------------------------------------------------------------------------

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
