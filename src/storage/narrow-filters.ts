import type { CodeSymbol } from "../types.js";
import type { SymbolQuery } from "./sqlite/queries.js";

/**
 * The in-memory statement of the scan predicates on `SymbolQuery` (`kinds`, `sourceContainsAny`,
 * `minLines`, `fileSuffixAny`) — ONE definition for the resident-index filter and the JSON backend, the same answer the
 * SQL in `queries.ts` and `store.rs` gives. A filter missing here fails OPEN: more rows than asked for.
 */
export function symbolMatchesScanPredicates(symbol: CodeSymbol, query: SymbolQuery): boolean {
  if (query.kinds !== undefined && !query.kinds.includes(symbol.kind)) return false;
  if (query.sourceContainsAny !== undefined) {
    const source = symbol.source;
    if (source === undefined || source === null) return false;
    if (!query.sourceContainsAny.some((needle) => source.includes(needle))) return false;
  }
  if (query.minLines !== undefined && symbol.end_line - symbol.start_line + 1 < query.minLines) return false;
  if (query.fileSuffixAny !== undefined && !query.fileSuffixAny.some((sfx) => symbol.file.endsWith(sfx))) return false;
  return true;
}

/**
 * Does a symbol answer to a requested id — the full `repo:file:name:line`, or the short
 * `file:name:line` the lookup tools print with the `repo:` prefix stripped?
 *
 * The in-memory statement of the rule `findSymbolsByRequestedIdsSqlite` answers with an index probe.
 * One definition for the JSON backend and the resident-index path: copies of a matching rule are
 * places for it to drift, and a drifted matcher does not fail — it resolves an id to a different
 * symbol, or to none. `getSymbols` applies the same rule inline because it must also know WHICH
 * request a symbol answers, which a boolean cannot tell it.
 */
export function symbolMatchesRequestedId(symbolId: string, requested: ReadonlySet<string>): boolean {
  if (requested.has(symbolId)) return true;
  const separator = symbolId.indexOf(":");
  return separator >= 0 && requested.has(symbolId.slice(separator + 1));
}

/** Drop `source` by omitting the key — never by setting it undefined, which reads as "no body". */
export function projectSource(symbol: CodeSymbol, withSource: boolean): CodeSymbol {
  if (withSource) return symbol;
  const { source: _dropped, ...rest } = symbol;
  return rest as CodeSymbol;
}

/** The in-memory twin of `findSymbolsByRequestedIdsSqlite`, in array order. */
export function filterByRequestedIds(
  symbols: readonly CodeSymbol[],
  requestedIds: readonly string[],
  withSource: boolean,
): CodeSymbol[] {
  const requested = new Set(requestedIds);
  if (requested.size === 0) return [];
  const out: CodeSymbol[] = [];
  for (const symbol of symbols) {
    if (symbolMatchesRequestedId(symbol.id, requested)) out.push(projectSource(symbol, withSource));
  }
  return out;
}

/** The in-memory twin of `findSymbolsInFilesSqlite`, in array order. */
export function filterByFiles(
  symbols: readonly CodeSymbol[],
  files: readonly string[],
  withSource: boolean,
): CodeSymbol[] {
  const wanted = new Set(files);
  if (wanted.size === 0) return [];
  const out: CodeSymbol[] = [];
  for (const symbol of symbols) {
    if (wanted.has(symbol.file)) out.push(projectSource(symbol, withSource));
  }
  return out;
}
