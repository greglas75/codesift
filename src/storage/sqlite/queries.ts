import type { CodeSymbol } from "../../types.js";
import { openIndexDb, openReadConnection, readMetaValue } from "./connection.js";
import { classifyStorageError, rethrowOperational } from "./errors.js";
import { rowToSymbol, type SymbolRow } from "./rows.js";
import { nextPageRows } from "./index-io.js";
import { getNativeCore, type NativeCore } from "../../native/index.js";

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
export const COLUMNS_WITHOUT_SOURCE =
  "id, file, name, kind, start_line, end_line, start_col, end_col, start_byte, end_byte, " +
  "signature, docstring, parent, is_async, is_exported, extras";

/**
 * SQLite's default parameter limit is 999. An `ids` list longer than that is a hard error rather
 * than a slow query, so it is chunked — and the chunks are unioned by the caller, not by SQL,
 * because a UNION would have to re-sort.
 */
export const MAX_BOUND_PARAMS = 900;

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
    // GLOB, not LIKE. SQLite's LIKE is case-INSENSITIVE for ASCII unless a pragma says otherwise,
    // so `LIKE 'create%'` also returned `CreateUser` — while the JSON branch and the resident-index
    // filter test `startsWith`, which is case-sensitive. That is a filter failing open on one
    // backend only: more rows than were asked for, silently. GLOB is case-sensitive and still uses
    // idx_symbols_name for a literal prefix. Its metacharacters `*`, `?` and `[` are escaped by
    // wrapping each in a bracket class, which GLOB reads as that one literal character.
    clauses.push("name GLOB ?");
    binds.push(`${query.namePrefix.replace(/[*?[]/g, "[$&]")}*`);
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
export function rowToSymbolNoSource(row: Omit<SymbolRow, "source">, repo: string): CodeSymbol {
  return rowToSymbol({ ...row, source: null } as SymbolRow, repo);
}

/**
 * The Rust core, when it serves this database (ADR-006 stage 1), else null.
 *
 * `openIndexDb` still runs first, through the TypeScript driver, and is cached after the first
 * call per path. It owns everything that WRITES on open — schema creation, the v1 -> v2 migration,
 * the newer `kind`/`parent` indexes — and the "written by a newer CodeSift" refusal. Skipping it
 * would let the native reader scan an old database without `idx_symbols_kind` (2 s instead of
 * 32 ms) or read one written by a newer schema; the Rust side therefore only ever issues SELECTs.
 *
 * `:memory:` stays on TypeScript: an in-memory database is private to the connection that made it,
 * so a second connection would see an empty one.
 */
async function nativeStoreFor(dbPath: string): Promise<NativeCore | null> {
  if (dbPath === ":memory:") return null;
  const core = getNativeCore("store");
  if (!core) return null;
  await openIndexDb(dbPath);
  return core;
}

/**
 * Route a native failure through the SAME classifier as the TypeScript path.
 *
 * The binding reports SQLite faults as `[sqlite:<extended code>] <message>`; the code goes back on
 * as `errcode`, which is the field `classifyStorageError` reads for node:sqlite errors. A locked or
 * corrupt database must become an `IndexStorageError` whichever implementation met it — otherwise
 * the fault falls into the "not indexed" branch, the failure this store's error handling exists for.
 */
export function rethrowNative(err: unknown, dbPath: string): never {
  const message = err instanceof Error ? err.message : String(err);
  const tagged = /^\[sqlite:(-?\d+)\] /.exec(message);
  if (tagged) {
    const like = Object.assign(new Error(message.slice(tagged[0].length)), { errcode: Number(tagged[1]) });
    // Unclassified (e.g. a plain SQLITE_ERROR) keeps the original error and its stack.
    if (classifyStorageError(like) !== null) rethrowOperational(like, dbPath);
    throw err;
  }
  // Not from SQLite — but classified like anything else the TypeScript path catches, so a fault
  // raised by a stream's own callback is treated identically on both paths.
  rethrowOperational(err, dbPath);
}

