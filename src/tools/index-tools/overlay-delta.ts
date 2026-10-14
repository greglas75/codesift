/**
 * A re-walk of an overlay index (worktree-overlay.ts), written as the files it changed.
 *
 * The walk in folder-indexer ends in a whole-index `saveIndex`, and on an overlay that write masks
 * every base path — a second `index_folder` turned the overlay back into a full copy, undoing the
 * seed for every worktree an agent or `ensureIndexFresh` re-walks. This plans the same result as a
 * delta instead.
 *
 * A file the walk re-parsed is compared with what the index holds, ids aside: the overlay's base
 * rows carry the base's prefix and a re-parse produces the worktree's, so identical content would
 * otherwise read as changed and copy every re-parsed file into the overlay. When they match, the
 * stored symbols are kept — also in the symbols the caller indexes for search, so the ids a search
 * hit names are the ids the store holds.
 */
import type { CodeSymbol, FileEntry } from "../../types.js";
import { fileEntryToRow, symbolToRow } from "../../storage/sqlite/rows.js";
import type { IndexDelta } from "../../storage/sqlite/accessors.js";

/**
 * The largest delta written as one: a quarter of the files (at least 64). Past it the walk writes a
 * whole index, which makes the database plain — by then the overlay is no longer small, and the
 * delta's transaction is synchronous (accessors.ts) while the whole-index write yields.
 */
const DELTA_FILE_FRACTION = 0.25;
const DELTA_MIN_FILES = 64;

export interface OverlayDeltaPlan {
  delta: Pick<IndexDelta, "replaced" | "entries" | "removed">;
  /** The walk's symbols with each unchanged re-parsed file's stored symbols put back. */
  symbols: CodeSymbol[];
  /** Files whose symbols are rewritten or removed — what the size bound counts. */
  changedFiles: number;
}

/** A file row as stored, for comparing entries the walk may have mutated since. */
export function storedEntryKey(entry: FileEntry): string {
  return JSON.stringify(fileEntryToRow(entry));
}

/** Column of `symbolToRow` holding the parent symbol's id, which carries a prefix like `id` does. */
const PARENT_COLUMN = 13;

function withoutPrefix(id: string, prefixes: readonly string[]): string {
  const prefix = prefixes.find((p) => id.startsWith(p));
  return prefix === undefined ? id : id.slice(prefix.length);
}

function symbolKey(sym: CodeSymbol, prefixes: readonly string[]): string {
  const row = symbolToRow(sym);
  row[0] = withoutPrefix(sym.id, prefixes);
  if (typeof row[PARENT_COLUMN] === "string") row[PARENT_COLUMN] = withoutPrefix(row[PARENT_COLUMN], prefixes);
  return JSON.stringify(row);
}

function sameSymbols(a: readonly CodeSymbol[], b: readonly CodeSymbol[], prefixes: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (symbolKey(a[i]!, prefixes) !== symbolKey(b[i]!, prefixes)) return false;
  }
  return true;
}

export function planOverlayDelta(input: {
  /** The stored symbols by file, as loaded before the walk. */
  storedSymbolsByFile: ReadonlyMap<string, CodeSymbol[]>;
  /** `storedEntryKey` of every stored file row, taken before the walk mutated any entry. */
  storedEntries: ReadonlyMap<string, string>;
  /** Files the walk re-parsed; every other file's symbols are the stored ones. */
  parsedPaths: ReadonlySet<string>;
  symbols: CodeSymbol[];
  entries: FileEntry[];
  /** Id prefixes the stored rows carry (the repo's and the base's). */
  idPrefixes: readonly string[];
}): OverlayDeltaPlan {
  const newByFile = new Map<string, CodeSymbol[]>();
  for (const sym of input.symbols) {
    const list = newByFile.get(sym.file);
    if (list) list.push(sym);
    else newByFile.set(sym.file, [sym]);
  }

  const unchanged = new Set<string>();
  const replaced: IndexDelta["replaced"] = [];
  const entryByPath = new Map(input.entries.map((e) => [e.path, e]));
  for (const path of input.parsedPaths) {
    const entry = entryByPath.get(path);
    if (!entry) continue; // parsed but not kept (merge dropped it): counted as removed below
    const fresh = newByFile.get(path) ?? [];
    const stored = input.storedSymbolsByFile.get(path) ?? [];
    if (input.storedEntries.has(path) && sameSymbols(stored, fresh, input.idPrefixes)) {
      unchanged.add(path);
    } else {
      replaced.push({ path, symbols: fresh, entry });
    }
  }
  const replacedPaths = new Set(replaced.map((r) => r.path));

  const entries = input.entries.filter(
    (e) => !replacedPaths.has(e.path) && input.storedEntries.get(e.path) !== storedEntryKey(e),
  );

  const kept = new Set<string>([...entryByPath.keys(), ...newByFile.keys()]);
  const removed = [...new Set([...input.storedEntries.keys(), ...input.storedSymbolsByFile.keys()])]
    .filter((path) => !kept.has(path));

  const symbols: CodeSymbol[] = [];
  const restored = new Set<string>();
  for (const sym of input.symbols) {
    if (!unchanged.has(sym.file)) {
      symbols.push(sym);
    } else if (!restored.has(sym.file)) {
      restored.add(sym.file);
      symbols.push(...(input.storedSymbolsByFile.get(sym.file) ?? []));
    }
  }

  return { delta: { replaced, entries, removed }, symbols, changedFiles: replaced.length + removed.length };
}

/** Whether a plan is small enough to write as a delta rather than as a whole index. */
export function deltaFits(plan: OverlayDeltaPlan, fileCount: number): boolean {
  return plan.changedFiles <= Math.max(DELTA_MIN_FILES, fileCount * DELTA_FILE_FRACTION);
}
