import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { getBM25Index, getCodeIndex } from "./index-tools.js";
import { searchBM25, applyCutoff } from "../search/bm25.js";
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
  options: { regex?: boolean; filePattern?: string | undefined; maxResults: number; contextLines: number },
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

  // Exclude dirs
  for (const dir of RG_EXCLUDE_DIRS) {
    args.push("--glob", `!${dir}`);
  }

  args.push("--", query, root);

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
    results = applyCutoff(results);
  }

  if (options?.rerank && results.length > 1) {
    const { rerankResults } = await import("../search/reranker.js");
    results = await rerankResults(query, results);
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

  let matches: TextMatch[];

  // OPT-1: Use ripgrep when available (10x faster)
  if (hasRipgrep()) {
    matches = searchWithRipgrep(index.root, query, {
      regex: useRegex,
      filePattern: filePattern,
      maxResults: maxResults,
      contextLines: contextLines,
    });
  } else {
    // Node.js fallback
    const regex = useRegex ? compileSearchRegex(query) : null;

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

  // OPT-3: Compact format — grep-like `file:line: content` output, ~50% less tokens than JSON
  // Auto-enable when auto_group is set (caller is optimization-aware) and results are small
  const useCompact = options?.compact
    ?? (options?.auto_group && contextLines === 0 && matches.length > 0 && matches.length <= AUTO_GROUP_THRESHOLD);

  if (useCompact && !options?.group_by_file) {
    return matches.map((m) => `${m.file}:${m.line}: ${m.content}`).join("\n");
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