export async function findSymbolsSqlite(
  dbPath: string,
  query: SymbolQuery,
): Promise<CodeSymbol[]> {
  const native = await nativeStoreFor(dbPath);
  if (native) {
    let chunks: string[];
    try {
      chunks = await native.findSymbols(dbPath, query);
    } catch (err) {
      rethrowNative(err, dbPath);
    }
    // The only part of the query that runs on the event loop — one ~4 MB parse at a time, yielding
    // between them, so a large result costs other clients a few ms per chunk, not its whole size.
    if (chunks.length === 1) return JSON.parse(chunks[0]!) as CodeSymbol[];
    const out: CodeSymbol[] = [];
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await new Promise<void>((resolve) => setImmediate(resolve));
      for (const s of JSON.parse(chunks[i]!) as CodeSymbol[]) out.push(s);
      chunks[i] = ""; // release the text as soon as it is parsed
    }
    return out;
  }
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
      // ORDER BY rowid: the order a full load hands back (`readTablePaged` walks rowid), so a tool
      // moved from `index.symbols.filter(...)` onto this keeps its result order, and `limit` keeps
      // choosing the same rows. Without it the order is whatever index the planner picked — name
      // order for a prefix query — which is a different answer to "the first N", not a slower one.
      // For an equality on an indexed column SQLite satisfies this from the index itself (rowid is
      // every index's trailing key), so it costs no sort on the hot predicates.
      const rows = db
        .prepare(`SELECT ${columns} FROM symbols ${sql} ORDER BY rowid${limitSql}`)
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
  const native = await nativeStoreFor(dbPath);
  if (native) return streamSymbolsNative(native, dbPath, query, onBatch);
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
 * The native half of `streamSymbolsSqlite`: the SAME loop, with only the page fetch moved to Rust.
 *
 * Page sizing by time budget, termination on an empty page, the limit (counted per id chunk, as the
 * loop above counts it), early stop and the yields are all this function's — copied, not
 * re-derived, so the two paths cannot disagree about which symbols a stream delivers. What Rust adds
 * is that a page is read off the main thread, from one snapshot held open for the whole stream.
 */
async function streamSymbolsNative(
  native: NativeCore,
  dbPath: string,
  query: SymbolQuery,
  onBatch: (batch: CodeSymbol[]) => void | boolean | Promise<void | boolean>,
): Promise<void> {
  let snapshot: Awaited<ReturnType<NativeCore["openSnapshot"]>>;
  try {
    snapshot = await native.openSnapshot(dbPath);
  } catch (err) {
    rethrowNative(err, dbPath);
  }
  try {
    if (snapshot.repo === null || snapshot.repo === undefined) return;
    for (const idChunk of chunkIds(query.ids)) {
      let cursor = 0;
      let rows = 50;
      let seen = 0;
      for (;;) {
        const started = Date.now();
        const page = await snapshot.page(query, idChunk, cursor, rows);
        if (page.count === 0) break;
        cursor = page.lastRowid!;
        const batch = JSON.parse(page.json) as CodeSymbol[];
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
  } catch (err) {
    rethrowNative(err, dbPath);
  } finally {
    snapshot.close();
  }
}

/**
 * Root, repo and counts — for the 26 call sites that materialise 349 MB to read `index.root`, and
 * the two that materialise it to check whether the index exists at all
 * (`nest-pipeline-tools.ts:45`, `sql-dml-safety-tools.ts:32`).
 */
export async function getIndexMetaSqlite(dbPath: string): Promise<IndexMeta | null> {
  const native = await nativeStoreFor(dbPath);
  if (native) {
    let m: Awaited<ReturnType<NativeCore["indexMeta"]>>;
    try {
      m = await native.indexMeta(dbPath);
    } catch (err) {
      rethrowNative(err, dbPath);
    }
    if (m === null) return null;
    return {
      repo: m.repo,
      root: m.root,
      updatedAt: Number(m.updatedAt ?? 0),
      symbolCount: m.symbolCount,
      fileCount: m.fileCount,
    };
  }
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
