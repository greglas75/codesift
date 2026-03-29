import type { CodeChunk } from "../types.js";
import { isTestFile } from "../utils/test-file.js";
import type { SubQuery, SubQueryResult } from "./retrieval-schemas.js";
import {
  estimateTokens,
  filterEmbeddingsByFile,
  computeRRFScores,
  formatChunksAsText,
  decomposeQuery,
  truncateSymbolSource,
  withTimeout,
} from "./retrieval-utils.js";
import { DEFAULT_TOP_K, DEFAULT_SOURCE_CHARS, EMBED_TIMEOUT_MS, RRF_K } from "./retrieval-constants.js";

// ---------------------------------------------------------------------------
// Shared semantic context loader (CQ14 — eliminates duplication)
// ---------------------------------------------------------------------------

interface SemanticContext {
  config: ReturnType<typeof import("../config.js").loadConfig>;
  provider: { embed: (texts: string[]) => Promise<number[][]> };
  vecs: number[][];
  repoMeta: { index_path: string } | null;
  chunks: Map<string, CodeChunk> | null;
  chunkEmbeddings: Map<string, Float32Array> | null;
  chunkFileLookup: Map<string, string | undefined>;
  filteredEmbeddings: Map<string, Float32Array>;
  topK: number;
  fileFilter: string | undefined;
  excludeTests: boolean;
  cosineSimilarity: (a: Float32Array, b: Float32Array) => number;
}

async function loadSemanticContext(
  repo: string,
  query: Extract<SubQuery, { type: "semantic" }> | Extract<SubQuery, { type: "hybrid" }>,
): Promise<SemanticContext> {
  const { createEmbeddingProvider, cosineSimilarity } = await import("../search/semantic.js");
  const { loadConfig: getConfig } = await import("../config.js");
  const { getRepo } = await import("../storage/registry.js");
  const { loadChunks, loadChunkEmbeddings, getChunkPath, getChunkEmbeddingPath } =
    await import("../storage/chunk-store.js");

  const config = getConfig();
  if (!config.embeddingProvider) {
    throw new Error(
      "No embedding provider configured. Set CODESIFT_VOYAGE_API_KEY, CODESIFT_OPENAI_API_KEY, or CODESIFT_OLLAMA_URL.",
    );
  }

  const topK = query.top_k ?? DEFAULT_TOP_K;
  const fileFilter = query.file_filter;
  const excludeTests = query.exclude_tests ?? true;

  const provider = createEmbeddingProvider(config.embeddingProvider, config);
  const subQueryTexts = decomposeQuery(query.query);
  const vecs = await withTimeout(provider.embed(subQueryTexts), EMBED_TIMEOUT_MS, "Embedding API");

  const repoMeta = await getRepo(config.registryPath, repo);
  let chunks: Map<string, CodeChunk> | null = null;
  let chunkEmbeddings: Map<string, Float32Array> | null = null;

  if (repoMeta) {
    [chunks, chunkEmbeddings] = await Promise.all([
      loadChunks(getChunkPath(repoMeta.index_path)),
      loadChunkEmbeddings(getChunkEmbeddingPath(repoMeta.index_path)),
    ]);
  }

  const chunkFileLookup = chunks
    ? new Map([...chunks.entries()].map(([id, c]) => [id, c.file]))
    : new Map<string, string | undefined>();

  const sourceEmbeddings = chunkEmbeddings ?? new Map<string, Float32Array>();
  const filteredEmbeddings = filterEmbeddingsByFile(sourceEmbeddings, chunkFileLookup, fileFilter, excludeTests);

  return {
    config, provider, vecs, repoMeta,
    chunks, chunkEmbeddings, chunkFileLookup, filteredEmbeddings,
    topK, fileFilter, excludeTests, cosineSimilarity,
  };
}

// ---------------------------------------------------------------------------
// Semantic query handler
// ---------------------------------------------------------------------------

