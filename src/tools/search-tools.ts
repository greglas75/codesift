import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { getBM25Index, getCodeIndex } from "./index-tools.js";
import { searchBM25, applyCutoff } from "../search/bm25.js";
import { loadConfig } from "../config.js";
import { walkDirectory } from "../utils/walk.js";
import { matchFilePattern } from "../utils/glob.js";
import { raceWallClock } from "../utils/wall-clock.js";
import type { SearchResult, TextMatch, TextMatchGroup, SymbolKind } from "../types.js";

const DEFAULT_MAX_TEXT_MATCHES = 200;
const MAX_WALK_FILES = 50_000; // Safety limit — stop walking after this many files
const SEARCH_TIMEOUT_MS = 30_000; // Abort search after 30s to prevent 100s+ hangs

/**
 * End-to-end wall-clock cap on a single searchText call. Telemetry showed
 * p95 = 2.4s but a 937s outlier — slow paths exist in semantic enrichment
 * and Node.js fallback walks. Configurable via CODESIFT_SEARCH_TEXT_CAP_MS.
 */
const SEARCH_TEXT_WALL_CLOCK_MS = (() => {
  const env = process.env["CODESIFT_SEARCH_TEXT_CAP_MS"];
  const parsed = env ? Number(env) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8000;
})();
const AUTO_GROUP_THRESHOLD = 50; // Auto-switch to group_by_file above this match count (when auto_group=true)
const SERVER_AUTO_GROUP_THRESHOLD = 30; // Server-side auto-group when caller omitted ALL grouping opts
const MAX_RESPONSE_CHARS = 80_000; // ~20K tokens — force group_by_file above this
const MAX_FIRST_MATCH_CHARS = 300; // Cap first_match preview in grouped output
const MAX_LINE_CHARS = 500; // Truncate individual match lines (minified JS/JSON can be 100K+)
const DEFAULT_TOP_K_WITH_SOURCE = 10; // Cap results when include_source=true without file_pattern
const BM25_FILTER_MULTIPLIER = 5; // Widen BM25 candidate set when filters active
const BM25_FILTER_MIN_K = 200; // Minimum candidate set size when filters active
const BM25_FILE_SHORTLIST_K = 60; // top-K BM25 symbol hits → unique file set for identifier-query shortlist
const IDENTIFIER_QUERY_RX = /^[A-Za-z_][A-Za-z0-9_]{2,}$/; // single identifier ≥3 chars — triggers BM25 shortlist + auto-rank
const DEFAULT_SOURCE_CHARS_NARROW = 200; // Source truncation without file_pattern (reduce waste)
const DEFAULT_SOURCE_CHARS_WIDE = 500; // Source truncation with file_pattern
const CHARS_PER_TOKEN = 3.5; // Approximate chars-per-token for budget calculation
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
  decorator?: string | undefined;
  include_source?: boolean | undefined;
  top_k?: number | undefined;
  source_chars?: number | undefined;
  detail_level?: DetailLevel | undefined;
  token_budget?: number | undefined;
  rerank?: boolean | undefined;
}

export interface SearchTextOptions {
  regex?: boolean | undefined;
  file_pattern?: string | undefined;
  context_lines?: number | undefined;
  max_results?: number | undefined;
  group_by_file?: boolean | undefined;
  auto_group?: boolean | undefined;
  compact?: boolean | undefined;
  ranked?: boolean | undefined;
}

// ── Private helpers ─────────────────────────────────────

function matchesDecoratorFilter(
  decorators: string[] | undefined,
  decoratorFilter: string | undefined,
): boolean {
  if (!decoratorFilter) return true;
  if (!decorators || decorators.length === 0) return false;

  const normalizedFilter = decoratorFilter.trim().replace(/^@/, "");
  return decorators.some((decorator) => {
    const normalized = decorator.trim().replace(/^@/, "");
    return normalized === normalizedFilter || normalized.startsWith(`${normalizedFilter}(`);
  });
}

