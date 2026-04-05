import { describe, it, expect } from "vitest";
import type { TextMatch, ContainingSymbol, SymbolKind } from "../../src/types.js";
import type { SearchTextOptions } from "../../src/tools/search-tools.js";

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
