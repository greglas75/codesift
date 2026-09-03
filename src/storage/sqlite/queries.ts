import type { CodeSymbol } from "../../types.js";
import { openIndexDb, openReadConnection, readMetaValue } from "./connection.js";
import { rethrowOperational } from "./errors.js";
import { rowToSymbol, type SymbolRow } from "./rows.js";
import { nextPageRows } from "./index-io.js";

/**
 * Ask the database for the rows a tool needs, instead of materialising the whole index.
 *
 * A cold `getCodeIndex` builds 349 MB and ~352,000 objects for the largest repo here, through a
 * synchronous SQLite API, and hands the same object to every caller. Measured against that:
 *
 *     WHERE name = ?      9 ms        WHERE kind = ?     32 ms (after idx_symbols_kind)
 *     WHERE file = ?     10 ms        materialise all   ~10,000 ms
 *
 * Three orders of magnitude, and the classification of the 159 call sites says 31% of them need no
 * array at all — a metadata read or a single WHERE.
 */

/**
 * `withSource` has NO DEFAULT, on purpose.
 *
 * `source` is 45% of the footprint — roughly 650 bytes per symbol — and two thirds of call sites
 * never read it. But omitting the column silently is the dangerous half: `rowToSymbol` does
 * `if (row.source !== null) sym.source = row.source`, so a projected-away column arrives as
 * `undefined` and produces a symbol that is INDISTINGUISHABLE from one whose source is genuinely
 * empty. A caller would read "this function has no body" as a fact about the code.
 *
 * Requiring the flag makes the compiler ask the question at every call site. When it is false the
 * key is omitted entirely rather than set to undefined, so `"source" in symbol` is an honest test.
 */
export interface SymbolQuery {
  withSource: boolean;
  file?: string;
  name?: string;
  /** Prefix only. A leading `%` cannot use idx_symbols_name and degrades to a full scan. */
  namePrefix?: string;
  kind?: string;
  parent?: string;
  ids?: readonly string[];
  limit?: number;
}

export interface IndexMeta {
  repo: string;
  root: string;
  updatedAt: number;
  symbolCount: number;
  fileCount: number;
}

/** Every column except `source`, so the projection can drop the expensive one by name. */
const COLUMNS_WITHOUT_SOURCE =
  "id, file, name, kind, start_line, end_line, start_col, end_col, start_byte, end_byte, " +
  "signature, docstring, parent, is_async, is_exported, extras";

/**
 * SQLite's default parameter limit is 999. An `ids` list longer than that is a hard error rather
 * than a slow query, so it is chunked — and the chunks are unioned by the caller, not by SQL,
 * because a UNION would have to re-sort.
 */
const MAX_BOUND_PARAMS = 900;

interface Predicate {
  sql: string;
  binds: unknown[];
}

function buildPredicate(query: SymbolQuery, idChunk?: readonly string[]): Predicate {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (query.file !== undefined) { clauses.push("file = ?"); binds.push(query.file); }
  if (query.name !== undefined) { clauses.push("name = ?"); binds.push(query.name); }
  if (query.namePrefix !== undefined) {
    // `LIKE 'x%'` uses idx_symbols_name; the ESCAPE clause keeps a literal % or _ in a symbol name
    // from turning into a wildcard, which would silently widen the query.
    clauses.push("name LIKE ? ESCAPE '\\'");
    binds.push(`${query.namePrefix.replace(/[\\%_]/g, "\\$&")}%`);
  }
  if (query.kind !== undefined) { clauses.push("kind = ?"); binds.push(query.kind); }
  if (query.parent !== undefined) { clauses.push("parent = ?"); binds.push(query.parent); }
  if (idChunk !== undefined) {
    clauses.push(`id IN (${idChunk.map(() => "?").join(",")})`);
    binds.push(...idChunk);
  }
  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", binds };
}

function chunkIds(ids: readonly string[] | undefined): Array<readonly string[] | undefined> {
  if (ids === undefined) return [undefined];
  if (ids.length === 0) return [];
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += MAX_BOUND_PARAMS) out.push([...ids.slice(i, i + MAX_BOUND_PARAMS)]);
  return out;
}

/**
 * Map a row whose `source` column was never selected.
 *
 * Not `rowToSymbol` with a patched row: that mapper tests `row.source !== null`, and `undefined`
 * passes that test. Giving it an explicit null is what keeps the key absent rather than present
 * and undefined — the distinction the whole `withSource` contract rests on.
 */
function rowToSymbolNoSource(row: Omit<SymbolRow, "source">, repo: string): CodeSymbol {
  return rowToSymbol({ ...row, source: null } as SymbolRow, repo);
}