/** Check if a symbol matches the active kind and file_pattern filters. */
function matchesSymbolFilters(
  symbol: { kind: string; file: string; decorators?: string[] },
  options?: Pick<SearchSymbolsOptions, "kind" | "file_pattern" | "decorator">,
): boolean {
  if (options?.kind && symbol.kind !== options.kind) return false;
  if (options?.file_pattern && !matchFilePattern(symbol.file, options.file_pattern)) return false;
  if (!matchesDecoratorFilter(symbol.decorators, options?.decorator)) return false;
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

// ── Ripgrep backend ────────────────────────────────────

/** Directories always excluded from ripgrep search */
const RG_EXCLUDE_DIRS = [
  "node_modules", ".git", ".next", "dist", ".codesift", "coverage",
  ".playwright-mcp", "__pycache__", ".mypy_cache", ".tox",
];

/** Detect whether `rg` (ripgrep) is available on this system. Cached at module level. */
let rgAvailable: boolean | null = null;
function hasRipgrep(): boolean {
  if (rgAvailable !== null) return rgAvailable;
  try {
    execFileSync("rg", ["--version"], { stdio: "pipe", timeout: 2000 });
    rgAvailable = true;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

/**
 * Search via ripgrep — fast C-based search, parses `rg -n` output.
 * Falls back to Node.js search if rg is not available.
 */
function searchWithRipgrep(
  root: string,
  query: string,
  options: {
    regex?: boolean;
    filePattern?: string | undefined;
    maxResults: number;
    contextLines: number;
    /** Optional: restrict search to this file list (relative paths) instead of walking `root`. */
    candidateFiles?: readonly string[] | undefined;
  },
): TextMatch[] {
  const args: string[] = [
    "-n",                    // line numbers
    "--no-heading",          // flat output
    "--max-columns", String(MAX_LINE_CHARS),
    "--max-columns-preview", // show truncated preview
    "--max-count", String(Math.min(options.maxResults * 2, 5000)), // per-file cap (generous to hit global max)
  ];

  if (!options.regex) {
    args.push("-F"); // fixed string (literal)
  }

  if (options.contextLines > 0) {
    args.push("-C", String(options.contextLines));
  }

  // File pattern → rg glob
  if (options.filePattern) {
    // Handle patterns like "src/**" or "*.ts"
    args.push("--glob", options.filePattern);
  }

  // Exclude dirs (only relevant when scanning the whole root — candidate file lists
  // are explicit paths and bypass the walker)
  if (!options.candidateFiles || options.candidateFiles.length === 0) {
    for (const dir of RG_EXCLUDE_DIRS) {
      args.push("--glob", `!${dir}`);
    }
  }

  if (options.candidateFiles && options.candidateFiles.length > 0) {
    // ripgrep omits the file-path prefix in output when given a single file,
    // and the parser below expects `path:line:content`. `--with-filename`
    // forces the prefix regardless of file count.
    args.push("--with-filename");
  }
  args.push("--", query);
  if (options.candidateFiles && options.candidateFiles.length > 0) {
    // Pass explicit file paths as positional args. Avoids whole-tree walk.
    for (const relPath of options.candidateFiles) {
      args.push(join(root, relPath));
    }
  } else {
    args.push(root);
  }

  let stdout: string;
  try {
    stdout = execFileSync("rg", args, {
      encoding: "utf-8",
      maxBuffer: 20 * 1024 * 1024, // 20MB
      timeout: SEARCH_TIMEOUT_MS,
    });
  } catch (err: unknown) {
    // rg exits 1 = no matches, 2 = error
    if (err && typeof err === "object" && "status" in err) {
      const exitCode = (err as { status: number }).status;
      if (exitCode === 1) return []; // no matches
      if ("stdout" in err && typeof (err as { stdout: unknown }).stdout === "string") {
        stdout = (err as { stdout: string }).stdout;
        if (!stdout) return [];
      } else {
        return [];
      }
    } else {
      return [];
    }
  }

  const matches: TextMatch[] = [];
  const rootPrefix = root.endsWith("/") ? root : root + "/";

  // Parse context blocks: lines separated by "--" separators
  const blocks = options.contextLines > 0
    ? stdout.split(/^--$/m)
    : [stdout];

  for (const block of blocks) {
    if (matches.length >= options.maxResults) break;

    const lines = block.split("\n").filter(Boolean);
    // In context mode, find the actual match line (has `:` separator) vs context (has `-` separator)
    // In non-context mode, all lines are matches
    for (const rawLine of lines) {
      if (matches.length >= options.maxResults) break;

      // rg format: /abs/path/file.ts:42:content  (match)
      // rg format: /abs/path/file.ts-40-content   (context, only with -C)
      // We only want match lines (with `:` after line number)
      const matchResult = rawLine.match(/^(.+?):(\d+):(.*)/);
      if (!matchResult) continue;

      const [, absPath, lineNumStr, content] = matchResult;
      if (!absPath || !lineNumStr || content === undefined) continue;

      const relPath = absPath.startsWith(rootPrefix)
        ? absPath.slice(rootPrefix.length)
        : absPath;

      matches.push({
        file: relPath,
        line: parseInt(lineNumStr, 10),
        content: content,
      });
    }
  }

  // For context mode, we need to re-parse to attach context_before/context_after
  // But context_lines=0 is the default now, so this path is rarely hit
  if (options.contextLines > 0 && blocks.length > 1) {
    return parseRipgrepContextBlocks(stdout, rootPrefix, options.maxResults, options.contextLines);
  }

  return matches;
}

/**
 * Parse rg output with context lines (-C N) into TextMatch[] with context_before/context_after.
 */
function parseRipgrepContextBlocks(
  stdout: string,
  rootPrefix: string,
  maxResults: number,
  contextLines: number,
): TextMatch[] {
  const matches: TextMatch[] = [];
  const blocks = stdout.split(/^--$/m);

  for (const block of blocks) {
    if (matches.length >= maxResults) break;

    const lines = block.split("\n").filter(Boolean);
    // Separate match lines from context lines
    // Match: path:line:content  Context: path-line-content
    const parsed: Array<{ path: string; line: number; content: string; isMatch: boolean }> = [];

    for (const raw of lines) {
      // Try match line first (colon after line number)
      const matchLine = raw.match(/^(.+?):(\d+):(.*)/);
      if (matchLine && matchLine[1] && matchLine[2] && matchLine[3] !== undefined) {
        parsed.push({
          path: matchLine[1].startsWith(rootPrefix) ? matchLine[1].slice(rootPrefix.length) : matchLine[1],
          line: parseInt(matchLine[2], 10),
          content: matchLine[3],
          isMatch: true,
        });
        continue;
      }
      // Try context line (hyphen after line number)
      const ctxLine = raw.match(/^(.+?)-(\d+)-(.*)/);
      if (ctxLine && ctxLine[1] && ctxLine[2] && ctxLine[3] !== undefined) {
        parsed.push({
          path: ctxLine[1].startsWith(rootPrefix) ? ctxLine[1].slice(rootPrefix.length) : ctxLine[1],
          line: parseInt(ctxLine[2], 10),
          content: ctxLine[3],
          isMatch: false,
        });
      }
    }

    // Build TextMatch for each match line with surrounding context
    for (let i = 0; i < parsed.length; i++) {
      const p = parsed[i]!;
      if (!p.isMatch) continue;
      if (matches.length >= maxResults) break;

      const contextBefore: string[] = [];
      const contextAfter: string[] = [];

      // Collect context before
      for (let j = Math.max(0, i - contextLines); j < i; j++) {
        const ctx = parsed[j];
        if (ctx && !ctx.isMatch) contextBefore.push(ctx.content);
      }
      // Collect context after
      for (let j = i + 1; j <= Math.min(parsed.length - 1, i + contextLines); j++) {
        const ctx = parsed[j];
        if (ctx && !ctx.isMatch) contextAfter.push(ctx.content);
      }

      const match: TextMatch = { file: p.path, line: p.line, content: p.content };
      if (contextBefore.length > 0) match.context_before = contextBefore;
      if (contextAfter.length > 0) match.context_after = contextAfter;
      matches.push(match);
    }
  }

  return matches;
}

// ── Node.js fallback search ───────────────────────────

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
 * Supports filtering by symbol kind, file pattern, and decorator metadata.
 *
 * When query is empty, returns all symbols matching the filters (up to top_k).
 * When kind, decorator, or file_pattern filters are active, BM25 searches a wider candidate
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
  const hasFilters = !!options?.kind || !!options?.file_pattern || !!options?.decorator;

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
    results = applyCutoff(results);
  }

  if (options?.rerank && results.length > 1) {
    const { rerankResults } = await import("../search/reranker.js");
    results = await rerankResults(query, results);
  }

  // Server-side auto-compact: telemetry showed 100% of search_symbols calls
  // omit detail_level/token_budget (post-fact H6 hints don't change agent
  // behavior). When the result count is large and the caller didn't specify
  // detail_level, switch to "compact" — cuts payload roughly in half without
  // losing critical info (location is preserved; agent can fetch source via
  // get_symbol if needed). An EXPLICIT include_source=true opts out: the
  // caller asked for source, compact would silently drop it.
  const SERVER_AUTO_COMPACT_THRESHOLD = 12;
  const callerExplicitlyWantsSource = options?.include_source === true;
  const detail = options?.detail_level
    ?? (results.length > SERVER_AUTO_COMPACT_THRESHOLD
        && !options?.token_budget
        && !callerExplicitlyWantsSource
        ? "compact"
        : "standard");
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
  options?: SearchTextOptions & { compact: true },
): Promise<string>;
export async function searchText(
  repo: string,
  query: string,
  options?: SearchTextOptions,
): Promise<TextMatch[]>;
export async function searchText(
  repo: string,
  query: string,
  options?: SearchTextOptions,
): Promise<TextMatch[] | TextMatchGroup[] | string> {
  return raceWallClock(
    searchTextInner(repo, query, options),
    SEARCH_TEXT_WALL_CLOCK_MS,
    () => [{
      file: "<truncated>",
      line: 0,
      content: `search exceeded ${SEARCH_TEXT_WALL_CLOCK_MS}ms — narrow scope with file_pattern (e.g. "src/**/*.ts") or use search_symbols for identifier lookup. Ranked mode runs after the regex scan and does not speed it up.`,
      truncated: true,
      hint: "narrow scope with file_pattern, or use search_symbols for identifier lookup",
    }] as TextMatch[],
  );
}

async function searchTextInner(
  repo: string,
  query: string,
  options?: SearchTextOptions,
): Promise<TextMatch[] | TextMatchGroup[] | string> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const useRegex = options?.regex ?? false;
  const filePattern = options?.file_pattern;
  const maxResults = options?.max_results
    ?? (useRegex && !filePattern ? DEFAULT_MAX_REGEX_RESULTS : DEFAULT_MAX_TEXT_MATCHES);
  const contextLines = options?.context_lines ?? 0; // OPT-2: default 0 (was 2) — saves ~30 tokens/match

  // Validate regex safety before passing to ripgrep
  if (useRegex) {
    compileSearchRegex(query); // throws on ReDoS patterns
  }

  // OPT-RANK-1: For single-identifier queries without an explicit file_pattern,
  // shortlist candidate files via BM25 (top-K symbol hits → unique file set)
  // BEFORE scanning. Telemetry showed identifier queries on large repos hit
  // the 8s wall-clock cap because ripgrep walked the entire tree; restricting
  // to ~60 candidate files drops scan time to <500ms while preserving the
  // matches an agent actually wants (definition + usages of the identifier).
  // Skipped when the agent passed file_pattern (already narrowed) or for
  // regex/multi-word queries (BM25 symbol relevance doesn't generalize).
  let candidateFiles: string[] | undefined;
  if (!useRegex && !filePattern && IDENTIFIER_QUERY_RX.test(query)) {
    try {
      const bm25 = await getBM25Index(repo);
      if (bm25) {
        const config = loadConfig();
        const bm25Hits = searchBM25(bm25, query, BM25_FILE_SHORTLIST_K, config.bm25FieldWeights);
        if (bm25Hits.length > 0) {
          const fileSet = new Set<string>();
          for (const r of bm25Hits) fileSet.add(r.symbol.file);
          candidateFiles = [...fileSet];
        }
      }
    } catch {
      // Graceful fallback — full scan if BM25 lookup fails for any reason
    }
  }

  let matches: TextMatch[];

  // OPT-1: Use ripgrep when available (10x faster)
  if (hasRipgrep()) {
    matches = searchWithRipgrep(index.root, query, {
      regex: useRegex,
      filePattern: filePattern,
      maxResults: maxResults,
      contextLines: contextLines,
      candidateFiles: candidateFiles,
    });
  } else {
    // Node.js fallback
    const regex = useRegex ? compileSearchRegex(query) : null;

    let allFiles: string[];
    if (candidateFiles && candidateFiles.length > 0) {
      // OPT-RANK-1: BM25 shortlist already narrowed the search space — skip the walk.
      allFiles = [...candidateFiles];
    } else if (filePattern) {
      allFiles = index.files.map((f) => f.path);
    } else {
      allFiles = await walkDirectory(index.root, {
        fileFilter: (ext) => !BINARY_EXTENSIONS.has(ext),
        maxFiles: MAX_WALK_FILES,
        relative: true,
      });
    }

    matches = [];
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
  }

  // Server-side auto-promotion of ranked mode for identifier-like queries when
  // the caller passed no grouping/ranking options. Telemetry showed 0/5640
  // calls used ranked=true despite it saving 1-3 follow-up get_symbol calls
  // for "find usages of X" queries — agents simply weren't reaching for it.
  // Conservative trigger: query must look like a single identifier (≥3 chars)
  // and the caller must not have expressed any grouping preference.
  const callerOmittedGroupOpts =
    options?.group_by_file === undefined
    && options?.auto_group === undefined
    && options?.ranked === undefined
    && options?.compact === undefined;
  const isIdentifierQuery = !useRegex && IDENTIFIER_QUERY_RX.test(query);
  const shouldRank = options?.ranked
    || (callerOmittedGroupOpts && isIdentifierQuery);

  // Ranked mode: classify hits with symbol context, deduplicate, and sort by centrality.
  // Takes precedence over auto_group/compact — returns TextMatch[] with containing_symbol.
  if (shouldRank && matches.length > 0) {
    try {
      const { classifyHitsWithSymbols } = await import("./search-ranker.js");
      const bm25Idx = await getBM25Index(repo);
      if (bm25Idx) {
        matches = await classifyHitsWithSymbols(matches, index, { centrality: bm25Idx.centrality });
      }
    } catch {
      // Graceful fallback — return unranked matches if pipeline fails
    }
    return matches;
  }

  // OPT-3: Compact format — grep-like `file:line: content` output, ~50% less tokens than JSON
  // Auto-enable when auto_group is set (caller is optimization-aware) and results are small
  const useCompact = options?.compact
    ?? (options?.auto_group && contextLines === 0 && matches.length > 0 && matches.length <= AUTO_GROUP_THRESHOLD);

  if (useCompact && !options?.group_by_file) {
    // Group by file to avoid repeating long paths (saves ~30% on multi-match files)
    const groups = new Map<string, string[]>();
    for (const m of matches) {
      let g = groups.get(m.file);
      if (!g) { g = []; groups.set(m.file, g); }
      g.push(`  ${m.line}: ${m.content}`);
    }
    if (groups.size === matches.length) {
      // Each file has 1 match — flat format is fine
      return matches.map((m) => `${m.file}:${m.line}: ${m.content}`).join("\n");
    }
    // Grouped: file header + indented matches
    const parts: string[] = [];
    for (const [file, lines] of groups) {
      parts.push(`${file}\n${lines.join("\n")}`);
    }
    return parts.join("\n");
  }

  // Estimate response size; force grouping when output would be enormous
  const estimatedChars = matches.reduce((sum, m) => {
    let chars = m.file.length + m.content.length + JSON_OVERHEAD_PER_MATCH;
    if (m.context_before) chars += m.context_before.reduce((s, l) => s + l.length, 0);
    if (m.context_after) chars += m.context_after.reduce((s, l) => s + l.length, 0);
    return sum + chars;
  }, 0);

  // Server-side default grouping: when caller didn't specify any grouping/ranking
  // option AND result count exceeds SERVER_AUTO_GROUP_THRESHOLD, group by file.
  // Telemetry showed 51% of search_text calls omitted these opts entirely;
  // grouping cuts payload by ~50% (975 → 499 avg tokens per call).
  // (callerOmittedGroupOpts hoisted above for shared use with ranked auto-promote)

  const shouldGroup = options?.group_by_file
    || (options?.auto_group && matches.length > AUTO_GROUP_THRESHOLD)
    || (callerOmittedGroupOpts && matches.length > SERVER_AUTO_GROUP_THRESHOLD)
    || estimatedChars > MAX_RESPONSE_CHARS;

  if (shouldGroup) {
    return groupMatchesByFile(matches);
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Semantic search — standalone wrapper around retrieval infrastructure
// ---------------------------------------------------------------------------

export async function semanticSearch(
  repo: string,
  query: string,
  options?: {
    top_k?: number;
    file_pattern?: string;
    exclude_tests?: boolean;
    rerank?: boolean;
  },
): Promise<string> {
  const { handleSemanticQuery } = await import("../retrieval/semantic-handlers.js");
  const result = await handleSemanticQuery(repo, {
    type: "semantic",
    query,
    top_k: options?.top_k,
    file_filter: options?.file_pattern,
    exclude_tests: options?.exclude_tests,
    rerank: options?.rerank,
  });
  return typeof result.data === "string" ? result.data : JSON.stringify(result.data);
}

// ---------------------------------------------------------------------------
// Zero-hit fallback — vocabulary suggestions + semantic rescue
//
// Telemetry (30d window, 2026-06): 44% of search_text calls (2,539/5,826)
// returned zero matches. Each miss costs the agent a turn of re-guessing.
// On a miss we now return (a) near-miss symbol names from the index
// vocabulary and (b) semantic results when an embeddings index already
// exists on disk — never triggering a fresh embedding build on this path.
// ---------------------------------------------------------------------------

const ZERO_HIT_SUGGESTION_CAP = 5;
const ZERO_HIT_SEMANTIC_TOP_K = 5;
const ZERO_HIT_SEMANTIC_CAP_MS = 4000;
const ZERO_HIT_EDIT_DISTANCE_MAX = 2;
const ZERO_HIT_MIN_QUERY_LEN = 3;

export interface ZeroHitFallbackResult {
  /** Near-miss symbol names from the index vocabulary ("did you mean"). */
  suggestions?: string[];
  /** Formatted semantic-search results — present only when an embeddings
   * index already existed and the query embedded within the time cap. */
  semantic_results?: string;
}

/** Levenshtein distance with early exit once the distance exceeds `max`. */
function boundedEditDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length]!;
}

