import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { CodeIndex, CodeSymbol, FileEntry } from "../types.js";
import { atomicWriteFile } from "./_shared.js";
import {
  isSqliteAvailable,
  loadIndexSqlite,
  saveIndexSqlite,
  saveIncrementalSqlite,
  removeFileFromIndexSqlite,
  getFileEntrySqlite,
  getDataVersion,
} from "./sqlite-index-store.js";

/** Serialize concurrent writes to the same index path. */
const writeLocks = new Map<string, Promise<void>>();

// ---------------------------------------------------------------------------
// Backend selection (ADR-003)
// ---------------------------------------------------------------------------

export type IndexBackend = "json" | "sqlite";

/**
 * Which on-disk format to use.
 *
 * `CODESIFT_INDEX_BACKEND=json` pins the legacy path (the documented rollback);
 * `=sqlite` demands the new one and fails loudly if `node:sqlite` is missing, so a CI run
 * cannot quietly exercise the wrong backend. Unset auto-detects, which is what keeps the
 * `engines: >=20` floor honest: Node 20 has no `node:sqlite` and simply stays on JSON.
 *
 * Read from the environment here rather than `config.ts` because the choice must be
 * resolvable from the short-lived `codesift postindex-file` hook process too, which never
 * builds a full config.
 */
let backendPromise: Promise<IndexBackend> | undefined;

export async function resolveIndexBackend(): Promise<IndexBackend> {
  backendPromise ??= computeIndexBackend();
  return backendPromise;
}

async function computeIndexBackend(): Promise<IndexBackend> {
  const explicit = process.env["CODESIFT_INDEX_BACKEND"];
  if (explicit === "json") return "json";
  if (explicit === "sqlite") {
    if (!(await isSqliteAvailable())) {
      throw new Error(
        "CODESIFT_INDEX_BACKEND=sqlite but node:sqlite is unavailable (requires Node >= 22.5)",
      );
    }
    return "sqlite";
  }
  return (await isSqliteAvailable()) ? "sqlite" : "json";
}

export function resetIndexBackendForTesting(): void {
  backendPromise = undefined;
}

/** `<hash>.index.json` -> `<hash>.index.db`, so both formats sit side by side and the JSON
 *  stays available as the rollback artifact. */
export function sqlitePathFor(indexPath: string): string {
  return indexPath.endsWith(".json")
    ? `${indexPath.slice(0, -".json".length)}.db`
    : `${indexPath}.db`;
}

/** Guards one-time JSON->SQLite migration per index path. */
const migrations = new Map<string, Promise<void>>();

/**
 * Bring an existing JSON index across on first touch.
 *
 * Deliberately non-destructive: the source `.json` is left in place. Deleting it would make
 * `CODESIFT_INDEX_BACKEND=json` a one-way door, and the whole point of shipping a rollback
 * switch is that it still has something to roll back to.
 */
async function ensureSqliteMigrated(indexPath: string, dbPath: string): Promise<void> {
  const inFlight = migrations.get(dbPath);
  if (inFlight) return inFlight;

  const run = (async () => {
    if ((await loadIndexSqlite(dbPath)) !== null) return; // already migrated
    const legacy = await loadJsonIndex(indexPath);
    if (legacy) await saveIndexSqlite(dbPath, legacy);
  })();

  migrations.set(dbPath, run);
  try {
    await run;
  } finally {
    // Keep the resolved marker only on success; a failed migration should be retried
    // rather than remembered as done.
    if (await isMigrated(dbPath)) migrations.set(dbPath, Promise.resolve());
    else migrations.delete(dbPath);
  }
}

async function isMigrated(dbPath: string): Promise<boolean> {
  try {
    return (await loadIndexSqlite(dbPath)) !== null;
  } catch {
    return false;
  }
}

export function resetMigrationCacheForTesting(): void {
  migrations.clear();
}

/**
 * Save a code index atomically.
 * Writes to a temp file first, then renames to prevent partial reads.
 */
export async function saveIndex(
  indexPath: string,
  index: CodeIndex,
): Promise<void> {
  if ((await resolveIndexBackend()) === "sqlite") {
    const dbPath = sqlitePathFor(indexPath);
    await saveIndexSqlite(dbPath, index);
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
 * Materialised-index cache, keyed by db path and validated against SQLite's `data_version`.
 *
 * Rebuilding 32k symbol objects out of rows is measurably *slower* than one big
 * `JSON.parse` (267 ms vs 91 ms on a 4k-file index), so without this the migration would
 * trade a faster write path for a slower read path — and reads happen on every tool call.
 *
 * A cache was impossible under JSON: the `codesift postindex-file` hook writes the same
 * index from its own process, and a plain file offers no way to notice. `PRAGMA
 * data_version` changes whenever *another* connection commits, which is exactly that
 * missing signal. It does NOT move for our own writes, so those invalidate explicitly
 * below — that asymmetry is a property of SQLite, not an oversight.
 *
 * The cached object is returned by reference. Callers treat `loadIndex` as a read API; the
 * one code path that mutates a loaded index (`flushIndexMutations`) belongs to the JSON
 * backend and never reaches here.
 */
interface CachedIndex {
  index: CodeIndex;
  dataVersion: number;
}
const indexCache = new Map<string, CachedIndex>();

function invalidateIndexCache(dbPath: string): void {
  indexCache.delete(dbPath);
}

export function resetIndexCacheForTesting(): void {
  indexCache.clear();
}

export function getIndexCacheSizeForTesting(): number {
  return indexCache.size;
}

/** Backend-agnostic read, without version enforcement. */
async function readIndex(indexPath: string): Promise<CodeIndex | null> {
  if ((await resolveIndexBackend()) === "sqlite") {
    const dbPath = sqlitePathFor(indexPath);
    await ensureSqliteMigrated(indexPath, dbPath);

    const dataVersion = await getDataVersion(dbPath);
    const cached = indexCache.get(dbPath);
    if (cached && cached.dataVersion === dataVersion) return cached.index;

    const index = await loadIndexSqlite(dbPath);
    if (index) indexCache.set(dbPath, { index, dataVersion });
    return index;
  }
  return loadJsonIndex(indexPath);
}

/** The legacy path, kept intact: it is both the Node 20 backend and the rollback target. */
async function loadJsonIndex(indexPath: string): Promise<CodeIndex | null> {
  try {
    const raw = await readFile(indexPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!isValidIndex(parsed)) return null;
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
export function collectExtractorVersionMismatches(
  index: CodeIndex,
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
  try {
    const parsed = await readIndex(indexPath);
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
  index: CodeIndex,
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
