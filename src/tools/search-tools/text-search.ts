import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getBM25Index, getCodeIndex } from "../index-tools.js";
import { searchBM25 } from "../../search/bm25.js";
import { loadConfig } from "../../config.js";
import { walkDirectory } from "../../utils/walk.js";
import { matchFilePattern } from "../../utils/glob.js";
import { raceWallClock } from "../../utils/wall-clock.js";
import type { CodeIndex, TextMatch, TextMatchGroup } from "../../types.js";
import {
  AUTO_GROUP_THRESHOLD,
  BINARY_EXTENSIONS,
  BM25_FILE_SHORTLIST_K,
  DEFAULT_MAX_REGEX_RESULTS,
  DEFAULT_MAX_TEXT_MATCHES,
  IDENTIFIER_QUERY_RX,
  JSON_OVERHEAD_PER_MATCH,
  MAX_FIRST_MATCH_CHARS,
  MAX_LINE_CHARS,
  MAX_RESPONSE_CHARS,
  MAX_WALK_FILES,
  REDOS_PATTERNS,
  SEARCH_TEXT_WALL_CLOCK_MS,
  SEARCH_TIMEOUT_MS,
  SERVER_AUTO_GROUP_THRESHOLD,
} from "./constants.js";
import { hasRipgrep, searchWithRipgrep } from "./ripgrep.js";
import type { SearchTextOptions } from "./types.js";

type SearchTextResult = TextMatch[] | TextMatchGroup[] | string;

