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

function formatSemanticResults(results: Array<{ symbol: { file: string; start_line: number; kind: string; name: string; signature?: string; source?: string } }>): string {
  if (results.length === 0) return "(no results)";
  return results.map((r) => {
    const s = r.symbol;
    const header = `${s.file}:${s.start_line} ${s.kind} ${s.name}${s.signature ? ` ${s.signature}` : ""}`;
    return s.source ? `${header}\n${s.source}` : header;
  }).join("\n\n");
}

// ---------------------------------------------------------------------------
// Shared semantic context loader (CQ14 — eliminates duplication)
// ---------------------------------------------------------------------------

interface SemanticContext {
  config: ReturnType<typeof import("../config.js").loadConfig>;
  provider: { embed: (texts: string[]) => Promise<number[][]> };
  vecs: number[][];
  repoMeta: { index_path: string } | null;
  chunks: Map<string, CodeChunk> | null;
  /** The published chunk vector file, when the repo has chunks. */
  chunkVectorPath: string | undefined;
  /** The chunk vectors as a TypeScript map — loaded only when the native set cannot answer. */
  loadChunkEmbeddings: () => Promise<Map<string, Float32Array> | null>;
  chunkFileLookup: Map<string, string | undefined>;
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
  const { loadChunks, getChunkPath, getChunkEmbeddingPath, resolveChunkIndexPaths } =
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
  const vecs = await withTimeout(provider.embed(subQueryTexts, "query"), EMBED_TIMEOUT_MS, "Embedding API");

  const repoMeta = await getRepo(config.registryPath, repo);
  let chunks: Map<string, CodeChunk> | null = null;
  let chunkVectorPath: string | undefined;
  let loadChunkEmbeddings = async (): Promise<Map<string, Float32Array> | null> => null;

  if (repoMeta) {
    // Chunk embeddings come from the cache, not a fresh parse. This call used to re-read and
    // re-parse the whole ndjson on EVERY query: 958–1,208 ms and a +686 MB RSS spike each time,
    // 87% of the query's wall clock, for a file that had not changed since the previous question.
    // The cosine similarity the query exists to compute was 2%.
    const { getChunkEmbeddingCache } = await import("../tools/index-tools/registry.js");
    const chunkPath = getChunkPath(repoMeta.index_path);
    const activePaths = await resolveChunkIndexPaths(
      chunkPath,
      getChunkEmbeddingPath(repoMeta.index_path),
    );
    chunkVectorPath = activePaths.embeddings;
    let cached: Promise<Map<string, Float32Array> | null> | undefined;
    loadChunkEmbeddings = () => (cached ??= getChunkEmbeddingCache(repo, activePaths.embeddings));
    chunks = await loadChunks(chunkPath, activePaths.chunks);
  }

  const chunkFileLookup = chunks
    ? new Map([...chunks.entries()].map(([id, c]) => [id, c.file]))
    : new Map<string, string | undefined>();

  return {
    config, provider, vecs, repoMeta,
    chunks, chunkVectorPath, loadChunkEmbeddings, chunkFileLookup,
    topK, fileFilter, excludeTests, cosineSimilarity,
  };
}

/** Whether the stored vectors were made by the active model (a missing meta is not a mismatch). */
async function storedModelMatches(ctx: SemanticContext): Promise<boolean> {
  if (!ctx.repoMeta || !ctx.config.embeddingProvider) return true;
  const { getEmbeddingMetaPath, loadEmbeddingMeta } = await import("../storage/embedding-store.js");
  const { expectedEmbeddingModel } = await import("../search/semantic.js");
  const meta = await loadEmbeddingMeta(getEmbeddingMetaPath(ctx.repoMeta.index_path));
  if (!meta) return true;
  return meta.model === expectedEmbeddingModel(ctx.config.embeddingProvider, ctx.config.localModel, ctx.config.ollamaModel);
}

/**
 * The chunk ranking — `computeRRFScores` over the sub-query vectors, then `extra` (a hybrid query's
 * text matches) added in order, then the stable top-K cut — from the native set when it can answer,
 * else from the TypeScript map. `dims` is the stored width; null when the repo has no usable chunk
 * vectors (the caller falls back to symbol-level search).
 */
