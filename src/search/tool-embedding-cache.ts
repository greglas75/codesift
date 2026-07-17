import { batchEmbed } from "../storage/embedding-store.js";
import { loadConfig } from "../config.js";
import type { ToolDefinition } from "../register-tools.js";
import { createEmbeddingProvider } from "./semantic.js";
import { toolDefsFingerprint } from "./tool-ranker-bm25.js";
import {
  getToolEmbeddingCachePath,
  readToolEmbeddingCache,
  writeToolEmbeddingCache,
} from "./tool-embedding-storage.js";

const TOOL_EMBEDDING_CACHE_KEY = "__tool_descriptions__";

export { getToolEmbeddingCachePath } from "./tool-embedding-storage.js";

export async function getToolEmbeddings(
  definitions: readonly ToolDefinition[],
): Promise<Map<string, number[]> | null> {
  if (definitions.length === 0) return new Map();
  const config = loadConfig();
  if (!config.embeddingProvider) return null;
  const fingerprint = toolDefsFingerprint(definitions);
  const cachePath = getToolEmbeddingCachePath();
  const cached = await readToolEmbeddingCache(cachePath);
  if (cached?.fingerprint === fingerprint) return toEmbeddingMap(cached.embeddings);
  try {
    const provider = createEmbeddingProvider(config.embeddingProvider, config);
    const texts = new Map<string, string>();
    for (const definition of definitions) {
      texts.set(
        definition.name,
        [definition.name, definition.description, definition.searchHint ?? ""].filter(Boolean).join("\n"),
      );
    }
    const result = await batchEmbed(
      texts,
      new Map<string, Float32Array>(),
      (batch) => provider.embed(batch, "document"),
      config.embeddingBatchSize,
      TOOL_EMBEDDING_CACHE_KEY,
    );
    const embeddings: Record<string, number[]> = {};
    for (const [name, vector] of result) embeddings[name] = Array.from(vector);
    await writeToolEmbeddingCache(cachePath, { fingerprint, embeddings });
    return toEmbeddingMap(embeddings);
  } catch {
    return null;
  }
}

function toEmbeddingMap(record: Record<string, number[]>): Map<string, number[]> {
  const output = new Map<string, number[]>();
  for (const [name, vector] of Object.entries(record)) {
    if (Array.isArray(vector)) output.set(name, vector);
  }
  return output;
}
