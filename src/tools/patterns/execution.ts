/** Generic indexed pattern execution engine. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "../index-tools.js";
import { BUILTIN_PATTERNS } from "./catalog.js";
import { stripCommentsAndStrings } from "../../utils/source-stripper.js";
import { isTestFileStrict as isTestFile } from "../../utils/test-file.js";
import type { SymbolKind } from "../../types.js";

export interface PatternMatch {
  name: string;
  kind: SymbolKind;
  file: string;
  start_line: number;
  end_line: number;
  matched_pattern: string;
  context: string;            // the matching line(s)
}

export interface PatternResult {
  matches: PatternMatch[];
  pattern: string;
  scanned_symbols: number;
}

/**
 * Run optional postFilter on a regex match slice. Returns false if the match
 * should be dropped. If the filter throws, logs a warning and keeps the match
 * (fail-open) so transient postFilter bugs do not hide security findings.
 */
function shouldKeepPostFilterMatch(
  patternKey: string,
  matchText: string,
  postFilter: ((match: string) => boolean) | undefined,
): boolean {
  if (!postFilter) return true;
  try {
    return postFilter(matchText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[search_patterns] postFilter for "${patternKey}" threw: ${msg} — keeping match (fail-open)`,
    );
    return true;
  }
}

type CodeIndex = NonNullable<Awaited<ReturnType<typeof getCodeIndex>>>;
type IndexedSymbol = CodeIndex["symbols"][number];
type IndexedFileEntry = CodeIndex["files"][number];

interface SearchPatternOptions {
  file_pattern?: string | undefined;
  include_tests?: boolean | undefined;
  max_results?: number | undefined;
}

interface SearchPatternSettings {
  includeTests: boolean;
  maxResults: number;
  filePattern?: string;
}

interface PatternExecutionConfig {
  key: string;
  regex: RegExp;
  patternName: string;
  fileExcludePattern?: RegExp;
  fileIncludePattern?: RegExp;
  postFilter?: (match: string) => boolean;
  preprocess?: "strip-comments-strings";
}

interface PatternSearchContext {
  index: CodeIndex;
  config: PatternExecutionConfig;
  settings: SearchPatternSettings;
  matches: PatternMatch[];
  scanned: number;
}

interface PatternScanStrategy {
  name: "symbols" | "files";
  shouldRun: (context: PatternSearchContext) => boolean;
  scan: (context: PatternSearchContext) => Promise<void> | void;
}

type SymbolScanFilter = (sym: IndexedSymbol, context: PatternSearchContext) => boolean;
type FileScanFilter = (fileEntry: IndexedFileEntry, context: PatternSearchContext) => boolean;

const SYMBOL_SCAN_FILTERS: readonly SymbolScanFilter[] = [
  (sym) => Boolean(sym.source),
  (sym, { settings }) => settings.includeTests || !isTestFile(sym.file),
  (sym, { settings }) => !settings.filePattern || sym.file.includes(settings.filePattern),
  (sym, { config }) => !config.fileExcludePattern?.test(sym.file),
  (sym, { config }) => !config.fileIncludePattern || config.fileIncludePattern.test(sym.file),
];

const FILE_SCAN_FILTERS: readonly FileScanFilter[] = [
  (fileEntry, { config }) => config.fileIncludePattern?.test(fileEntry.path) === true,
  (fileEntry, { settings }) => !settings.filePattern || fileEntry.path.includes(settings.filePattern),
  (fileEntry, { config }) => !config.fileExcludePattern?.test(fileEntry.path),
  (fileEntry, { matches }) => !matches.some((match) => match.file === fileEntry.path),
];

function normalizeSearchPatternOptions(options: SearchPatternOptions | undefined): SearchPatternSettings {
  return {
    includeTests: options?.include_tests ?? false,
    maxResults: options?.max_results ?? 50,
    ...(options?.file_pattern ? { filePattern: options.file_pattern } : {}),
  };
}

function resolvePatternConfig(pattern: string): PatternExecutionConfig {
  const builtin = BUILTIN_PATTERNS[pattern];
  if (builtin) {
    return {
      key: pattern,
      regex: builtin.regex,
      patternName: `${pattern}: ${builtin.description}`,
      ...(builtin.fileExcludePattern ? { fileExcludePattern: builtin.fileExcludePattern } : {}),
      ...(builtin.fileIncludePattern ? { fileIncludePattern: builtin.fileIncludePattern } : {}),
      ...(builtin.postFilter ? { postFilter: builtin.postFilter } : {}),
      ...(builtin.preprocess ? { preprocess: builtin.preprocess } : {}),
    };
  }

  try {
    return {
      key: pattern,
      regex: new RegExp(pattern),
      patternName: pattern,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid regex pattern: ${msg}`);
  }
}

function hasMatchCapacity(context: PatternSearchContext): boolean {
  return context.matches.length < context.settings.maxResults;
}

function sourceForPatternScan(source: string, preprocess: PatternExecutionConfig["preprocess"]): string {
  return preprocess === "strip-comments-strings"
    ? stripCommentsAndStrings(source)
    : source;
}

function findAcceptedMatch(config: PatternExecutionConfig, source: string): RegExpExecArray | null {
  const scanSource = sourceForPatternScan(source, config.preprocess);
  const match = config.regex.exec(scanSource);
  if (!match) return null;
  return shouldKeepPostFilterMatch(config.key, match[0], config.postFilter) ? match : null;
}

