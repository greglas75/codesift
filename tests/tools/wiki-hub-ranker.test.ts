import { describe, it, expect } from "vitest";
import { JS_BUILTIN_METHOD_NAMES, rankHubsByPageRank } from "../../src/tools/wiki-hub-ranker.js";
import type { ImportEdge } from "../../src/utils/import-graph.js";

describe("JS_BUILTIN_METHOD_NAMES", () => {
  it("contains at least 40 entries", () => {
    expect(JS_BUILTIN_METHOD_NAMES.size).toBeGreaterThanOrEqual(40);
  });

  it("contains expected prototype method names", () => {
    for (const name of ["map", "filter", "reduce", "slice", "now", "get", "then", "valueOf", "toString"]) {
      expect(JS_BUILTIN_METHOD_NAMES.has(name)).toBe(true);
    }
  });
});

describe("rankHubsByPageRank", () => {
  it("returns empty hubs + degraded_reason for empty edges (no classifySymbolRoles fallback)", () => {
    const result = rankHubsByPageRank([], []);
    expect(result.hubs).toEqual([]);
    expect(result.degraded_reason).toBe("import_graph_empty");
  });

  it("drops builtin-named symbols from low-file-rank files (AC-SHIP-1a)", () => {
    // Simulate 25 files with A.ts importing through a chain; builtin_file is peripheral.
    const edges: ImportEdge[] = [];
    for (let i = 0; i < 24; i++) {
      edges.push({ from: `core${i}.ts`, to: `core${i + 1}.ts` });
    }
    // builtin_file only imported once, from outside the core chain
    edges.push({ from: "leaf.ts", to: "builtin_file.ts" });
    const candidates = [{
      name: "map", file: "builtin_file.ts", role: "utility",
      callers: 500, callees: 1,
    }];
    const result = rankHubsByPageRank(edges, candidates, { topK: 10 });
    expect(result.hubs.find((h) => h.name === "map")).toBeUndefined();
  });

  it("preserves project-symbol `map` when its file is in top-20 by PageRank", () => {
    const edges: ImportEdge[] = [
      { from: "caller1.ts", to: "util.ts" },
      { from: "caller2.ts", to: "util.ts" },
      { from: "caller3.ts", to: "util.ts" },
      { from: "caller4.ts", to: "util.ts" },
    ];
    const candidates = [{
      name: "map", file: "util.ts", role: "core", callers: 4, callees: 0,
    }];
    const result = rankHubsByPageRank(edges, candidates, { topK: 10 });
    expect(result.hubs.find((h) => h.name === "map")).toBeDefined();
  });
});
