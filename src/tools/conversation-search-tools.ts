import { basename } from "node:path";
import { loadIndex, getIndexPath } from "../storage/index-store.js";
import { buildBM25Index, searchBM25, applyCutoff, type BM25Index } from "../search/bm25.js";
import { loadConfig } from "../config.js";
import {
  getConversationBM25Index,
  loadConversationEmbeddingsCached,
  setConversationBM25Index,
} from "./conversation-cache.js";
import {
  getClaudeConversationProjectPath,
  resolveConversationProjectPath,
} from "./conversation-paths.js";
import type { CodeIndex, CodeSymbol } from "../types.js";

export interface ConversationSearchResult {
  session_id: string;
  timestamp: string;
  git_branch: string;
  user_question: string;
  assistant_answer: string;
  score: number;
  file: string;
  turn_index: number;
  project?: string;
}

export interface SearchConversationsResult {
  results: ConversationSearchResult[];
  total_matches: number;
}

/**
 * Map a SearchResult to a ConversationSearchResult with metadata extraction.
 */
function toConversationResult(r: { symbol: CodeSymbol; score: number }, repoName?: string): ConversationSearchResult {
  const sym = r.symbol;
  const source = sym.source ?? "";
  const sepIdx = source.indexOf("\n---\n");
  const assistantAnswer = sepIdx >= 0 ? source.slice(sepIdx + 5, sepIdx + 505) : "";
  const turnMatch = sym.id.match(/:turn_(\d+):/);
  const turnIndex = turnMatch ? parseInt(turnMatch[1]!, 10) : 0;

  // Parse signature for metadata: "timestamp\nuser_text" or "timestamp | branch\nuser_text"
  const sig = sym.signature ?? "";
  const firstNewline = sig.indexOf("\n");
  const metaLine = firstNewline >= 0 ? sig.slice(0, firstNewline) : "";
  const metaParts = metaLine.split(" | ");
  // Check if first part looks like a timestamp (starts with 20)
  const timestamp = metaParts[0]?.startsWith("20") ? metaParts[0] : "";
  const gitBranch = timestamp ? (metaParts[1] ?? "") : "";

  return {
    session_id: sym.parent ?? "",
    timestamp,
    git_branch: gitBranch,
    user_question: sym.name,
    assistant_answer: assistantAnswer,
    score: r.score,
    file: sym.file,
    turn_index: turnIndex,
    ...(repoName ? { project: repoName } : {}),
  };
}

/**
 * Load BM25 index + symbol map for a conversation repo (from cache or disk).
 */
async function loadConversationIndex(rootPath: string): Promise<{
  bm25: BM25Index;
  repoName: string;
  indexPath: string;
  symbols: Map<string, CodeSymbol>;
} | null> {
  const repoName = `conversations/${basename(rootPath)}`;
  const config = loadConfig();
  const indexPath = getIndexPath(config.dataDir, rootPath);

  let bm25 = getConversationBM25Index(repoName);
  let codeIndex: CodeIndex | null = null;

  if (!bm25) {
    try {
      codeIndex = await loadIndex(indexPath);
      if (codeIndex && codeIndex.symbols.length > 0) {
        bm25 = buildBM25Index(codeIndex.symbols);
        setConversationBM25Index(repoName, bm25);
      }
    } catch {
      return null;
    }
  }

  if (!bm25) return null;

  // Build symbol map from BM25 index or loaded index
  const symbols = bm25.symbols;

  return { bm25, repoName, indexPath, symbols };
}

/**
 * Search indexed conversation turns using hybrid BM25 + semantic search.
 *
 * When embeddings are available, fuses BM25 keyword results with semantic
 * similarity via RRF (Reciprocal Rank Fusion). Falls back to BM25-only
 * when no embedding provider is configured.
 */
export async function searchConversations(
  query: string,
  projectPath?: string,
  limit?: number,
  internalOpts?: {
    /** Precomputed query embedding — lets searchAllConversations embed the
     * query once instead of once per conversation repo. */
    queryVec?: Float32Array;
  },
): Promise<SearchConversationsResult> {
  const rootPath = resolveConversationProjectPath(projectPath);
  const loaded = await loadConversationIndex(rootPath);
  if (!loaded) return { results: [], total_matches: 0 };

  const { bm25, repoName, indexPath, symbols } = loaded;
  const config = loadConfig();
  const topK = limit ?? 10;

  // BM25 results
  const bm25Results = searchBM25(bm25, query, topK * 2, config.bm25FieldWeights);
  const bm25Filtered = applyCutoff(bm25Results);

  // Try semantic search if embeddings available
  let semanticResults: Array<{ symbol: CodeSymbol; score: number }> = [];
  if (config.embeddingProvider) {
    try {
      const { createEmbeddingProvider, searchSemantic } = await import("../search/semantic.js");
      const { getEmbeddingPath } = await import("../storage/embedding-store.js");

      const embeddingPath = getEmbeddingPath(indexPath);
      const embeddings = await loadConversationEmbeddingsCached(embeddingPath);

      if (embeddings.size > 0) {
        let qEmb = internalOpts?.queryVec;
        if (!qEmb) {
          const provider = createEmbeddingProvider(config.embeddingProvider, config);
          const [queryVec] = await provider.embed([query], "query");
          if (queryVec) qEmb = new Float32Array(queryVec);
        }
        if (qEmb) {
          semanticResults = searchSemantic(qEmb, embeddings, symbols, topK * 2);
        }
      }
    } catch {
      // Semantic search failed — fall back to BM25 only
    }
  }

  const finalResults = fuseConversationResults(bm25Filtered, semanticResults, topK);
  const results = finalResults.map((r) => toConversationResult(r, repoName));
  return { results, total_matches: results.length };
}

