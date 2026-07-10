import { getBM25Index } from "../index-tools.js";
import { applyCutoff, searchBM25, type BM25Index } from "../../search/bm25.js";
import { loadConfig } from "../../config.js";
import { matchFilePattern } from "../../utils/glob.js";
import type { CodeSymbol, SearchResult } from "../../types.js";
import {
  BM25_FILTER_MIN_K,
  BM25_FILTER_MULTIPLIER,
  CHARS_PER_TOKEN,
  DEFAULT_SOURCE_CHARS_NARROW,
  DEFAULT_SOURCE_CHARS_WIDE,
  DEFAULT_TOP_K_WITH_SOURCE,
  MAX_SYMBOL_RESULTS,
  SERVER_AUTO_COMPACT_THRESHOLD,
} from "./constants.js";
import type { DetailLevel, SearchSymbolsOptions } from "./types.js";

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

function matchesSymbolFilters(symbol: CodeSymbol, options?: SearchSymbolsOptions): boolean {
  if (options?.kind && symbol.kind !== options.kind) return false;
  if (options?.file_pattern && !matchFilePattern(symbol.file, options.file_pattern)) return false;
  return matchesDecoratorFilter(symbol.decorators, options?.decorator);
}

function compactSearchResults(results: SearchResult[]): SearchResult[] {
  return results.map(({ symbol, score }) => ({
    symbol: {
      id: symbol.id,
      name: symbol.name,
      kind: symbol.kind,
      file: symbol.file,
      start_line: symbol.start_line,
    },
    score,
  })) as SearchResult[];
}

function stripSearchResultSources(results: SearchResult[]): SearchResult[] {
  return results.map(({ symbol: { source: _source, ...symbol }, ...result }) => ({
    ...result,
    symbol: symbol as CodeSymbol,
  }));
}

function resolveSourceCharacterLimit(
  detail: DetailLevel,
  includeSource: boolean,
  options?: Pick<SearchSymbolsOptions, "source_chars" | "file_pattern">,
): number | undefined {
  if (options?.source_chars !== undefined) return options.source_chars;
  if (!includeSource || detail === "full") return undefined;
  return options?.file_pattern ? DEFAULT_SOURCE_CHARS_WIDE : DEFAULT_SOURCE_CHARS_NARROW;
}

function truncateSearchResultSources(results: SearchResult[], sourceChars: number): SearchResult[] {
  return results.map((result) => {
    const source = result.symbol.source;
    if (!source || source.length <= sourceChars) return result;
    return { ...result, symbol: { ...result.symbol, source: `${source.slice(0, sourceChars)}...` } };
  });
}

function cleanSearchResults(results: SearchResult[]): SearchResult[] {
  return results.map(({ symbol: { tokens: _tokens, repo: _repo, ...symbol }, ...result }) => ({
    ...result,
    symbol: symbol as CodeSymbol,
  }));
}

function shapeSearchResults(
  results: SearchResult[],
  detail: DetailLevel,
  includeSource: boolean,
  options?: Pick<SearchSymbolsOptions, "source_chars" | "file_pattern">,
): SearchResult[] {
  if (detail === "compact") return compactSearchResults(results);
  let shaped = includeSource ? results : stripSearchResultSources(results);
  const sourceChars = resolveSourceCharacterLimit(detail, includeSource, options);
  if (sourceChars !== undefined && sourceChars > 0) {
    shaped = truncateSearchResultSources(shaped, sourceChars);
  }
  return cleanSearchResults(shaped);
}

function collectSearchResults(
  index: BM25Index,
  query: string,
  topK: number,
  options: SearchSymbolsOptions | undefined,
  fieldWeights: ReturnType<typeof loadConfig>["bm25FieldWeights"],
): SearchResult[] {
  if (!query.trim()) {
    const results: SearchResult[] = [];
    for (const symbol of index.symbols.values()) {
      if (!matchesSymbolFilters(symbol, options)) continue;
      results.push({ symbol, score: 0 });
      if (results.length >= topK) break;
    }
    return results;
  }
  const hasFilters = !!options?.kind || !!options?.file_pattern || !!options?.decorator;
  const searchTopK = hasFilters ? Math.max(topK * BM25_FILTER_MULTIPLIER, BM25_FILTER_MIN_K) : topK;
  const filtered = searchBM25(index, query, searchTopK, fieldWeights)
    .filter(({ symbol }) => matchesSymbolFilters(symbol, options))
    .slice(0, topK);
  return applyCutoff(filtered);
}

function resolveDetailLevel(
  results: SearchResult[],
  options: SearchSymbolsOptions | undefined,
): DetailLevel {
  if (options?.detail_level) return options.detail_level;
  const shouldCompact = results.length > SERVER_AUTO_COMPACT_THRESHOLD
    && !options?.token_budget
    && options?.include_source !== true;
  return shouldCompact ? "compact" : "standard";
}

function packToTokenBudget(results: SearchResult[], tokenBudget: number): SearchResult[] {
  const packed: SearchResult[] = [];
  let usedTokens = 0;
  for (const result of results) {
    const resultTokens = Math.ceil(JSON.stringify(result).length / CHARS_PER_TOKEN);
    if (usedTokens + resultTokens > tokenBudget) break;
    packed.push(result);
    usedTokens += resultTokens;
  }
  return packed;
}

function resolveTopK(
  configuredTopK: number,
  includeSource: boolean,
  options: SearchSymbolsOptions | undefined,
): number {
  const defaultTopK = includeSource && !options?.file_pattern
    ? DEFAULT_TOP_K_WITH_SOURCE
    : configuredTopK;
  const requestedTopK = options?.top_k ?? defaultTopK;
  if (!Number.isFinite(requestedTopK)) return MAX_SYMBOL_RESULTS;
  return Math.min(Math.max(Math.trunc(requestedTopK), 0), MAX_SYMBOL_RESULTS);
}

async function rerankSearchResults(
  query: string,
  results: SearchResult[],
  enabled: boolean,
): Promise<SearchResult[]> {
  if (!enabled || results.length <= 1) return results;
  const { rerankResults } = await import("../../search/reranker.js");
  return rerankResults(query, results);
}

export async function searchSymbols(
  repo: string,
  query: string,
  options?: SearchSymbolsOptions,
): Promise<SearchResult[]> {
  const index = await getBM25Index(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  const config = loadConfig();
  const includeSource = options?.include_source ?? true;
  const topK = resolveTopK(config.defaultTopK, includeSource, options);
  let results = collectSearchResults(index, query, topK, options, config.bm25FieldWeights);
  results = await rerankSearchResults(query, results, options?.rerank === true);
  const shaped = shapeSearchResults(results, resolveDetailLevel(results, options), includeSource, options);
  const tokenBudget = options?.token_budget;
  if (tokenBudget === undefined || tokenBudget <= 0) return shaped;
  return packToTokenBudget(shaped, tokenBudget);
}
