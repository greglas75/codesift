import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { CodeIndex, CodeSymbol, FileEntry } from "../types.js";
import { atomicWriteFile } from "./_shared.js";
import {
  loadIndexSqlite,
  saveIndexSqlite,
  saveIncrementalSqlite,
  removeFileFromIndexSqlite,
  getFileEntrySqlite,
  getDataVersion,
  classifyStorageError,
  IndexStorageError,
  loadIndexSummarySqlite,
  type IndexSummary,
} from "./sqlite-index-store.js";
import {
  cacheLoadedIndex,
  cacheLoadedSummary,
  getCachedIndex,
  getCachedSummary,
  invalidateIndexCache,
} from "./index-cache.js";
import {
  assertCanonicalIndexPath,
  ensureSqliteMigrated as migrateLegacyIndex,
  resolveIndexBackend,
  sqlitePathFor,
} from "./index-migration.js";
import {
  isExtractorVersionCurrent,
  loadVersionAwareIndex,
  type IndexOrStaleResult,
} from "./index-version.js";
import {
  removeFileFromJsonIndex,
  saveIncrementalJson,
} from "./index-json-mutations.js";
export {
  getIndexCacheBytesForTesting,
  getIndexCacheSizeForTesting,
  resetIndexCacheForTesting,
  resetSummaryCacheForTesting,
} from "./index-cache.js";
export {
  type IndexBackend,
  resetIndexBackendForTesting,
  resetMigrationCacheForTesting,
  resolveIndexBackend,
  sqlitePathFor,
} from "./index-migration.js";
export {
  collectExtractorVersionMismatches,
  isExtractorVersionCurrent,
  type ExtractorVersionCheckable,
  type ExtractorVersionMismatchRow,
  type IndexOrStaleResult,
} from "./index-version.js";
export {
  getIndexWriteCountForTesting,
  resetIndexWriteCountForTesting,
} from "./index-json-mutations.js";

async function ensureSqliteMigrated(indexPath: string, dbPath: string): Promise<void> {
  await migrateLegacyIndex(indexPath, dbPath, loadJsonIndex);
}

/**
 * Save a code index atomically.
 * Writes to a temp file first, then renames to prevent partial reads.
 */
export async function saveIndex(
  indexPath: string,
  index: CodeIndex,
  opts?: { sourceComplete?: boolean },
): Promise<void> {
  assertCanonicalIndexPath(indexPath);
  if ((await resolveIndexBackend()) === "sqlite") {
    const dbPath = sqlitePathFor(indexPath);
    await saveIndexSqlite(dbPath, index, opts);
    invalidateIndexCache(dbPath);
    return;
  }
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
  const index = await readIndex(indexPath);
  if (!index) return null;
  if (currentVersions && !isExtractorVersionCurrent(index, currentVersions)) return null;
  return index;
}

/**
 * One file's `files[]` entry.
 *
 * This is the accessor ADR-003 exists for. `file-indexer` needs a single file's `mtime_ms`
 * and `symbol_count` to decide whether an edit changed anything, and used to obtain them by
 * loading the entire index — a 262 MB parse on tgm-survey-platform, paid on the first touch
 * of every file, in a hook process that exits immediately afterwards and so can never reuse
 * the result. Under SQLite it is one indexed row.
 *
 * The JSON backend keeps the old cost; there is no way to read one record out of a blob.
 */
export async function getFileEntry(
  indexPath: string,
  filePath: string,
): Promise<FileEntry | undefined> {
  assertCanonicalIndexPath(indexPath);
  if ((await resolveIndexBackend()) === "sqlite") {
    const dbPath = sqlitePathFor(indexPath);
    await ensureSqliteMigrated(indexPath, dbPath);
    return getFileEntrySqlite(dbPath, filePath);
  }
  const index = await loadJsonIndex(indexPath);
  return index?.files.find((f) => f.path === filePath);
}

/**
 * Read an index's files and metadata WITHOUT constructing its symbols (ADR-004 stage 2).
 *
 * On the SQLite backend this skips the object graph entirely. On JSON there is nothing to skip —
 * the format forces a whole-document parse — so this is parity, not a speedup, and it exists so
 * callers can be written once against the narrow shape rather than branching on the backend.
 */
