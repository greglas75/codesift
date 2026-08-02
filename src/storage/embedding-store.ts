import { readFile } from "node:fs/promises";
import type { EmbeddingMeta } from "../types.js";
import { loadSharedCache, appendSharedCache, contentKey } from "./shared-embedding-cache.js";
import { atomicWriteFile, cleanupOrphanTempFiles } from "./_shared.js";

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
  /**
   * Content hash of the text this vector was produced from.
   *
   * Lives on the SAME line as the vector on purpose. The hashes used to sit in
   * a module-level Map that was never written anywhere, so every fresh process
   * loaded the vectors, found no hashes, and re-embedded the entire corpus —
   * measured at 4,178,280 symbols across 1,587 repos, i.e. 16.5 hours on an M5
   * GPU or 93 on CPU, repeated on every MCP server start. Storing it beside the
   * vector means the two cannot drift apart and costs no extra file or read.
   *
   * Optional: files written before this existed have no `h`, and those entries
   * are simply re-embedded once, which restores the invariant.
   */
  h?: number;
}

/**
 * Load all embeddings from an ndjson file.
 * Returns a Map of symbolId → Float32Array vector.
 */
/**
 * Content hashes read alongside the vectors on the last load of a given path.
 *
 * Keyed by path rather than repo name because that is what the loader knows.
 * Populated as a side effect of `loadEmbeddings` — the data is already on the
 * line, so collecting it costs nothing extra.
 */
const loadedContentHashes = new Map<string, Map<string, number>>();

/** Content hashes that came with the vectors at `embeddingPath`, if any. */
export function contentHashesForPath(embeddingPath: string): Map<string, number> {
  return loadedContentHashes.get(embeddingPath) ?? new Map<string, number>();
}

export async function loadEmbeddings(
  embeddingPath: string,
  maxBytes: number = Number.POSITIVE_INFINITY,
): Promise<Map<string, Float32Array>> {
  const embeddings = new Map<string, Float32Array>();
  const hashes = new Map<string, number>();
  loadedContentHashes.set(embeddingPath, hashes);

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
            // Hashes describe vectors we are dropping; keeping them would let
            // batchEmbed believe those symbols are still covered.
            hashes.clear();
            rl.close();
            stream.destroy();
            resolve();
            return;
          }
          embeddings.set(entry.id, vec);
          if (typeof entry.h === "number") hashes.set(entry.id, entry.h);
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
  hashes?: ReadonlyMap<string, number>,
): Promise<void> {
  // Sweep orphans from earlier runs that were killed mid-write. These files are
  // never overwritten (the name carries a timestamp), so without this they
  // accumulate indefinitely — see cleanupOrphanTempFiles.
  await cleanupOrphanTempFiles(embeddingPath);

  const tmpPath = `${embeddingPath}.tmp.${Date.now()}`;
  const { createWriteStream } = await import("node:fs");
  const stream = createWriteStream(tmpPath, { encoding: "utf-8" });

  // Register error listener immediately to prevent unhandled error crash
  let streamError: Error | null = null;
  stream.on("error", (err) => { streamError = err; });

  try {
    for (const [id, vec] of embeddings) {
      if (streamError) throw streamError;
      const h = hashes?.get(id);
      const line = JSON.stringify(
        h === undefined ? { id, vec: Array.from(vec) } : { id, vec: Array.from(vec), h },
      ) + "\n";
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
 * Seed the in-process hash map for `cacheKey` from what was persisted.
 *
 * This map used to start empty on every process, so `hashes.get(id)` was always
 * undefined, every symbol compared as changed, and the entire corpus was
 * re-embedded on each MCP server start — 4.18M symbols across 1,587 repos, and
 * servers restart once per session.
 */
export function primeContentHashes(cacheKey: string, hashes: ReadonlyMap<string, number>): void {
  if (hashes.size === 0) return;
  const target = embeddingContentHashes.get(cacheKey) ?? new Map<string, number>();
  for (const [id, h] of hashes) if (!target.has(id)) target.set(id, h);
  embeddingContentHashes.set(cacheKey, target);
}

/** Hashes currently known for `cacheKey`, for persisting beside the vectors. */
export function contentHashesFor(cacheKey: string): ReadonlyMap<string, number> {
  return embeddingContentHashes.get(cacheKey) ?? new Map<string, number>();
}

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
  /**
   * Model identity for the cross-repo cache. A vector is a pure function of
   * (model, dimensions, text), so the same text embedded for a second repo can
   * be looked up instead of recomputed — which is what makes indexing a
   * worktree cheap rather than a full duplicate pass. Omitted (CLI paths,
   * tests) disables the shared lookup and behaves exactly as before.
   */
  sharedModel?: { model: string; dimensions: number },
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

  // Cross-repo lookup before calling the model. Half of the symbols still
  // queued for embedding on this machine live in worktrees or temp copies whose
  // text is byte-identical to a repo already embedded; those become a hash
  // lookup here instead of a model call.
  const shared = sharedModel ? await loadSharedCache() : null;
  const freshlyEmbedded: Array<{ key: string; vec: Float32Array }> = [];
  const stillToEmbed: Array<{ id: string; text: string; key?: string }> = [];
  for (const item of toEmbed) {
    if (!shared || !sharedModel) {
      stillToEmbed.push(item);
      continue;
    }
    const key = contentKey(sharedModel.model, sharedModel.dimensions, item.text);
    const hit = shared.get(key);
    if (hit) {
      result.set(item.id, hit);
    } else {
      stillToEmbed.push({ ...item, key });
    }
  }
  toEmbed.length = 0;
  toEmbed.push(...stillToEmbed);

  // Process in batches (only symbols that need embedding)
  for (let i = 0; i < toEmbed.length; i += batchSize) {
    const batch = toEmbed.slice(i, i + batchSize);
    const texts = batch.map((b) => b.text);

    const vectors = await embedFn(texts);

    for (let j = 0; j < batch.length; j++) {
      const entry = batch[j];
      const vec = vectors[j];
      if (entry && vec) {
        const f32 = new Float32Array(vec);
        result.set(entry.id, f32);
        const key = (entry as { key?: string }).key;
        if (key) freshlyEmbedded.push({ key, vec: f32 });
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
  // Publish what was computed so the NEXT repo containing this text — a sibling
  // worktree, a temp copy — gets it for free.
  if (sharedModel) appendSharedCache(freshlyEmbedded);

  return result;
}
