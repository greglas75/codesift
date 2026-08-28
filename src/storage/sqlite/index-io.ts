import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { CodeIndex, CodeSymbol, FileEntry } from "../../types.js";
import { recordIndexFootprint } from "../index-footprint.js";
import {
  openIndexDb,
  openReadConnection,
  readMetaValue,
  rollbackQuietly,
  writeMetaValue,
  maybeCheckpointWal,
} from "./connection.js";
import { rethrowOperational } from "./errors.js";
import { readMetaExtras } from "./meta.js";
import {
  INSERT_FILE_SQL,
  INSERT_SYMBOL_SQL,
  fileEntryToRow,
  fileRowBytes,
  rowToFileEntry,
  rowToSymbol,
  symbolRowBytes,
  symbolToRow,
  type FileRow,
  type SymbolRow,
} from "./rows.js";
import { SCHEMA_VERSION } from "./schema.js";

/**
 * Whole-index read and write: the paths that touch every row.
 *
 * These are the operations the narrow accessors exist to avoid, kept together because they share
 * the same two invariants — one transaction per logical read, and `repo` written last so a
 * half-written index reads as empty rather than as a complete one.
 */

/**
 * Replace the entire index. Used by full (re)indexing and by JSON->SQLite migration.
 *
 * `sourceComplete` means every symbol in `index` came from parsing the file it belongs to during
 * THIS run — the only condition under which the `lossy_v1_migration` marker can honestly be
 * cleared. It defaults to false, and the default is the point: rewriting every row is NOT the
 * same as re-reading every file. `index_folder` reuses cached symbols for files whose mtime has
 * not moved, and `enqueueIndexMutation` folds a single-file edit into a whole-index rewrite that
 * arrives here indistinguishable from a real reindex. An earlier version cleared the marker on
 * any call and so erased the warning on the next keystroke after an upgrade.
 *
 * Defaulting to "still lossy" errs toward over-warning, which a reindex clears, rather than
 * toward silence, which nothing does.
 */
export async function saveIndexSqlite(
  dbPath: string,
  index: CodeIndex,
  opts?: { sourceComplete?: boolean },
): Promise<void> {
  const db = await openIndexDb(dbPath);

  db.exec("BEGIN");
  try {
    writeIndexRows(db, index);
    if (opts?.sourceComplete === true) {
      db.prepare("DELETE FROM meta WHERE key = ?").run("lossy_v1_migration");
    }
    db.exec("COMMIT");
    // AFTER the commit, never inside the transaction: a checkpoint cannot run in one, and it must
    // not be able to fail a write that already succeeded.
    maybeCheckpointWal(db, dbPath);
  } catch (err) {
    rollbackQuietly(db);
    // Classified here, not left raw. `saveIndex`/`saveIncremental` have no classifying boundary of
    // their own, so a SQLITE_BUSY or a full disk during a write used to reach the tool layer as an
    // anonymous Error — carrying the same information as a bug in our own code.
    rethrowOperational(err, dbPath);
  }
}

/**
 * True when this database was upgraded from the v1 schema, whose PRIMARY KEY on a non-unique
 * `symbols.id` silently discarded colliding rows. The rebuild preserved everything still stored,
 * but cannot recover what was already gone — so a short symbol list here is a fact about the
 * migration, not about the code. Cleared by a full reindex.
 */
export async function wasLossilyMigrated(dbPath: string): Promise<boolean> {
  const db = await openIndexDb(dbPath);
  return readMetaValue(db, "lossy_v1_migration") !== undefined;
}

/**
 * Replace all rows + meta. Caller owns the transaction.
 *
 * `repo` is written here, inside that transaction, and `loadIndexSqlite` treats its absence
 * as "no index" — so a write killed midway rolls back and the db reads as empty rather than
 * as a partially-populated index that later looks complete.
 */
function writeIndexRows(db: DatabaseSyncType, index: CodeIndex): void {
  db.exec("DELETE FROM symbols");
  db.exec("DELETE FROM files");

  const insSym = db.prepare(INSERT_SYMBOL_SQL);
  for (const sym of index.symbols) insSym.run(...(symbolToRow(sym) as never[]));

  const insFile = db.prepare(INSERT_FILE_SQL);
  for (const file of index.files) insFile.run(...(fileEntryToRow(file) as never[]));

  writeMetaValue(db, "repo", index.repo);
  writeMetaValue(db, "root", index.root);
  writeMetaValue(db, "created_at", String(index.created_at));
  writeMetaValue(db, "updated_at", String(index.updated_at));
  writeMetaValue(db, "extractor_version", JSON.stringify(index.extractor_version ?? null));
  writeMetaValue(db, "workspaces", JSON.stringify(index.workspaces ?? null));
  writeMetaValue(db, "schema_version", String(SCHEMA_VERSION));
}

