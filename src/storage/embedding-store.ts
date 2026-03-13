import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { EmbeddingMeta } from "../types.js";

/**
 * Get the embedding file path from an index path.
 * {hash}.index.json → {hash}.embeddings.ndjson
 */
export function getEmbeddingPath(indexPath: string): string {
  return indexPath.replace(/\.index\.json$/, ".embeddings.ndjson");
}

/**
 * Get the embedding metadata file path.
 * {hash}.index.json → {hash}.embeddings.meta.json
 */
export function getEmbeddingMetaPath(indexPath: string): string {
  return indexPath.replace(/\.index\.json$/, ".embeddings.meta.json");
}

interface EmbeddingLine {
  id: string;
  vec: number[];
}

/**
 * Load all embeddings from an ndjson file.
 * Returns a Map of symbolId → Float32Array vector.
 */
export async function loadEmbeddings(
  embeddingPath: string,
): Promise<Map<string, Float32Array>> {
  const embeddings = new Map<string, Float32Array>();

  try {
    const raw = await readFile(embeddingPath, "utf-8");
    const lines = raw.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed: unknown = JSON.parse(trimmed);
        const entry = parsed as EmbeddingLine;
        if (entry.id && Array.isArray(entry.vec)) {
          embeddings.set(entry.id, new Float32Array(entry.vec));
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File doesn't exist — return empty
  }

  return embeddings;
}

/**
 * Save all embeddings atomically to an ndjson file.
 */
export async function saveEmbeddings(
  embeddingPath: string,
  embeddings: Map<string, Float32Array>,
): Promise<void> {
  const dir = dirname(embeddingPath);
  await mkdir(dir, { recursive: true });

  const lines: string[] = [];
  for (const [id, vec] of embeddings) {
    lines.push(JSON.stringify({ id, vec: Array.from(vec) }));
  }

  const tmpPath = `${embeddingPath}.tmp.${Date.now()}`;
  const data = lines.join("\n") + "\n";

  try {
    await writeFile(tmpPath, data, "utf-8");
    await rename(tmpPath, embeddingPath);
  } catch (err) {
    try { await unlink(tmpPath); } catch { /* cleanup best-effort */ }
    throw err;
  }
}

/**
 * Save embedding metadata atomically.
 */
export async function saveEmbeddingMeta(
  metaPath: string,
  meta: EmbeddingMeta,
): Promise<void> {
  const dir = dirname(metaPath);
  await mkdir(dir, { recursive: true });

  const tmpPath = `${metaPath}.tmp.${Date.now()}`;
  const data = JSON.stringify(meta);

  try {
    await writeFile(tmpPath, data, "utf-8");
    await rename(tmpPath, metaPath);
  } catch (err) {
    try { await unlink(tmpPath); } catch { /* cleanup best-effort */ }
    throw err;
  }
}

/**
 * Load embedding metadata.
 * Returns null if not found or invalid.
 */
export async function loadEmbeddingMeta(
  metaPath: string,
): Promise<EmbeddingMeta | null> {
  try {
    const raw = await readFile(metaPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    if (
      typeof parsed === "object" && parsed !== null &&
      typeof (parsed as Record<string, unknown>)["model"] === "string" &&
      typeof (parsed as Record<string, unknown>)["dimensions"] === "number"
    ) {
      return parsed as EmbeddingMeta;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Batch-embed symbols using the given provider, appending to existing embeddings.
 * Only embeds symbols that don't already have an embedding.
 *
 * @param symbolTexts - Map of symbolId → text to embed
 * @param existing - Existing embeddings to skip
 * @param embedFn - The provider's embed function
 * @param batchSize - How many texts per API call
 * @returns Map of symbolId → Float32Array (existing + new)
 */
export async function batchEmbed(
  symbolTexts: Map<string, string>,
  existing: Map<string, Float32Array>,
  embedFn: (texts: string[]) => Promise<number[][]>,
  batchSize: number,
): Promise<Map<string, Float32Array>> {
  const result = new Map(existing);

  // Find symbols that need embedding
  const toEmbed: Array<{ id: string; text: string }> = [];
  for (const [id, text] of symbolTexts) {
    if (!existing.has(id)) {
      toEmbed.push({ id, text });
    }
  }

  // Process in batches (only symbols that need embedding)
  for (let i = 0; i < toEmbed.length; i += batchSize) {
    const batch = toEmbed.slice(i, i + batchSize);
    const texts = batch.map((b) => b.text);

    const vectors = await embedFn(texts);

    for (let j = 0; j < batch.length; j++) {
      const entry = batch[j];
      const vec = vectors[j];
      if (entry && vec) {
        result.set(entry.id, new Float32Array(vec));
      }
    }
  }

  // Remove embeddings for symbols that no longer exist in the corpus
  const stale = [...result.keys()].filter((id) => !symbolTexts.has(id));
  for (const id of stale) {
    result.delete(id);
  }

  return result;
}
