import type { CodeSymbol } from "../../types.js";
import { openIndexDb, readMetaValue } from "./connection.js";
import { rethrowOperational } from "./errors.js";
import { rowToSymbol, type SymbolRow } from "./rows.js";
import { COLUMNS_WITHOUT_SOURCE, MAX_BOUND_PARAMS, rowToSymbolNoSource } from "./queries.js";

/**
 * Two narrow reads `SymbolQuery` cannot express, for the hot lookup tools (ADR-004 stage 2).
 *
 * Kept OUT of `SymbolQuery` on purpose. Every predicate added there has to be answered by three
 * hand-written filters — the SQL, the JSON branch and the resident-index filter in the tool layer —
 * and a clause one of them forgets does not throw, it returns MORE rows than were asked for. A
 * separate function with one obvious meaning is a filter nobody can half-implement.
 *
 * Both return rows in rowid order across every chunk: the order `readTablePaged` gives a full load,
 * so a tool moved off `index.symbols.filter(...)` keeps its result order — which several of them
 * expose directly (the candidate list of an ambiguous id, the first match of a name).
 */

type RowWithRid = SymbolRow & { _rid: number };

function chunk<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += MAX_BOUND_PARAMS) out.push(items.slice(i, i + MAX_BOUND_PARAMS));
  return out;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

/** Rows from several chunked queries, deduplicated by rowid and put back in rowid order. */
function inRowidOrder(rows: RowWithRid[], repo: string, withSource: boolean): CodeSymbol[] {
  const byRid = new Map<number, RowWithRid>();
  for (const row of rows) byRid.set(row._rid, row);
  return [...byRid.values()]
    .sort((a, b) => a._rid - b._rid)
    .map(({ _rid: _dropped, ...row }) =>
      withSource ? rowToSymbol(row as SymbolRow, repo) : rowToSymbolNoSource(row, repo),
    );
}

/**
 * `rows.push(...batch)` passes every row as a call argument, and V8 caps those: a `file IN (…)` or
 * `id IN (…)` chunk bounds the PARAMETERS at 900, not the rows, so one chunk over a minified or
 * generated file can return enough rows to throw `RangeError: Maximum call stack size exceeded`.
 */
function pushAll<T>(target: T[], batch: readonly T[]): void {
  for (const item of batch) target.push(item);
}

/**
 * Every symbol a caller could mean by one of `requestedIds`: its id equals the request, or its id
 * minus everything up to and including the FIRST `:` does. That second form is the short id the
 * lookup tools print (`file:name:line`, with the `repo:` prefix stripped), and agents pass it back.
 *
 * This is `symbolMatchesRequestedId` (storage/narrow-filters.ts), exactly, answered by an index probe
 * rather than a scan. The suffix form looks unindexable — "strip the first segment, then compare" —
 * but it is not, given one fact that two O(log n) probes establish: if the smallest and largest ids
 * share a prefix `P` that ends at the smallest id's first colon, EVERY id between them shares it
 * (lexicographic order cannot leave and re-enter a prefix), so every id's first colon sits at the
 * same place and "suffix equals r" is precisely "id equals P + r". Then both forms are one
 * `id IN (...)` on idx_symbols_id.
 *
 * When the ids do NOT share a prefix — a hand-assembled index, ids without a colon — the probe says
 * so and this falls back to a full scan of the symbols table with the suffix rule spelled out in SQL
 * (`substr(instr())` cannot use an index). Slower,
 * still exact; the fast path is never taken on an assumption about what ids look like.
 *
 * Colliding ids are returned as separate rows. Ids are `file:name:line`, which is not unique, and
 * the callers must be able to see a collision to refuse it.
 */