/** Rank symbol names against a single-token query: exact-insensitive first,
 * then substring containment, then small edit distance. */
function suggestFromVocabulary(query: string, names: Iterable<string>): string[] {
  const q = query.toLowerCase();
  const scored: Array<{ name: string; score: number }> = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const n = name.toLowerCase();
    if (n === q) continue; // exact match would have been found by the scan
    let score: number;
    if (n.includes(q) || q.includes(n)) {
      score = Math.abs(n.length - q.length); // tighter containment ranks higher
    } else {
      const d = boundedEditDistance(q, n, ZERO_HIT_EDIT_DISTANCE_MAX);
      if (d > ZERO_HIT_EDIT_DISTANCE_MAX) continue;
      score = 10 + d; // containment always beats fuzzy
    }
    scored.push({ name, score });
  }
  scored.sort((a, b) => a.score - b.score || a.name.length - b.name.length);
  return scored.slice(0, ZERO_HIT_SUGGESTION_CAP).map((s) => s.name);
}

/**
 * Build fallback guidance after a zero-hit text search. Both branches are
 * best-effort: any failure degrades to an empty object, never an error.
 */
export async function zeroHitFallback(
  repo: string,
  query: string,
): Promise<ZeroHitFallbackResult> {
  const out: ZeroHitFallbackResult = {};
  const trimmed = query.trim();
  if (trimmed.length < ZERO_HIT_MIN_QUERY_LEN) return out;

  // (a) Vocabulary suggestions — only meaningful for single-token queries.
  if (!/\s/.test(trimmed)) {
    try {
      const index = await getCodeIndex(repo);
      if (index) {
        const suggestions = suggestFromVocabulary(
          trimmed,
          index.symbols.map((s) => s.name),
        );
        if (suggestions.length > 0) out.suggestions = suggestions;
      }
    } catch {
      // best-effort
    }
  }

  // (b) Semantic rescue — gated on a pre-existing embeddings file so a miss
  // never triggers an expensive embedding build.
  try {
    const config = loadConfig();
    const { getRepo } = await import("../storage/registry.js");
    const meta = await getRepo(config.registryPath, repo);
    if (meta) {
      const { existsSync } = await import("node:fs");
      const { getEmbeddingPath } = await import("../storage/embedding-store.js");
      const { getChunkEmbeddingPath } = await import("../storage/chunk-store.js");
      const hasEmbeddings =
        existsSync(getEmbeddingPath(meta.index_path))
        || existsSync(getChunkEmbeddingPath(meta.index_path));
      if (hasEmbeddings) {
        const semantic = await raceWallClock(
          semanticSearch(repo, trimmed, { top_k: ZERO_HIT_SEMANTIC_TOP_K }),
          ZERO_HIT_SEMANTIC_CAP_MS,
          () => "",
        );
        if (semantic && semantic !== "(no results)") out.semantic_results = semantic;
      }
    }
  } catch {
    // best-effort — no provider, no registry entry, embed timeout, etc.
  }

  return out;
}
