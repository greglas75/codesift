import { readFile } from "node:fs/promises";
import type { EmbeddingMeta } from "../types.js";
import { atomicWriteFile } from "./_shared.js";

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
 * Save all embeddings to an ndjson file using streaming writes.
 * Avoids building a single huge string (30K+ symbols × 1536 floats = >300MB).
 */
export async function saveEmbeddings(
  embeddingPath: string,
  embeddings: Map<string, Float32Array>,
): Promise<void> {
  const tmpPath = embeddingPath + ".tmp";
  const { createWriteStream } = await import("node:fs");
  const stream = createWriteStream(tmpPath, { encoding: "utf-8" });

  try {
    for (const [id, vec] of embeddings) {
      const line = JSON.stringify({ id, vec: Array.from(vec) }) + "\n";
      const canContinue = stream.write(line);
      if (!canContinue) {
        await new Promise<void>((resolve) => stream.once("drain", resolve));
      }
    }
    await new Promise<void>((resolve, reject) => {
      stream.end(() => resolve());
      stream.on("error", reject);
    });
    // Atomic rename
    const { rename } = await import("node:fs/promises");
    await rename(tmpPath, embeddingPath);
  } catch (err) {
    // Clean up temp file on error
    try { const { unlink } = await import("node:fs/promises"); await unlink(tmpPath); } catch { /* ignore */ }
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
  const data = JSON.stringify(meta);
  await atomicWriteFile(metaPath, data);
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
