import type { CodeIndex } from "../types.js";

/**
 * How much heap a materialised index occupies, so the cache can budget bytes instead of entries.
 *
 * Kept beside the index rather than on it: `CodeIndex` is a wire/storage shape that gets
 * serialised and copied, and a measurement of this process's heap is neither. A WeakMap also
 * cannot keep an evicted index alive, which a field on the object could not promise.
 */
const footprints = new WeakMap<CodeIndex, number>();

/**
 * Per-symbol heap cost, measured rather than guessed: loading the real tgm-survey-platform index
 * (240,137 symbols) moves `heapUsed` by 349 MB under `--expose-gc`, i.e. ~1,454 B/symbol
 * including source text. Rounded up for the same reason as the loader's own constant — this is
 * fitted to one index, and the residual error belongs on the evict-sooner side.
 *
 * Only ever a FALLBACK. The SQLite loader tallies the actual bytes as it walks the rows, which
 * costs one addition each and needs no constant; this covers indexes that arrived some other way
 * (the JSON backend, a hand-built index in a test) where re-walking to measure would cost more
 * than the eviction decision is worth.
 */
const ESTIMATED_BYTES_PER_SYMBOL = 1_600;
const ESTIMATED_BYTES_PER_FILE = 300;

export function recordIndexFootprint(index: CodeIndex, bytes: number): void {
  footprints.set(index, bytes);
}

/**
 * Measured footprint when the loader recorded one, otherwise the calibrated estimate.
 *
 * Deliberately returns a number in both cases instead of `undefined`: the caller is choosing what
 * to evict, and "size unknown" there can only degrade into either treating a 400 MB index as free
 * or refusing to cache it at all. An estimate within a small factor is enough for that decision,
 * whereas the entry-counting it replaces was wrong by two orders of magnitude.
 */
export function indexFootprintBytes(index: CodeIndex): number {
  const measured = footprints.get(index);
  if (measured !== undefined) return measured;
  const symbols = index.symbol_count || index.symbols.length;
  const files = index.file_count || index.files.length;
  return symbols * ESTIMATED_BYTES_PER_SYMBOL + files * ESTIMATED_BYTES_PER_FILE;
}