function compileSearchRegex(query: string): RegExp {
  if (REDOS_PATTERNS.some((pattern) => pattern.test(query))) {
    throw new Error("Regex pattern rejected: potential catastrophic backtracking (ReDoS)");
  }
  try {
    return new RegExp(query);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regex pattern: ${message}`);
  }
}

interface FileSearchOptions {
  content: string;
  filePath: string;
  query: string;
  regex: RegExp | null;
  contextLines: number;
  maxMatches: number;
}

function searchFileForMatches(options: FileSearchOptions): TextMatch[] {
  const lines = options.content.split("\n");
  const matches: TextMatch[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (matches.length >= options.maxMatches) break;
    const line = lines[index];
    if (line === undefined) continue;
    const isMatch = options.regex ? options.regex.test(line) : line.includes(options.query);
    if (!isMatch) continue;
    const contextBefore = lines.slice(Math.max(0, index - options.contextLines), index);
    const contextAfter = lines.slice(index + 1, index + options.contextLines + 1);
    const content = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line;
    const match: TextMatch = { file: options.filePath, line: index + 1, content };
    if (contextBefore.length > 0) match.context_before = contextBefore;
    if (contextAfter.length > 0) match.context_after = contextAfter;
    matches.push(match);
  }
  return matches;
}

function groupMatchesByFile(matches: TextMatch[]): TextMatchGroup[] {
  const groups = new Map<string, TextMatchGroup>();
  for (const match of matches) {
    const existingGroup = groups.get(match.file);
    if (existingGroup) {
      existingGroup.count++;
      existingGroup.lines.push(match.line);
      continue;
    }
    groups.set(match.file, {
      file: match.file,
      count: 1,
      lines: [match.line],
      first_match: match.content.length > MAX_FIRST_MATCH_CHARS
        ? `${match.content.slice(0, MAX_FIRST_MATCH_CHARS)}...`
        : match.content,
    });
  }
  return [...groups.values()];
}

async function shortlistCandidateFiles(
  repo: string,
  query: string,
  useRegex: boolean,
  filePattern: string | undefined,
): Promise<string[] | undefined> {
  if (useRegex || filePattern || !IDENTIFIER_QUERY_RX.test(query)) return undefined;
  try {
    const bm25Index = await getBM25Index(repo);
    if (!bm25Index) return undefined;
    const config = loadConfig();
    const hits = searchBM25(
      bm25Index,
      query,
      BM25_FILE_SHORTLIST_K,
      config.bm25FieldWeights,
    );
    if (hits.length === 0) return undefined;
    return [...new Set(hits.map(({ symbol }) => symbol.file))];
  } catch {
    return undefined;
  }
}

async function resolveFallbackFiles(
  index: CodeIndex,
  candidateFiles: string[] | undefined,
  filePattern: string | undefined,
): Promise<string[]> {
  if (candidateFiles && candidateFiles.length > 0) return [...candidateFiles];
  if (filePattern) return index.files.map((file) => file.path);
  return walkDirectory(index.root, {
    fileFilter: (extension) => !BINARY_EXTENSIONS.has(extension),
    maxFiles: MAX_WALK_FILES,
    relative: true,
  });
}

interface MatchCollectionOptions {
  repo: string;
  index: CodeIndex;
  query: string;
  useRegex: boolean;
  filePattern: string | undefined;
  maxResults: number;
  contextLines: number;
  candidateFiles: string[] | undefined;
}

async function searchWithNodeFallback(options: MatchCollectionOptions): Promise<TextMatch[]> {
  const regex = options.useRegex ? compileSearchRegex(options.query) : null;
  const files = await resolveFallbackFiles(options.index, options.candidateFiles, options.filePattern);
  const matches: TextMatch[] = [];
  const searchStartedAt = Date.now();
  for (const filePath of files) {
    if (matches.length >= options.maxResults) break;
    if (Date.now() - searchStartedAt > SEARCH_TIMEOUT_MS) break;
    if (options.filePattern && !matchFilePattern(filePath, options.filePattern)) continue;
    let content: string;
    try {
      content = await readFile(join(options.index.root, filePath), "utf-8");
    } catch {
      continue;
    }
    matches.push(...searchFileForMatches({
      content,
      filePath,
      query: options.query,
      regex,
      contextLines: options.contextLines,
      maxMatches: options.maxResults - matches.length,
    }));
  }
  return matches;
}

async function collectMatches(options: MatchCollectionOptions): Promise<TextMatch[]> {
  if (!hasRipgrep()) return searchWithNodeFallback(options);
  return searchWithRipgrep(options.index.root, options.query, {
    regex: options.useRegex,
    filePattern: options.filePattern,
    maxResults: options.maxResults,
    contextLines: options.contextLines,
    candidateFiles: options.candidateFiles,
  });
}

function callerOmittedGrouping(options: SearchTextOptions | undefined): boolean {
  return options?.group_by_file === undefined
    && options?.auto_group === undefined
    && options?.ranked === undefined
    && options?.compact === undefined;
}

async function rankMatches(
  repo: string,
  index: CodeIndex,
  matches: TextMatch[],
): Promise<TextMatch[]> {
  try {
    const { classifyHitsWithSymbols } = await import("../search-ranker.js");
    const bm25Index = await getBM25Index(repo);
    return bm25Index
      ? await classifyHitsWithSymbols(matches, index, { centrality: bm25Index.centrality })
      : matches;
  } catch {
    return matches;
  }
}

function compactMatches(matches: TextMatch[]): string {
  const groups = new Map<string, string[]>();
  for (const match of matches) {
    const lines = groups.get(match.file) ?? [];
    if (!groups.has(match.file)) groups.set(match.file, lines);
    lines.push(`  ${match.line}: ${match.content}`);
  }
  if (groups.size === matches.length) {
    return matches.map((match) => `${match.file}:${match.line}: ${match.content}`).join("\n");
  }
  return [...groups].map(([file, lines]) => `${file}\n${lines.join("\n")}`).join("\n");
}

function countResponseCharacters(matches: TextMatch[]): number {
  return matches.reduce((total, match) => {
    const before = match.context_before?.reduce((sum, line) => sum + line.length, 0) ?? 0;
    const after = match.context_after?.reduce((sum, line) => sum + line.length, 0) ?? 0;
    return total + match.file.length + match.content.length + before + after + JSON_OVERHEAD_PER_MATCH;
  }, 0);
}

function shouldUseCompactFormat(
  matches: TextMatch[],
  options: SearchTextOptions | undefined,
  contextLines: number,
): boolean {
  if (options?.compact !== undefined) return options.compact;
  return options?.auto_group === true
    && contextLines === 0
    && matches.length > 0
    && matches.length <= AUTO_GROUP_THRESHOLD;
}

function shouldGroupMatches(
  matches: TextMatch[],
  options: SearchTextOptions | undefined,
  omittedGrouping: boolean,
): boolean {
  return options?.group_by_file === true
    || (options?.auto_group && matches.length > AUTO_GROUP_THRESHOLD)
    || (omittedGrouping && matches.length > SERVER_AUTO_GROUP_THRESHOLD)
    || countResponseCharacters(matches) > MAX_RESPONSE_CHARS;
}

function formatMatches(
  matches: TextMatch[],
  options: SearchTextOptions | undefined,
  contextLines: number,
  omittedGrouping: boolean,
): SearchTextResult {
  if (shouldUseCompactFormat(matches, options, contextLines) && !options?.group_by_file) {
    return compactMatches(matches);
  }
  return shouldGroupMatches(matches, options, omittedGrouping)
    ? groupMatchesByFile(matches)
    : matches;
}

interface ResolvedTextSearchOptions {
  useRegex: boolean;
  filePattern: string | undefined;
  maxResults: number;
  contextLines: number;
}

function resolveMaximumResults(
  options: SearchTextOptions | undefined,
  useRegex: boolean,
  filePattern: string | undefined,
): number {
  if (options?.max_results !== undefined) return options.max_results;
  if (useRegex && !filePattern) return DEFAULT_MAX_REGEX_RESULTS;
  return DEFAULT_MAX_TEXT_MATCHES;
}

function resolveTextSearchOptions(options: SearchTextOptions | undefined): ResolvedTextSearchOptions {
  const useRegex = options?.regex ?? false;
  const filePattern = options?.file_pattern;
  const maxResults = resolveMaximumResults(options, useRegex, filePattern);
  return { useRegex, filePattern, maxResults, contextLines: options?.context_lines ?? 0 };
}

function shouldRankMatches(
  query: string,
  options: SearchTextOptions | undefined,
  useRegex: boolean,
  omittedGrouping: boolean,
): boolean {
  if (options?.ranked === true) return true;
  return omittedGrouping && !useRegex && IDENTIFIER_QUERY_RX.test(query);
}

async function searchTextInner(
  repo: string,
  query: string,
  options?: SearchTextOptions,
): Promise<SearchTextResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  const { useRegex, filePattern, maxResults, contextLines } = resolveTextSearchOptions(options);
  if (useRegex) compileSearchRegex(query);
  const candidateFiles = await shortlistCandidateFiles(repo, query, useRegex, filePattern);
  const matches = await collectMatches({
    repo,
    index,
    query,
    useRegex,
    filePattern,
    maxResults,
    contextLines,
    candidateFiles,
  });
  const omittedGrouping = callerOmittedGrouping(options);
  return shouldRankMatches(query, options, useRegex, omittedGrouping) && matches.length > 0
    ? rankMatches(repo, index, matches)
    : formatMatches(matches, options, contextLines, omittedGrouping);
}

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
): Promise<SearchTextResult> {
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
