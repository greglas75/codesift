import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import {
  extractMarkdownSymbols,
  extractPrismaSymbols,
  extractAstroSymbols,
  extractConversationSymbols,
} from "../../parser/symbol-extractor.js";
import { runTreeSitterParse } from "../../parser/parser-pool.js";
import { extractSqlSymbols, stripJinjaTokens } from "../../parser/extractors/sql.js";
import { getLanguageForPath } from "../../parser/parser-manager.js";
import { embeddingMemBudgetBytes } from "../../config.js";
import { buildSymbolText, createEmbeddingProvider } from "../../search/semantic.js";
import {
  loadEmbeddings,
  saveEmbeddings,
  saveEmbeddingMeta,
  getEmbeddingPath,
  getEmbeddingMetaPath,
  batchEmbed,
} from "../../storage/embedding-store.js";
import {
  saveChunks,
  saveChunkEmbeddings,
  loadChunkEmbeddings,
  getChunkPath,
  getChunkEmbeddingPath,
} from "../../storage/chunk-store.js";
import { chunkFile, chunkBySymbols } from "../../search/chunker.js";
import { loadConfig } from "../../config.js";
import type { CodeSymbol, FileEntry, CodeChunk } from "../../types.js";
import { embeddingCaches } from "./state.js";

const PARSE_CONCURRENCY = 8;
const CHUNK_EMBEDDING_BATCH_SIZE = 96;

export async function parseOneFile(
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
export async function parseFiles(
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
export function propagateDirtySignatures(
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
    const existing = await loadEmbeddings(embeddingPath, embeddingMemBudgetBytes());
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
export async function readAndChunkFiles(
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
export async function embedChunks(
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
