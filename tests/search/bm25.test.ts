import { buildBM25Index, searchBM25, tokenizeText, applyCutoff } from "../../src/search/bm25.js";
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
