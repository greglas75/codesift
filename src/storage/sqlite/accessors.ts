import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { CodeSymbol, FileEntry } from "../../types.js";
import {
  openIndexDb,
  openReadConnection,
  readMetaValue,
  rollbackQuietly,
  writeMetaValue,
} from "./connection.js";
import { rethrowOperational } from "./errors.js";
import { readMetaExtras, type IndexSummary } from "./meta.js";
import {
  INSERT_FILE_SQL,
  INSERT_SYMBOL_SQL,
  fileEntryToRow,
  rowToFileEntry,
  rowToSymbol,
  symbolToRow,
  type FileRow,
  type SymbolRow,
} from "./rows.js";

/**
 * Narrow accessors — the reason this backend exists.
 *
 * Every function here answers a question WITHOUT materialising the index. Under the JSON backend
 * each of these cost a full parse of the whole repo's symbols; that is the cost ADR-003 set out to
 * remove and ADR-004 stage 2 is still working through call site by call site.
 */

/**
 * One file's `mtime_ms`, without materialising the index.
 *
 * `file-indexer.ts` used to parse the whole blob for exactly this value and then
 * `saveIncremental` parsed it a second time — two full parses of 262 MB to decide whether a
 * 40-line file had changed.
 */
export async function getFileMtimeSqlite(
  dbPath: string,
  filePath: string,
): Promise<number | undefined> {
  const db = await openIndexDb(dbPath);
  const row = db.prepare("SELECT mtime_ms FROM files WHERE path = ?").get(filePath) as
    | { mtime_ms: number | null }
    | undefined;
  return row?.mtime_ms ?? undefined;
}

/**
 * Read an index without constructing its symbols.
 *
 * Measured on the real tgm-survey-platform index (240,137 symbols): a full load costs ~1.0 s and
 * 349 MB of resident heap, essentially all of it building symbol objects. Tools that never touch
 * `index.symbols` — `index_status` is the clearest, it reports counts it reads from metadata — paid
 * that in full for nothing.
 */
export async function loadIndexSummarySqlite(dbPath: string): Promise<IndexSummary | null> {
  await openIndexDb(dbPath);
  let reader: DatabaseSyncType | undefined;
  let out: IndexSummary | null = null;
  try {
    // Same one-transaction rule as `loadIndexSqlite`: files and meta must describe one instant,
    // or the summary reports a file list from one revision with counts from another.
    // Bound to a `const` as well as to `reader`: the closure below outlives the narrowing of the
    // `let`, so reading it through `reader` needed an `as` cast that asserted away an `undefined`
    // the compiler was right to track. The local carries the non-optional type honestly.
    const snapshot = await openReadConnection(dbPath);
    reader = snapshot;
    snapshot.exec("BEGIN");
    try {
      const meta = (key: string): string | undefined => readMetaValue(snapshot, key);
      const repo = meta("repo");
      const root = meta("root");
      if (repo === undefined || root === undefined) {
        snapshot.exec("COMMIT");
        return null; // genuinely empty — not a fault
      }

      // ORDER BY rowid, matching `readTablePaged`'s keyset walk. Without it the two SQLite read
      // paths could hand back the same files in different orders, so a caller comparing a summary
      // against a full load would see a difference that is not in the data.
      const files = (
        snapshot.prepare("SELECT * FROM files ORDER BY rowid").all() as unknown as FileRow[]
      ).map(rowToFileEntry);
      const counted = snapshot.prepare("SELECT COUNT(*) AS n FROM symbols").get() as
        | { n: number }
        | undefined;

      const summary: IndexSummary = {
        repo,
        root,
        files,
        created_at: Number(meta("created_at") ?? 0),
        updated_at: Number(meta("updated_at") ?? 0),
        symbol_count: Number(counted?.n ?? 0),
        file_count: files.length,
      };

      Object.assign(summary, readMetaExtras(meta));

      snapshot.exec("COMMIT");
      out = summary;
    } catch (err) {
      rollbackQuietly(snapshot);
      throw err;
    }
  } catch (err) {
    rethrowOperational(err, dbPath);
  } finally {
    try { reader?.close(); } catch { /* best-effort */ }
  }
  return out;
}

/** One file's `files[]` entry, without materialising the index. */
export async function getFileEntrySqlite(
  dbPath: string,
  filePath: string,
): Promise<FileEntry | undefined> {
  const db = await openIndexDb(dbPath);
  const row = db.prepare("SELECT * FROM files WHERE path = ?").get(filePath) as unknown as
    | FileRow
    | undefined;
  return row ? rowToFileEntry(row) : undefined;
}

/** Replace one file's symbols (and optionally its files[] entry) in a single transaction. */
export async function saveIncrementalSqlite(
  dbPath: string,
  updatedFile: string,
  newSymbols: CodeSymbol[],
  fileEntry?: FileEntry,
): Promise<void> {
  const db = await openIndexDb(dbPath);

  if (readMetaValue(db, "repo") === undefined) {
    throw new Error(`Cannot incrementally update: index not found at ${dbPath}`);
  }

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM symbols WHERE file = ?").run(updatedFile);

    const insSym = db.prepare(INSERT_SYMBOL_SQL);
    for (const sym of newSymbols) insSym.run(...(symbolToRow(sym) as never[]));

    if (fileEntry) db.prepare(INSERT_FILE_SQL).run(...(fileEntryToRow(fileEntry) as never[]));

    writeMetaValue(db, "updated_at", String(Date.now()));
    db.exec("COMMIT");
  } catch (err) {
    rollbackQuietly(db);
    rethrowOperational(err, dbPath);
  }
}

/** Drop a deleted file's symbols and its files[] entry. */
export async function removeFileFromIndexSqlite(
  dbPath: string,
  deletedFile: string,
): Promise<void> {
  const db = await openIndexDb(dbPath);
  if (readMetaValue(db, "repo") === undefined) return; // nothing to remove

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM symbols WHERE file = ?").run(deletedFile);
    db.prepare("DELETE FROM files WHERE path = ?").run(deletedFile);
    writeMetaValue(db, "updated_at", String(Date.now()));
    db.exec("COMMIT");
  } catch (err) {
    rollbackQuietly(db);
    rethrowOperational(err, dbPath);
  }
}

/** All symbols for one file — lets per-file tools skip the whole-index load. */
export async function getSymbolsForFileSqlite(
  dbPath: string,
  filePath: string,
): Promise<CodeSymbol[]> {
  const db = await openIndexDb(dbPath);
  const repo = readMetaValue(db, "repo");
  if (repo === undefined) return [];
  const rows = db
    .prepare("SELECT * FROM symbols WHERE file = ?")
    .all(filePath) as unknown as SymbolRow[];
  return rows.map((row) => rowToSymbol(row, repo));
}

/**
 * Cross-process change counter. SQLite bumps `data_version` when *another* connection
 * commits, which is the invalidation signal a plain JSON file never had — and the reason an
 * in-memory index cache becomes safe here despite the hook writing from its own process.
 */
export async function getDataVersion(dbPath: string): Promise<number> {
  const db = await openIndexDb(dbPath);
  const row = db.prepare("PRAGMA data_version").get() as { data_version: number };
  return row.data_version;
}
