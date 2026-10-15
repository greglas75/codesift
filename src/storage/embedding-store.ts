import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import type { EmbeddingMeta } from "../types.js";
import { loadSharedCache, appendSharedCache, contentKey } from "./shared-embedding-cache.js";
import { atomicWriteFile, cleanupOrphanTempFiles } from "./_shared.js";
import { readVectorFile, shouldWriteVectorFile, VectorFileError, writeVectorFile } from "./vector-file.js";

/**
 * Get the embedding file path from an index path.
 * {hash}.index.json → {hash}.embeddings.ndjson
 */
export function getEmbeddingPath(indexPath: string): string {
  return indexPath.replace(/\.index\.json$/, ".embeddings.ndjson");
}

/**
 * The binary twin of a `<hash>.embeddings.ndjson` path, `<hash>.embeddings.vec` (vector-file.ts), or
 * null for a path of another shape (the tool-description cache keeps its own ndjson file).
 */
export function vectorFilePathFor(embeddingPath: string): string | null {
  return embeddingPath.endsWith(".embeddings.ndjson")
    ? embeddingPath.replace(/\.embeddings\.ndjson$/, ".embeddings.vec")
    : null;
}

/**
 * The file that holds a repo's vectors now: the `.vec` when there is one, else the ndjson, else null.
 *
 * Never decided by mtime. Every writer of one kind deletes the other (`saveEmbeddings`, the worktree
 * seed's clone), and a clone may or may not carry the donor's mtime (`cp -c`, FICLONE), so "the newer
 * of the two" would pick at random exactly where both can briefly exist.
 */
export function currentEmbeddingFile(embeddingPath: string): string | null {
  const vec = vectorFilePathFor(embeddingPath);
  if (vec && existsSync(vec)) return vec;
  return existsSync(embeddingPath) ? embeddingPath : null;
}

/** Whether the repo has a vector file of either kind. */
export function embeddingFileExists(embeddingPath: string): boolean {
  return currentEmbeddingFile(embeddingPath) !== null;
}

/**
 * Get the embedding metadata file path.
 * {hash}.index.json → {hash}.embeddings.meta.json
 */
export function getEmbeddingMetaPath(indexPath: string): string {
  return indexPath.replace(/\.index\.json$/, ".embeddings.meta.json");
}

/**
 * Vectors an embedding run has computed but not yet folded into the main file.
 * {hash}.index.json → {hash}.embeddings.partial.ndjson
 *
 * The main file is written once, at the end of a run, so any failure before that discarded the
 * whole run. On a ~450k-symbol repo that is hours of model calls, and the daemon log held 1,021
 * failed runs (839 timeouts) — none of which saved a vector. Each finished batch is appended here
 * instead, and the next run starts from it. Same line format as the main file, after one header
 * line naming the model: vectors from another model are not comparable and must not be resumed.
 */
export function getPartialEmbeddingPath(indexPath: string): string {
  return indexPath.replace(/\.index\.json$/, ".embeddings.partial.ndjson");
}

