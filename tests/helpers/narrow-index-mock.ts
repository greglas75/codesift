/**
 * Project ONE mocked `getCodeIndex` fixture into the narrow reads of ADR-004 stage 2.
 *
 * Tools converted off `getCodeIndex` call `getIndexSummary`, `findRepoSymbols` and
 * `streamRepoSymbols` instead. A test that stubs each of those separately has several fixtures for
 * one repo, and when they drift the test is asserting on the mock rather than on the tool. Deriving
 * all of them from the same `getCodeIndex` stub keeps the existing `mockResolvedValue(index)` call
 * sites working unchanged.
 *
 * The symbol predicate mirrors the real one (`filterCachedSymbols` in registry.ts): every field of
 * `SymbolQuery` is honoured, and `withSource: false` drops the key rather than setting it to
 * undefined. A mock that ignored a filter would return MORE than the tool asked for and hide a
 * wrong query.
 *
 * Stub with `mockResolvedValue`, not `mockResolvedValueOnce`: a converted tool reads the fixture
 * several times (summary first, then one or more symbol reads), and a one-shot stub makes every
 * read after the first see an unindexed repo — the tool then reports an empty result, not an error.
 *
 * Usage, inside a hoisted factory:
 *
 *   vi.mock("../../src/tools/index-tools.js", async () => {
 *     const { narrowIndexMock } = await import("../helpers/narrow-index-mock.js");
 *     return narrowIndexMock(vi.fn());
 *   });
 */

interface MockSymbol {
  id?: string;
  file: string;
  name: string;
  kind: string;
  parent?: string;
  source?: string;
}

interface MockQuery {
  withSource: boolean;
  file?: string;
  name?: string;
  namePrefix?: string;
  kind?: string;
  parent?: string;
  ids?: readonly string[];
  limit?: number;
}

type IndexLoader = (...args: unknown[]) => unknown;

function filterSymbols(symbols: MockSymbol[], query: MockQuery): MockSymbol[] {
  const ids = query.ids === undefined ? null : new Set(query.ids);
  const out: MockSymbol[] = [];
  for (const symbol of symbols) {
    if (query.limit !== undefined && out.length >= query.limit) break;
    if (query.file !== undefined && symbol.file !== query.file) continue;
    if (query.name !== undefined && symbol.name !== query.name) continue;
    if (query.namePrefix !== undefined && !symbol.name.startsWith(query.namePrefix)) continue;
    if (query.kind !== undefined && symbol.kind !== query.kind) continue;
    if (query.parent !== undefined && symbol.parent !== query.parent) continue;
    if (ids !== null && (symbol.id === undefined || !ids.has(symbol.id))) continue;
    if (query.withSource) {
      out.push(symbol);
    } else {
      const { source: _dropped, ...rest } = symbol;
      out.push(rest);
    }
  }
  return out;
}

export function narrowIndexMock<T extends IndexLoader>(getCodeIndex: T) {
  const load = async (repo: unknown): Promise<Record<string, unknown> | null> =>
    ((await getCodeIndex(repo)) as Record<string, unknown> | null | undefined) ?? null;
  const symbolsOf = (index: Record<string, unknown> | null): MockSymbol[] =>
    ((index?.["symbols"] as MockSymbol[] | undefined) ?? []);

  return {
    getCodeIndex,
    getIndexSummary: async (repo: unknown) => {
      const index = await load(repo);
      if (!index) return null;
      const { symbols: _symbols, ...summary } = index;
      return {
        ...summary,
        symbol_count: (index["symbol_count"] as number | undefined) ?? symbolsOf(index).length,
        file_count:
          (index["file_count"] as number | undefined) ??
          ((index["files"] as unknown[] | undefined) ?? []).length,
      };
    },
    findRepoSymbols: async (repo: unknown, query: MockQuery) =>
      filterSymbols(symbolsOf(await load(repo)), query),
    streamRepoSymbols: async (
      repo: unknown,
      query: MockQuery,
      onBatch: (batch: MockSymbol[]) => unknown,
    ) => {
      const index = await load(repo);
      if (!index) return;
      await onBatch(filterSymbols(symbolsOf(index), query));
    },
  };
}
