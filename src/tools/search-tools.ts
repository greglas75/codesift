import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { getBM25Index, getCodeIndex } from "./index-tools.js";
import { searchBM25 } from "../search/bm25.js";
import { loadConfig } from "../config.js";
import type { SearchResult, TextMatch, SymbolKind } from "../types.js";

const DEFAULT_MAX_TEXT_MATCHES = 500;
const MAX_FILE_SIZE = 1_000_000; // 1MB — skip giant files
const MAX_WALK_FILES = 50_000; // Safety limit — stop walking after this many files

/** Directories to skip during text search file walk */
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage",
  ".codesift", ".next", "__pycache__", ".pytest_cache",
  ".venv", "venv", ".tox", ".mypy_cache", ".turbo",
  "generated", "audit-results", ".backup", "jscpd-report",
]);

/** Binary/non-text extensions to skip during text search */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".zip", ".gz", ".tar", ".bz2", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".exe", ".dll", ".so", ".dylib", ".o", ".obj",
  ".wasm", ".class", ".pyc", ".pyo",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav", ".flac",
  ".db", ".sqlite", ".sqlite3",
  ".lock",
]);

export interface SearchSymbolsOptions {
  kind?: SymbolKind | undefined;
  file_pattern?: string | undefined;
  include_source?: boolean | undefined;
  top_k?: number | undefined;
  source_chars?: number | undefined;
}

export interface SearchTextOptions {
  regex?: boolean | undefined;
  file_pattern?: string | undefined;
  context_lines?: number | undefined;
  max_results?: number | undefined;
}

/**
 * Match a file path against a simple glob pattern.
 * Supports: "*.ts", "src/*.ts", "src/**\/*.ts", "**\/*.test.ts"
 */
function matchFilePattern(filePath: string, pattern: string): boolean {
  // Exact match
  if (filePath === pattern) return true;

  // "**\/" prefix — match anywhere in path
  if (pattern.startsWith("**/")) {
    const suffix = pattern.slice(3);
    // Recursively match the suffix against every segment tail
    return matchFilePattern(filePath, suffix) ||
      filePath.includes("/" + suffix) ||
      matchFileSuffix(filePath, suffix);
  }

  // "*" at the start — match extension-style patterns like "*.ts"
  if (pattern.startsWith("*") && !pattern.includes("/")) {
    const suffix = pattern.slice(1);
    return filePath.endsWith(suffix);
  }

  // "dir/**" — match everything under directory (e.g., "src/**")
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return filePath.startsWith(prefix + "/") || filePath === prefix;
  }

  // Pattern with "**" in the middle (e.g., "src/**/*.ts")
  if (pattern.includes("/**/")) {
    const [prefix, suffix] = splitFirst(pattern, "/**/");
    if (!filePath.startsWith(prefix + "/") && filePath !== prefix) return false;
    const rest = filePath.slice(prefix.length + 1);
    return matchFilePattern(rest, suffix) ||
      matchFilePattern(rest, "**/" + suffix);
  }

  // Simple directory prefix + filename pattern (e.g., "src/*.ts")
  if (pattern.includes("/") && pattern.includes("*")) {
    const lastSlash = pattern.lastIndexOf("/");
    const dirPart = pattern.slice(0, lastSlash);
    const filePart = pattern.slice(lastSlash + 1);
    const fileLastSlash = filePath.lastIndexOf("/");
    const fileDir = fileLastSlash >= 0 ? filePath.slice(0, fileLastSlash) : "";
    const fileName = fileLastSlash >= 0 ? filePath.slice(fileLastSlash + 1) : filePath;

    if (fileDir !== dirPart) return false;
    return matchFilePattern(fileName, filePart);
  }

  // No wildcards: substring match on the full path
  // "risk.service.ts" matches "src/lib/services/risk/risk.service.ts"
  // "validators" matches "src/lib/validators/schema.ts"
  if (!pattern.includes("*")) {
    return filePath.includes(pattern);
  }

  return false;
}

function matchFileSuffix(filePath: string, suffix: string): boolean {
  if (suffix.startsWith("*")) {
    const ext = suffix.slice(1);
    return filePath.endsWith(ext);
  }
  return filePath.endsWith("/" + suffix) || filePath === suffix;
}

function splitFirst(str: string, sep: string): [string, string] {
  const idx = str.indexOf(sep);
  if (idx < 0) return [str, ""];
  return [str.slice(0, idx), str.slice(idx + sep.length)];
}

/**
 * Walk a directory tree collecting all text files.
 * Returns relative paths from rootPath.
 * Unlike the index walk, this includes ALL text files (not just parseable ones).
 */
async function walkAllTextFiles(rootPath: string): Promise<string[]> {
  const files: string[] = [];
  let limitReached = false;

  async function walk(dirPath: string): Promise<void> {
    if (limitReached) return;

    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return; // permission denied, etc.
    }

    for (const entry of entries) {
      if (limitReached) return;
      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) {
          continue;
        }
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name);

        // Skip binary files
        if (BINARY_EXTENSIONS.has(ext)) continue;

        // Skip files that are too large
        try {
          const fileStat = await stat(fullPath);
          if (fileStat.size > MAX_FILE_SIZE) continue;
        } catch {
          continue;
        }

        files.push(relative(rootPath, fullPath));

        if (files.length >= MAX_WALK_FILES) {
          console.warn(
            `[codesift] walkAllTextFiles: reached ${MAX_WALK_FILES} file limit, returning partial results`,
          );
          limitReached = true;
          return;
        }
      }
    }
  }

  await walk(rootPath);
  return files;
}

