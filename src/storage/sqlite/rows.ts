import type { CodeSymbol, FileEntry } from "../../types.js";

/**
 * Row <-> domain mapping, and the byte accounting that goes with it.
 *
 * Fidelity over elegance: hot fields get real columns (so a full load builds objects without
 * parsing anything), and the rarely-populated tail is kept as one JSON `extras` column.
 *
 * The footprint helpers live here rather than with the loader because they are a property of the
 * ROW SHAPE — they have to change whenever a column does, and keeping them next to the mapping is
 * what makes that obvious to whoever adds the column.
 */

/** Fields that live in `extras` rather than getting their own column: present on a minority
 *  of symbols, and language-specific enough that hard-coding them as columns would mean a
 *  schema migration every time an extractor learns a new trick. */
interface SymbolExtras {
  tokens?: string[];
  decorators?: string[];
  extends?: string[];
  implements?: string[];
  meta?: Record<string, unknown>;
}

export type SymbolRow = {
  id: string;
  file: string;
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
  start_col: number | null;
  end_col: number | null;
  start_byte: number | null;
  end_byte: number | null;
  signature: string | null;
  docstring: string | null;
  source: string | null;
  parent: string | null;
  is_async: number | null;
  is_exported: number | null;
  extras: string | null;
};

export function symbolToRow(sym: CodeSymbol): unknown[] {
  const extras: SymbolExtras = {};
  if (sym.tokens !== undefined) extras.tokens = sym.tokens;
  if (sym.decorators !== undefined) extras.decorators = sym.decorators;
  if (sym.extends !== undefined) extras.extends = sym.extends;
  if (sym.implements !== undefined) extras.implements = sym.implements;
  if (sym.meta !== undefined) extras.meta = sym.meta;
  const hasExtras = Object.keys(extras).length > 0;

  return [
    sym.id,
    sym.file,
    sym.name,
    sym.kind,
    sym.start_line,
    sym.end_line,
    sym.start_col ?? null,
    sym.end_col ?? null,
    sym.start_byte ?? null,
    sym.end_byte ?? null,
    sym.signature ?? null,
    sym.docstring ?? null,
    sym.source ?? null,
    sym.parent ?? null,
    sym.is_async === undefined ? null : sym.is_async ? 1 : 0,
    sym.is_exported === undefined ? null : sym.is_exported ? 1 : 0,
    hasExtras ? JSON.stringify(extras) : null,
  ];
}

/** `repo` is identical for every symbol in an index, so it lives in `meta` and is stamped
 *  back on here instead of being written 100k times. */
export function rowToSymbol(row: SymbolRow, repo: string): CodeSymbol {
  const sym: CodeSymbol = {
    id: row.id,
    repo,
    name: row.name,
    kind: row.kind as CodeSymbol["kind"],
    file: row.file,
    start_line: row.start_line,
    end_line: row.end_line,
  };

  if (row.start_col !== null) sym.start_col = row.start_col;
  if (row.end_col !== null) sym.end_col = row.end_col;
  if (row.start_byte !== null) sym.start_byte = row.start_byte;
  if (row.end_byte !== null) sym.end_byte = row.end_byte;
  if (row.signature !== null) sym.signature = row.signature;
  if (row.docstring !== null) sym.docstring = row.docstring;
  if (row.source !== null) sym.source = row.source;
  if (row.parent !== null) sym.parent = row.parent;
  if (row.is_async !== null) sym.is_async = row.is_async === 1;
  if (row.is_exported !== null) sym.is_exported = row.is_exported === 1;

  if (row.extras !== null) {
    const extras = JSON.parse(row.extras) as SymbolExtras;
    if (extras.tokens !== undefined) sym.tokens = extras.tokens;
    if (extras.decorators !== undefined) sym.decorators = extras.decorators;
    if (extras.extends !== undefined) sym.extends = extras.extends;
    if (extras.implements !== undefined) sym.implements = extras.implements;
    if (extras.meta !== undefined) sym.meta = extras.meta;
  }

  return sym;
}

export type FileRow = {
  path: string;
  language: string;
  symbol_count: number;
  last_modified: number;
  mtime_ms: number | null;
  stale: number | null;
};

export function rowToFileEntry(row: FileRow): FileEntry {
  const entry: FileEntry = {
    path: row.path,
    language: row.language,
    symbol_count: row.symbol_count,
    last_modified: row.last_modified,
  };
  if (row.mtime_ms !== null) entry.mtime_ms = row.mtime_ms;
  if (row.stale !== null) entry.stale = row.stale === 1;
  return entry;
}

