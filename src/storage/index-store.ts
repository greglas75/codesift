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
  ensureSqliteMigrated as migrateLegacyIndex,
  resolveIndexBackend,
  sqlitePathFor,
} from "./index-migration.js";
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

/** Serialize concurrent writes to the same index path. */
const writeLocks = new Map<string, Promise<void>>();

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
export type IndexOrStaleResult =
  | { status: "ok"; index: CodeIndex }
  | {
      /** The store exists but could not be read — locked, corrupt, unreadable. Distinct from a
       *  null return, which means "nothing is indexed here". A caller that treats this as an
       *  empty index reports a confident, wrong "no results". */
      status: "unreadable";
      reason: "storage_error";
      /** SQLITE_* / errno code, for operators and for deciding whether a retry is sane. */
      code: string;
      message: string;
    }
  | {
      status: "stale";
      reason: "extractor_version_mismatch";
      /** Language whose extractor version drifted (e.g., "typescript", "python"). */
      language: string;
      expected_version: string;
      actual_version: string;
      /** Present when multiple `currentVersions` keys drift at once — operators
       *  should not assume fixing the primary `language` alone refreshes everything. */
      mismatch_detail?: string;
    };

export type ExtractorVersionMismatchRow = {
  language: string;
  expected: string;
  actual: string;
};

/** All languages whose stored `extractor_version` entry does not match
 *  `currentVersions`, applying the same tolerances as `loadIndexOrStale`
 *  (newly added keys with no files in that language are skipped). */
/**
 * Only the two fields the check actually reads, so an `IndexSummary` (ADR-004 stage 2) can be
 * validated without materialising symbols just to satisfy a parameter type.
 */
export type ExtractorVersionCheckable = Pick<CodeIndex, "extractor_version" | "files">;

export function collectExtractorVersionMismatches(
  index: ExtractorVersionCheckable,
  currentVersions: Record<string, string>,
): ExtractorVersionMismatchRow[] {
  const stored = index.extractor_version ?? {};
  const storedKeys = Object.keys(stored);
  const indexedLanguages = new Set<string>();
  for (const file of index.files) indexedLanguages.add(file.language);

  const out: ExtractorVersionMismatchRow[] = [];

  // Degenerate index: no files AND no version keys — treat as empty/uninitialized.
  // Use the sentinel language "*" so callers and operators can recognize the case
  // instead of being misled into thinking a specific extractor drifted (the prior
  // implementation reported `Object.keys(currentVersions)[0]`, which was arbitrary).
  if (index.files.length === 0 && storedKeys.length === 0) {
    const langKeys = Object.keys(currentVersions);
    if (langKeys.length === 0) return [];
    out.push({
      language: "*",
      expected: "any",
      actual: "empty_index",
    });
    return out;
  }

  for (const lang of Object.keys(currentVersions)) {
    const expected = currentVersions[lang];
    const actual = stored[lang];
    if (expected === actual) continue;
    if (actual === undefined && !indexedLanguages.has(lang)) continue;
    out.push({
      language: lang,
      expected: expected ?? "unknown",
      actual: actual ?? "missing",
    });
  }
  return out;
}

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
  let parsed: CodeIndex | null;
  try {
    parsed = await readIndex(indexPath);
  } catch (err) {
    const code = classifyStorageError(err);
    if (code === null) throw err;
    return {
      status: "unreadable",
      reason: "storage_error",
      code,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    if (!parsed) return null;
    const mismatches = collectExtractorVersionMismatches(parsed, currentVersions);
    if (mismatches.length > 0) {
      const first = mismatches[0]!;
      return {
        status: "stale",
        reason: "extractor_version_mismatch",
        language: first.language,
        expected_version: first.expected,
        actual_version: first.actual,
        ...(mismatches.length > 1
          ? {
              mismatch_detail: mismatches
                .map(
                  (m) =>
                    `${m.language}: expected ${m.expected}, got ${m.actual}`,
                )
                .join("; "),
            }
          : {}),
      };
    }
    return { status: "ok", index: parsed };
  } catch {
    return null;
  }
}

/**
 * Check whether the stored `extractor_version` snapshot matches the current
 * set of extractor versions. Returns false when any language present in BOTH
 * `currentVersions` and `index.files` is missing from the stored snapshot or
 * has a different value. Languages added to `currentVersions` after this index
 * was written are tolerated when the index has no files in that language —
 * matches the tolerance applied by `collectExtractorVersionMismatches`. A missing
 * `extractor_version` field on a fully legacy index is still treated as a
 * version miss.
 */
export function isExtractorVersionCurrent(
  index: ExtractorVersionCheckable,
  currentVersions: Record<string, string>,
): boolean {
  if (!index.extractor_version) return false;
  return collectExtractorVersionMismatches(index, currentVersions).length === 0;
}

/**
 * A single pending edit to an on-disk index, waiting to be folded into the next
 * write. `apply` mutates the loaded index in place; `missing` decides what to do
 * when there is no index on disk at all.
 */
interface IndexMutation {
  /** Mutates in place; returns false when it was a no-op. */
  apply: (index: CodeIndex) => boolean;
  /** "throw" for updates that require an existing index, "skip" for removals. */
  missing: "throw" | "skip";
  resolve: () => void;
  reject: (err: unknown) => void;
}

const pendingMutations = new Map<string, IndexMutation[]>();
const scheduledFlushes = new Map<string, Promise<void>>();

/**
 * Count of full index rewrites. Exposed for tests: the whole point of batching
 * is that N queued edits cost fewer than N rewrites, and ESM will not let a
 * test spy on `node:fs/promises` to measure that from the outside.
 */