export async function loadIndexSummary(indexPath: string): Promise<IndexSummary | null> {
  assertCanonicalIndexPath(indexPath);
  if ((await resolveIndexBackend()) === "sqlite") {
    const dbPath = sqlitePathFor(indexPath);
    await ensureSqliteMigrated(indexPath, dbPath);

    // Cached on the same `data_version` signal as the full index. Without this a repo whose only
    // traffic is `index_status` re-opened a connection and re-read the whole files table on every
    // call, while its `getCodeIndex` sibling was served from memory — an asymmetry with no reason
    // behind it. A summary is small (3 MB against 349 MB on the measured index), so this is not
    // budgeted against `CODESIFT_MAX_INDEX_CACHE_MB`; it is bounded by entry count instead.
    const dataVersion = await getDataVersion(dbPath);
    const cached = getCachedSummary(dbPath, dataVersion);
    if (cached !== null) return cached;

    const summary = await loadIndexSummarySqlite(dbPath);
    if (summary === null) return null;
    return cacheLoadedSummary(dbPath, summary, dataVersion);
  }
  warnIfRollbackIsStale(indexPath);
  const index = await loadJsonIndex(indexPath);
  return index === null ? null : summariseIndex(index);
}

/**
 * Project a fully-loaded index onto the narrow shape, dropping the symbols array.
 *
 * `files` is COPIED, not aliased. This function's main caller projects an index held in the
 * `codeIndexes` cache, so handing back the live array would let one caller's `sort`/`splice`
 * rewrite what every later reader is given — the exact boundary `copyIndex` above exists to
 * defend, reached by a different route. `workspaces` is copied for the same reason.
 */
export function summariseIndex(index: CodeIndex): IndexSummary {
  const summary: IndexSummary = {
    repo: index.repo,
    root: index.root,
    files: index.files === undefined ? [] : [...index.files],
    created_at: index.created_at,
    updated_at: index.updated_at,
    symbol_count: index.symbol_count,
    file_count: index.file_count,
  };
  if (index.extractor_version !== undefined) summary.extractor_version = index.extractor_version;
  if (index.workspaces !== undefined) summary.workspaces = [...index.workspaces];
  // `files` is required on CodeIndex, so the guard above is unreachable through the typed path —
  // but this projects objects that also arrive from JSON on disk, where nothing enforces the type,
  // and the cache-hit call site sits outside its caller's try/catch. A throw there would surface as
  // a crash on a status call, which is a worse answer than an empty file list.
  if (index.lossy_migration === true) summary.lossy_migration = true;
  return summary;
}

/** Backend-agnostic read, without version enforcement. */
async function readIndex(indexPath: string): Promise<CodeIndex | null> {
  assertCanonicalIndexPath(indexPath);
  if ((await resolveIndexBackend()) === "sqlite") {
    const dbPath = sqlitePathFor(indexPath);
    await ensureSqliteMigrated(indexPath, dbPath);

    const dataVersion = await getDataVersion(dbPath);
    const cached = getCachedIndex(dbPath, dataVersion);
    if (cached !== null) return cached;

    const index = await loadIndexSqlite(dbPath);
    if (!index) return null;
    return cacheLoadedIndex(dbPath, index, dataVersion);
  }
  warnIfRollbackIsStale(indexPath);
  return loadJsonIndex(indexPath);
}

/**
 * Warn when the JSON backend is serving a snapshot that SQLite has since moved past.
 *
 * The rollback switch keeps the `.json` untouched, which is what makes rolling back possible
 * — and also means that after a repo has run on SQLite for a while, the JSON is a frozen
 * snapshot from migration day. Falling back to it then answers every query from a stale index
 * with no error and no empty result: the shape is valid, the extractor versions still match,
 * it is simply old. That is the worst failure mode we have (confidently wrong), so it gets a
 * loud one-time line rather than silence.
 */
const staleRollbackWarned = new Set<string>();

function warnIfRollbackIsStale(indexPath: string): void {
  if (staleRollbackWarned.has(indexPath)) return;
  try {
    // Mark only once a real comparison happened. Marking up front would permanently silence
    // the warning for a long-lived JSON-pinned process that read this repo before any `.db`
    // existed — precisely the process that most needs telling when one appears later.
    const dbStat = statSync(sqlitePathFor(indexPath));
    const jsonStat = statSync(indexPath);
    staleRollbackWarned.add(indexPath);
    if (dbStat.mtimeMs <= jsonStat.mtimeMs) return;
    const ageHours = Math.round((dbStat.mtimeMs - jsonStat.mtimeMs) / 3_600_000);
    console.error(
      `[codesift] WARNING: reading the legacy JSON index at ${indexPath}, but a SQLite index ` +
        `updated ~${ageHours}h more recently exists alongside it. Every answer from this repo ` +
        `is from the pre-rollback snapshot. Run index_folder to rebuild the JSON index, or ` +
        `unset CODESIFT_INDEX_BACKEND to go back to SQLite.`,
    );
  } catch {
    /* no .db, or unreadable — nothing to compare against, so nothing to warn about */
  }
}

export function resetStaleRollbackWarningForTesting(): void {
  staleRollbackWarned.clear();
}

