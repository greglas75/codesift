import { buildBM25Index, buildBM25IndexYielding, searchBM25, tokenizeText, applyCutoff } from "../../src/search/bm25.js";
import type { CodeSymbol, SearchResult } from "../../src/types.js";

function makeSymbol(overrides: Partial<CodeSymbol> & { id: string; name: string }): CodeSymbol {
  return {
    repo: "test",
    kind: "function",
    file: "test.ts",
    start_line: 1,
    end_line: 10,
    ...overrides,
  };
}

function makeResult(id: string, score: number): SearchResult {
  return { score, symbol: makeSymbol({ id, name: id }) };
}

const DEFAULT_WEIGHTS = { name: 3.0, signature: 2.0, docstring: 1.5, body: 1.0 };

const testSymbols: CodeSymbol[] = [
  makeSymbol({
    id: "1",
    name: "getUserById",
    signature: "async getUserById(id: string): Promise<User>",
  }),
  makeSymbol({
    id: "2",
    name: "createUser",
    signature: "async createUser(data: CreateUserInput): Promise<User>",
  }),
  makeSymbol({
    id: "3",
    name: "deleteUser",
    signature: "async deleteUser(id: string): Promise<void>",
  }),
  makeSymbol({
    id: "4",
    name: "processPayment",
    signature: "processPayment(amount: number): PaymentResult",
  }),
  makeSymbol({
    id: "5",
    name: "validateEmail",
    signature: "validateEmail(email: string): boolean",
  }),
];

describe("tokenizeText", () => {
  it("splits camelCase identifiers into lowercase tokens", () => {
    const tokens = tokenizeText("getUserById");
    expect(tokens).toContain("get");
    expect(tokens).toContain("user");
    expect(tokens).toContain("by");
    expect(tokens).toContain("id");
  });

  it("splits on punctuation and lowercases words", () => {
    expect(tokenizeText("Hello, World!")).toEqual(["hello", "world"]);
  });

  it("returns empty array for empty string", () => {
    expect(tokenizeText("")).toEqual([]);
  });

  it("filters out tokens shorter than 2 characters", () => {
    expect(tokenizeText("a b c")).toEqual([]);
  });
});

describe("buildBM25Index", () => {
  it("returns docCount 0 for empty array", () => {
    const index = buildBM25Index([]);
    expect(index.docCount).toBe(0);
  });

  it("indexes all symbols and makes them available in lookup", () => {
    const symbols = testSymbols.slice(0, 3);
    const index = buildBM25Index(symbols);

    expect(index.docCount).toBe(3);
    expect(index.symbols.size).toBe(3);
    expect(index.symbols.get("1")).toBeDefined();
    expect(index.symbols.get("2")).toBeDefined();
    expect(index.symbols.get("3")).toBeDefined();
  });
});

describe("searchBM25", () => {
  let index: ReturnType<typeof buildBM25Index>;

  beforeEach(() => {
    index = buildBM25Index(testSymbols);
  });

  it("returns empty array when index is empty", () => {
    const emptyIndex = buildBM25Index([]);
    const results = searchBM25(emptyIndex, "user", 10, DEFAULT_WEIGHTS);
    expect(results).toEqual([]);
  });

  it("ranks exact symbol name match as #1", () => {
    const results = searchBM25(index, "getUserById", 5, DEFAULT_WEIGHTS);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].symbol.id).toBe("1");
  });

  it("returns empty array when no tokens match", () => {
    const results = searchBM25(index, "zzzznothing", 10, DEFAULT_WEIGHTS);
    expect(results).toEqual([]);
  });

  it("respects topK limit", () => {
    const results = searchBM25(index, "user", 2, DEFAULT_WEIGHTS);
    expect(results).toHaveLength(2);
  });

  it("returns results sorted by score descending", () => {
    const results = searchBM25(index, "user", 10, DEFAULT_WEIGHTS);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("includes matched tokens in the matches array", () => {
    const results = searchBM25(index, "getUserById", 5, DEFAULT_WEIGHTS);
    expect(results.length).toBeGreaterThan(0);

    const topResult = results[0];
    expect(topResult.matches).toBeDefined();
    expect(topResult.matches!.length).toBeGreaterThan(0);
    expect(topResult.matches).toContain("get");
    expect(topResult.matches).toContain("user");
  });
});

describe("applyCutoff", () => {
  it("cuts results below 15% of top score", () => {
    const results: SearchResult[] = [
      makeResult("a", 10.0),
      makeResult("b", 8.0),
      makeResult("c", 7.0),
      makeResult("d", 1.2),
      makeResult("e", 0.5),
    ];
    const cut = applyCutoff(results);
    expect(cut.length).toBe(3);
  });

  it("always returns minimum 3 results", () => {
    const results: SearchResult[] = [
      makeResult("a", 10.0),
      makeResult("b", 0.1),
      makeResult("c", 0.05),
    ];
    const cut = applyCutoff(results);
    expect(cut.length).toBe(3);
  });

  it("returns all if no gap", () => {
    const results: SearchResult[] = [
      makeResult("a", 10.0),
      makeResult("b", 9.5),
      makeResult("c", 8.0),
    ];
    expect(applyCutoff(results).length).toBe(3);
  });

  it("handles empty array", () => {
    expect(applyCutoff([])).toEqual([]);
  });
});

/**
 * Building this index was the single longest synchronous burst in the process. Measured on the
 * largest real index here (372,949 symbols, 20,132 files): 19.5 seconds during which a 20 ms timer
 * fired ZERO times — no other client got an answer in that window, `/health` included. 18.3 s of it
 * was the tokenise-and-map loop, 1.2 s the import-centrality pass, which is why only the first
 * yields.
 */
describe("buildBM25IndexYielding", () => {
  function manySymbols(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: `local/t:src/f${i % 40}.ts:s${i}:${i}`,
      name: `handleRequest${i}`,
      kind: "function",
      file: `src/f${i % 40}.ts`,
      start_line: i,
      end_line: i + 5,
      source: `function handleRequest${i}(input: string) { return parse(input) + ${i}; }`,
    }));
  }

  it("produces the same index as the synchronous builder", async () => {
    // Identical work, identical output — the only difference is who gets the CPU meanwhile.
    const symbols = manySymbols(300) as never;
    const sync = buildBM25Index(symbols);
    const async_ = await buildBM25IndexYielding(symbols);

    expect(async_.docCount).toBe(sync.docCount);
    expect(async_.symbols.size).toBe(sync.symbols.size);
    expect(async_.avgFieldLengths).toEqual(sync.avgFieldLengths);
    expect([...async_.fields.name.keys()].sort()).toEqual([...sync.fields.name.keys()].sort());
    expect([...async_.centrality.entries()].sort()).toEqual([...sync.centrality.entries()].sort());
  });

  it("lets timers fire while it builds", async () => {
    // The property that was missing. Before this it was exactly 0, however long the build took.
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    try {
      await buildBM25IndexYielding(manySymbols(9000) as never);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  }, 60_000);

  it("handles an empty input and a tail shorter than one batch", async () => {
    expect((await buildBM25IndexYielding([])).docCount).toBe(0);
    // 2500 is not a multiple of the 2000-symbol batch, so the remainder after the last yield counts.
    const idx = await buildBM25IndexYielding(manySymbols(2500) as never);
    expect(idx.docCount).toBe(2500);
    expect(idx.symbols.size).toBe(2500);
  }, 60_000);
});