/** Bytes `loadEmbeddings` charges for a map — the same per-entry price, so budgets add up. */
export function residentEmbeddingBytes(embeddings: ReadonlyMap<string, Float32Array>): number {
  let bytes = 0;
  for (const [id, vec] of embeddings) bytes += vec.byteLength + id.length * 2 + 48;
  return bytes;
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

/**
 * The id rewrite recorded beside a CLONED vector file (see `EmbeddingMeta.id_rebase`), or null.
 *
 * Read from the meta file because that is where the seed records it — the vector file itself is a
 * byte-identical clone of the donor's and cannot say whose ids it carries.
 */
export function idRebaseFor(embeddingPath: string, readText: (path: string) => string): { from: string; to: string } | null {
  if (!embeddingPath.endsWith(".embeddings.ndjson")) return null;
  try {
    const meta = JSON.parse(readText(embeddingPath.replace(/\.embeddings\.ndjson$/, ".embeddings.meta.json"))) as {
      id_rebase?: { from?: unknown; to?: unknown };
    };
    const { from, to } = meta.id_rebase ?? {};
    // A prefix is `<repo>:`. An empty `from` would match every id and prefix it twice.
    const isPrefix = (p: unknown): p is string => typeof p === "string" && p.length > 1 && p.endsWith(":");
    return isPrefix(from) && isPrefix(to) && from !== to ? { from, to } : null;
  } catch {
    return null;
  }
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
  const { createReadStream, statSync, readFileSync } = await import("node:fs");
  const { createInterface } = await import("node:readline");

  const rebase = idRebaseFor(embeddingPath, (p) => readFileSync(p, "utf-8"));

  // The binary file when there is one: an exact resident size from its header (no text-to-binary
  // ratio to guess), a checksum, and no parsing.
  const vecPath = vectorFilePathFor(embeddingPath);
  if (vecPath && existsSync(vecPath)) {
    try {
      const read = await readVectorFile(vecPath, { maxBytes, rebase });
      if (read.overBudget) {
        console.error(
          `[codesift] embeddings skipped (above the ${(maxBytes / 1e6).toFixed(0)} MB budget) — ` +
            `semantic falls back to BM25. Raise CODESIFT_MAX_EMBEDDING_MEM_MB to load it.`,
        );
        return embeddings;
      }
      for (const [id, h] of read.hashes) hashes.set(id, h);
      return read.embeddings;
    } catch (err) {
      // A damaged `.vec` is not read; the ndjson it replaced, if one is still there, is the next best
      // copy (`prune` deletes that ndjson only behind a `.vec` that verifies).
      const message = err instanceof VectorFileError || err instanceof Error ? err.message : String(err);
      console.error(`[codesift] ${vecPath}: ${message} — not using it`);
      if (!existsSync(embeddingPath)) return embeddings;
    }
  }

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
          if (rebase && entry.id.startsWith(rebase.from)) entry.id = rebase.to + entry.id.slice(rebase.from.length);
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

/** Remove a file; one that is already gone is fine, any other failure is the caller's. */
export async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
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
  const vecPath = vectorFilePathFor(embeddingPath);
  if (vecPath && shouldWriteVectorFile(embeddings)) {
    await cleanupOrphanTempFiles(vecPath);
    // Halves of ndjson writes from before the switch, too: nothing else will ever sweep them.
    await cleanupOrphanTempFiles(embeddingPath);
    await writeVectorFile(vecPath, embeddings, hashes);
    // The ndjson it replaces would otherwise be read by nothing and reclaimed by nobody.
    await unlink(embeddingPath).catch(() => undefined);
    return;
  }

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
    // A `.vec` beside it would win every read (rollback mode, or vectors of mixed widths), so it goes
    // BEFORE the rename: a crash in between then leaves no vectors (re-embedded) rather than the old
    // ones served as current forever, and a removal that fails fails the save.
    if (vecPath) await unlinkIfPresent(vecPath);
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

/** An embedding id without its trailing `:line` — `repo:file:name` for a symbol, `repo:file` for a chunk. */
function withoutLine(id: string): string {
  const cut = id.lastIndexOf(":");
  return cut > 0 ? id.slice(0, cut) : id;
}

/** Stored vectors keyed by place (id without line) and content hash; only ids with a known hash. */
function vectorsByPlaceAndHash(
  existing: ReadonlyMap<string, Float32Array>,
  hashes: ReadonlyMap<string, number>,
): Map<string, Float32Array> {
  const byPlace = new Map<string, Float32Array>();
  for (const [id, vec] of existing) {
    const h = hashes.get(id);
    if (h !== undefined) byPlace.set(`${withoutLine(id)}\0${h}`, vec);
  }
  return byPlace;
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
/**
 * A failure that says nothing about the INPUT — the request never got an answer.
 * An HTTP 4xx did get one and must not be retried: the model rejected the batch,
 * and sending it again, or in halves, just fails more slowly.
 */
function isTransientStall(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return false;
  if (err instanceof Error && err.name === "AbortError") return false;
  if (err instanceof DOMException && err.name === "TimeoutError") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /aborted|timed? ?out|ECONNRESET|socket hang up|fetch failed|other side closed/i.test(message);
}

/** How many times a stalled batch may be split before the failure is real. */
const MAX_STALL_SPLITS = 4;
/** Below this, splitting buys nothing — a stall on 8 items is not a size problem. */
const MIN_SPLITTABLE_BATCH = 8;

/**
 * Issue one batch, surviving a request that stalls instead of answering.
 *
 * Without this a single stalled request throws all the way out of batchEmbed, the
 * caller logs it, and the ENTIRE repo's pass is discarded — including every batch
 * that already succeeded. Measured 2026-08-10 while re-embedding: ResearchShieldNew
 * lost 1226s of work to one such request, and designer's chunk pass lost 1871s,
 * both after hundreds of healthy batches. With retry in place the same repo
 * finished 379,808 vectors in 65 minutes, having hit two stalls on the way.
 *
 * Halving rather than repeating: a batch that stalled once will usually stall again
 * unchanged, and the halves are also the diagnosis — if one half sails through, the
 * problem was volume, not content.
 */
async function embedBatchWithStallRetry(
  embedFn: (texts: string[]) => Promise<number[][]>,
  texts: string[],
  depth = 0,
): Promise<number[][]> {
  try {
    const vectors = await embedFn(texts);
    if (vectors.length !== texts.length) {
      throw new Error(`embedding provider returned ${vectors.length} vectors for ${texts.length} texts`);
    }
    const dimensions = vectors[0]?.length ?? 0;
    if (dimensions === 0 || vectors.some((vector) =>
      vector.length !== dimensions || vector.some((value) =>
        !Number.isFinite(value) || !Number.isFinite(Math.fround(value))))) {
      throw new Error("embedding provider returned malformed vectors");
    }
    return vectors;
  } catch (err: unknown) {
    if (!isTransientStall(err) || depth >= MAX_STALL_SPLITS || texts.length < MIN_SPLITTABLE_BATCH) {
      throw err;
    }
    const half = Math.ceil(texts.length / 2);
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `[codesift] embed batch of ${texts.length} stalled (${reason}) — retrying as ${half}+${texts.length - half}`,
    );
    const first = await embedBatchWithStallRetry(embedFn, texts.slice(0, half), depth + 1);
    const second = await embedBatchWithStallRetry(embedFn, texts.slice(half), depth + 1);
    // concat, not spread: a batch is small enough that `[...a, ...b]` would be safe, but the
    // argument-stack overflow fixed in this same function is a good reason not to keep the habit.
    return first.concat(second);
  }
}

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
  /**
   * Called with each batch the MODEL produced, as soon as it is produced — so a caller can persist
   * progress that a later failure would otherwise discard. Lookups from the shared cache are not
   * reported: they cost nothing to repeat.
   */
  onBatch?: (entries: Array<{ id: string; vec: Float32Array; h: number | undefined }>) => Promise<void>,
  /**
   * Batches in flight at once. 1 for a model on this machine; a remote API answers each batch in
   * ~1-3 s whatever the load here, so sequential requests made a 498k-symbol repo a 3-hour job.
   */
  concurrency = 1,
): Promise<Map<string, Float32Array>> {
  const result = new Map(existing);
  // A COPY, published only when the run returns: the shared map outlives a failed run in this process,
  // and a hash it holds for a vector that never reached disk makes the next run keep the stale one.
  const hashes = new Map<string, number>(cacheKey ? (embeddingContentHashes.get(cacheKey) ?? []) : []);

  // Find symbols that need embedding (new or content changed)
  const toEmbed: Array<{ id: string; text: string }> = [];
  // The hash a symbol WILL have once its vector exists, committed to `hashes` only then — the
  // checkpoint line for that vector carries it, and an un-embedded symbol never claims it.
  const pendingHash = new Map<string, number>();
  for (const [id, text] of symbolTexts) {
    const hash = contentHash(text);
    const needsEmbed = !existing.has(id) || (cacheKey !== undefined && hashes.get(id) !== hash);
    if (needsEmbed) {
      toEmbed.push({ id, text });
      pendingHash.set(id, hash);
    } else {
      hashes.set(id, hash);
    }
  }

  // An id ends in its line number, so a line added near the top of a file renames every symbol and
  // chunk below it while their text stays the same. Measured 2026-10-15: a worktree of rdesigner on
  // another branch cloned the main checkout's 480k chunk vectors and still sent ~100k chunks to the
  // API. A vector is a function of the text alone, so the same text in the same file (id minus its
  // line) under the hash already stored takes the stored vector; the file scope keeps the 32-bit
  // hash from pairing unrelated texts.
  if (cacheKey !== undefined && toEmbed.length > 0) {
    const moved = vectorsByPlaceAndHash(existing, hashes);
    const remaining: typeof toEmbed = [];
    for (const item of toEmbed) {
      const h = pendingHash.get(item.id)!;
      const vec = moved.get(`${withoutLine(item.id)}\0${h}`);
      if (vec) {
        result.set(item.id, vec);
        hashes.set(item.id, h);
      } else {
        remaining.push(item);
      }
    }
    toEmbed.length = 0;
    for (const item of remaining) toEmbed.push(item);
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
      const h = pendingHash.get(item.id);
      if (h !== undefined) hashes.set(item.id, h);
    } else {
      stillToEmbed.push({ ...item, key });
    }
  }
  // Iterate `stillToEmbed` directly. Copying it back into `toEmbed` via
  // `push(...stillToEmbed)` spread one argument per symbol onto the call stack,
  // which V8 overflows somewhere between 100k and 125k arguments — so every repo
  // above ~100k symbols threw "Maximum call stack size exceeded" here and could
  // never be embedded at all (12 repos on this machine, the four largest first).
  const window = batchSize * Math.max(1, concurrency);
  for (let w = 0; w < stillToEmbed.length; w += window) {
    const batches: Array<typeof stillToEmbed> = [];
    for (let i = w; i < Math.min(w + window, stillToEmbed.length); i += batchSize) {
      batches.push(stillToEmbed.slice(i, i + batchSize));
    }
    const answers = await Promise.allSettled(
      batches.map((batch) => embedBatchWithStallRetry(embedFn, batch.map((b) => b.text))),
    );

    // In batch order, so the checkpoint is written as a sequential run would write it. A failed batch
    // stops the run AFTER every batch that succeeded in its window is checkpointed — the sequential
    // loop kept what came before a failure, and a paid API must not be asked for those twice.
    let failure: { reason: unknown } | null = null;
    for (let k = 0; k < batches.length; k++) {
      const batch = batches[k]!;
      const answer = answers[k]!;
      if (answer.status === "rejected") {
        failure ??= { reason: answer.reason };
        continue;
      }
      const vectors = answer.value;
      const done: Array<{ id: string; vec: Float32Array; h: number | undefined }> = [];
      for (let j = 0; j < batch.length; j++) {
        const entry = batch[j];
        const vec = vectors[j];
        if (entry && vec) {
          const f32 = new Float32Array(vec);
          result.set(entry.id, f32);
          if (entry.key) freshlyEmbedded.push({ key: entry.key, vec: f32 });
          const h = pendingHash.get(entry.id);
          if (h !== undefined) hashes.set(entry.id, h);
          done.push({ id: entry.id, vec: f32, h });
        }
      }
      if (onBatch) await onBatch(done);
    }
    if (failure) throw failure.reason;
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