function fuseConversationResults(
  bm25Results: Array<{ symbol: CodeSymbol; score: number }>,
  semanticResults: Array<{ symbol: CodeSymbol; score: number }>,
  topK: number,
): Array<{ symbol: CodeSymbol; score: number }> {
  if (semanticResults.length > 0) {
    const semanticMap = new Map<string, number>();
    for (const r of semanticResults) {
      semanticMap.set(r.symbol.id, r.score);
    }

    // Add semantic similarity as a bonus to BM25 score (scaled to ~20% of BM25 range)
    const maxBm25 = bm25Results.length > 0 ? bm25Results[0]!.score : 1;
    const boosted = bm25Results.map((r) => {
      const semScore = semanticMap.get(r.symbol.id) ?? 0;
      return { symbol: r.symbol, score: r.score + semScore * maxBm25 * 0.2 };
    });

    // Also add semantic-only results not in BM25 (with lower base score)
    for (const r of semanticResults) {
      if (!bm25Results.some((b) => b.symbol.id === r.symbol.id)) {
        boosted.push({ symbol: r.symbol, score: r.score * maxBm25 * 0.15 });
      }
    }

    boosted.sort((a, b) => b.score - a.score);
    return boosted.slice(0, topK);
  }
  return bm25Results.slice(0, topK);
}

/**
 * Search ALL indexed conversation projects at once.
 * Iterates over all `conversations/*` repos in the registry,
 * searches each, merges and re-ranks results.
 */
export async function searchAllConversations(
  query: string,
  limit?: number,
): Promise<SearchConversationsResult & { projects_searched: number }> {
  const { listRepos } = await import("../storage/registry.js");
  const config = loadConfig();
  const repos = await listRepos(config.registryPath);

  const conversationRepos = repos.filter(
    (r) => r.name.startsWith("conversations/") && !r.name.includes("conv-test") && !r.name.includes("conv-ret"),
  );

  // Embed the query ONCE for all repos. Previously each repo embedded the
  // same query independently and the loop was sequential — with ~20+
  // conversation repos that compounded to a p50 of 8.1s per call.
  let queryVec: Float32Array | undefined;
  if (config.embeddingProvider && conversationRepos.length > 0) {
    try {
      const { createEmbeddingProvider } = await import("../search/semantic.js");
      const provider = createEmbeddingProvider(config.embeddingProvider, config);
      const [vec] = await provider.embed([query], "query");
      if (vec) queryVec = new Float32Array(vec);
    } catch {
      // No embed → per-repo searches fall back to BM25-only
    }
  }

  const perRepo = await Promise.all(
    conversationRepos.map(async (repo): Promise<ConversationSearchResult[]> => {
      try {
        const { results } = await searchConversations(
          query,
          repo.root,
          limit ?? 10,
          queryVec ? { queryVec } : {},
        );
        return results.map((r) => ({ ...r, project: repo.name }) as ConversationSearchResult);
      } catch {
        return []; // Skip repos that fail to load
      }
    }),
  );
  const allResults: ConversationSearchResult[] = perRepo.flat();

  // Sort by score descending, take top limit
  allResults.sort((a, b) => b.score - a.score);
  const topK = limit ?? 10;
  const trimmed = allResults.slice(0, topK);

  return {
    results: trimmed,
    total_matches: trimmed.length,
    projects_searched: conversationRepos.length,
  };
}

export interface FindConversationsForSymbolResult {
  symbol: { name: string; file: string; kind: string };
  conversations: ConversationSearchResult[];
  session_count: number;
}

/**
 * Find conversation turns that mention a given symbol name.
 *
 * Resolves the symbol in the code repo first, then searches the matching
 * Claude Code conversation directory for discussions of that symbol.
 */
export async function findConversationsForSymbol(
  symbolName: string,
  repo: string,
  limit?: number,
): Promise<FindConversationsForSymbolResult> {
  let resolvedSymbol = { name: symbolName, file: "", kind: "" };
  let projectPath: string | undefined;

  try {
    const { searchSymbols } = await import("./search-tools.js");
    const symbolResults = await searchSymbols(repo, symbolName, {
      include_source: false,
      detail_level: "compact",
      top_k: 10,
    });
    const bestMatch =
      symbolResults.find((r) => r.symbol.name === symbolName) ??
      symbolResults.find((r) => r.symbol.name.toLowerCase() === symbolName.toLowerCase()) ??
      symbolResults[0];

    if (bestMatch) {
      resolvedSymbol = {
        name: bestMatch.symbol.name,
        file: bestMatch.symbol.file,
        kind: bestMatch.symbol.kind,
      };
    }
  } catch {
    // Fall back to plain-text search using the provided symbol name.
  }

  try {
    const { getRepo } = await import("../storage/registry.js");
    const config = loadConfig();
    const repoMeta = await getRepo(config.registryPath, repo);
    if (repoMeta) {
      projectPath = getClaudeConversationProjectPath(repoMeta.root);
    }
  } catch {
    // Fall back to the current project's conversations if repo lookup fails.
  }

  const { results } = await searchConversations(resolvedSymbol.name, projectPath, limit ?? 5);

  const uniqueSessions = new Set(results.map((r) => r.session_id));

  return {
    symbol: resolvedSymbol,
    conversations: results,
    session_count: uniqueSessions.size,
  };
}