/**
 * Import a legacy JSON index, but only if this db is still empty — decided and written
 * inside ONE `BEGIN IMMEDIATE` transaction.
 *
 * The check-then-act cannot be done in JS: `codesift postindex-file` is a fresh process per
 * edit, so two of them (or one plus the server) can both observe an empty db, both read the
 * same legacy JSON, and the slower writer then overwrites an incremental update the faster
 * one already committed. An in-process guard cannot see the other process at all.
 *
 * `BEGIN IMMEDIATE` takes the write lock before the emptiness check, so the second writer
 * either waits and then sees the committed import (returns false), or fails on busy_timeout —
 * never silently clobbers. Returns true when this call performed the import.
 */
export async function importLegacyIndexIfEmpty(
  dbPath: string,
  index: CodeIndex,
): Promise<boolean> {
  const db = await openIndexDb(dbPath);

  db.exec("BEGIN IMMEDIATE");
  try {
    if (readMetaValue(db, "repo") !== undefined) {
      db.exec("ROLLBACK");
      return false; // another process got there first
    }
    writeIndexRows(db, index);
    db.exec("COMMIT");
    return true;
  } catch (err) {
    rollbackQuietly(db);
    rethrowOperational(err, dbPath);
  }
}

/**
 * Read a whole table into objects a page at a time, yielding between pages.
 *
 * Materializing an index is the single longest CPU burst in the process, and under the shared
 * daemon it is not the caller's own time being spent — every other client's request is stalled
 * behind it. Measured on this machine's largest index (240,133 symbols): a plain `.map()` blocked
 * the loop for 4.8 s with ZERO timer ticks in that window, so `/health` stopped answering and one
 * client's first cold request looked to everyone else like the daemon had died.
 *
 * The block to remove is `.all()`, not the `.map()` after it: it materializes every row into JS
 * before any of our code runs, so chunking only the mapping still leaves one unbroken stall.
 *
 * A/B'd in one process, alternating, 3 runs each, on the largest index here (240,133
 * symbols) — separate processes are useless for this, the page cache moved the same
 * measurement by 2x:
 *
 *     .all() + map    median 5609 ms   0 timer ticks — the loop never ran at all
 *     paged           median 4635 ms   12 ticks/run
 *
 * So this is not the usual responsiveness-for-throughput trade: paging is BOTH faster and
 * interruptible, because a page is one bulk `.all()` over a rowid range and SQLite never
 * has to hold the whole result set. `iterate()` also fixes the stall but gives up the bulk
 * fetch per row.
 *
 * `setImmediate` rather than a microtask: a promise continuation would run before I/O and timers,
 * which is exactly the work being starved. The chunk size is what keeps the yield itself cheap —
 * per-item yielding turned the same load into minutes.
 *
 * The page is sized by TIME, not rows, because yielding is not sufficient on its own — an
 * HTTP server only answers between pages, so the page length is the latency floor. Measured
 * against a live server polled every 50 ms while pages of a given length ran:
 *
 *     page 400 ms   6 answered, 8 timed out, worst latency 2182 ms
 *     page 200 ms  19 answered, 0 timed out, worst latency  489 ms
 *     page  50 ms  78 answered, 0 timed out, worst latency  226 ms
 *
 * and the row count that lands on 50 ms is not a constant: profiling the daemon mid-freeze
 * put 8,016 of 10,113 samples in `StatementSync::All` with GC on the rest, because the same
 * page that costs milliseconds on a fresh heap costs seconds on a daemon already holding
 * several indexes. Hence the feedback loop rather than a tuned constant.
 *
 * Keyset pagination on rowid, never OFFSET: OFFSET re-scans the skipped rows on every page,
 * turning a linear read into a quadratic one exactly on the biggest indexes this exists for.
 */
const PAGE_TARGET_MS = 50;
const PAGE_MIN_ROWS = 500;
const PAGE_MAX_ROWS = 20_000;

