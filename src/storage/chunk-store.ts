import { createReadStream } from "node:fs";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
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
  await writeAtomicNdjson(
    chunkPath,
    chunkLines(chunks),
  );
}

function* chunkLines(chunks: Iterable<CodeChunk>): Iterable<string> {
  for (const c of chunks) {
    yield JSON.stringify({
        id: c.id,
        file: c.file,
        startLine: c.startLine,
        endLine: c.endLine,
        text: c.text,
        tokenCount: c.tokenCount,
      } satisfies ChunkLine) + "\n";
  }
}

async function writeAtomicNdjson(filePath: string, lines: Iterable<string>): Promise<void> {
  await cleanupOrphanTempFiles(filePath);
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  const { createWriteStream } = await import("node:fs");
  const stream = createWriteStream(tmpPath, { encoding: "utf-8", flags: "wx" });

  try {
    for (const line of lines) {
      if (!stream.write(line)) await once(stream, "drain");
    }
    stream.end();
    await once(stream, "finish");
    const { rename } = await import("node:fs/promises");
    await rename(tmpPath, filePath);
  } catch (err) {
    stream.destroy();
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
): Promise<Map<K, V> | null> {
  const map = new Map<K, V>();
  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (guard(parsed)) {
          const [key, value] = toEntry(parsed);
          map.set(key, value);
        }
      } catch {
        // Skip a malformed line rather than abandoning the whole file. A truncated tail is the
        // expected failure — a writer killed mid-append leaves one.
      }
    }
  } catch {
    // A stream-level failure means completeness is unknown. Returning a partial map would make a
    // damaged cache indistinguishable from a valid one and silently degrade semantic results.
    return null;
  }
  return map.size > 0 ? map : null;
}

/**
 * Load all chunks from an ndjson file.
 * Returns a Map of chunkId → CodeChunk, or null if file not found.
 */
export async function loadChunks(
  chunkPath: string,
): Promise<Map<string, CodeChunk> | null> {
  return loadNdjsonMap<string, CodeChunk>(
    chunkPath,
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
  await writeAtomicNdjson(
    embeddingPath,
    chunkEmbeddingLines(embeddings),
  );
}

function* chunkEmbeddingLines(
  embeddings: Iterable<[string, Float32Array]>,
): Iterable<string> {
  for (const [id, vec] of embeddings) {
    yield JSON.stringify({ id, vec: Array.from(vec) } satisfies ChunkEmbeddingLine) + "\n";
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
): Promise<Map<string, Float32Array> | null> {
  return loadNdjsonMap<string, Float32Array>(
    embeddingPath,
    isChunkEmbeddingLine,
    (parsed) => [(parsed as ChunkEmbeddingLine).id, new Float32Array((parsed as ChunkEmbeddingLine).vec)],
  );
}
