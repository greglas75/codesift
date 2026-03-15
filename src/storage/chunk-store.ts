import { readFile } from "node:fs/promises";
import type { CodeChunk } from "../types.js";
import { atomicWriteFile } from "./_shared.js";

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
  const lines = chunks.map((c) =>
    JSON.stringify({
      id: c.id,
      file: c.file,
      startLine: c.startLine,
      endLine: c.endLine,
      text: c.text,
      tokenCount: c.tokenCount,
    } satisfies ChunkLine),
  );

  const data = lines.join("\n") + "\n";
  await atomicWriteFile(chunkPath, data);
}

/**
 * Load all chunks from an ndjson file.
 * Returns a Map of chunkId → CodeChunk, or null if file not found.
 */
export async function loadChunks(
  chunkPath: string,
): Promise<Map<string, CodeChunk> | null> {
  try {
    const raw = await readFile(chunkPath, "utf-8");
    const map = new Map<string, CodeChunk>();

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isChunkLine(parsed)) {
          map.set(parsed.id, parsed);
        }
      } catch {
        // Skip malformed lines
      }
    }

    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
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
  const lines: string[] = [];
  for (const [id, vec] of embeddings) {
    lines.push(JSON.stringify({ id, vec: Array.from(vec) } satisfies ChunkEmbeddingLine));
  }

  const data = lines.join("\n") + "\n";
  await atomicWriteFile(embeddingPath, data);
}

/**
 * Load all chunk embeddings from an ndjson file.
 * Returns a Map of chunkId → Float32Array, or null if file not found / empty.
 */
export async function loadChunkEmbeddings(
  embeddingPath: string,
): Promise<Map<string, Float32Array> | null> {
  try {
    const raw = await readFile(embeddingPath, "utf-8");
    const map = new Map<string, Float32Array>();

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (
          typeof parsed === "object" && parsed !== null &&
          typeof (parsed as Record<string, unknown>)["id"] === "string" &&
          Array.isArray((parsed as Record<string, unknown>)["vec"])
        ) {
          const entry = parsed as ChunkEmbeddingLine;
          map.set(entry.id, new Float32Array(entry.vec));
        }
      } catch {
        // Skip malformed lines
      }
    }

    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
}
