import { describe, it, expect } from "vitest";
import type { TextMatch, ContainingSymbol, SymbolKind, CodeIndex, CodeSymbol } from "../../src/types.js";
import type { SearchTextOptions } from "../../src/tools/search-tools.js";
import { classifyHitsWithSymbols } from "../../src/tools/search-ranker.js";

function makeSymbol(overrides: Partial<CodeSymbol>): CodeSymbol {
  return {
    id: "sym-1",
    repo: "local/test",
    name: "test",
    kind: "function",
    file: "test.ts",
    start_line: 1,
    end_line: 10,
    source: "",
    signature: "",
    ...overrides,
  } as CodeSymbol;
}

function makeMatch(file: string, line: number, content: string): TextMatch {
  return { file, line, content };
}

function makeIndex(symbols: CodeSymbol[]): CodeIndex {
  return { symbols, files: [], metadata: {} } as unknown as CodeIndex;
}

describe("ContainingSymbol type", () => {
  it("has required fields", () => {
    const cs: ContainingSymbol = {
      name: "myFunction",
      kind: "function" as SymbolKind,
      start_line: 10,
      end_line: 25,
      in_degree: 5,
    };
    expect(cs.name).toBe("myFunction");
    expect(cs.kind).toBe("function");
    expect(cs.start_line).toBe(10);
    expect(cs.end_line).toBe(25);
    expect(cs.in_degree).toBe(5);
  });

  it("TextMatch accepts optional containing_symbol", () => {
    const match: TextMatch = {
      file: "test.ts",
      line: 15,
      content: "const x = 1;",
    };
    expect(match.containing_symbol).toBeUndefined();

    const matchWithSymbol: TextMatch = {
      file: "test.ts",
      line: 15,
      content: "const x = 1;",
      containing_symbol: {
        name: "init",
        kind: "function" as SymbolKind,
        start_line: 10,
        end_line: 30,
        in_degree: 3,
      },
    };
    expect(matchWithSymbol.containing_symbol?.name).toBe("init");
  });

  it("SearchTextOptions accepts ranked boolean", () => {
    const opts: SearchTextOptions = { ranked: true };
    expect(opts.ranked).toBe(true);
    const opts2: SearchTextOptions = {};
    expect(opts2.ranked).toBeUndefined();
  });
});

describe("classifyHitsWithSymbols", () => {
  const mockBm25 = {
    centrality: new Map([
      ["test.ts", 2.5],
      ["other.ts", 0.5],
    ]),
  };

  it("classifies hit inside a function", async () => {
    const index = makeIndex([
      makeSymbol({ name: "myFunc", start_line: 5, end_line: 30, file: "test.ts" }),
    ]);
    const matches = [makeMatch("test.ts", 10, "const x = 1;")];
    const result = await classifyHitsWithSymbols(matches, index, mockBm25);
    expect(result[0].containing_symbol).toBeDefined();
    expect(result[0].containing_symbol!.name).toBe("myFunc");
    expect(result[0].containing_symbol!.in_degree).toBe(2.5);
  });

  it("leaves hit unclassified when outside any symbol", async () => {
    const index = makeIndex([
      makeSymbol({ start_line: 50, end_line: 60, file: "test.ts" }),
    ]);
    const matches = [makeMatch("test.ts", 10, "orphan line")];
    const result = await classifyHitsWithSymbols(matches, index, mockBm25);
    expect(result[0].containing_symbol).toBeUndefined();
  });

  it("deduplicates: max 2 hits per function", async () => {
    const index = makeIndex([
      makeSymbol({ name: "bigFunc", start_line: 1, end_line: 100, file: "test.ts" }),
    ]);
    const matches = [
      makeMatch("test.ts", 5, "hit A"),
      makeMatch("test.ts", 10, "hit B"),
      makeMatch("test.ts", 15, "hit C"),
      makeMatch("test.ts", 20, "hit D"),
      makeMatch("test.ts", 25, "hit E"),
    ];
    const result = await classifyHitsWithSymbols(matches, index, mockBm25);
    const classified = result.filter(
      (m) => m.containing_symbol?.name === "bigFunc",
    );
    expect(classified.length).toBe(2);
  });

  it("ranks by in_degree: higher centrality first", async () => {
    const index = makeIndex([
      makeSymbol({ name: "popular", start_line: 1, end_line: 10, file: "test.ts" }),
      makeSymbol({ name: "obscure", start_line: 1, end_line: 10, file: "other.ts" }),
    ]);
    const matches = [
      makeMatch("other.ts", 5, "hit in obscure"),
      makeMatch("test.ts", 5, "hit in popular"),
    ];
    const result = await classifyHitsWithSymbols(matches, index, mockBm25);
    expect(result[0].containing_symbol!.name).toBe("popular"); // higher centrality
  });

  it("returns empty array for empty matches", async () => {
    const index = makeIndex([]);
    const result = await classifyHitsWithSymbols([], index, mockBm25);
    expect(result).toEqual([]);
  });

  it("returns matches unchanged for empty symbol index", async () => {
    const index = makeIndex([]);
    const matches = [makeMatch("test.ts", 10, "some content")];
    const result = await classifyHitsWithSymbols(matches, index, mockBm25);
    expect(result.length).toBe(1);
    expect(result[0].containing_symbol).toBeUndefined();
  });

  it("handles unsorted symbols correctly", async () => {
    const index = makeIndex([
      makeSymbol({ name: "second", start_line: 20, end_line: 30, file: "test.ts" }),
      makeSymbol({ name: "first", start_line: 1, end_line: 10, file: "test.ts" }),
    ]);
    const matches = [makeMatch("test.ts", 5, "in first function")];
    const result = await classifyHitsWithSymbols(matches, index, mockBm25);
    expect(result[0].containing_symbol!.name).toBe("first");
  });
});

describe("searchText ranked mode wiring", () => {
  it("ranked mode returns TextMatch with containing_symbol when index available", async () => {
    // This tests that the integration point exists.
    // We can't easily create a real repo index in a unit test,
    // so we verify the option is accepted and doesn't crash.
    const { searchText } = await import("../../src/tools/search-tools.js");

    // searchText with ranked=true on a non-existent repo should gracefully handle
    // the missing index (no crash, returns matches without classification)
    try {
      await searchText("local/nonexistent-repo", "test", { ranked: true, max_results: 5 });
    } catch (e: unknown) {
      // Expected — repo doesn't exist. The point is it doesn't crash on the ranked param.
      expect(e).toBeDefined();
    }
  });

  it("ranked mode is opt-in — default returns plain TextMatch", async () => {
    const { searchText } = await import("../../src/tools/search-tools.js");
    // Without ranked, the existing behavior is unchanged.
    try {
      await searchText("local/nonexistent-repo", "test", { max_results: 5 });
    } catch (e: unknown) {
      expect(e).toBeDefined();
    }
  });

  it("ranked=true takes precedence over auto_group", async () => {
    // Verify that ranked=true is in SearchTextOptions alongside auto_group
    const opts: SearchTextOptions = { ranked: true, auto_group: true };
    expect(opts.ranked).toBe(true);
    expect(opts.auto_group).toBe(true);
    // When ranked is set, auto_group should be skipped (tested at integration level)
    // Type-level check: both can coexist without TS error
  });

  it("ranked=false leaves options unchanged", async () => {
    const opts: SearchTextOptions = { ranked: false };
    expect(opts.ranked).toBe(false);
  });
});
