import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { atomicWriteFile } from "../storage/_shared.js";

export interface CachedToolEmbeddings {
  fingerprint: string;
  embeddings: Record<string, number[]>;
}

export function getToolEmbeddingCachePath(): string {
  return join(homedir(), ".codesift", "tool-embeddings.ndjson");
}

export async function readToolEmbeddingCache(path: string): Promise<CachedToolEmbeddings | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record["fingerprint"] !== "string"
      || typeof record["embeddings"] !== "object"
      || record["embeddings"] === null
      || Array.isArray(record["embeddings"])
    ) {
      return null;
    }
    const embeddings = record["embeddings"] as Record<string, unknown>;
    const vectors = Object.values(embeddings);
    // A cache with no vectors at all is a half-written file, not a valid empty
    // catalog — the fingerprint it carries was computed from real tool defs.
    if (vectors.length === 0) return null;
    let dimension: number | null = null;
    for (const value of vectors) {
      // `[].some()` is vacuously false, so an empty vector slips through a
      // bare some()-check — it has to be rejected on length explicitly.
      if (!Array.isArray(value) || value.length === 0) return null;
      if (value.some((entry) => !Number.isFinite(entry))) return null;
      // Every vector comes from one provider+model, so a dimension mismatch
      // means the file is corrupt or was written across a provider switch.
      // Left unchecked, cosine() returns 0 for the odd ones out and those
      // tools silently vanish from semantic ranking with no error.
      dimension ??= value.length;
      if (value.length !== dimension) return null;
    }
    return parsed as CachedToolEmbeddings;
  } catch {
    return null;
  }
}

export async function writeToolEmbeddingCache(
  path: string,
  cache: CachedToolEmbeddings,
): Promise<void> {
  try {
    await atomicWriteFile(path, JSON.stringify(cache));
  } catch {
    // Cache persistence is optional; ranking can regenerate embeddings.
  }
}
