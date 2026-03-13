import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { CodeIndex, CodeSymbol } from "../types.js";

/**
 * Save a code index atomically.
 * Writes to a temp file first, then renames to prevent partial reads.
 */
export async function saveIndex(
  indexPath: string,
  index: CodeIndex,
): Promise<void> {
  const dir = dirname(indexPath);
  await mkdir(dir, { recursive: true });

  const tmpPath = `${indexPath}.tmp.${Date.now()}.json`;
  const data = JSON.stringify(index);

  await writeFile(tmpPath, data, "utf-8");
  await rename(tmpPath, indexPath);
}

/**
 * Load a code index from disk.
 * Returns null if file doesn't exist, is unreadable, or has invalid shape.
 */
export async function loadIndex(
  indexPath: string,
): Promise<CodeIndex | null> {
  try {
    const raw = await readFile(indexPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    if (!isValidIndex(parsed)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Incrementally update an index for a single changed file.
 * Removes old symbols for the file, adds new ones, and saves atomically.
 */
export async function saveIncremental(
  indexPath: string,
  updatedFile: string,
  newSymbols: CodeSymbol[],
): Promise<void> {
  const existing = await loadIndex(indexPath);
  if (!existing) {
    throw new Error(`Cannot incrementally update: index not found at ${indexPath}`);
  }

  const filtered = existing.symbols.filter(
    (symbol) => symbol.file !== updatedFile,
  );
  const merged = [...filtered, ...newSymbols];

  existing.symbols = merged;
  existing.symbol_count = merged.length;
  existing.updated_at = Date.now();

  await saveIndex(indexPath, existing);
}

/**
 * Derive a deterministic index file path from a repo root.
 * Uses a truncated SHA-256 hash of the root path.
 */
export function getIndexPath(dataDir: string, repoRoot: string): string {
  const hash = createHash("sha256")
    .update(repoRoot)
    .digest("hex")
    .slice(0, 12);

  return join(dataDir, `${hash}.index.json`);
}

function isValidIndex(value: unknown): value is CodeIndex {
  if (typeof value !== "object" || value === null) return false;

  const obj = value as Record<string, unknown>;
  if (typeof obj["repo"] !== "string") return false;
  if (!Array.isArray(obj["symbols"])) return false;

  return true;
}