export async function findSymbolsSqlite(
  dbPath: string,
  query: SymbolQuery,
): Promise<CodeSymbol[]> {
  const db = await openIndexDb(dbPath);
  try {
    const repo = readMetaValue(db, "repo");
    if (repo === undefined) return [];
    const columns = query.withSource ? "*" : COLUMNS_WITHOUT_SOURCE;
    const out: CodeSymbol[] = [];
    for (const idChunk of chunkIds(query.ids)) {
      if (query.limit !== undefined && out.length >= query.limit) break;
      const { sql, binds } = buildPredicate(query, idChunk);
      const remaining = query.limit === undefined ? undefined : query.limit - out.length;
      const limitSql = remaining === undefined ? "" : ` LIMIT ${Math.max(0, remaining)}`;
      const rows = db
        .prepare(`SELECT ${columns} FROM symbols ${sql}${limitSql}`)
        .all(...(binds as never[])) as unknown as SymbolRow[];
      for (const row of rows) {
        out.push(query.withSource ? rowToSymbol(row, repo) : rowToSymbolNoSource(row, repo));
      }
    }
    return out;
  } catch (err) {
    // Corruption surfaces on the first page touched, not at open, and callers use
    // `isIndexStorageError` to tell a storage fault from "nothing indexed here". Without this the
    // read falls into the branch that reports an unindexed repo — a fault rendered as an empty
    // answer, which is the worst shape a search result can take.
    rethrowOperational(err, dbPath);
  }
}

/**
 * Fold over matching symbols in pages, yielding the event loop between them.
 *
 * For the whole-scan callers (bucket A: 37 of 159 call sites) that genuinely have to see every
 * symbol but never need them all resident at once — regex scanners, adjacency builders, vocabulary
 * collectors. They fold and discard, so holding 352,000 objects was never the requirement.
 *
 * A private read connection, like `loadIndexSqlite`: the pages must come from ONE snapshot, and
 * this yields between them, so a shared connection could observe another process's commit halfway
 * through and return a mixture of two states.
 */
export async function streamSymbolsSqlite(
  dbPath: string,
  query: SymbolQuery,
  /** Return `false` to stop early — for callers with a wall-clock budget, which must be able to
   *  abandon a scan without reading the rest of the table. */
  onBatch: (batch: CodeSymbol[]) => void | boolean | Promise<void | boolean>,
): Promise<void> {
  const reader = await openReadConnection(dbPath);
  try {
    const repo = readMetaValue(reader, "repo");
    if (repo === undefined) return;
    const columns = query.withSource ? "*" : COLUMNS_WITHOUT_SOURCE;
    reader.exec("BEGIN");
    try {
      for (const idChunk of chunkIds(query.ids)) {
        const { sql, binds } = buildPredicate(query, idChunk);
        const where = sql === "" ? "WHERE rowid > ?" : `${sql} AND rowid > ?`;
        const stmt = reader.prepare(
          `SELECT rowid AS _rid, ${columns} FROM symbols ${where} ORDER BY rowid LIMIT ?`,
        );
        let cursor = 0;
        let rows = 50;
        let seen = 0;
        for (;;) {
          const started = Date.now();
          const page = stmt.all(...(binds as never[]), cursor, rows) as unknown as Array<
            SymbolRow & { _rid: number }
          >;
          // Terminate on EMPTY, not on a short page.
          //
          // With the filter in SQL a short page does in fact mean exhaustion — LIMIT counts
          // MATCHES, not scanned rows — so `page.length < rows` would be correct today. It is not
          // used anyway, for one round-trip: the moment anyone adds a post-fetch filter in JS (the
          // obvious way to express a predicate SQL cannot), the short-page test silently becomes
          // "stop at the first sparsely-matching stretch and report success". Costing one extra
          // query to remove that trap is the right trade in a reader that folds over 352,000 rows.
          if (page.length === 0) break;
          cursor = page[page.length - 1]!._rid;
          const batch = page.map((row) =>
            query.withSource ? rowToSymbol(row, repo) : rowToSymbolNoSource(row, repo),
          );
          seen += batch.length;
          if (query.limit !== undefined && seen >= query.limit) {
            await onBatch(batch.slice(0, batch.length - (seen - query.limit)));
            break;
          }
          if ((await onBatch(batch)) === false) break;
          rows = nextPageRows(rows, Date.now() - started);
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    } finally {
      try { reader.exec("COMMIT"); } catch { /* the close below is what matters */ }
    }
  } catch (err) {
    rethrowOperational(err, dbPath);
  } finally {
    try { reader.close(); } catch { /* already gone */ }
  }
}

/**
 * Root, repo and counts — for the 26 call sites that materialise 349 MB to read `index.root`, and
 * the two that materialise it to check whether the index exists at all
 * (`nest-pipeline-tools.ts:45`, `sql-dml-safety-tools.ts:32`).
 */
export async function getIndexMetaSqlite(dbPath: string): Promise<IndexMeta | null> {
  const db = await openIndexDb(dbPath);
  try {
    const repo = readMetaValue(db, "repo");
    const root = readMetaValue(db, "root");
    if (repo === undefined || root === undefined) return null;
    const symbolCount = (db.prepare("SELECT COUNT(*) AS n FROM symbols").get() as { n: number }).n;
    const fileCount = (db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number }).n;
    return {
      repo,
      root,
      updatedAt: Number(readMetaValue(db, "updated_at") ?? 0),
      symbolCount,
      fileCount,
    };
  } catch (err) {
    rethrowOperational(err, dbPath);
  }
}
