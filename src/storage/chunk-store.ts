import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { basename, dirname, join } from "node:path";
import type { CodeChunk } from "../types.js";
import { cleanupOrphanTempFiles } from "./_shared.js";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Derive the chunk ndjson path from the index path.
 * {hash}.index.json → {hash}.chunks.ndjson
 */
export function getChunkPath(indexPath: string): string {
  return indexPath.replace(/\.index\.json$/, ".chunks.ndjson");
}

/**
 * Derive the chunk-embedding ndjson path from the index path.
 * {hash}.index.json → {hash}.chunk-embeddings.ndjson
 */
export function getChunkEmbeddingPath(indexPath: string): string {
  return indexPath.replace(/\.index\.json$/, ".chunk-embeddings.ndjson");
}

// ---------------------------------------------------------------------------
// Chunk persistence
// ---------------------------------------------------------------------------

interface ChunkLine {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  tokenCount: number;
}

interface ChunkIndexManifest {
  version: 1;
  chunks: string;
  embeddings: string;
}

function getChunkManifestPath(filePath: string): string {
  if (filePath.endsWith(".chunks.ndjson")) {
    return filePath.replace(/\.chunks\.ndjson$/, ".chunk-index.json");
  }
  if (filePath.endsWith(".chunk-embeddings.ndjson")) {
    return filePath.replace(/\.chunk-embeddings\.ndjson$/, ".chunk-index.json");
  }
  return `${filePath}.chunk-index.json`;
}

