import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { CodeIndex, CodeSymbol, FileEntry } from "../types.js";
import { atomicWriteFile } from "./_shared.js";

/** Serialize concurrent writes to the same index path. */
const writeLocks = new Map<string, Promise<void>>();

/**
 * Save a code index atomically.
 * Writes to a temp file first, then renames to prevent partial reads.
 */
export async function saveIndex(
  indexPath: string,
  index: CodeIndex,
): Promise<void> {
  const data = JSON.stringify(index);
  await atomicWriteFile(indexPath, data);
}

/**
 * Load a code index from disk.
 * Returns null if file doesn't exist, is unreadable, or has invalid shape.
 *
 * When `currentVersions` is provided, the stored `extractor_version` snapshot
 * is compared against it. A missing field or any mismatched language version
 * is treated as cache miss (returns null) — forcing callers to rebuild the
 * index. Omit the argument for read-modify-write flows (incremental updates)
 * where version enforcement would cause spurious reindexes.
 */
export async function loadIndex(
  indexPath: string,
  currentVersions?: Record<string, string>,
): Promise<CodeIndex | null> {
  try {
    const raw = await readFile(indexPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    if (!isValidIndex(parsed)) {
      return null;
    }

    if (currentVersions && !isExtractorVersionCurrent(parsed, currentVersions)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/** Discriminated union returned by loadIndexOrStale: distinguishes a healthy
 *  load from a version-mismatch stale-index case. Tools route through this
 *  helper instead of calling loadIndex directly so stale indexes surface as
 *  structured errors via staleToMcpError (src/tools/_helpers.ts) rather than
 *  silent empty results. */
export type IndexOrStaleResult =
  | { status: "ok"; index: CodeIndex }
  | {
      status: "stale";
      reason: "extractor_version_mismatch";
      expected_version: string;
      actual_version: string;
    };

/** Load an index with version-aware stale detection.
 *
 * Returns:
 *   - `{ status: "ok", index }` when the index is present, valid, and matches
 *     the provided `currentVersions` for the language under inspection.
 *   - `{ status: "stale", reason: "extractor_version_mismatch", ... }` when
 *     the file exists and is parseable but its TypeScript extractor version
 *     differs from the current bundled version.
 *
 * Currently only the `typescript` language version is reported in the stale
 * payload (this is the language whose schema bumps are most likely to invalidate
 * existing indexes). The check is general — any mismatch in `currentVersions`
 * yields a stale verdict — but the message names typescript for clarity.
 *
 * On file-not-found, parse error, or invalid shape, this function falls back
 * to `loadIndex(...)` returning null. Callers must still handle null (no
 * structured error) for those cases. */
export async function loadIndexOrStale(
  indexPath: string,
  currentVersions: Record<string, string>,
): Promise<IndexOrStaleResult | null> {
  try {
    const raw = await readFile(indexPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!isValidIndex(parsed)) return null;
    if (!isExtractorVersionCurrent(parsed, currentVersions)) {
      // Identify the first mismatching language; report typescript by name
      // for clarity, since that's the most commonly-bumped key.
      const stored = parsed.extractor_version ?? {};
      const expected = currentVersions["typescript"] ?? "unknown";
      const actual = stored["typescript"] ?? "missing";
      return {
        status: "stale",
        reason: "extractor_version_mismatch",
        expected_version: expected,
        actual_version: actual,
      };
    }
    return { status: "ok", index: parsed };
  } catch {
    return null;
  }
}

/**
 * Check whether the stored `extractor_version` snapshot matches the current
 * set of extractor versions. Returns false if any language present in
 * `currentVersions` is missing from the stored snapshot or has a different
 * value. A missing `extractor_version` field on a legacy index is treated as
 * a version miss.
 */
export function isExtractorVersionCurrent(
  index: CodeIndex,
  currentVersions: Record<string, string>,
): boolean {
  const stored = index.extractor_version;
  if (!stored) return false;
  for (const lang of Object.keys(currentVersions)) {
    if (stored[lang] !== currentVersions[lang]) return false;
  }
  return true;
}

/**
 * Incrementally update an index for a single changed file.
 * Removes old symbols for the file, adds new ones, and saves atomically.
 * Serialized per indexPath to prevent read-modify-write races.
 */
export async function saveIncremental(
  indexPath: string,
  updatedFile: string,
  newSymbols: CodeSymbol[],
  fileEntry?: FileEntry,
): Promise<void> {
  const prev = writeLocks.get(indexPath) ?? Promise.resolve();

  const next = prev.then(async () => {
    const existing = await loadIndex(indexPath);
    if (!existing) {
      throw new Error(`Cannot incrementally update: index not found at ${indexPath}`);
    }

    // Update symbols
    const filtered = existing.symbols.filter(
      (symbol) => symbol.file !== updatedFile,
    );
    const merged = [...filtered, ...newSymbols];

    existing.symbols = merged;
    existing.symbol_count = merged.length;
    existing.updated_at = Date.now();

    // Update files[] to keep it in sync
    if (fileEntry) {
      existing.files = existing.files.filter((f) => f.path !== updatedFile);
      existing.files.push(fileEntry);
      existing.file_count = existing.files.length;
    }

    await saveIndex(indexPath, existing);
  });

  // Store the chain (swallow errors so next caller isn't blocked)
  writeLocks.set(indexPath, next.catch(() => {}));
  return next;
}

/**
 * Remove all symbols and the file entry for a deleted file.
 * Serialized per indexPath to prevent read-modify-write races.
 */
export async function removeFileFromIndex(
  indexPath: string,
  deletedFile: string,
): Promise<void> {
  const prev = writeLocks.get(indexPath) ?? Promise.resolve();

  const next = prev.then(async () => {
    const existing = await loadIndex(indexPath);
    if (!existing) return;

    const hadSymbols = existing.symbols.some((s) => s.file === deletedFile);
    const hadFile = existing.files.some((f) => f.path === deletedFile);
    if (!hadSymbols && !hadFile) return;

    existing.symbols = existing.symbols.filter((s) => s.file !== deletedFile);
    existing.symbol_count = existing.symbols.length;
    existing.files = existing.files.filter((f) => f.path !== deletedFile);
    existing.file_count = existing.files.length;
    existing.updated_at = Date.now();

    await saveIndex(indexPath, existing);
  });

  writeLocks.set(indexPath, next.catch(() => {}));
  return next;
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
