import { describe, expect, it } from "vitest";
import { assembleL1 } from "../../src/tools/context-levels/l1.js";
import { assembleL2 } from "../../src/tools/context-levels/l2.js";
import { assembleL3 } from "../../src/tools/context-levels/l3.js";
import type { CodeIndex, CodeSymbol, SearchResult } from "../../src/types.js";

function result(id: string, name: string, file: string, signature?: string): SearchResult {
  const symbol: CodeSymbol = {
    id,
    repo: "repo",
    name,
    kind: "function",
    file,
    start_line: 3,
    end_line: 5,
    source: `function ${name}() {}`,
    ...(signature ? { signature } : {}),
  };
  return { symbol, score: 1 };
}

const results = [
  result("a", "alpha", "src/core/a.ts", "(): string"),
  result("b", "beta", "src/core/b.ts"),
  result("c", "gamma", "src/ui/c.ts"),
];

describe("context level assemblers", () => {
  it("L1 emits the exact compact shape and truncates before the first oversized item", () => {
    expect(assembleL1(results.slice(0, 1), 5000)).toEqual({
      compact_symbols: [{ id: "a", name: "alpha", kind: "function", file: "src/core/a.ts", start_line: 3, signature: "(): string" }],
      level: "L1",
      total_tokens: 27,
      truncated: false,
      result_count: 1,
    });
    expect(assembleL1(results, 0)).toEqual({ compact_symbols: [], level: "L1", total_tokens: 0, truncated: true, result_count: 0 });
  });

  it("L2 preserves file grouping, export formatting, counts, and language enrichment", () => {
    const index = {
      files: [
        { path: "src/core/a.ts", language: "typescript", symbol_count: 1, last_modified: 0 },
        { path: "src/core/b.ts", language: "typescript", symbol_count: 1, last_modified: 0 },
      ],
    } as CodeIndex;
    const assembled = assembleL2(results.slice(0, 2), 5000, index);
    expect(assembled.file_summaries).toEqual([
      { path: "src/core/a.ts", language: "typescript", exports: ["alpha(function)"], symbol_count: 1 },
      { path: "src/core/b.ts", language: "typescript", exports: ["beta(function)"], symbol_count: 1 },
    ]);
    expect(assembleL2(results, 0, index)).toEqual({ file_summaries: [], level: "L2", total_tokens: 0, truncated: true, result_count: 0 });
  });

  it("L3 sorts directories by symbol count and preserves file order", () => {
    expect(assembleL3(results, 5000).directory_overview).toEqual([
      { path: "src/core", file_count: 2, symbol_count: 2, top_files: ["src/core/a.ts", "src/core/b.ts"] },
      { path: "src/ui", file_count: 1, symbol_count: 1, top_files: ["src/ui/c.ts"] },
    ]);
    expect(assembleL3(results, 0)).toEqual({ directory_overview: [], level: "L3", total_tokens: 0, truncated: true, result_count: 0 });
  });
});
