import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getBM25Index, getCodeIndex } from "./index-tools.js";
import { searchBM25 } from "../search/bm25.js";
import { loadConfig } from "../config.js";
import { walkDirectory } from "../utils/walk.js";
import { matchFilePattern } from "../utils/glob.js";
import type { SearchResult, TextMatch, TextMatchGroup, SymbolKind } from "../types.js";

const DEFAULT_MAX_TEXT_MATCHES = 200;
const MAX_WALK_FILES = 50_000; // Safety limit — stop walking after this many files
const AUTO_GROUP_THRESHOLD = 50; // Auto-switch to group_by_file above this match count
const MAX_RESPONSE_CHARS = 80_000; // ~20K tokens — force group_by_file above this
const MAX_FIRST_MATCH_CHARS = 300; // Cap first_match preview in grouped output

// SEC-003: Detect common catastrophic backtracking patterns (ReDoS)
const REDOS_PATTERNS = [
  /\(.*[+*].*\)[+*]/,          // Nested quantifiers: (a+)+ or (a*)*
  /\(.*\|.*\)[+*]/,            // Alternation with quantifier: (a|b)+
  /\(.*[+*].*\)\{/,            // Nested quantifier with range: (a+){2,}
  /\([^)]*\\[dDwWsS][+*].*\)[+*]/, // Character class with nested quantifier
];

function isSafeRegex(pattern: string): boolean {
  return !REDOS_PATTERNS.some((p) => p.test(pattern));
}

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
  group_by_file?: boolean | undefined;
  auto_group?: boolean | undefined;
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
  const includeSource = options?.include_source ?? true;
  // When include_source=true without file_pattern, cap results to avoid 10K+ token responses
  const defaultK = (includeSource && !options?.file_pattern) ? 10 : config.defaultTopK;
  const topK = options?.top_k ?? defaultK;
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

  // Strip internal/redundant fields from response to reduce token output:
  // - tokens: BM25 internal pre-computed token array (not useful to agents)
  // - repo: redundant — agent already knows which repo they searched
  return results.map((r) => {
    const { tokens: _tokens, repo: _repo, ...cleanSymbol } = r.symbol;
    return { ...r, symbol: cleanSymbol as typeof r.symbol };
  });
}

/**
 * Full-text search across all files in a repository.
 * Walks the filesystem to search ALL text files, not just indexed ones.
 *
 * When group_by_file=true, returns TextMatchGroup[] instead of TextMatch[].
 * This reduces output by 80-90% for high-cardinality searches (e.g., "throw new AppError" with 200+ hits).
 */
export async function searchText(
  repo: string,
  query: string,
  options?: SearchTextOptions & { group_by_file: true },
): Promise<TextMatchGroup[]>;
export async function searchText(
  repo: string,
  query: string,
  options?: SearchTextOptions,
): Promise<TextMatch[]>;
export async function searchText(
  repo: string,
  query: string,
  options?: SearchTextOptions,
): Promise<TextMatch[] | TextMatchGroup[]> {
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
    // SEC-003: Check for catastrophic backtracking before compiling
    if (!isSafeRegex(query)) {
      throw new Error("Regex pattern rejected: potential catastrophic backtracking (ReDoS)");
    }
    try {
      regex = new RegExp(query);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid regex pattern: ${message}`);
    }
  }

  // Walk the filesystem to find ALL text files (not just indexed/parseable ones)
  const allFiles = await walkDirectory(index.root, {
    fileFilter: (ext) => !BINARY_EXTENSIONS.has(ext),
    maxFiles: MAX_WALK_FILES,
    relative: true,
  });

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

  // Estimate response size; force grouping when output would be enormous
  const estimatedChars = matches.reduce((sum, m) => {
    let chars = m.file.length + m.content.length + 40; // JSON overhead
    if (m.context_before) chars += m.context_before.reduce((s, l) => s + l.length, 0);
    if (m.context_after) chars += m.context_after.reduce((s, l) => s + l.length, 0);
    return sum + chars;
  }, 0);

  const shouldGroup = options?.group_by_file
    || (options?.auto_group && matches.length > AUTO_GROUP_THRESHOLD)
    || estimatedChars > MAX_RESPONSE_CHARS;

  if (shouldGroup) {
    const groups = new Map<string, TextMatchGroup>();
    for (const m of matches) {
      const existing = groups.get(m.file);
      if (existing) {
        existing.count++;
        existing.lines.push(m.line);
      } else {
        groups.set(m.file, {
          file: m.file,
          count: 1,
          lines: [m.line],
          first_match: m.content.length > MAX_FIRST_MATCH_CHARS
            ? m.content.slice(0, MAX_FIRST_MATCH_CHARS) + "..."
            : m.content,
        });
      }
    }
    return [...groups.values()];
  }

  return matches;
}