export async function handleSemanticQuery(
  repo: string,
  query: Extract<SubQuery, { type: "semantic" }>,
): Promise<SubQueryResult> {
  const ctx = await loadSemanticContext(repo, query);

  // Chunk-level semantic search (preferred path)
  if (ctx.chunks && ctx.chunkEmbeddings) {
    const rrfScores = computeRRFScores(ctx.vecs, ctx.filteredEmbeddings, ctx.cosineSimilarity);
    const topIds = [...rrfScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, ctx.topK)
      .map(([id]) => id);

    let finalIds = topIds;
    if (query.rerank) {
      const { rerankChunkIds } = await import("../search/reranker.js");
      finalIds = await rerankChunkIds(query.query, topIds, ctx.chunks);
    }

    const text = formatChunksAsText(finalIds, ctx.chunks, false);
    return { type: "semantic", data: text, tokens: estimateTokens(text) };
  }

  // Fall back to symbol-level semantic search
  const { getCodeIndex, getEmbeddingCache } = await import("../tools/index-tools.js");
  const { searchSemantic } = await import("../search/semantic.js");

  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found`);

  const embeddings = await getEmbeddingCache(repo);
  if (!embeddings) {
    throw new Error(`No embeddings for "${repo}". Run index_folder with an embedding provider configured.`);
  }

  const sourceLimit = query.source_chars ?? DEFAULT_SOURCE_CHARS;
  const symbolMap = new Map(index.symbols.map((s) => [s.id, s]));
  const symFileLookup = new Map([...symbolMap.entries()].map(([id, s]) => [id, s.file]));
  const filteredEmbeddings = filterEmbeddingsByFile(embeddings, symFileLookup, ctx.fileFilter, ctx.excludeTests);

  const primaryVec = ctx.vecs[0];
  if (!primaryVec) throw new Error("Embedding provider returned no vector");

  const results = searchSemantic(new Float32Array(primaryVec), filteredEmbeddings, symbolMap, ctx.topK);
  const data = results.map((r) => truncateSymbolSource(r.symbol, sourceLimit));
  const text = JSON.stringify(data);
  return { type: "semantic", data, tokens: estimateTokens(text) };
}

// ---------------------------------------------------------------------------
// Hybrid query handler (semantic + text, RRF-merged)
// ---------------------------------------------------------------------------

export async function handleHybridQuery(
  repo: string,
  query: Extract<SubQuery, { type: "hybrid" }>,
): Promise<SubQueryResult> {
  const { searchText } = await import("../tools/search-tools.js");

  // Run text search in parallel with semantic context loading (embed + chunk load)
  const [ctx, textMatches] = await Promise.all([
    loadSemanticContext(repo, query),
    searchText(repo, query.query, { file_pattern: query.file_filter }).catch(() => []),
  ]);
  if (!ctx.repoMeta) throw new Error(`Repository "${repo}" not found`);
  if (!ctx.chunks || !ctx.chunkEmbeddings) throw new Error(`No chunk index for "${repo}"`);


  // 1. Semantic RRF contributions
  const rrfScores = computeRRFScores(ctx.vecs, ctx.filteredEmbeddings, ctx.cosineSimilarity);

  // 2. Text match RRF contributions — map match line -> covering chunk
  const fileToChunks = new Map<string, Array<{ id: string; startLine: number; endLine: number }>>();
  for (const [id, chunk] of ctx.chunks) {
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
    if (ctx.excludeTests && isTestFile(match.file)) continue;
    const list = fileToChunks.get(match.file) ?? [];
    for (const chunk of list) {
      if (chunk.startLine <= match.line && match.line <= chunk.endLine) {
        rrfScores.set(chunk.id, (rrfScores.get(chunk.id) ?? 0) + 1 / (RRF_K + rank + 1));
        break;
      }
    }
  }

  let topIds = [...rrfScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, ctx.topK)
    .map(([id]) => id);

  if (query.rerank) {
    const { rerankChunkIds } = await import("../search/reranker.js");
    topIds = await rerankChunkIds(query.query, topIds, ctx.chunks);
  }

  const hybridText = formatChunksAsText(topIds, ctx.chunks, ctx.excludeTests);
  return { type: "hybrid", data: hybridText, tokens: estimateTokens(hybridText) };
}