let indexWriteCount = 0;
export function getIndexWriteCountForTesting(): number {
  return indexWriteCount;
}
export function resetIndexWriteCountForTesting(): void {
  indexWriteCount = 0;
}

/**
 * Fold every queued mutation for one index into a SINGLE load + save.
 *
 * The index is one JSON blob per repo, so each write costs a full parse plus a
 * full stringify of the whole thing — 263 MB on tgm-survey-platform, 391 MB on
 * Mobi3. Agents edit in bursts and the PostToolUse hook calls index_file once
 * per edit, so the old one-write-per-edit path re-serialised the entire repo N
 * times for N files. Telemetry over 10,613 index_file calls: 235 ms median
 * overall, but 3.7 s median / 15.2 s p90 on tgm-survey-platform, 7.5 h of wall
 * clock in total. Batching collapses a burst of N edits to one parse+write.
 *
 * Ordering and durability are unchanged: mutations still apply in submission
 * order, and a caller's promise still resolves only once its own edit is on
 * disk. This does not fix the underlying whole-blob format — it removes the
 * repeated cost of it.
 */
async function flushIndexMutations(indexPath: string): Promise<void> {
  const batch = pendingMutations.get(indexPath);
  if (!batch || batch.length === 0) return;
  // Take ownership before the first await: anything queued from here on belongs
  // to the next flush, which the scheduler chains after this one.
  pendingMutations.delete(indexPath);

  try {
    const existing = await loadIndex(indexPath);
    if (!existing) {
      // Updates need an index to update; removals against a missing index are
      // already in the desired state.
      for (const mutation of batch) {
        if (mutation.missing === "throw") {
          mutation.reject(new Error(`Cannot incrementally update: index not found at ${indexPath}`));
        } else {
          mutation.resolve();
        }
      }
      return;
    }

    let changed = false;
    for (const mutation of batch) {
      if (mutation.apply(existing)) changed = true;
    }
    // A batch of pure no-ops (e.g. removing files the index never had) must not
    // rewrite the whole blob — that was the point of the old early return.
    if (changed) {
      existing.updated_at = Date.now();
      indexWriteCount++;
      await saveIndex(indexPath, existing);
    }
    for (const mutation of batch) mutation.resolve();
  } catch (err) {
    for (const mutation of batch) mutation.reject(err);
  }
}

/** Queue a mutation and make sure exactly one flush is pending per index. */
function enqueueIndexMutation(
  indexPath: string,
  missing: IndexMutation["missing"],
  apply: (index: CodeIndex) => boolean,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const queue = pendingMutations.get(indexPath);
    if (queue) queue.push({ apply, missing, resolve, reject });
    else pendingMutations.set(indexPath, [{ apply, missing, resolve, reject }]);

    // A flush already waiting has not drained yet, so it will pick this up.
    if (scheduledFlushes.has(indexPath)) return;

    const prev = writeLocks.get(indexPath) ?? Promise.resolve();
    const next = prev.then(() => {
      // Release the slot before draining so mutations that arrive during the
      // load/save schedule their own follow-up flush instead of being lost.
      scheduledFlushes.delete(indexPath);
      return flushIndexMutations(indexPath);
    });
    scheduledFlushes.set(indexPath, next);
    // Swallow errors on the lock chain so one failure cannot block later writers.
    writeLocks.set(indexPath, next.catch(() => {}));
  });
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
  if ((await resolveIndexBackend()) === "sqlite") {
    const dbPath = sqlitePathFor(indexPath);
    await ensureSqliteMigrated(indexPath, dbPath);
    // No mutation batching here on purpose: batching exists to amortise a whole-blob
    // rewrite, and this backend writes one file's rows inside a transaction instead.
    await saveIncrementalSqlite(dbPath, updatedFile, newSymbols, fileEntry);
    invalidateIndexCache(dbPath);
    return;
  }
  return enqueueIndexMutation(indexPath, "throw", (existing) => {
    const filtered = existing.symbols.filter((symbol) => symbol.file !== updatedFile);
    const merged = [...filtered, ...newSymbols];

    existing.symbols = merged;
    existing.symbol_count = merged.length;

    // Update files[] to keep it in sync
    if (fileEntry) {
      existing.files = existing.files.filter((f) => f.path !== updatedFile);
      existing.files.push(fileEntry);
      existing.file_count = existing.files.length;
    }
    // A re-index of a file always rewrites its symbols, so this is never a no-op.
    return true;
  });
}

/**
 * Remove all symbols and the file entry for a deleted file.
 * Serialized per indexPath to prevent read-modify-write races.
 */
export async function removeFileFromIndex(
  indexPath: string,
  deletedFile: string,
): Promise<void> {
  if ((await resolveIndexBackend()) === "sqlite") {
    const dbPath = sqlitePathFor(indexPath);
    await ensureSqliteMigrated(indexPath, dbPath);
    await removeFileFromIndexSqlite(dbPath, deletedFile);
    invalidateIndexCache(dbPath);
    return;
  }
  return enqueueIndexMutation(indexPath, "skip", (existing) => {
    const hadSymbols = existing.symbols.some((s) => s.file === deletedFile);
    const hadFile = existing.files.some((f) => f.path === deletedFile);
    if (!hadSymbols && !hadFile) return false;

    existing.symbols = existing.symbols.filter((s) => s.file !== deletedFile);
    existing.symbol_count = existing.symbols.length;
    existing.files = existing.files.filter((f) => f.path !== deletedFile);
    existing.file_count = existing.files.length;
    return true;
  });
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