/**
 * Search symbols by name/signature/docstring using BM25 ranking.
 * Supports filtering by symbol kind and file pattern.
 *
 * When query is empty, returns all symbols matching the filters (up to top_k).
 * When kind or file_pattern filters are active, BM25 searches a wider candidate
 * set to avoid post-filter truncation.
 */
export async function searchSymbols(
  repo: string,
  query: string,
  options?: SearchSymbolsOptions,
): Promise<SearchResult[]> {
  const index = await getBM25Index(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const config = loadConfig();
  const topK = options?.top_k ?? config.defaultTopK;
  const includeSource = options?.include_source ?? true;
  const hasKindFilter = !!options?.kind;
  const hasFileFilter = !!options?.file_pattern;
  const hasFilters = hasKindFilter || hasFileFilter;

  let results: SearchResult[];

  if (!query.trim()) {
    // Empty query: return all symbols matching filters (no BM25 scoring)
    const allSymbols = [...index.symbols.values()];
    let filtered = allSymbols;

    if (hasKindFilter) {
      const kind = options!.kind!;
      filtered = filtered.filter((s) => s.kind === kind);
    }
    if (hasFileFilter) {
      const pattern = options!.file_pattern!;
      filtered = filtered.filter((s) => matchFilePattern(s.file, pattern));
    }

    results = filtered.slice(0, topK).map((symbol) => ({
      symbol,
      score: 0,
    }));
  } else {
    // When filters are active, search a wider candidate set from BM25
    // so that post-filter truncation doesn't lose relevant results.
    const searchTopK = hasFilters ? Math.max(topK * 5, 200) : topK;
    results = searchBM25(index, query, searchTopK, config.bm25FieldWeights);

    // Filter by symbol kind
    if (hasKindFilter) {
      const kind = options!.kind!;
      results = results.filter((r) => r.symbol.kind === kind);
    }

    // Filter by file pattern
    if (hasFileFilter) {
      const pattern = options!.file_pattern!;
      results = results.filter((r) => matchFilePattern(r.symbol.file, pattern));
    }

    // Re-truncate to requested top_k after filtering
    results = results.slice(0, topK);
  }

  // Strip source if not requested
  if (!includeSource) {
    results = results.map((r) => {
      const { source: _source, ...symbolWithoutSource } = r.symbol;
      return { ...r, symbol: symbolWithoutSource as typeof r.symbol };
    });
  }

  // Truncate source to source_chars limit (default 500 when include_source=true)
  const sourceChars = options?.source_chars ?? (includeSource ? 500 : undefined);
  if (includeSource && sourceChars !== undefined && sourceChars > 0) {
    results = results.map((r) => {
      const source = r.symbol.source;
      if (source && source.length > sourceChars) {
        return {
          ...r,
          symbol: { ...r.symbol, source: source.slice(0, sourceChars) + "..." },
        };
      }
      return r;
    });
  }

  return results;
}

/**
 * Full-text search across all files in a repository.
 * Walks the filesystem to search ALL text files, not just indexed ones.
 */
export async function searchText(
  repo: string,
  query: string,
  options?: SearchTextOptions,
): Promise<TextMatch[]> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const contextLines = options?.context_lines ?? 2;
  const useRegex = options?.regex ?? false;
  const filePattern = options?.file_pattern;
  const maxResults = options?.max_results ?? DEFAULT_MAX_TEXT_MATCHES;

  let regex: RegExp | null = null;
  if (useRegex) {
    try {
      regex = new RegExp(query);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid regex pattern: ${message}`);
    }
  }

  // Walk the filesystem to find ALL text files (not just indexed/parseable ones)
  const allFiles = await walkAllTextFiles(index.root);

  const matches: TextMatch[] = [];

  for (const filePath of allFiles) {
    if (matches.length >= maxResults) break;

    // Filter by file pattern
    if (filePattern && !matchFilePattern(filePath, filePattern)) {
      continue;
    }

    const fullPath = join(index.root, filePath);
    let content: string;
    try {
      content = await readFile(fullPath, "utf-8");
    } catch {
      continue; // File may have been deleted or moved
    }

    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= maxResults) break;

      const line = lines[i];
      if (line === undefined) continue;

      const isMatch = regex ? regex.test(line) : line.includes(query);
      if (!isMatch) continue;

      const contextBefore: string[] = [];
      const contextAfter: string[] = [];

      for (let j = Math.max(0, i - contextLines); j < i; j++) {
        const ctxLine = lines[j];
        if (ctxLine !== undefined) {
          contextBefore.push(ctxLine);
        }
      }

      for (let j = i + 1; j <= Math.min(lines.length - 1, i + contextLines); j++) {
        const ctxLine = lines[j];
        if (ctxLine !== undefined) {
          contextAfter.push(ctxLine);
        }
      }

      const match: TextMatch = {
        file: filePath,
        line: i + 1, // 1-based
        content: line,
      };
      if (contextBefore.length > 0) {
        match.context_before = contextBefore;
      }
      if (contextAfter.length > 0) {
        match.context_after = contextAfter;
      }
      matches.push(match);
    }
  }

  return matches;
}
