import { stat } from "node:fs/promises";
import type { BM25Index } from "../search/bm25.js";

const bm25Indexes = new Map<string, BM25Index>();
const embeddingsCache = new Map<string, {
  mtimeMs: number;
  embeddings: Map<string, Float32Array>;
}>();

export function getConversationBM25Index(repoName: string): BM25Index | null {
  return bm25Indexes.get(repoName) ?? null;
}

export function setConversationBM25Index(repoName: string, index: BM25Index): void {
  bm25Indexes.set(repoName, index);
}

export async function loadConversationEmbeddingsCached(
  embeddingPath: string,
): Promise<Map<string, Float32Array>> {
  let mtimeMs = -1;
  try {
    mtimeMs = (await stat(embeddingPath)).mtimeMs;
  } catch {
    // Missing files load as an empty embedding map.
  }
  const cached = embeddingsCache.get(embeddingPath);
  if (cached?.mtimeMs === mtimeMs) return cached.embeddings;
  const { loadEmbeddings } = await import("../storage/embedding-store.js");
  const { embeddingMemBudgetBytes } = await import("../config.js");
  const embeddings = await loadEmbeddings(embeddingPath, embeddingMemBudgetBytes());
  embeddingsCache.set(embeddingPath, { mtimeMs, embeddings });
  return embeddings;
}

export function clearConversationEmbeddingsCacheForTesting(): void {
  embeddingsCache.clear();
}
