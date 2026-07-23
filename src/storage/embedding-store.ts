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
  maxBytes: number = Number.POSITIVE_INFINITY,
): Promise<Map<string, Float32Array>> {
  const embeddings = new Map<string, Float32Array>();

  // Stream line-by-line rather than readFile-ing the whole file into one string:
  // embedding files are GB-scale (e.g. 4.5GB), so a single slurp spikes the heap
  // by the full file size at load. readline keeps peak memory to one line plus
  // the resident Float32Array map.
  const { createReadStream, existsSync, statSync } = await import("node:fs");
  const { createInterface } = await import("node:readline");

  // Missing file → empty map (mirrors prior readFile catch). Guarding here avoids
  // an async ENOENT surfacing as an unhandled stream/readline error.
  if (!existsSync(embeddingPath)) return embeddings;

  // HARD memory bound. The streaming above only stops the *file text* from being
  // slurped in one shot — it still built the full resident Float32Array map, so a
  // 5.5 GB embedding file became 5.5 GB of live heap PER REPO, and the cross-repo
  // eviction can never drop the pinned (just-loaded) repo. That is exactly how one
  // MCP server ballooned to 20+ GB. Refuse to hold more than the budget:
  //
  //  1. Cheap up-front skip for files that cannot possibly fit. The ndjson text is
  //     roughly 3x the Float32Array it decodes to (each float is ~12 chars of JSON
  //     vs 4 bytes binary), so only a file several times the budget is hopeless.
  //     The factor is deliberately generous (4x): under-rejecting is free — the
  //     exact resident-byte guard below still bounds memory — while over-rejecting
  //     would refuse repos that comfortably fit and silently kill their semantic
  //     search. Skipping here just avoids streaming a 5 GB file to learn that.
  const FILE_TO_RESIDENT_RATIO = 4;
  try {
    const size = statSync(embeddingPath).size;
    if (size > maxBytes * FILE_TO_RESIDENT_RATIO) {
      console.error(
        `[codesift] embeddings skipped (${(size / 1e9).toFixed(1)} GB > ` +
          `${(maxBytes / 1e6).toFixed(0)} MB budget) — semantic falls back to BM25. ` +
          `Raise CODESIFT_MAX_EMBEDDING_MEM_MB to load it.`,
      );
      return embeddings;
    }
  } catch { /* stat failed — the streaming guard below still bounds resident bytes */ }

  // 2. Streaming guard — bound resident bytes even for a file that stat couldn't
  //    size or whose vectors are unexpectedly wide. A partial map covers an
  //    arbitrary symbol subset (misleading semantic hits), so on overflow we drop
  //    everything and fall back to BM25 rather than serving half an index.
  let residentBytes = 0;
  let overBudget = false;
  await new Promise<void>((resolve) => {
    let stream: import("node:fs").ReadStream;
    try {
      stream = createReadStream(embeddingPath, { encoding: "utf-8" });
    } catch {
      resolve();
      return;
    }
    stream.on("error", () => resolve()); // unreadable mid-stream → return what we have
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("error", () => resolve());
    rl.on("line", (line) => {
      if (overBudget) return;
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const entry = JSON.parse(trimmed) as EmbeddingLine;
        if (entry.id && Array.isArray(entry.vec)) {
          const vec = new Float32Array(entry.vec);
          residentBytes += vec.byteLength + entry.id.length * 2 + 48; // vector + key + Map overhead
          if (residentBytes > maxBytes) {
            overBudget = true;
            embeddings.clear();
            rl.close();
            stream.destroy();
            resolve();
            return;
          }
          embeddings.set(entry.id, vec);
        }
      } catch {
        // Skip malformed lines
      }
    });
    rl.on("close", () => resolve());
  });

  if (overBudget) {
    console.error(
      `[codesift] embeddings skipped (exceeded ${(maxBytes / 1e6).toFixed(0)} MB ` +
        `budget mid-load) — semantic falls back to BM25.`,
    );
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
  const tmpPath = `${embeddingPath}.tmp.${Date.now()}`;
  const { createWriteStream } = await import("node:fs");
  const stream = createWriteStream(tmpPath, { encoding: "utf-8" });

  // Register error listener immediately to prevent unhandled error crash
  let streamError: Error | null = null;
  stream.on("error", (err) => { streamError = err; });

  try {
    for (const [id, vec] of embeddings) {
      if (streamError) throw streamError;
      const line = JSON.stringify({ id, vec: Array.from(vec) }) + "\n";
      const canContinue = stream.write(line);
      if (!canContinue) {
        await new Promise<void>((resolve) => stream.once("drain", resolve));
      }
    }
    if (streamError) throw streamError;
    await new Promise<void>((resolve, reject) => {
      stream.end(() => streamError ? reject(streamError) : resolve());
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

/** Simple hash for content-change detection (FNV-1a 32-bit). */
function contentHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Track content hashes so we re-embed when symbol content changes. */
const embeddingContentHashes = new Map<string, Map<string, number>>();

/**
 * Batch-embed symbols using the given provider, appending to existing embeddings.
 * Skips symbols whose ID exists AND content hash hasn't changed.
 * Re-embeds symbols whose content changed even if ID is the same.
 *
 * @param symbolTexts - Map of symbolId → text to embed
 * @param existing - Existing embeddings to skip
 * @param embedFn - The provider's embed function
 * @param batchSize - How many texts per API call
 * @param cacheKey - Optional key to track content hashes across calls
 * @returns Map of symbolId → Float32Array (existing + new)
 */
export async function batchEmbed(
  symbolTexts: Map<string, string>,
  existing: Map<string, Float32Array>,
  embedFn: (texts: string[]) => Promise<number[][]>,
  batchSize: number,
  cacheKey?: string,
): Promise<Map<string, Float32Array>> {
  const result = new Map(existing);
  const hashes = cacheKey ? (embeddingContentHashes.get(cacheKey) ?? new Map<string, number>()) : new Map<string, number>();

  // Find symbols that need embedding (new or content changed)
  const toEmbed: Array<{ id: string; text: string }> = [];
  for (const [id, text] of symbolTexts) {
    const hash = contentHash(text);
    const needsEmbed = !existing.has(id) || (cacheKey !== undefined && hashes.get(id) !== hash);
    if (needsEmbed) {
      toEmbed.push({ id, text });
    }
    hashes.set(id, hash);
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
    hashes.delete(id);
  }

  if (cacheKey) {
    embeddingContentHashes.set(cacheKey, hashes);
  }

  return result;
}