function matchLineNumber(source: string, matchIndex: number): number {
  return source.slice(0, matchIndex).split("\n").length;
}

function matchedLineText(source: string, match: RegExpExecArray): string {
  const lineEnd = source.indexOf("\n", match.index);
  const originalLine = source.slice(match.index, lineEnd === -1 ? source.length : lineEnd);
  return originalLine.length > 0 ? originalLine : match[0].split("\n")[0]!;
}

function shouldScanSymbol(sym: IndexedSymbol, context: PatternSearchContext): boolean {
  return SYMBOL_SCAN_FILTERS.every((filter) => filter(sym, context));
}

function toSymbolPatternMatch(sym: IndexedSymbol, config: PatternExecutionConfig): PatternMatch | undefined {
  if (!sym.source) return undefined;

  const match = findAcceptedMatch(config, sym.source);
  if (!match) return undefined;

  const linesBefore = matchLineNumber(sym.source, match.index);
  return {
    name: sym.name,
    kind: sym.kind,
    file: sym.file,
    start_line: sym.start_line + linesBefore - 1,
    end_line: sym.end_line,
    matched_pattern: config.patternName,
    context: matchedLineText(sym.source, match).trim().slice(0, 200),
  };
}

function shouldScanFile(fileEntry: IndexedFileEntry, context: PatternSearchContext): boolean {
  return FILE_SCAN_FILTERS.every((filter) => filter(fileEntry, context));
}

async function readIndexedFile(index: CodeIndex, fileEntry: IndexedFileEntry): Promise<string | undefined> {
  try {
    return await readFile(join(index.root, fileEntry.path), "utf-8");
  } catch {
    return undefined;
  }
}

function toFilePatternMatch(
  fileEntry: IndexedFileEntry,
  content: string,
  config: PatternExecutionConfig,
): PatternMatch | undefined {
  const match = findAcceptedMatch(config, content);
  if (!match) return undefined;

  const linesBefore = matchLineNumber(content, match.index);
  return {
    name: fileEntry.path.split("/").pop() ?? fileEntry.path,
    kind: "function" as SymbolKind, // file-level match has no symbol kind
    file: fileEntry.path,
    start_line: linesBefore,
    end_line: linesBefore,
    matched_pattern: config.patternName,
    context: matchedLineText(content, match).trim().slice(0, 200),
  };
}

function scanSymbolEntry(context: PatternSearchContext, sym: IndexedSymbol): PatternMatch | undefined {
  if (!shouldScanSymbol(sym, context)) return undefined;

  context.scanned++;
  return toSymbolPatternMatch(sym, context.config);
}

async function scanFileEntry(
  context: PatternSearchContext,
  fileEntry: IndexedFileEntry,
): Promise<PatternMatch | undefined> {
  if (!shouldScanFile(fileEntry, context)) return undefined;

  const content = await readIndexedFile(context.index, fileEntry);
  if (content === undefined) return undefined;

  context.scanned++;
  return toFilePatternMatch(fileEntry, content, context.config);
}

function scanIndexedSymbols(context: PatternSearchContext): void {
  for (const sym of context.index.symbols) {
    if (!hasMatchCapacity(context)) return;

    const match = scanSymbolEntry(context, sym);
    if (match) context.matches.push(match);
  }
}

async function scanIndexedFiles(context: PatternSearchContext): Promise<void> {
  for (const fileEntry of context.index.files) {
    if (!hasMatchCapacity(context)) return;

    const match = await scanFileEntry(context, fileEntry);
    if (match) context.matches.push(match);
  }
}

const PATTERN_SCAN_STRATEGIES: readonly PatternScanStrategy[] = [
  {
    name: "symbols",
    shouldRun: () => true,
    scan: scanIndexedSymbols,
  },
  {
    name: "files",
    shouldRun: ({ config }) => config.fileIncludePattern !== undefined,
    scan: scanIndexedFiles,
  },
];

/**
 * Search for structural code patterns across indexed symbols.
 * Supports built-in patterns (by name) or custom regex.
 */
export async function searchPatterns(
  repo: string,
  pattern: string,
  options?: SearchPatternOptions,
): Promise<PatternResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const context: PatternSearchContext = {
    index,
    config: resolvePatternConfig(pattern),
    settings: normalizeSearchPatternOptions(options),
    matches: [],
    scanned: 0,
  };

  for (const strategy of PATTERN_SCAN_STRATEGIES) {
    if (!hasMatchCapacity(context)) break;
    if (strategy.shouldRun(context)) await strategy.scan(context);
  }

  return {
    matches: context.matches,
    pattern: context.config.patternName,
    scanned_symbols: context.scanned,
  };
}

/**
 * List all available built-in patterns.
 */
export function listPatterns(): Array<{
  name: string;
  description: string;
  fileExcludePattern?: string;
  fileIncludePattern?: string;
}> {
  return Object.entries(BUILTIN_PATTERNS).map(([name, p]) => ({
    name,
    description: p.description,
    ...(p.fileExcludePattern ? { fileExcludePattern: p.fileExcludePattern.source } : {}),
    ...(p.fileIncludePattern ? { fileIncludePattern: p.fileIncludePattern.source } : {}),
  }));
}
