/** Generic indexed pattern execution engine. */
import { readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep, win32 } from "node:path";
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
  sourceOnlyFileScan: boolean;
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
  (fileEntry, { settings }) => settings.includeTests || !isTestFile(fileEntry.path),
  (fileEntry, { config }) => config.fileIncludePattern?.test(fileEntry.path) === true,
  (fileEntry, { settings }) => !settings.filePattern || fileEntry.path.includes(settings.filePattern),
  (fileEntry, { config }) => !config.fileExcludePattern?.test(fileEntry.path),
];

const MAX_PATTERN_RESULTS = 1000;

function normalizeMaxResults(maxResults: number | undefined): number {
  if (maxResults === undefined) return 50;
  if (!Number.isFinite(maxResults) || !Number.isInteger(maxResults) || maxResults <= 0) {
    throw new Error("max_results must be a positive finite integer");
  }
  return Math.min(maxResults, MAX_PATTERN_RESULTS);
}

function normalizeSearchPatternOptions(options: SearchPatternOptions | undefined): SearchPatternSettings {
  return {
    includeTests: options?.include_tests ?? false,
    maxResults: normalizeMaxResults(options?.max_results),
    ...(options?.file_pattern ? { filePattern: options.file_pattern } : {}),
  };
}

function resolvePatternConfig(pattern: string): PatternExecutionConfig {
  const builtin = BUILTIN_PATTERNS[pattern];
  if (builtin) {
    return {
      key: pattern,
      regex: new RegExp(builtin.regex.source, builtin.regex.flags),
      patternName: `${pattern}: ${builtin.description}`,
      sourceOnlyFileScan: true,
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
      sourceOnlyFileScan: false,
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
  const scanSource = preprocess === "strip-comments-strings"
    ? stripCommentsAndStrings(source)
    : source;
  if (scanSource.length !== source.length) {
    throw new Error("Pattern scan preprocessing must preserve source offsets");
  }
  return scanSource;
}

function findAcceptedMatch(
  config: PatternExecutionConfig,
  source: string,
  sourceOnly = false,
): RegExpExecArray | null {
  const scanSource = sourceForPatternScan(source, config.preprocess);
  const scanRegex = sourceOnly && !config.regex.global && !config.regex.sticky
    ? new RegExp(config.regex.source, `${config.regex.flags}g`)
    : config.regex;
  scanRegex.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = scanRegex.exec(scanSource))) {
    if (
      shouldKeepPostFilterMatch(config.key, match[0], config.postFilter)
      && (!sourceOnly || startsInSourceCode(source, match))
    ) {
      return match;
    }
    if (!scanRegex.global && !scanRegex.sticky) return null;
    if (match[0].length === 0) scanRegex.lastIndex++;
  }
  return null;
}

function startsInSourceCode(source: string, match: RegExpExecArray): boolean {
  const sourceWithoutCommentsAndStrings = stripCommentsAndStrings(source);
  const originalStart = source[match.index];
  return originalStart !== undefined
    && originalStart.trim().length > 0
    && sourceWithoutCommentsAndStrings[match.index] === originalStart;
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
  const filePath = resolveIndexedFilePath(index.root, fileEntry.path);
  if (!filePath) {
    console.warn(`[search_patterns] skipped indexed path outside repository root: ${fileEntry.path}`);
    return undefined;
  }

  try {
    const [rootPath, resolvedFilePath] = await Promise.all([
      realpath(index.root),
      realpath(filePath),
    ]);
    if (!isPathWithinRoot(rootPath, resolvedFilePath)) {
      console.warn(`[search_patterns] skipped indexed symlink outside repository root: ${fileEntry.path}`);
      return undefined;
    }
    return await readFile(resolvedFilePath, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[search_patterns] failed to read indexed file ${fileEntry.path}: ${message}`);
    return undefined;
  }
}

/** Resolve an indexed path without allowing reads outside the repository root. */
export function resolveIndexedFilePath(root: string, indexedPath: string): string | undefined {
  if (
    indexedPath.startsWith("/")
    || indexedPath.startsWith("\\")
    || /^[A-Za-z]:/.test(indexedPath)
    || win32.isAbsolute(indexedPath)
  ) {
    return undefined;
  }

  const rootPath = resolve(root);
  const candidate = resolve(rootPath, indexedPath);
  return isPathWithinRoot(rootPath, candidate) ? candidate : undefined;
}

function isPathWithinRoot(rootPath: string, candidate: string): boolean {
  const relativePath = relative(rootPath, candidate);
  return relativePath === ""
    || (
      !win32.isAbsolute(relativePath)
      && !relativePath.startsWith("/")
      && !relativePath.startsWith("\\")
      && relativePath !== ".."
      && !relativePath.startsWith(`..${sep}`)
    );
}

function toFilePatternMatch(
  fileEntry: IndexedFileEntry,
  content: string,
  config: PatternExecutionConfig,
): PatternMatch | undefined {
  const match = findAcceptedMatch(config, content, config.sourceOnlyFileScan);
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
  const match = toFilePatternMatch(fileEntry, content, context.config);
  if (!match) return undefined;

  return context.matches.some(
    (existing) => existing.file === match.file && existing.start_line === match.start_line,
  )
    ? undefined
    : match;
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
