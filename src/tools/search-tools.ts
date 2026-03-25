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
const SEARCH_TIMEOUT_MS = 30_000; // Abort search after 30s to prevent 100s+ hangs
const AUTO_GROUP_THRESHOLD = 50; // Auto-switch to group_by_file above this match count
const MAX_RESPONSE_CHARS = 80_000; // ~20K tokens — force group_by_file above this
const MAX_FIRST_MATCH_CHARS = 300; // Cap first_match preview in grouped output
const MAX_LINE_CHARS = 500; // Truncate individual match lines (minified JS/JSON can be 100K+)
const DEFAULT_TOP_K_WITH_SOURCE = 10; // Cap results when include_source=true without file_pattern
const BM25_FILTER_MULTIPLIER = 5; // Widen BM25 candidate set when filters active
const BM25_FILTER_MIN_K = 200; // Minimum candidate set size when filters active
const DEFAULT_SOURCE_CHARS_NARROW = 200; // Source truncation without file_pattern (reduce waste)
const DEFAULT_SOURCE_CHARS_WIDE = 500; // Source truncation with file_pattern
const CHARS_PER_TOKEN = 4; // Approximate chars-per-token for budget calculation
const DEFAULT_MAX_REGEX_RESULTS = 50; // Regex without file_pattern — tighter cap to limit timeout
const JSON_OVERHEAD_PER_MATCH = 40; // Estimated JSON serialization overhead per TextMatch

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

export type DetailLevel = "compact" | "standard" | "full";

export interface SearchSymbolsOptions {
  kind?: SymbolKind | undefined;
  file_pattern?: string | undefined;
  include_source?: boolean | undefined;
  top_k?: number | undefined;
  source_chars?: number | undefined;
  detail_level?: DetailLevel | undefined;
  token_budget?: number | undefined;
}

export interface SearchTextOptions {
  regex?: boolean | undefined;
  file_pattern?: string | undefined;
  context_lines?: number | undefined;
  max_results?: number | undefined;
  group_by_file?: boolean | undefined;
  auto_group?: boolean | undefined;
}

// ── Private helpers ─────────────────────────────────────

/** Check if a symbol matches the active kind and file_pattern filters. */
function matchesSymbolFilters(
  symbol: { kind: string; file: string },
  options?: Pick<SearchSymbolsOptions, "kind" | "file_pattern">,
): boolean {
  if (options?.kind && symbol.kind !== options.kind) return false;
  if (options?.file_pattern && !matchFilePattern(symbol.file, options.file_pattern)) return false;
  return true;
}

/**
 * Apply detail-level shaping, source truncation, and field cleanup.
 * Compact: ~15 tok/result. Standard: signature + truncated source. Full: unlimited.
 */
function shapeSearchResults(
  results: SearchResult[],
  detail: DetailLevel,
  includeSource: boolean,
  options?: Pick<SearchSymbolsOptions, "source_chars" | "file_pattern">,
): SearchResult[] {
  if (detail === "compact") {
    return results.map((r) => ({
      symbol: {
        id: r.symbol.id,
        name: r.symbol.name,
        kind: r.symbol.kind,
        file: r.symbol.file,
        start_line: r.symbol.start_line,
      },
      score: r.score,
    })) as SearchResult[];
  }

  let shaped = results;

  if (!includeSource) {
    shaped = shaped.map((r) => {
      const { source: _source, ...symbolWithoutSource } = r.symbol;
      return { ...r, symbol: symbolWithoutSource as typeof r.symbol };
    });
  }

  const defaultSourceChars = detail === "full" ? undefined
    : (includeSource && !options?.file_pattern) ? DEFAULT_SOURCE_CHARS_NARROW : DEFAULT_SOURCE_CHARS_WIDE;
  const sourceChars = options?.source_chars ?? (includeSource ? defaultSourceChars : undefined);
  if (includeSource && sourceChars !== undefined && sourceChars > 0) {
    shaped = shaped.map((r) => {
      const source = r.symbol.source;
      if (source && source.length > sourceChars) {
        return { ...r, symbol: { ...r.symbol, source: source.slice(0, sourceChars) + "..." } };
      }
      return r;
    });
  }

  return shaped.map((r) => {
    const { tokens: _tokens, repo: _repo, ...cleanSymbol } = r.symbol;
    return { ...r, symbol: cleanSymbol as typeof r.symbol };
  });
}