export async function findSymbolsByRequestedIdsSqlite(
  dbPath: string,
  requestedIds: readonly string[],
  withSource: boolean,
): Promise<CodeSymbol[]> {
  const db = await openIndexDb(dbPath);
  try {
    const repo = readMetaValue(db, "repo");
    if (repo === undefined) return [];
    const requested = [...new Set(requestedIds)];
    if (requested.length === 0) return [];

    const columns = withSource ? "*" : COLUMNS_WITHOUT_SOURCE;
    const bounds = db.prepare("SELECT MIN(id) AS lo, MAX(id) AS hi FROM symbols").get() as
      | { lo: string | null; hi: string | null }
      | undefined;
    const lo = bounds?.lo ?? null;
    const hi = bounds?.hi ?? null;
    if (lo === null || hi === null) return [];

    const firstColon = lo.indexOf(":");
    const sharedPrefix = firstColon >= 0 && hi.startsWith(lo.slice(0, firstColon + 1))
      ? lo.slice(0, firstColon + 1)
      : null;

    const rows: RowWithRid[] = [];
    if (sharedPrefix !== null) {
      const candidates = new Set<string>();
      for (const r of requested) {
        candidates.add(r);
        candidates.add(sharedPrefix + r);
      }
      for (const ids of chunk([...candidates])) {
        pushAll(rows, (db
          .prepare(`SELECT rowid AS _rid, ${columns} FROM symbols WHERE id IN (${placeholders(ids.length)})`)
          .all(...(ids as never[])) as unknown as RowWithRid[]));
      }
    } else {
      // Half the bound-parameter budget per chunk: each request is bound twice.
      for (let i = 0; i < requested.length; i += MAX_BOUND_PARAMS / 2) {
        const ids = requested.slice(i, i + MAX_BOUND_PARAMS / 2);
        const marks = placeholders(ids.length);
        pushAll(rows, (db
          .prepare(
            `SELECT rowid AS _rid, ${columns} FROM symbols WHERE id IN (${marks}) ` +
              `OR (instr(id, ':') > 0 AND substr(id, instr(id, ':') + 1) IN (${marks}))`,
          )
          .all(...(ids as never[]), ...(ids as never[])) as unknown as RowWithRid[]));
      }
    }
    return inRowidOrder(rows, repo, withSource);
  } catch (err) {
    rethrowOperational(err, dbPath);
  }
}

/**
 * Every symbol in any of `files`, in rowid order.
 *
 * For the diff tools, which need the symbols of the files a git range touched and used to filter
 * all of them to find those. One `file IN (...)` per chunk on idx_symbols_file — not one query per
 * file, which on a several-thousand-file range would cost more than the load it replaces.
 */
export async function findSymbolsInFilesSqlite(
  dbPath: string,
  files: readonly string[],
  withSource: boolean,
): Promise<CodeSymbol[]> {
  const db = await openIndexDb(dbPath);
  try {
    const repo = readMetaValue(db, "repo");
    if (repo === undefined) return [];
    const wanted = [...new Set(files)];
    if (wanted.length === 0) return [];
    const columns = withSource ? "*" : COLUMNS_WITHOUT_SOURCE;
    const rows: RowWithRid[] = [];
    for (const paths of chunk(wanted)) {
      pushAll(rows, (db
        .prepare(`SELECT rowid AS _rid, ${columns} FROM symbols WHERE file IN (${placeholders(paths.length)})`)
        .all(...(paths as never[])) as unknown as RowWithRid[]));
    }
    return inRowidOrder(rows, repo, withSource);
  } catch (err) {
    rethrowOperational(err, dbPath);
  }
}

/**
 * Every distinct symbol name, in order of first appearance (rowid) — the vocabulary the zero-hit
 * suggestions rank. One grouped scan on idx_symbols_name: 0.2 s for 258k names out of 1.4M symbols,
 * where materialising the symbols to read their names took 8-13 s. Case-sensitive (BINARY), like
 * `new Set(names)`.
 */
export async function findSymbolNamesSqlite(dbPath: string): Promise<string[]> {
  const db = await openIndexDb(dbPath);
  try {
    if (readMetaValue(db, "repo") === undefined) return [];
    const rows = db
      .prepare("SELECT name FROM symbols GROUP BY name ORDER BY MIN(rowid)")
      .all() as unknown as Array<{ name: string }>;
    return rows.map((row) => row.name);
  } catch (err) {
    rethrowOperational(err, dbPath);
  }
}
