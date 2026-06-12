import { readFile, unlink } from "node:fs/promises";
import { atomicWriteFile } from "./_shared.js";

export const HASH_SNAPSHOT_VERSION = 1;

export interface FileHashSnapshot {
  version: 1;
  repo: string;
  created_at: number;
  files: Record<string, string>;
}

/**
 * Convert an index path to its companion snapshot path.
 * e.g. "/x/abc123.index.json" → "/x/abc123.snapshot.json"
 *
 * Throws if indexPath does not end with ".index.json" (safety guard against
 * accidentally overwriting the wrong file).
 */
export function getSnapshotPath(indexPath: string): string {
  if (!indexPath.endsWith(".index.json")) {
    throw new Error(
      `hash-snapshot: expected an .index.json path, got "${indexPath}"`,
    );
  }
  return indexPath.replace(/\.index\.json$/, ".snapshot.json");
}

/**
 * Write a FileHashSnapshot atomically.
 */
export async function saveHashSnapshot(
  path: string,
  snap: FileHashSnapshot,
): Promise<void> {
  const data = JSON.stringify(snap);
  await atomicWriteFile(path, data);
}

/**
 * Load a FileHashSnapshot from disk.
 * Returns null when:
 *   - the file does not exist
 *   - the file contains invalid JSON
 *   - the stored version !== 1
 *   - expectedRepo is provided and does not match snapshot.repo
 *
 * Non-ENOENT file read errors are logged as a warning before returning null.
 * JSON parse errors are silent (expected corruption path).
 */
export async function loadHashSnapshot(
  path: string,
  expectedRepo?: string,
): Promise<FileHashSnapshot | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err: unknown) {
    // ENOENT = expected case (file doesn't exist yet). Other errors = log & degrade.
    const errno = (err as NodeJS.ErrnoException)?.code;
    if (errno !== "ENOENT") {
      const msg =
        err instanceof Error ? err.message : String(err);
      console.warn(
        `[codesift] hash-snapshot load failed (degrading to full re-parse): ${msg}`,
      );
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSON parse errors are silent (corruption is expected & recoverable)
    return null;
  }

  if (!isValidSnapshot(parsed)) {
    return null;
  }

  if (expectedRepo !== undefined && parsed.repo !== expectedRepo) {
    return null;
  }

  return parsed;
}

/**
 * Delete a snapshot file idempotently — never throws if the file is absent.
 */
export async function deleteHashSnapshot(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err: unknown) {
    // ENOENT = already gone, which is fine. Re-throw anything else.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

function isValidSnapshot(value: unknown): value is FileHashSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  if (obj["version"] !== HASH_SNAPSHOT_VERSION) return false;
  if (typeof obj["repo"] !== "string") return false;
  if (typeof obj["created_at"] !== "number") return false;

  const files = obj["files"];
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    return false;
  }

  // All values in files must be strings
  for (const v of Object.values(files)) {
    if (typeof v !== "string") return false;
  }

  return true;
}
