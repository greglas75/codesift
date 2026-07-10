import { CORE_TOOL_NAMES } from "../../register-tools.js";
import type { ToolRecommendation } from "../../search/tool-ranker.js";
import type { CodeIndex } from "../../types.js";
import type { FileRecommendation, ParsedQuery, PlanTurnResult, SymbolRecommendation } from "./types.js";

export const MAX_TOOLS = 10;
export const MAX_SYMBOLS = 20;
export const MAX_FILES = 10;

export function buildUnindexedResult(
  query: string,
  startedAt: number,
  truncated = false,
): PlanTurnResult {
  const indexFolderRecommendation: ToolRecommendation = {
    name: "index_folder",
    confidence: 1.0,
    reasoning: "Repo is not indexed — run index_folder before any query tools",
    is_hidden: !CORE_TOOL_NAMES.has("index_folder"),
  };
  return {
    query,
    truncated,
    confidence: 1.0,
    tools: [indexFolderRecommendation],
    symbols: [],
    files: [],
    reveal_required: indexFolderRecommendation.is_hidden ? [indexFolderRecommendation.name] : [],
    already_used: [],
    metadata: {
      intents_detected: 0,
      bm25_candidates: 0,
      embedding_available: false,
      session_queries_seen: 0,
      duration_ms: Date.now() - startedAt,
      unindexed: true,
      cold_start: true,
      ...(truncated ? { truncated: true } : {}),
    },
  };
}

export function mergeToolRecommendations(
  batches: ToolRecommendation[][],
): ToolRecommendation[] {
  const recommendationsByName = new Map<string, ToolRecommendation>();
  for (const batch of batches) {
    for (const recommendation of batch) {
      const existing = recommendationsByName.get(recommendation.name);
      if (!existing || recommendation.confidence > existing.confidence) {
        recommendationsByName.set(recommendation.name, recommendation);
      }
    }
  }
  return [...recommendationsByName.values()].sort((a, b) => b.confidence - a.confidence);
}

export function collectSymbolRecommendations(
  parsed: ParsedQuery,
  index: CodeIndex,
): SymbolRecommendation[] {
  if (parsed.symbol_refs.length === 0) return [];
  const recommendationsByName = new Map<string, SymbolRecommendation>();
  const wantedNames = new Set(parsed.symbol_refs);
  for (const symbol of index.symbols) {
    if (!wantedNames.has(symbol.name) || recommendationsByName.has(symbol.name)) continue;
    recommendationsByName.set(symbol.name, {
      name: symbol.name,
      file: symbol.file,
      line: symbol.start_line,
      kind: symbol.kind,
      score: 1.0,
    });
    if (recommendationsByName.size >= MAX_SYMBOLS) break;
  }
  return [...recommendationsByName.values()];
}

export function collectFileRecommendations(
  parsed: ParsedQuery,
  index: CodeIndex,
): FileRecommendation[] {
  if (parsed.file_refs.length === 0) return [];
  const recommendations: FileRecommendation[] = [];
  const seen = new Set<string>();
  const wantedFiles = new Set(parsed.file_refs.slice(0, MAX_FILES));
  const indexedFiles = new Set<string>();
  for (const file of index.files) {
    if (wantedFiles.has(file.path)) indexedFiles.add(file.path);
    if (indexedFiles.size === wantedFiles.size) break;
  }
  for (const fileReference of parsed.file_refs) {
    if (seen.has(fileReference)) continue;
    seen.add(fileReference);
    const isIndexed = indexedFiles.has(fileReference);
    recommendations.push({
      path: fileReference,
      score: isIndexed ? 1.0 : 0.5,
      reason: isIndexed ? "explicit file reference" : "referenced in query",
    });
    if (recommendations.length >= MAX_FILES) break;
  }
  return recommendations;
}
