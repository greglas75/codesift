import { basename } from "node:path";
import { loadIndex, getIndexPath } from "../storage/index-store.js";
import { buildBM25IndexYielding, searchBM25, applyCutoff, type BM25Index } from "../search/bm25.js";
import { loadBM25Index, saveBM25Index } from "../search/bm25-store.js";
import { loadConfig } from "../config.js";
import {
  getConversationBM25Index,
  hasConversationBM25Index,
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

  // Ask the index when it last changed BEFORE trusting a cached build. Without this the first search
  // in a process froze the answer for that process's life — 27 hours in the daemon, during which no
  // conversation recorded since the first call could be found.
  //
  // Only asked when there IS something cached to invalidate. `loadIndexSummary` reads the file table
  // and measures 3.1 ms on a cold connection against 0.6 ms for `loadIndex` itself on an empty
  // conversation repo — so asking unconditionally added ~3.9 s across 1,258 repos to exactly the pass
  // where every one of them misses.
  let indexUpdatedAt = 0;
  if (hasConversationBM25Index(repoName)) {
    try {
      const { loadIndexSummary } = await import("../storage/index-store.js");
      indexUpdatedAt = (await loadIndexSummary(indexPath))?.updated_at ?? 0;
    } catch {
      // Unknown freshness keeps whatever is cached — the conservative direction.
    }
  }

  let bm25 = getConversationBM25Index(repoName, indexUpdatedAt);
  let codeIndex: CodeIndex | null = null;

  if (!bm25) {
    try {
      codeIndex = await loadIndex(indexPath);
      if (codeIndex && codeIndex.symbols.length > 0) {
        // Prefer the persisted index. `loadBM25Index` validates its own header against this exact
        // code index and returns null on any disagreement, so a stale file costs one line of parsing
        // rather than a wrong answer. Measured on the three largest conversation directories here:
        // 4.3x, 20.3x and 12.1x faster than rebuilding.
        bm25 = await loadBM25Index(indexPath, codeIndex);
        if (!bm25) {
          bm25 = await buildBM25IndexYielding(codeIndex.symbols);
          // Written here as well as at index time, because every conversation repo on this machine
          // was already indexed by a build that did not persist one — without this they would only
          // ever get a file on their next re-index.
          //
          // This comment used to claim "a duplicate concurrent write is safe: the writer is
          // temp-then-rename". That was wrong, and the behaviour audit of this release said so:
          // temp-then-rename makes ONE writer atomic, while two writers sharing a temp NAME collide
          // on one inode. The writer's temp name now carries a per-call nonce, which is what actually
          // makes a duplicate concurrent write safe — the rename is last-wins between two COMPLETE
          // files rather than between two halves of an interleaved one.
          try {
            await saveBM25Index(indexPath, bm25, codeIndex);
          } catch {
            // A cache that cannot be written is still a correct search.
          }
        }
        setConversationBM25Index(repoName, bm25, codeIndex.updated_at ?? codeIndex.created_at ?? Date.now());
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
/**
 * Conversation repos searched at once.
 *
 * Four rather than the code path's two: a conversation index is far smaller than a repository index,
 * and the work is dominated by per-repo setup rather than by one large allocation. The point is that
 * the number is BOUNDED and does not grow with how many projects the machine has accumulated.
 * `CODESIFT_CONVERSATION_SEARCH_CONCURRENCY` overrides.
 */
const CONVERSATION_SEARCH_CONCURRENCY = (() => {
  const raw = Number(process.env["CODESIFT_CONVERSATION_SEARCH_CONCURRENCY"]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4;
})();

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

  // Bounded fan-out. This was one `Promise.all` over every conversation repo, written when the
  // comment above said "~20+"; this install has 1,258, so a single call put 1,258 index loads and
  // BM25 builds in flight at once, past the two-at-a-time gate that exists for exactly that on the
  // code path. Measured: 53.7 s and 2,784 MB retained. A worker pool keeps the same total work and
  // the same results while bounding what is resident at any instant.
  const searchOne = async (repo: { name: string; root: string }): Promise<ConversationSearchResult[]> => {
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
  };
  const perRepo: ConversationSearchResult[][] = new Array(conversationRepos.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(CONVERSATION_SEARCH_CONCURRENCY, conversationRepos.length) },
    async () => {
      for (;;) {
        const i = cursor++;
        const repo = conversationRepos[i];
        if (repo === undefined) return;
        perRepo[i] = await searchOne(repo);
      }
    },
  );
  await Promise.all(workers);
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