async function readTablePaged<T, R>(
  db: DatabaseSyncType,
  table: string,
  fn: (row: T) => R,
): Promise<R[]> {
  const stmt = db.prepare(
    `SELECT rowid AS _rid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  );
  const out: R[] = [];
  let cursor = 0;
  let rows = 4_000;
  for (;;) {
    const started = Date.now();
    const page = stmt.all(cursor, rows) as unknown as Array<T & { _rid: number }>;
    if (page.length === 0) return out;
    for (const row of page) out.push(fn(row));
    const elapsed = Date.now() - started;
    cursor = page[page.length - 1]!._rid;
    if (page.length < rows) return out;
    // Aim the NEXT page at the time budget rather than a row count. Per-row cost is not a
    // property of the data: the same page costs milliseconds on a fresh heap and seconds
    // under a daemon already holding several indexes, because allocating a few thousand
    // objects there lands in incremental marking. A fixed row count is therefore tuned for
    // one heap and wrong for the other; a fixed time budget holds in both.
    rows = Math.max(PAGE_MIN_ROWS, Math.min(PAGE_MAX_ROWS,
      Math.round(rows * (PAGE_TARGET_MS / Math.max(elapsed, 1)))));
    await new Promise<void>((r) => setImmediate(r));
  }
}

/** Materialise the whole index. Returns null when the db has never been written to. */
export async function loadIndexSqlite(dbPath: string): Promise<CodeIndex | null> {
  // Called for its side effects, not its handle: this is what creates the schema and runs the
  // v1->v2 migration. The read below deliberately uses its own connection instead (see the
  // snapshot comment), so there is nothing here to bind.
  await openIndexDb(dbPath);

  let repo: string | undefined;
  let root: string | undefined;
  let symbols: CodeSymbol[] = [];
  let files: FileEntry[] = [];
  let meta: Record<string, string | undefined> = {};
  let reader: DatabaseSyncType | undefined;
  let footprint = 0;
  try {
    // EVERYTHING that goes into the returned index is read inside ONE transaction on a private
    // connection, so every field describes the same instant. The paged reader yields between
    // pages; without the snapshot a write arriving during a yield would be half-included, and
    // `symbols` could disagree with `files` in the very object callers treat as consistent.
    //
    // The meta reads belong inside it for the same reason and are easy to leave out — the first
    // version of this did exactly that, taking `repo`/`root` before the transaction opened and
    // `created_at`/`updated_at`/`extractor_version`/`workspaces` after it committed. That is a
    // narrower window, not a closed one: a concurrent `saveIndexSqlite` landing in either gap
    // yields metadata from one revision paired with rows from another, which is worse than an
    // obviously stale index because every field is individually valid.
    reader = await openReadConnection(dbPath);
    reader.exec("BEGIN");
    try {
      repo = readMetaValue(reader, "repo");
      root = readMetaValue(reader, "root");
      if (repo === undefined || root === undefined) {
        reader.exec("COMMIT");
        return null; // genuinely empty — not a fault
      }
      const owner = repo;
      for (const key of [
        "created_at",
        "updated_at",
        "extractor_version",
        "workspaces",
        "lossy_v1_migration",
      ]) {
        meta[key] = readMetaValue(reader, key);
      }
      symbols = await readTablePaged<SymbolRow, CodeSymbol>(reader, "symbols", (row) => {
        footprint += symbolRowBytes(row);
        return rowToSymbol(row, owner);
      });
      files = await readTablePaged<FileRow, FileEntry>(reader, "files", (row) => {
        footprint += fileRowBytes(row);
        return rowToFileEntry(row);
      });
      reader.exec("COMMIT");
    } catch (err) {
      rollbackQuietly(reader);
      throw err;
    }
  } catch (err) {
    // Corruption often only surfaces on the first page read, not at open time.
    rethrowOperational(err, dbPath);
  } finally {
    try { reader?.close(); } catch { /* best-effort; the snapshot is done with either way */ }
  }

  const index: CodeIndex = {
    repo,
    root,
    symbols,
    files,
    created_at: Number(meta["created_at"] ?? 0),
    updated_at: Number(meta["updated_at"] ?? 0),
    symbol_count: symbols.length,
    file_count: files.length,
  };

  // `lossy_migration` rides on the index itself rather than behind an accessor callers must know
  // to call: the first version of that marker was written on migration, exported, and consulted by
  // nobody, so a lossy index still answered like a complete one.
  Object.assign(index, readMetaExtras((k) => meta[k]));

  recordIndexFootprint(index, footprint);
  return index;
}
