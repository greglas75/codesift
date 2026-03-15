import { loadConfig } from "../config.js";
import type { CodeChunk, SymbolKind } from "../types.js";
import { isTestFile } from "../utils/test-file.js";

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

/**
 * Estimate token count from a string. ~4 chars per token.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Shared helpers for semantic + hybrid cases (CQ14 dedup)
// ---------------------------------------------------------------------------

/**
 * Filter embedding entries by file path substring and/or test file exclusion.
 * Uses a lookup map to resolve the file path for each embedding ID.
 */
function filterEmbeddingsByFile(
  embeddings: Map<string, Float32Array>,
  fileLookup: Map<string, string | undefined>,
  fileFilter: string | undefined,
  excludeTests: boolean,
): Map<string, Float32Array> {
  if (!fileFilter && !excludeTests) return embeddings;
  return new Map([...embeddings.entries()].filter(([id]) => {
    const file = fileLookup.get(id);
    if (!file) return false;
    if (fileFilter && !file.includes(fileFilter)) return false;
    if (excludeTests && isTestFile(file)) return false;
    return true;
  }));
}

/**
 * Compute RRF scores from multiple embedding query vectors against filtered embeddings.
 * Each vector produces a ranked list; scores are accumulated via RRF formula.
 */
function computeRRFScores(
  vecs: number[][],
  filteredEmbeddings: Map<string, Float32Array>,
  cosSim: (a: Float32Array, b: Float32Array) => number,
): Map<string, number> {
  const rrfK = 60;
  const rrfScores = new Map<string, number>();
  for (const vec of vecs) {
    if (!vec) continue;
    const qEmbed = new Float32Array(vec);
    const subScores: Array<{ id: string; score: number }> = [];
    for (const [id, chunkVec] of filteredEmbeddings) {
      if (chunkVec.length === qEmbed.length) {
        subScores.push({ id, score: cosSim(qEmbed, chunkVec) });
      }
    }
    subScores.sort((a, b) => b.score - a.score);
    subScores.forEach((s, rank) => {
      rrfScores.set(s.id, (rrfScores.get(s.id) ?? 0) + 1 / (rrfK + rank + 1));
    });
  }
  return rrfScores;
}

type ChunkEntry = { startLine: number; endLine: number; text: string };

/**
 * Group top chunk IDs by file, merge overlapping/adjacent chunks, and format
 * as numbered plain text sections.
 */
function formatChunksAsText(
  topIds: string[],
  chunks: Map<string, CodeChunk>,
  excludeTests: boolean,
): string {
  const byFile = new Map<string, ChunkEntry[]>();
  for (const id of topIds) {
    const chunk = chunks.get(id);
    if (!chunk) continue;
    if (excludeTests && isTestFile(chunk.file)) continue;
    const existing = byFile.get(chunk.file) ?? [];
    existing.push({ startLine: chunk.startLine, endLine: chunk.endLine, text: chunk.text });
    byFile.set(chunk.file, existing);
  }

  const sections: string[] = ["The following code sections were retrieved:"];
  for (const [file, fileChunks] of byFile) {
    fileChunks.sort((a, b) => a.startLine - b.startLine);
    // Merge overlapping/adjacent chunks to avoid duplicate lines
    const merged: ChunkEntry[] = [];
    for (const chunk of fileChunks) {
      const last = merged[merged.length - 1];
      if (last && chunk.startLine <= last.endLine + 5) {
        if (chunk.endLine > last.endLine) {
          const overlapLines = last.endLine - chunk.startLine + 1;
          const newLines = chunk.text.split("\n").slice(overlapLines);
          last.text = last.text + "\n" + newLines.join("\n");
          last.endLine = chunk.endLine;
        }
      } else {
        merged.push({ startLine: chunk.startLine, endLine: chunk.endLine, text: chunk.text });
      }
    }
    sections.push(`Path: ${file}`);
    for (const chunk of merged) {
      // Add line numbers to each line
      const lines = chunk.text.split("\n");
      const numbered = lines.map((line, i) => {
        const lineNo = String(chunk.startLine + i).padStart(6, " ");
        return `${lineNo}\t${line}`;
      }).join("\n");
      sections.push(numbered);
    }
    sections.push("...");
  }

  return sections.join("\n");
}