async function rankChunks(
  repo: string,
  ctx: SemanticContext,
  extra: ReadonlyArray<readonly [string, number]>,
): Promise<{ ids: string[]; dims: number } | null> {
  if (!ctx.chunks) return null;
  const queries = ctx.vecs.filter((v): v is number[] => Boolean(v)).map((v) => new Float32Array(v));
  const { localEmbeddingsDisabled } = await import("../config.js");
  if (ctx.chunkVectorPath && !localEmbeddingsDisabled() && (await storedModelMatches(ctx))) {
    const { rankNativeRrf, chunkSetKey } = await import("../search/native-vectors.js");
    const chunks = ctx.chunks;
    const native = await rankNativeRrf({
      set: chunkSetKey(repo),
      vectorPath: ctx.chunkVectorPath,
      // The query reads chunks and vectors of one generation, which share their ids even in a clone.
      rebase: null,
      listFiles: async () => ({ ids: [...chunks.keys()], files: [...chunks.values()].map((c) => c.file) }),
      queries,
      topK: ctx.topK,
      contains: ctx.fileFilter,
      excludeTests: ctx.excludeTests,
      extra,
    });
    if (native) return native;
  }

  const embeddings = await ctx.loadChunkEmbeddings();
  if (!embeddings) return null;
  const { detectDimensionMismatch } = await import("../search/semantic.js");
  const queryDim = queries[0]?.length ?? 0;
  const dims = (queryDim > 0 ? detectDimensionMismatch(queryDim, embeddings)?.storedDim : undefined) ?? queryDim;
  const filtered = filterEmbeddingsByFile(embeddings, ctx.chunkFileLookup, ctx.fileFilter, ctx.excludeTests);
  const rrfScores = computeRRFScores(ctx.vecs, filtered, ctx.cosineSimilarity);
  for (const [id, score] of extra) rrfScores.set(id, (rrfScores.get(id) ?? 0) + score);
  const ids = [...rrfScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, ctx.topK)
    .map(([id]) => id);
  return { ids, dims };
}

/**
 * The symbol-level ranking through the native vector set, or null when it cannot answer (no core, no
 * vector file, vectors of another model, a failed load) — null means the TypeScript path below.
 */
async function nativeSymbolSearch(
  repo: string,
  ctx: SemanticContext,
  query: Float32Array,
): Promise<{ hits: Array<{ id: string; score: number }>; dims: number } | null> {
  if (!ctx.repoMeta) return null;
  const { localEmbeddingsDisabled } = await import("../config.js");
  if (localEmbeddingsDisabled()) return null;
  // Vectors of another model are incomparable: the TypeScript path refuses them with the message that
  // says so, so leave it to that path.
  if (!(await storedModelMatches(ctx))) return null;
  const { getEmbeddingPath, idRebaseFor, currentEmbeddingFile } = await import("../storage/embedding-store.js");
  const indexPath = ctx.repoMeta.index_path;
  const embeddingPath = getEmbeddingPath(indexPath);
  const vectorPath = currentEmbeddingFile(embeddingPath);
  if (!vectorPath) return null;
  const { readFileSync } = await import("node:fs");
  const { searchNativeVectors } = await import("../search/native-vectors.js");
  const { findRepoSymbols } = await import("../tools/index-tools.js");
  return searchNativeVectors({
    set: repo,
    vectorPath,
    // Keyed by the ndjson name, whichever file holds the vectors: it locates the meta.
    rebase: idRebaseFor(embeddingPath, (p) => readFileSync(p, "utf-8")),
    listFiles: async () => {
      const symbols = await findRepoSymbols(repo, { withSource: false }, { skipFreshness: true });
      return { ids: symbols.map((s) => s.id), files: symbols.map((s) => s.file) };
    },
    filesVersion: async () => {
      const { resolveIndexBackend, sqlitePathFor } = await import("../storage/index-migration.js");
      if ((await resolveIndexBackend()) !== "sqlite") return 0;
      const { getDataVersion } = await import("../storage/sqlite/accessors.js");
      return getDataVersion(sqlitePathFor(indexPath));
    },
    query,
    topK: ctx.topK,
    contains: ctx.fileFilter,
    excludeTests: ctx.excludeTests,
  });
}

// ---------------------------------------------------------------------------
// Semantic query handler
// ---------------------------------------------------------------------------

