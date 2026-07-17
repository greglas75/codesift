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
    if (Object.values(embeddings).some(
      (value) => !Array.isArray(value) || value.some((entry) => !Number.isFinite(entry)),
    )) return null;
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