/**
 * Execute a single sub-query and return the result with token estimate.
 */
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
      const results = await findReferences(
        repo,
        query["symbol_name"] as string,
      );
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

    case "semantic": {
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

      // Auto-decompose long queries for RRF merging (shared by both paths)
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
          return { type: qType, data: text, tokens: estimateTokens(text) };
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
      return { type: qType, data, tokens: estimateTokens(text) };
    }

    case "hybrid": {
      // Hybrid: semantic embedding search + text/BM25 search, RRF-merged.
      // Benefits: no need to choose semantic vs text — gets best of both.
      const { getRepo: getRepoH } = await import("../storage/registry.js");
      const { loadChunks: loadChunksH, loadChunkEmbeddings: loadChunkEmbeddingsH, getChunkPath: getChunkPathH, getChunkEmbeddingPath: getChunkEmbeddingPathH } = await import("../storage/chunk-store.js");
      const { createEmbeddingProvider: createProviderH, cosineSimilarity: cosSimH } = await import("../search/semantic.js");
      const { loadConfig: getConfigH } = await import("../config.js");
      const { searchText: searchTextH } = await import("../tools/search-tools.js");

      const hybridConfig = getConfigH();
      if (!hybridConfig.embeddingProvider) {
        throw new Error("No embedding provider configured.");
      }

      const topK = (query["top_k"] as number | undefined) ?? 10;
      const fileFilter = query["file_filter"] as string | undefined;
      const excludeTests = (query["exclude_tests"] as boolean | undefined) ?? true;
      const queryText = query["query"] as string;

      const repoMeta = await getRepoH(hybridConfig.registryPath, repo);
      if (!repoMeta) throw new Error(`Repository "${repo}" not found`);

      const chunkPath = getChunkPathH(repoMeta.index_path);
      const chunkEmbeddingPath = getChunkEmbeddingPathH(repoMeta.index_path);

      // Run semantic embedding + text search in parallel
      const provider = createProviderH(hybridConfig.embeddingProvider, hybridConfig);
      const subQueryTexts = decomposeQuery(queryText);
      const [chunks, chunkEmbeddings, textMatches, embVecs] = await Promise.all([
        loadChunksH(chunkPath),
        loadChunkEmbeddingsH(chunkEmbeddingPath),
        searchTextH(repo, queryText, { file_pattern: fileFilter }).catch(() => []),
        provider.embed(subQueryTexts),
      ]);

      if (!chunks || !chunkEmbeddings) throw new Error(`No chunk index for "${repo}"`);

      const chunkFileLookup = new Map([...chunks.entries()].map(([id, c]) => [id, c.file]));
      const filteredEmbeddings = filterEmbeddingsByFile(chunkEmbeddings, chunkFileLookup, fileFilter, excludeTests);

      // 1. Semantic RRF contributions (one pass per decomposed sub-query)
      const rrfScores = computeRRFScores(embVecs, filteredEmbeddings, cosSimH);

      // 2. Text match RRF contributions — map match line -> covering chunk
      // Build file -> sorted-chunks index for efficient line lookup
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
        // Skip text matches from test files when excluding tests
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
      return { type: qType, data: hybridText, tokens: estimateTokens(hybridText) };
    }

    default:
      return {
        type: qType,
        data: { error: `Unknown sub-query type: ${qType}` },
        tokens: 50,
      };
  }
}

/**
 * Split a long query into sub-queries at natural connectors for RRF merging.
 * Queries ≤ 8 words are returned as-is.
 */
function decomposeQuery(query: string): string[] {
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length <= 8) return [query];

  const splitWords = new Set(["and", "or", "from", "to", "with", "using", "for", "via", "then"]);
  const lo = Math.floor(words.length * 0.35);
  const hi = Math.floor(words.length * 0.65);

  for (let i = lo; i <= hi; i++) {
    if (splitWords.has((words[i] ?? "").toLowerCase())) {
      const a = words.slice(0, i).join(" ");
      const b = words.slice(i + 1).join(" ");
      if (a.trim() && b.trim()) return [a, b];
    }
  }

  const mid = Math.floor(words.length / 2);
  return [words.slice(0, mid).join(" "), words.slice(mid).join(" ")];
}

export interface CodebaseRetrievalResult {
  results: SubQueryResult[];
  total_tokens: number;
  truncated: boolean;
  query_count: number;
}

/**
 * Execute multiple sub-queries in a single batched call with shared token budget.
 *
 * Features:
 * - Cross-query deduplication (same symbol in multiple results → included once)
 * - Token budget enforcement
 * - Max 20 sub-queries per call
 * - Parallel execution where queries are independent
 */
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
      // Try to include a truncated version
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