/** Validate regex for ReDoS safety and compile without g/y flags, or throw descriptive error. */
function compileSearchRegex(query: string): RegExp {
  if (!isSafeRegex(query)) {
    throw new Error("Regex pattern rejected: potential catastrophic backtracking (ReDoS)");
  }
  try {
    // No g/y flags — regex is reused across files; stateful flags cause alternating matches
    return new RegExp(query);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid regex pattern: ${message}`);
  }
}

/** Search file content for line matches, collecting context lines around each hit. */
function searchFileForMatches(
  content: string,
  filePath: string,
  query: string,
  regex: RegExp | null,
  contextLines: number,
  maxMatches: number,
): TextMatch[] {
  const lines = content.split("\n");
  const matches: TextMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (matches.length >= maxMatches) break;

    const line = lines[i];
    if (line === undefined) continue;

    const isMatch = regex ? regex.test(line) : line.includes(query);
    if (!isMatch) continue;

    const contextBefore: string[] = [];
    for (let j = Math.max(0, i - contextLines); j < i; j++) {
      const ctxLine = lines[j];
      if (ctxLine !== undefined) contextBefore.push(ctxLine);
    }

    const contextAfter: string[] = [];
    for (let j = i + 1; j <= Math.min(lines.length - 1, i + contextLines); j++) {
      const ctxLine = lines[j];
      if (ctxLine !== undefined) contextAfter.push(ctxLine);
    }

    const truncLine = line.length > MAX_LINE_CHARS
      ? line.slice(0, MAX_LINE_CHARS) + "..."
      : line;
    const match: TextMatch = {
      file: filePath,
      line: i + 1,
      content: truncLine,
    };
    if (contextBefore.length > 0) match.context_before = contextBefore;
    if (contextAfter.length > 0) match.context_after = contextAfter;
    matches.push(match);
  }

  return matches;
}

/** Aggregate flat TextMatch[] into per-file groups with counts and first_match preview. */
function groupMatchesByFile(matches: TextMatch[]): TextMatchGroup[] {
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

// ── Public API ──────────────────────────────────────────

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
  const defaultK = (includeSource && !options?.file_pattern) ? DEFAULT_TOP_K_WITH_SOURCE : config.defaultTopK;
  const topK = options?.top_k ?? defaultK;
  const hasFilters = !!options?.kind || !!options?.file_pattern;

  let results: SearchResult[];

  if (!query.trim()) {
    const allSymbols = [...index.symbols.values()];
    const filtered = allSymbols.filter((s) => matchesSymbolFilters(s, options));
    results = filtered.slice(0, topK).map((symbol) => ({ symbol, score: 0 }));
  } else {
    const searchTopK = hasFilters ? Math.max(topK * BM25_FILTER_MULTIPLIER, BM25_FILTER_MIN_K) : topK;
    results = searchBM25(index, query, searchTopK, config.bm25FieldWeights);
    results = results.filter((r) => matchesSymbolFilters(r.symbol, options));
    results = results.slice(0, topK);
  }

  const detail = options?.detail_level ?? "standard";
  const shaped = shapeSearchResults(results, detail, includeSource, options);

  // Token budget: greedily pack results until budget exhausted
  const budget = options?.token_budget;
  if (budget && budget > 0) {
    const packed: typeof shaped = [];
    let used = 0;
    for (const r of shaped) {
      const tok = Math.ceil(JSON.stringify(r).length / CHARS_PER_TOKEN);
      if (used + tok > budget) break;
      packed.push(r);
      used += tok;
    }
    return packed;
  }

  return shaped;
}

/**
 * Full-text search across all files in a repository.
 * Walks the filesystem to search ALL text files, not just indexed ones.
 *
 * When group_by_file=true, returns TextMatchGroup[] instead of TextMatch[].
 * This reduces output by 80-90% for high-cardinality searches.
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

  const useRegex = options?.regex ?? false;
  const filePattern = options?.file_pattern;
  const maxResults = options?.max_results
    ?? (useRegex && !filePattern ? DEFAULT_MAX_REGEX_RESULTS : DEFAULT_MAX_TEXT_MATCHES);
  const contextLines = options?.context_lines ?? 2;

  const regex = useRegex ? compileSearchRegex(query) : null;

  // Use indexed file list when file_pattern is specified (skip expensive filesystem walk)
  let allFiles: string[];
  if (filePattern) {
    allFiles = index.files.map((f) => f.path);
  } else {
    allFiles = await walkDirectory(index.root, {
      fileFilter: (ext) => !BINARY_EXTENSIONS.has(ext),
      maxFiles: MAX_WALK_FILES,
      relative: true,
    });
  }

  const matches: TextMatch[] = [];
  const searchStart = Date.now();

  for (const filePath of allFiles) {
    if (matches.length >= maxResults) break;
    if (Date.now() - searchStart > SEARCH_TIMEOUT_MS) break;

    if (filePattern && !matchFilePattern(filePath, filePattern)) continue;

    const fullPath = join(index.root, filePath);
    let content: string;
    try {
      content = await readFile(fullPath, "utf-8");
    } catch {
      continue;
    }

    const fileMatches = searchFileForMatches(
      content, filePath, query, regex, contextLines, maxResults - matches.length,
    );
    matches.push(...fileMatches);
  }

  // Estimate response size; force grouping when output would be enormous
  const estimatedChars = matches.reduce((sum, m) => {
    let chars = m.file.length + m.content.length + JSON_OVERHEAD_PER_MATCH;
    if (m.context_before) chars += m.context_before.reduce((s, l) => s + l.length, 0);
    if (m.context_after) chars += m.context_after.reduce((s, l) => s + l.length, 0);
    return sum + chars;
  }, 0);

  const shouldGroup = options?.group_by_file
    || (options?.auto_group && matches.length > AUTO_GROUP_THRESHOLD)
    || estimatedChars > MAX_RESPONSE_CHARS;

  if (shouldGroup) {
    return groupMatchesByFile(matches);
  }

  return matches;
}