export async function handleSemanticQuery(
  repo: string,
  query: Extract<SubQuery, { type: "semantic" }>,
): Promise<SubQueryResult> {
  const ctx = await loadSemanticContext(repo, query);

  const { detectDimensionMismatch, dimensionMismatchMessage } = await import("../search/semantic.js");
  const queryDim = ctx.vecs[0]?.length ?? 0;

  // Chunk-level semantic search (preferred path)
  const rankedChunks = ctx.chunks ? await rankChunks(repo, ctx, []) : null;
  if (ctx.chunks && rankedChunks) {
    if (queryDim > 0 && rankedChunks.dims !== queryDim) {
      const text = dimensionMismatchMessage(queryDim, rankedChunks.dims);
      return { type: "semantic", data: text, tokens: estimateTokens(text) };
    }
    const topIds = rankedChunks.ids;

    let finalIds = topIds;
    if (query.rerank) {
      const { rerankChunkIds } = await import("../search/reranker.js");
      finalIds = await rerankChunkIds(query.query, topIds, ctx.chunks);
    }

    const text = formatChunksAsText(finalIds, ctx.chunks, false);
    return { type: "semantic", data: text, tokens: estimateTokens(text) };
  }

  // Fall back to symbol-level semantic search
  const { findRepoSymbols, getEmbeddingCache, getIndexSummary } = await import("../tools/index-tools.js");
  const { searchSemantic } = await import("../search/semantic.js");
  const sourceLimit = query.source_chars ?? DEFAULT_SOURCE_CHARS;

  const primaryVec = ctx.vecs[0];
  if (!primaryVec) throw new Error("Embedding provider returned no vector");

  // The vectors in Rust memory when the core is there: same ranking, bit for bit, without parsing the
  // vector file on this thread or holding it in the V8 heap (search/native-vectors.ts).
  const native = await nativeSymbolSearch(repo, ctx, new Float32Array(primaryVec));
  if (native) {
    if (native.dims !== primaryVec.length) {
      const text = dimensionMismatchMessage(primaryVec.length, native.dims);
      return { type: "semantic", data: text, tokens: estimateTokens(text) };
    }
    const ids = native.hits.map((h) => h.id);
    const byId = new Map(
      (ids.length > 0 ? await findRepoSymbols(repo, { ids, withSource: true }, { skipFreshness: true }) : [])
        .map((s) => [s.id, s]),
    );
    const found = ids.flatMap((id) => {
      const symbol = byId.get(id);
      return symbol ? [{ symbol: truncateSymbolSource(symbol, sourceLimit) }] : [];
    });
    const text = formatSemanticResults(found);
    return { type: "semantic", data: text, tokens: estimateTokens(text) };
  }

  // Every symbol's id and file (no source) for the filter and the ranking; source is read only for
  // the few results shown (ADR-004 stage 2 — this loaded the whole index).
  const summary = await getIndexSummary(repo);
  if (!summary) throw new Error(`Repository "${repo}" not found`);
  const index = { symbols: await findRepoSymbols(repo, { withSource: false }, { skipFreshness: true }) };

  const embeddings = await getEmbeddingCache(repo);
  if (!embeddings) {
    throw new Error(
      `No usable embeddings for "${repo}". Either none were built, or they were built with a ` +
      `different embedding model than the one now active (a model change makes stored vectors ` +
      `incomparable — see the server log). Re-index the repo to rebuild them with the current model.`,
    );
  }

  const symbolMap = new Map(index.symbols.map((s) => [s.id, s]));
  const symFileLookup = new Map([...symbolMap.entries()].map(([id, s]) => [id, s.file]));
  const filteredEmbeddings = filterEmbeddingsByFile(embeddings, symFileLookup, ctx.fileFilter, ctx.excludeTests);

  const symbolMismatch = detectDimensionMismatch(primaryVec.length, filteredEmbeddings);
  if (symbolMismatch) {
    const text = dimensionMismatchMessage(primaryVec.length, symbolMismatch.storedDim);
    return { type: "semantic", data: text, tokens: estimateTokens(text) };
  }

  const ranked = searchSemantic(new Float32Array(primaryVec), filteredEmbeddings, symbolMap, ctx.topK);
  const withSource = new Map(
    (ranked.length > 0
      ? await findRepoSymbols(repo, { ids: ranked.map((r) => r.symbol.id), withSource: true }, { skipFreshness: true })
      : []
    ).map((s) => [s.id, s]),
  );
  // Both maps are keyed by id and filled in index order, so an id shared by two symbols resolves to
  // the same (last) one in each.
  const results = ranked.map((r) => ({ ...r, symbol: withSource.get(r.symbol.id) ?? r.symbol }));
  // Truncate source then format as text (avoid double JSON serialization)
  const truncated = results.map((r) => ({ ...r, symbol: truncateSymbolSource(r.symbol, sourceLimit) }));
  const text = formatSemanticResults(truncated);
  return { type: "semantic", data: text, tokens: estimateTokens(text) };
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
  if (!ctx.chunks) throw new Error(`No chunk index for "${repo}"`);

  // Text match RRF contributions — map match line -> covering chunk. Added after the semantic fusion,
  // in match order (rankChunks), which is the order the scores accumulate in.
  const extra: Array<[string, number]> = [];
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
    // Binary search for covering chunk (list is sorted by startLine)
    let lo = 0, hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const chunk = list[mid]!;
      if (chunk.endLine < match.line) {
        lo = mid + 1;
      } else if (chunk.startLine > match.line) {
        hi = mid - 1;
      } else {
        extra.push([chunk.id, 1 / (RRF_K + rank + 1)]);
        break;
      }
    }
  }

  const ranked = await rankChunks(repo, ctx, extra);
  if (!ranked) throw new Error(`No chunk index for "${repo}"`);
  let topIds = ranked.ids;

  if (query.rerank) {
    const { rerankChunkIds } = await import("../search/reranker.js");
    topIds = await rerankChunkIds(query.query, topIds, ctx.chunks);
  }

  const hybridText = formatChunksAsText(topIds, ctx.chunks, ctx.excludeTests);
  return { type: "hybrid", data: hybridText, tokens: estimateTokens(hybridText) };
}
