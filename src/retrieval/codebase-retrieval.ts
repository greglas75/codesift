import { loadConfig } from "../config.js";
import type { SymbolKind } from "../types.js";
import { isTestFile } from "../utils/test-file.js";
import {
  estimateTokens,
  filterEmbeddingsByFile,
  computeRRFScores,
  formatChunksAsText,
  decomposeQuery,
} from "./retrieval-utils.js";

// Re-export for backward compatibility (tests import from here)
export { estimateTokens, decomposeQuery } from "./retrieval-utils.js";

// Lazy imports to avoid circular dependencies at module load time.
// Each handler imports its dependency on first call.
type SubQueryResult = {
  type: string;
  data: unknown;
  tokens: number;
};

interface SubQuery {
  type: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Semantic + Hybrid handlers (extracted for readability)
// ---------------------------------------------------------------------------

async function handleSemanticQuery(
  repo: string,
  query: SubQuery,
): Promise<SubQueryResult> {
  const { getCodeIndex, getEmbeddingCache } = await import("../tools/index-tools.js");
  const { createEmbeddingProvider, searchSemantic, cosineSimilarity } = await import("../search/semantic.js");
  const { loadConfig: getConfig } = await import("../config.js");
  const { getRepo } = await import("../storage/registry.js");
  const { loadChunks, loadChunkEmbeddings, getChunkPath, getChunkEmbeddingPath } = await import("../storage/chunk-store.js");

  const semanticConfig = getConfig();
  if (!semanticConfig.embeddingProvider) {
    throw new Error("No embedding provider configured. Set CODESIFT_VOYAGE_API_KEY, CODESIFT_OPENAI_API_KEY, or CODESIFT_OLLAMA_URL.");
  }

  const topK = (query["top_k"] as number | undefined) ?? 10;
  const fileFilter = query["file_filter"] as string | undefined;
  const excludeTests = (query["exclude_tests"] as boolean | undefined) ?? true;

  const provider = createEmbeddingProvider(semanticConfig.embeddingProvider, semanticConfig);
  const subQueryTexts = decomposeQuery(query["query"] as string);
  const vecs = await provider.embed(subQueryTexts);

  // Try chunk-level semantic search first
  const repoMeta = await getRepo(semanticConfig.registryPath, repo);
  if (repoMeta) {
    const chunkPath = getChunkPath(repoMeta.index_path);
    const chunkEmbeddingPath = getChunkEmbeddingPath(repoMeta.index_path);
    const [chunks, chunkEmbeddings] = await Promise.all([
      loadChunks(chunkPath),
      loadChunkEmbeddings(chunkEmbeddingPath),
    ]);

    if (chunks && chunkEmbeddings) {
      const chunkFileLookup = new Map([...chunks.entries()].map(([id, c]) => [id, c.file]));
      const filteredEmbeddings = filterEmbeddingsByFile(chunkEmbeddings, chunkFileLookup, fileFilter, excludeTests);

      const rrfScores = computeRRFScores(vecs, filteredEmbeddings, cosineSimilarity);
      const topIds = [...rrfScores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, topK)
        .map(([id]) => id);

      const text = formatChunksAsText(topIds, chunks, false);
      return { type: "semantic", data: text, tokens: estimateTokens(text) };
    }
  }

  // Fall back to symbol-level semantic search when no chunks are indexed
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found`);

  const embeddings = await getEmbeddingCache(repo);
  if (!embeddings) throw new Error(`No embeddings for "${repo}". Run index_folder with an embedding provider configured.`);

  const sourceLimit = (query["source_chars"] as number | undefined) ?? 200;
  const symbolMap = new Map(index.symbols.map((s) => [s.id, s]));

  const symFileLookup = new Map([...symbolMap.entries()].map(([id, s]) => [id, s.file]));
  const filteredEmbeddings = filterEmbeddingsByFile(embeddings, symFileLookup, fileFilter, excludeTests);

  const primaryVec = vecs[0];
  if (!primaryVec) throw new Error("Embedding provider returned no vector");
  const results = searchSemantic(new Float32Array(primaryVec), filteredEmbeddings, symbolMap, topK);
  const data = results.map((r) => {
    const sym = r.symbol;
    return sourceLimit > 0 && sym.source && sym.source.length > sourceLimit
      ? { ...sym, source: sym.source.slice(0, sourceLimit) }
      : sym;
  });
  const text = JSON.stringify(data);
  return { type: "semantic", data, tokens: estimateTokens(text) };
}

async function handleHybridQuery(
  repo: string,
  query: SubQuery,
): Promise<SubQueryResult> {
  const { getRepo } = await import("../storage/registry.js");
  const { loadChunks, loadChunkEmbeddings, getChunkPath, getChunkEmbeddingPath } = await import("../storage/chunk-store.js");
  const { createEmbeddingProvider, cosineSimilarity } = await import("../search/semantic.js");
  const { loadConfig: getConfig } = await import("../config.js");
  const { searchText } = await import("../tools/search-tools.js");

  const hybridConfig = getConfig();
  if (!hybridConfig.embeddingProvider) {
    throw new Error("No embedding provider configured.");
  }

  const topK = (query["top_k"] as number | undefined) ?? 10;
  const fileFilter = query["file_filter"] as string | undefined;
  const excludeTests = (query["exclude_tests"] as boolean | undefined) ?? true;
  const queryText = query["query"] as string;

  const repoMeta = await getRepo(hybridConfig.registryPath, repo);
  if (!repoMeta) throw new Error(`Repository "${repo}" not found`);

  const chunkPath = getChunkPath(repoMeta.index_path);
  const chunkEmbeddingPath = getChunkEmbeddingPath(repoMeta.index_path);

  // Run semantic embedding + text search in parallel
  const provider = createEmbeddingProvider(hybridConfig.embeddingProvider, hybridConfig);
  const subQueryTexts = decomposeQuery(queryText);
  const [chunks, chunkEmbeddings, textMatches, embVecs] = await Promise.all([
    loadChunks(chunkPath),
    loadChunkEmbeddings(chunkEmbeddingPath),
    searchText(repo, queryText, { file_pattern: fileFilter }).catch(() => []),
    provider.embed(subQueryTexts),
  ]);

  if (!chunks || !chunkEmbeddings) throw new Error(`No chunk index for "${repo}"`);

  const chunkFileLookup = new Map([...chunks.entries()].map(([id, c]) => [id, c.file]));
  const filteredEmbeddings = filterEmbeddingsByFile(chunkEmbeddings, chunkFileLookup, fileFilter, excludeTests);

  // 1. Semantic RRF contributions (one pass per decomposed sub-query)
  const rrfScores = computeRRFScores(embVecs, filteredEmbeddings, cosineSimilarity);

  // 2. Text match RRF contributions — map match line -> covering chunk
  const rrfK = 60;
  const fileToChunks = new Map<string, Array<{ id: string; startLine: number; endLine: number }>>();
  for (const [id, chunk] of chunks) {
    const list = fileToChunks.get(chunk.file) ?? [];
    list.push({ id, startLine: chunk.startLine, endLine: chunk.endLine });
    fileToChunks.set(chunk.file, list);
  }
  for (const list of fileToChunks.values()) {
    list.sort((a, b) => a.startLine - b.startLine);
  }

  for (let rank = 0; rank < textMatches.length; rank++) {
    const match = textMatches[rank];
    if (!match) continue;
    if (excludeTests && isTestFile(match.file)) continue;
    const list = fileToChunks.get(match.file) ?? [];
    for (const chunk of list) {
      if (chunk.startLine <= match.line && match.line <= chunk.endLine) {
        rrfScores.set(chunk.id, (rrfScores.get(chunk.id) ?? 0) + 1 / (rrfK + rank + 1));
        break;
      }
    }
  }

  // Top_k by combined RRF score
  const topIds = [...rrfScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id]) => id);

  const hybridText = formatChunksAsText(topIds, chunks, excludeTests);
  return { type: "hybrid", data: hybridText, tokens: estimateTokens(hybridText) };
}

// ---------------------------------------------------------------------------
// Sub-query dispatcher
// ---------------------------------------------------------------------------

async function executeSubQuery(
  repo: string,
  query: SubQuery,
): Promise<SubQueryResult> {
  const qType = query.type;

  switch (qType) {
    case "symbols": {
      const { searchSymbols } = await import("../tools/search-tools.js");
      const results = await searchSymbols(repo, query["query"] as string, {
        kind: query["kind"] as SymbolKind | undefined,
        file_pattern: query["file_pattern"] as string | undefined,
        include_source: true,
        top_k: (query["top_k"] as number | undefined) ?? 5,
      });
      const sourceLimit = (query["source_chars"] as number | undefined) ?? 200;
      const data = results.map((r) => {
        const sym = r.symbol;
        return sourceLimit > 0 && sym.source && sym.source.length > sourceLimit
          ? { ...sym, source: sym.source.slice(0, sourceLimit) }
          : sym;
      });
      const text = JSON.stringify(data);
      return { type: qType, data, tokens: estimateTokens(text) };
    }

    case "text": {
      const { searchText } = await import("../tools/search-tools.js");
      const results = await searchText(repo, query["query"] as string, {
        regex: query["regex"] as boolean | undefined,
        context_lines: query["context_lines"] as number | undefined,
        file_pattern: query["file_pattern"] as string | undefined,
      });
      const text = JSON.stringify(results);
      return { type: qType, data: results, tokens: estimateTokens(text) };
    }

    case "file_tree": {
      const { getFileTree } = await import("../tools/outline-tools.js");
      const result = await getFileTree(repo, {
        path_prefix: (query["path"] ?? query["path_prefix"]) as string | undefined,
        name_pattern: query["name_pattern"] as string | undefined,
        depth: query["depth"] as number | undefined,
        compact: query["compact"] as boolean | undefined,
        min_symbols: query["min_symbols"] as number | undefined,
      });
      const text = JSON.stringify(result);
      return { type: qType, data: result, tokens: estimateTokens(text) };
    }

    case "outline": {
      const { getFileOutline } = await import("../tools/outline-tools.js");
      const result = await getFileOutline(repo, query["file_path"] as string);
      const text = JSON.stringify(result);
      return { type: qType, data: result, tokens: estimateTokens(text) };
    }

    case "references": {
      const { findReferences } = await import("../tools/symbol-tools.js");
      const results = await findReferences(repo, query["symbol_name"] as string);
      const text = JSON.stringify(results);
      return { type: qType, data: results, tokens: estimateTokens(text) };
    }

    case "call_chain": {
      const { traceCallChain } = await import("../tools/graph-tools.js");
      const result = await traceCallChain(
        repo,
        query["symbol_name"] as string,
        (query["direction"] as "callers" | "callees") ?? "callers",
        {
          depth: query["depth"] as number | undefined,
          include_source: (query["include_source"] as boolean | undefined) ?? false,
        },
      );
      const text = JSON.stringify(result);
      return { type: qType, data: result, tokens: estimateTokens(text) };
    }

    case "impact": {
      const { impactAnalysis } = await import("../tools/graph-tools.js");
      const result = await impactAnalysis(
        repo,
        query["since"] as string,
        {
          depth: query["depth"] as number | undefined,
          until: query["until"] as string | undefined,
          include_source: (query["include_source"] as boolean | undefined) ?? false,
        },
      );
      const text = JSON.stringify(result);
      return { type: qType, data: result, tokens: estimateTokens(text) };
    }

    case "context": {
      const { assembleContext } = await import("../tools/context-tools.js");
      const result = await assembleContext(
        repo,
        query["query"] as string,
        query["max_tokens"] as number | undefined,
      );
      const text = JSON.stringify(result);
      return { type: qType, data: result, tokens: estimateTokens(text) };
    }

    case "knowledge_map": {
      const { getKnowledgeMap } = await import("../tools/context-tools.js");
      const result = await getKnowledgeMap(
        repo,
        query["focus"] as string | undefined,
        query["depth"] as number | undefined,
      );
      const text = JSON.stringify(result);
      return { type: qType, data: result, tokens: estimateTokens(text) };
    }

    case "semantic":
      return handleSemanticQuery(repo, query);

    case "hybrid":
      return handleHybridQuery(repo, query);

    default:
      return {
        type: qType,
        data: { error: `Unknown sub-query type: ${qType}` },
        tokens: 50,
      };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CodebaseRetrievalResult {
  results: SubQueryResult[];
  total_tokens: number;
  truncated: boolean;
  query_count: number;
}

export async function codebaseRetrieval(
  repo: string,
  queries: SubQuery[],
  tokenBudget?: number,
): Promise<CodebaseRetrievalResult> {
  const config = loadConfig();
  const budget = tokenBudget ?? config.defaultTokenBudget;
  const maxQueries = 20;

  const limited = queries.slice(0, maxQueries);

  // Execute all sub-queries in parallel
  const subResults = await Promise.all(
    limited.map((q) =>
      executeSubQuery(repo, q).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        return {
          type: q.type,
          data: { error: message },
          tokens: estimateTokens(message),
        } satisfies SubQueryResult;
      }),
    ),
  );

  // Enforce token budget — include results until budget is exceeded
  const results: SubQueryResult[] = [];
  let totalTokens = 0;
  let truncated = false;

  for (const result of subResults) {
    if (totalTokens + result.tokens > budget) {
      truncated = true;
      const remaining = budget - totalTokens;
      if (remaining > 100) {
        const truncatedText = JSON.stringify(result.data).slice(0, remaining * 4);
        let truncatedData: unknown;
        try {
          truncatedData = JSON.parse(truncatedText);
        } catch {
          truncatedData = { partial: true, note: "Result truncated to fit token budget" };
        }
        results.push({
          type: result.type,
          data: truncatedData,
          tokens: remaining,
        });
        totalTokens += remaining;
      }
      break;
    }
    results.push(result);
    totalTokens += result.tokens;
  }

  return {
    results,
    total_tokens: totalTokens,
    truncated,
    query_count: limited.length,
  };
}
