import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getBM25Index, getCodeIndex } from "../index-tools.js";
import { walkDirectory } from "../../utils/walk.js";
import { matchFilePattern } from "../../utils/glob.js";
import { raceWallClock } from "../../utils/wall-clock.js";
import type { CodeIndex, TextMatch, TextMatchGroup } from "../../types.js";
import {
  AUTO_GROUP_THRESHOLD,
  BINARY_EXTENSIONS,
  DEFAULT_MAX_REGEX_RESULTS,
  DEFAULT_MAX_TEXT_MATCHES,
  IDENTIFIER_QUERY_RX,
  JSON_OVERHEAD_PER_MATCH,
  MAX_FIRST_MATCH_CHARS,
  MAX_CONTEXT_LINES,
  MAX_LINE_CHARS,
  MAX_RESPONSE_CHARS,
  MAX_TEXT_RESULTS,
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
  deadline: number;
  signal: AbortSignal;
}

function searchFileForMatches(options: FileSearchOptions): TextMatch[] {
  const lines = options.content.split("\n");
  const matches: TextMatch[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (matches.length >= options.maxMatches) break;
    if (options.signal.aborted || Date.now() >= options.deadline) break;
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

async function resolveFallbackFiles(
  index: CodeIndex,
  filePattern: string | undefined,
): Promise<string[]> {
  if (filePattern) return index.files.map((file) => file.path);
  return walkDirectory(index.root, {
    fileFilter: (extension) => !BINARY_EXTENSIONS.has(extension),
    maxFiles: MAX_WALK_FILES,
    relative: true,
  });
}

interface MatchCollectionOptions {
  index: CodeIndex;
  query: string;
  useRegex: boolean;
  filePattern: string | undefined;
  maxResults: number;
  contextLines: number;
  deadline: number;
  signal: AbortSignal;
}

async function searchWithNodeFallback(options: MatchCollectionOptions): Promise<TextMatch[]> {
  const regex = options.useRegex ? compileSearchRegex(options.query) : null;
  const files = await resolveFallbackFiles(options.index, options.filePattern);
  const matches: TextMatch[] = [];
  for (const filePath of files) {
    if (matches.length >= options.maxResults) break;
    if (options.signal.aborted || Date.now() >= options.deadline) break;
    if (options.filePattern && !matchFilePattern(filePath, options.filePattern)) continue;
    let content: string;
    try {
      content = await readFile(join(options.index.root, filePath), {
        encoding: "utf-8",
        signal: options.signal,
      });
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
      deadline: options.deadline,
      signal: options.signal,
    }));
  }
  return matches;
}

async function collectMatches(options: MatchCollectionOptions): Promise<TextMatch[]> {
  if (!await hasRipgrep()) return searchWithNodeFallback(options);
  try {
    return await searchWithRipgrep(options.index.root, options.query, {
      regex: options.useRegex,
      filePattern: options.filePattern,
      maxResults: options.maxResults,
      contextLines: options.contextLines,
      signal: options.signal,
    });
  } catch {
    if (options.signal.aborted) return [];
    return searchWithNodeFallback(options);
  }
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
  const defaultMaximum = useRegex && !filePattern
    ? DEFAULT_MAX_REGEX_RESULTS
    : DEFAULT_MAX_TEXT_MATCHES;
  const requestedMaximum = options?.max_results ?? defaultMaximum;
  if (!Number.isFinite(requestedMaximum)) return MAX_TEXT_RESULTS;
  return Math.min(Math.max(Math.trunc(requestedMaximum), 0), MAX_TEXT_RESULTS);
}

function resolveContextLines(options: SearchTextOptions | undefined): number {
  const requestedLines = options?.context_lines ?? 0;
  if (!Number.isFinite(requestedLines)) return MAX_CONTEXT_LINES;
  return Math.min(Math.max(Math.trunc(requestedLines), 0), MAX_CONTEXT_LINES);
}

function resolveTextSearchOptions(options: SearchTextOptions | undefined): ResolvedTextSearchOptions {
  const useRegex = options?.regex ?? false;
  const filePattern = options?.file_pattern;
  const maxResults = resolveMaximumResults(options, useRegex, filePattern);
  return { useRegex, filePattern, maxResults, contextLines: resolveContextLines(options) };
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
  signal: AbortSignal = new AbortController().signal,
): Promise<SearchTextResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  const { useRegex, filePattern, maxResults, contextLines } = resolveTextSearchOptions(options);
  if (useRegex) compileSearchRegex(query);
  const matches = await collectMatches({
    index,
    query,
    useRegex,
    filePattern,
    maxResults,
    contextLines,
    deadline: Date.now() + Math.min(SEARCH_TIMEOUT_MS, SEARCH_TEXT_WALL_CLOCK_MS),
    signal,
  });
  const omittedGrouping = callerOmittedGrouping(options);
  if (shouldRankMatches(query, options, useRegex, omittedGrouping) && matches.length > 0) {
    const rankedMatches = await rankMatches(repo, index, matches);
    if (options?.group_by_file === true || options?.compact === true) {
      return formatMatches(rankedMatches, options, contextLines, false);
    }
    return rankedMatches;
  }
  return formatMatches(matches, options, contextLines, omittedGrouping);
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
  const controller = new AbortController();
  const timeoutMessage = `search exceeded ${SEARCH_TEXT_WALL_CLOCK_MS}ms — narrow scope with file_pattern (e.g. "src/**/*.ts") or use search_symbols for identifier lookup. Ranked mode runs after the regex scan and does not speed it up.`;
  return raceWallClock(
    searchTextInner(repo, query, options, controller.signal),
    SEARCH_TEXT_WALL_CLOCK_MS,
    () => {
      controller.abort();
      if (options?.group_by_file) {
        return [{ file: "<truncated>", count: 1, lines: [0], first_match: timeoutMessage }];
      }
      if (options?.compact) return `<truncated>:0: ${timeoutMessage}`;
      return [{
        file: "<truncated>",
        line: 0,
        content: timeoutMessage,
        truncated: true,
        hint: "narrow scope with file_pattern, or use search_symbols for identifier lookup",
      }] as TextMatch[];
    },
  );
}