async function loadChunkManifest(filePath: string): Promise<ChunkIndexManifest | null> {
  let raw: string;
  try {
    const { readFile } = await import("node:fs/promises");
    raw = await readFile(getChunkManifestPath(filePath), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<ChunkIndexManifest>;
  const safeName = (value: unknown): value is string =>
    typeof value === "string" &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    basename(value) === value;
  if (
    parsed.version !== 1 ||
    !safeName(parsed.chunks) ||
    !safeName(parsed.embeddings)
  ) throw new Error(`Invalid chunk index manifest: ${getChunkManifestPath(filePath)}`);
  return parsed as ChunkIndexManifest;
}

export interface ResolvedChunkIndexPaths {
  chunks: string;
  embeddings: string;
}

/** Resolve both files from one manifest snapshot so a query cannot straddle generations. */
export async function resolveChunkIndexPaths(
  chunkPath: string,
  embeddingPath: string,
): Promise<ResolvedChunkIndexPaths> {
  if (getChunkManifestPath(chunkPath) !== getChunkManifestPath(embeddingPath)) {
    throw new Error("Chunk and embedding paths must share one index manifest");
  }
  const manifest = await loadChunkManifest(chunkPath);
  if (!manifest) return { chunks: chunkPath, embeddings: embeddingPath };
  const directory = dirname(chunkPath);
  return {
    chunks: join(directory, manifest.chunks),
    embeddings: join(directory, manifest.embeddings),
  };
}

async function resolveActiveChunkFile(
  filePath: string,
  kind: "chunks" | "embeddings",
): Promise<string> {
  const manifest = await loadChunkManifest(filePath);
  return manifest ? join(dirname(filePath), manifest[kind]) : filePath;
}

function isChunkLine(value: unknown): value is ChunkLine {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["id"] === "string" &&
    typeof obj["file"] === "string" &&
    typeof obj["startLine"] === "number" &&
    typeof obj["endLine"] === "number" &&
    typeof obj["text"] === "string" &&
    typeof obj["tokenCount"] === "number"
  );
}

/**
 * Save all chunks atomically as ndjson.
 * File: ~/.codesift/{hash}.chunks.ndjson
 */
export async function saveChunks(
  chunkPath: string,
  chunks: CodeChunk[],
): Promise<void> {
  // Streams for the same reason saveChunkEmbeddings does, one function below: a
  // single `lines.join("\n")` throws `RangeError: Invalid string length` once the
  // combined ndjson passes V8's max string length (~512 MiB), and this file holds
  // the chunk TEXT, so it is the larger of the two. The sibling was fixed and this
  // one was not — the largest chunks.ndjson on this machine is 154 MB (30% of the
  // ceiling), so it is a latent failure, and one that would land at the END of a
  // multi-hour embedding run with the vectors already computed.
  await cleanupOrphanTempFiles(chunkPath);

  const tmpPath = `${chunkPath}.tmp.${process.pid}.${randomUUID()}`;
  const { createWriteStream } = await import("node:fs");
  const stream = createWriteStream(tmpPath, { encoding: "utf-8" });
  // Observe errors from the first write, including writes that did not apply
  // backpressure and therefore never installed a temporary drain listener.
  const completion = finished(stream);

  try {
    for (const c of chunks) {
      const line = JSON.stringify({
        id: c.id,
        file: c.file,
        startLine: c.startLine,
        endLine: c.endLine,
        text: c.text,
        tokenCount: c.tokenCount,
      } satisfies ChunkLine) + "\n";
      if (!stream.write(line)) {
        // events.once rejects when a writable emits "error" before "drain".
        // A resolve-only drain waiter hangs forever on ENOSPC/EIO.
        await once(stream, "drain");
      }
    }
    stream.end();
    await completion;
    const { rename } = await import("node:fs/promises");
    await rename(tmpPath, chunkPath);
  } catch (err) {
    stream.destroy();
    await completion.catch(() => undefined);
    try { const { unlink } = await import("node:fs/promises"); await unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/** Generic NDJSON loader — reads file, parses each line, filters with a type guard, maps to value. */
/**
 * Read an ndjson file into a Map, one line at a time.
 *
 * This used to be `await readFile(path, "utf-8")` followed by `raw.split("\n")` — the whole file as
 * one string, then a second full copy as an array. Both die above V8's hard MAX_STRING_LENGTH
 * (536,870,888 chars), and the `catch { return null }` around it turned that into "this repo has no
 * embeddings".
 *
 * That is not hypothetical. Measured 2026-08-09 against the live data dir, two chunk-embedding files
 * are ALREADY unreadable and silently return null:
 *
 *     3,223.3 MB -> ERR_FS_FILE_TOO_LARGE      (fails in 2 ms)
 *       765.6 MB -> "Invalid string length"    (fails in 625 ms)
 *
 * 3.99 GB of embeddings that cost hours of model time, present on disk, reported as absent. A
 * control file at 497.4 MB loads fine, which is exactly what makes it invisible: it works until a
 * repo crosses half a gigabyte, and then it stops working without saying so.
 *
 * Streaming has no ceiling and holds one line at a time. It is also the same shape
 * `loadSharedCache` already uses — this file was the outlier.
 */
async function loadNdjsonMap<K extends string, V>(
  filePath: string,
  guard: (parsed: unknown) => boolean,
  toEntry: (parsed: unknown) => [K, V],
  maxResidentBytes = Number.POSITIVE_INFINITY,
  parsedEntryBytes: (parsed: unknown) => number = () => 0,
  parsedKey?: (parsed: unknown) => K,
): Promise<Map<K, V> | null> {
  const map = new Map<K, V>();
  const entryBytes = new Map<K, number>();
  let residentBytes = 0;
  let exceededBudget = false;
  try {
    const input = createReadStream(filePath, { encoding: "utf-8" });
    const rl = createInterface({
      input,
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        // Refuse a single oversized JSON record before materialising its
        // transient number[] alongside the resident Float32Array map.
        if (
          Number.isFinite(maxResidentBytes) &&
          Buffer.byteLength(trimmed, "utf8") > maxResidentBytes - residentBytes
        ) {
          exceededBudget = true;
          rl.close();
          input.destroy();
          break;
        }
        const parsed: unknown = JSON.parse(trimmed);
        if (guard(parsed)) {
          const estimatedBytes = parsedEntryBytes(parsed);
          const knownKey = parsedKey?.(parsed);
          const previousBytes = knownKey === undefined ? 0 : (entryBytes.get(knownKey) ?? 0);
          if (residentBytes - previousBytes + estimatedBytes > maxResidentBytes) {
            exceededBudget = true;
            map.clear();
            rl.close();
            input.destroy();
            console.error(
              `[codesift] chunk embeddings skipped: resident vectors exceed ` +
                `${Math.round(maxResidentBytes / 1024 / 1024)} MB budget`,
            );
            break;
          }
          const [key, value] = toEntry(parsed);
          residentBytes += estimatedBytes - previousBytes;
          entryBytes.set(key, estimatedBytes);
          map.set(key, value);
        }
      } catch {
        // Skip a malformed line rather than abandoning the whole file. A truncated tail is the
        // expected failure — a writer killed mid-append leaves one.
      }
    }
  } catch {
    // Missing or unreadable file. Anything already parsed is still worth returning: under the old
    // whole-file read a single bad byte cost the entire map.
    return map.size > 0 ? map : null;
  }
  if (exceededBudget) return null;
  return map.size > 0 ? map : null;
}

/**
 * Load all chunks from an ndjson file.
 * Returns a Map of chunkId → CodeChunk, or null if file not found.
 */
export async function loadChunks(
  chunkPath: string,
  resolvedPath?: string,
): Promise<Map<string, CodeChunk> | null> {
  const activePath = resolvedPath ?? await resolveActiveChunkFile(chunkPath, "chunks");
  return loadNdjsonMap<string, CodeChunk>(
    activePath,
    isChunkLine,
    (parsed) => [(parsed as CodeChunk).id, parsed as CodeChunk],
  );
}

// ---------------------------------------------------------------------------
// Chunk embedding persistence — same ndjson format as embedding-store
// ---------------------------------------------------------------------------

interface ChunkEmbeddingLine {
  id: string;
  vec: number[];
}

/**
 * Save all chunk embeddings atomically as ndjson.
 * File: ~/.codesift/{hash}.chunk-embeddings.ndjson
 */
export async function saveChunkEmbeddings(
  embeddingPath: string,
  embeddings: Map<string, Float32Array>,
): Promise<void> {
  // Stream line-by-line. The previous version built one big `lines.join("\n")`
  // string, which threw `RangeError: Invalid string length` once the combined
  // ndjson exceeded V8's max string length (~512 MB) — a repo with enough chunks
  // (e.g. TGMQuotas, ~27K) silently failed its entire chunk-embedding save with
  // exit 0 and no chunk file, so semantic search stayed symbol-only there. This
  // mirrors saveEmbeddings, which already streams for the same reason.
  // Same orphan sweep as saveEmbeddings — a killed process leaves these behind.
  await cleanupOrphanTempFiles(embeddingPath);

  const tmpPath = `${embeddingPath}.tmp.${process.pid}.${randomUUID()}`;
  const { createWriteStream } = await import("node:fs");
  const stream = createWriteStream(tmpPath, { encoding: "utf-8" });
  const completion = finished(stream);

  try {
    for (const [id, vec] of embeddings) {
      const line = JSON.stringify({ id, vec: Array.from(vec) } satisfies ChunkEmbeddingLine) + "\n";
      if (!stream.write(line)) {
        await once(stream, "drain");
      }
    }
    stream.end();
    await completion;
    const { rename } = await import("node:fs/promises");
    await rename(tmpPath, embeddingPath);
  } catch (err) {
    stream.destroy();
    await completion.catch(() => undefined);
    try { const { unlink } = await import("node:fs/promises"); await unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Publish chunk metadata and vectors by atomically switching one manifest.
 * A crash or concurrent writer can leave unreferenced generation files, but
 * readers observe either the complete old pair or the complete new pair.
 */
export async function saveChunkIndex(
  chunkPath: string,
  chunks: CodeChunk[],
  embeddingPath: string,
  embeddings: Map<string, Float32Array>,
): Promise<void> {
  const generation = `${process.pid}.${randomUUID()}`;
  const generationChunkPath = `${chunkPath}.generation.${generation}`;
  const generationEmbeddingPath = `${embeddingPath}.generation.${generation}`;
  const manifestPath = getChunkManifestPath(chunkPath);
  const manifestTmpPath = `${manifestPath}.tmp.${generation}`;
  const { rename, unlink, writeFile } = await import("node:fs/promises");
  try {
    await saveChunks(generationChunkPath, chunks);
    await saveChunkEmbeddings(generationEmbeddingPath, embeddings);
    const manifest: ChunkIndexManifest = {
      version: 1,
      chunks: basename(generationChunkPath),
      embeddings: basename(generationEmbeddingPath),
    };
    await writeFile(manifestTmpPath, `${JSON.stringify(manifest)}\n`, "utf8");
    await rename(manifestTmpPath, manifestPath);
  } catch (err) {
    await Promise.all([
      unlink(generationChunkPath).catch(() => undefined),
      unlink(generationEmbeddingPath).catch(() => undefined),
      unlink(manifestTmpPath).catch(() => undefined),
    ]);
    throw err;
  }
}

function isChunkEmbeddingLine(parsed: unknown): boolean {
  return typeof parsed === "object" && parsed !== null &&
    typeof (parsed as Record<string, unknown>)["id"] === "string" &&
    Array.isArray((parsed as Record<string, unknown>)["vec"]);
}

/**
 * Load all chunk embeddings from an ndjson file.
 * Returns a Map of chunkId → Float32Array, or null if file not found / empty.
 */
export async function loadChunkEmbeddings(
  embeddingPath: string,
  maxResidentBytes = Number.POSITIVE_INFINITY,
  resolvedPath?: string,
): Promise<Map<string, Float32Array> | null> {
  const activePath = resolvedPath ?? await resolveActiveChunkFile(embeddingPath, "embeddings");
  return loadNdjsonMap<string, Float32Array>(
    activePath,
    isChunkEmbeddingLine,
    (parsed) => [(parsed as ChunkEmbeddingLine).id, new Float32Array((parsed as ChunkEmbeddingLine).vec)],
    maxResidentBytes,
    (parsed) => {
      const entry = parsed as ChunkEmbeddingLine;
      return entry.vec.length * Float32Array.BYTES_PER_ELEMENT + entry.id.length * 2 + 128;
    },
    (parsed) => (parsed as ChunkEmbeddingLine).id,
  );
}