export function fileEntryToRow(entry: FileEntry): unknown[] {
  return [
    entry.path,
    entry.language,
    entry.symbol_count,
    entry.last_modified,
    entry.mtime_ms ?? null,
    entry.stale === undefined ? null : entry.stale ? 1 : 0,
  ];
}

export const INSERT_SYMBOL_SQL = `
INSERT INTO symbols (
  id, file, name, kind, start_line, end_line, start_col, end_col,
  start_byte, end_byte, signature, docstring, source, parent,
  is_async, is_exported, extras
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`;
// No upsert: both writers (`writeIndexRows`, `saveIncrementalSqlite`) DELETE the rows they
// are about to replace, so the only thing an ON CONFLICT clause ever resolved was a
// collision WITHIN one payload — two distinct symbols sharing a non-unique id — by throwing
// one of them away. See SCHEMA_VERSION.

export const INSERT_FILE_SQL = `
INSERT INTO files (path, language, symbol_count, last_modified, mtime_ms, stale)
VALUES (?,?,?,?,?,?)
ON CONFLICT(path) DO UPDATE SET
  language=excluded.language, symbol_count=excluded.symbol_count,
  last_modified=excluded.last_modified, mtime_ms=excluded.mtime_ms,
  stale=excluded.stale
`;

/**
 * Fixed heap cost of one materialised symbol, on top of its text.
 *
 * Calibrated against the real tgm-survey-platform index (240,137 symbols): loading it moves
 * `heapUsed` by 349 MB, of which the summed string lengths account for ~221 MB, leaving ~560 B
 * per symbol for the object header, property slots and array pointers. Counting only the text
 * would therefore under-report the cache by more than a third.
 *
 * Rounded UP from the fitted 560, deliberately. The constant is fitted to one index and other
 * repos will differ, so the residual error should fall on the safe side: over-reporting evicts a
 * little sooner than strictly necessary, whereas under-reporting lets the cache quietly exceed
 * the budget it exists to enforce. Measured overshoot on the calibration index is ~11%.
 */
export const SYMBOL_OBJECT_OVERHEAD_BYTES = 700;
export const FILE_OBJECT_OVERHEAD_BYTES = 200;

/**
 * Byte cost of a string field that may hold prose.
 *
 * `String.length` counts UTF-16 code units, not bytes. V8 stores a string one byte per character
 * only while every character fits Latin1; one non-Latin1 character anywhere makes the whole string
 * two-byte. So `.length` under-reports CJK, Cyrillic and emoji-bearing text by about half — and
 * under-reporting is the one direction the calibration comment below rules out, because it lets
 * the cache exceed the budget it exists to enforce. `source` alone is 45% of the footprint
 * (ADR-004), so a repo commented in Chinese would quietly blow through the cap.
 *
 * `Buffer.byteLength` over-reports instead (3 UTF-8 bytes per CJK character against V8's 2), which
 * is the acceptable side.
 */
function textBytes(value: string | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  return Buffer.byteLength(value, "utf8");
}

/**
 * Byte cost of one materialised file entry.
 *
 * Counted with `textBytes` and including `language`, not `path.length` alone. The caller used to
 * do the latter inline, which under-reported on exactly the two axes the comment above rules out:
 * a non-ASCII path counts half its bytes, and `language` counted zero. Small per row — but a
 * budget that is wrong in the permissive direction is the failure mode the budget exists to stop,
 * and having one of the two footprint helpers contradict the other's stated rule is worse than
 * either number.
 */
export function fileRowBytes(row: FileRow): number {
  return FILE_OBJECT_OVERHEAD_BYTES + textBytes(row.path) + textBytes(row.language);
}

export function symbolRowBytes(row: SymbolRow): number {
  return (
    SYMBOL_OBJECT_OVERHEAD_BYTES +
    // Identifiers and paths: overwhelmingly ASCII, and there are 240k of them — `.length` is
    // exact for ASCII and skips a scan per row on the fields least likely to need one.
    row.id.length +
    row.file.length +
    row.name.length +
    row.kind.length +
    // Prose and code text: the fields that actually carry non-Latin1 content. `parent` is a
    // symbol name and so is ASCII in practice, but it is measured the same way as the rest —
    // splitting it off saved one scan per row and cost a reader having to ask why.
    textBytes(row.parent) +
    textBytes(row.signature) +
    textBytes(row.docstring) +
    textBytes(row.source) +
    textBytes(row.extras)
  );
}