/**
 * Codes that genuinely mean "there is no index file here". Everything else that `readFile` can
 * fail with — EISDIR, ENOTDIR, ENAMETOOLONG, ELOOP, platform-specific I/O errors — describes a
 * path that is wrong or unreadable, not a repo that was never indexed. Reporting those as
 * absence is the same misdiagnosis this change exists to remove, one layer down.
 */
const ABSENCE_CODES = new Set(["ENOENT", "ENOTDIR_PARENT"]);

function nonAbsenceReadCode(err: unknown): string | null {
  const code =
    typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  // No recognisable code at all: this is NOT evidence of absence. Only an explicit ENOENT is.
  // Defaulting the unknown case to "nothing indexed here" is how a real fault becomes a
  // confident empty answer — the whole failure mode being removed.
  if (typeof code !== "string") return "UNKNOWN_READ_ERROR";
  return ABSENCE_CODES.has(code) ? null : code;
}

/**
 * The legacy path, kept intact: it is both the Node 20 backend and the rollback target.
 *
 * ENOENT is absence and stays `null`; a malformed document is also `null` (an invalid index is
 * rebuildable, which is the historical contract). But EACCES/EIO/EBUSY mean the file exists and
 * we simply could not read it — reporting that as "no index" is how a permissions problem gets
 * misdiagnosed as an unindexed repo.
 */
async function loadJsonIndex(indexPath: string): Promise<CodeIndex | null> {
  let raw: string;
  try {
    raw = await readFile(indexPath, "utf-8");
  } catch (err) {
    const code = classifyStorageError(err) ?? nonAbsenceReadCode(err);
    if (code !== null) {
      throw new IndexStorageError(
        `index storage at ${indexPath} is unreadable (${code}): ${
          err instanceof Error ? err.message : String(err)
        }`,
        code,
        indexPath,
        { cause: err },
      );
    }
    return null; // ENOENT and friends: nothing indexed here
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isValidIndex(parsed)) return null;
    return parsed;
  } catch {
    return null; // malformed JSON is a rebuildable index, not a storage fault
  }
}

/** Discriminated union returned by loadIndexOrStale: distinguishes a healthy
 *  load from a version-mismatch stale-index case. Tools route through this
 *  helper instead of calling loadIndex directly so stale indexes surface as
 *  structured errors via staleToMcpError (src/tools/_helpers.ts) rather than
 *  silent empty results. */
/** Load an index with version-aware stale detection.
 *
 * Returns:
 *   - `{ status: "ok", index }` when the index is present, valid, and matches
 *     the provided `currentVersions` for the language under inspection.
 *   - `{ status: "stale", reason: "extractor_version_mismatch", ... }` when
 *     the file exists and is parseable but its TypeScript extractor version
 *     differs from the current bundled version.
 *
 * The stale payload names the actual mismatching language (typescript, python,
 * php, etc.). Earlier versions hard-coded "typescript" in the message even
 * when a different language drifted; that misled anyone reading the warning
 * during a non-TS bump.
 *
 * On file-not-found, parse error, or invalid shape, this function falls back
 * to `loadIndex(...)` returning null. Callers must still handle null (no
 * structured error) for those cases. */
export async function loadIndexOrStale(
  indexPath: string,
  currentVersions: Record<string, string>,
): Promise<IndexOrStaleResult | null> {
  return loadVersionAwareIndex(indexPath, currentVersions, readIndex);
}

const jsonMutationIo = { loadIndex, saveIndex };

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
  assertCanonicalIndexPath(indexPath);
  if ((await resolveIndexBackend()) === "sqlite") {
    const dbPath = sqlitePathFor(indexPath);
    await ensureSqliteMigrated(indexPath, dbPath);
    // No mutation batching here on purpose: batching exists to amortise a whole-blob
    // rewrite, and this backend writes one file's rows inside a transaction instead.
    await saveIncrementalSqlite(dbPath, updatedFile, newSymbols, fileEntry);
    invalidateIndexCache(dbPath);
    return;
  }
  return saveIncrementalJson(indexPath, updatedFile, newSymbols, fileEntry, jsonMutationIo);
}

/**
 * Remove all symbols and the file entry for a deleted file.
 * Serialized per indexPath to prevent read-modify-write races.
 */
export async function removeFileFromIndex(
  indexPath: string,
  deletedFile: string,
): Promise<void> {
  assertCanonicalIndexPath(indexPath);
  if ((await resolveIndexBackend()) === "sqlite") {
    const dbPath = sqlitePathFor(indexPath);
    await ensureSqliteMigrated(indexPath, dbPath);
    await removeFileFromIndexSqlite(dbPath, deletedFile);
    invalidateIndexCache(dbPath);
    return;
  }
  return removeFileFromJsonIndex(indexPath, deletedFile, jsonMutationIo);
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
