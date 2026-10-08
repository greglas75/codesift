/**
 * Derive the narrow index reads (`getIndexSummary`, `findRepoSymbols`, `streamRepoSymbols`) from a
 * test's `getCodeIndex` mock, so a test that stubs one fixture keeps asserting on the tool rather
 * than on which accessor happens to be stubbed (ADR-004 stage 2).
 *
 * One fixture, projected into all four shapes: two stubs of one fixture drift, and the drift
 * surfaces as a test asserting on the mock.
 *
 * Deliberately faithful to the real accessors' contracts, because a lax mock is how a narrowing
 * mistake ships green:
 *  - `withSource: false` REMOVES the `source` key, exactly as the SQL projection does — a tool that
 *    reads source it did not ask for sees nothing and fails its assertions.
 *  - every `SymbolQuery` predicate is applied, including `ids: []` meaning none.
 *  - the stream pages in batches of two and honours `false` as a stop, so early-exit and
 *    multi-page folding are exercised rather than one convenient batch.
 *
 * Usage, inside a hoisted factory (the import must be dynamic):
 *
 *   vi.mock("../../src/tools/index-tools.js", async () => {
 *     const { withDerivedIndexAccessors } = await import("../helpers/index-accessors-from-fixture.js");
 *     return withDerivedIndexAccessors({ getCodeIndex: vi.fn() });
 *   });
 */

interface FixtureSymbol {
  id?: string;
  file?: string;
  name?: string;
  kind?: string;
  parent?: string;
  source?: string;
  [key: string]: unknown;
}

interface FixtureQuery {
  withSource: boolean;
  file?: string;
  name?: string;
  namePrefix?: string;
  kind?: string;
  parent?: string;
  ids?: readonly string[];
  limit?: number;
}

type GetCodeIndexLike = (repo: string, options?: { skipFreshness?: boolean }) => unknown;

const STREAM_PAGE = 2;

function filterFixtureSymbols(symbols: FixtureSymbol[], query: FixtureQuery): FixtureSymbol[] {
  const ids = query.ids === undefined ? null : new Set(query.ids);
  const out: FixtureSymbol[] = [];
  for (const symbol of symbols) {
    if (query.limit !== undefined && out.length >= query.limit) break;
    if (query.file !== undefined && symbol.file !== query.file) continue;
    if (query.name !== undefined && symbol.name !== query.name) continue;
    if (query.namePrefix !== undefined && !(symbol.name ?? "").startsWith(query.namePrefix)) continue;
    if (query.kind !== undefined && symbol.kind !== query.kind) continue;
    if (query.parent !== undefined && symbol.parent !== query.parent) continue;
    if (ids !== null && !ids.has(symbol.id ?? "")) continue;
    if (query.withSource) {
      out.push(symbol);
    } else {
      const { source: _dropped, ...rest } = symbol;
      out.push(rest);
    }
  }
  return out;
}

async function fixtureOf(
  getCodeIndex: GetCodeIndexLike,
  repo: string,
  options?: { skipFreshness?: boolean },
): Promise<Record<string, unknown> | null> {
  // Forward `options` only when given, so a test asserting the call shape (`toHaveBeenCalledWith(repo)`)
  // sees the same arguments the tool itself passed.
  const index = await (options === undefined ? getCodeIndex(repo) : getCodeIndex(repo, options));
  return (index ?? null) as Record<string, unknown> | null;
}

export function withDerivedIndexAccessors<T extends { getCodeIndex: GetCodeIndexLike }>(
  base: T,
): T & {
  getIndexSummary: (repo: string, options?: { skipFreshness?: boolean }) => Promise<unknown>;
  findRepoSymbols: (repo: string, query: FixtureQuery, options?: { skipFreshness?: boolean }) => Promise<FixtureSymbol[]>;
  streamRepoSymbols: (
    repo: string,
    query: FixtureQuery,
    onBatch: (batch: FixtureSymbol[]) => unknown,
    options?: { skipFreshness?: boolean },
  ) => Promise<void>;
} {
  const { getCodeIndex } = base;
  return {
    ...base,
    getIndexSummary: async (repo, options) => {
      const index = await fixtureOf(getCodeIndex, repo, options);
      if (!index) return null;
      const { symbols, ...summary } = index;
      return {
        ...summary,
        symbol_count: Array.isArray(symbols) ? symbols.length : 0,
        file_count: Array.isArray(index["files"]) ? (index["files"] as unknown[]).length : 0,
      };
    },
    findRepoSymbols: async (repo, query, options) => {
      const index = await fixtureOf(getCodeIndex, repo, options);
      const symbols = (index?.["symbols"] as FixtureSymbol[] | undefined) ?? [];
      return filterFixtureSymbols(symbols, query);
    },
    streamRepoSymbols: async (repo, query, onBatch, options) => {
      const index = await fixtureOf(getCodeIndex, repo, options);
      const symbols = filterFixtureSymbols((index?.["symbols"] as FixtureSymbol[] | undefined) ?? [], query);
      for (let i = 0; i < symbols.length; i += STREAM_PAGE) {
        if ((await onBatch(symbols.slice(i, i + STREAM_PAGE))) === false) return;
      }
    },
  };
}
