import { describe, it, expect } from "vitest";
import { resolve, join } from "node:path";
import { collectImportEdges } from "../../src/utils/import-graph.js";
import { clearTsconfigCache } from "../../src/utils/tsconfig-paths.js";
import { resetParseCache } from "../../src/parser/parse-cache.js";
import type { CodeIndex } from "../../src/types.js";

const FIXTURE = resolve(__dirname, "../fixtures/type-only-cycle");

describe("type-only cycle filter integration", () => {
  it("collectImportEdges flags type-only edges; runtime edges stay runtime", async () => {
    clearTsconfigCache();
    resetParseCache();

    const files = ["runtime-a.ts", "runtime-b.ts", "types-a.ts", "types-b.ts"].map(
      (path) => ({
        path,
        language: "typescript" as const,
        symbol_count: 1,
        last_modified: 0,
      }),
    );
    const index: CodeIndex = {
      repo: "test-fixture",
      root: FIXTURE,
      symbols: [],
      files,
      created_at: 0,
      updated_at: 0,
      symbol_count: 0,
      file_count: files.length,
    };

    const edges = await collectImportEdges(index);
    const byFrom = (from: string) =>
      edges.filter((e) => e.from === from).map((e) => ({ to: e.to, t: e.type_only ?? false }));

    expect(byFrom("runtime-a.ts")).toEqual([{ to: "runtime-b.ts", t: false }]);
    expect(byFrom("runtime-b.ts")).toEqual([{ to: "runtime-a.ts", t: false }]);
    expect(byFrom("types-a.ts")).toEqual([{ to: "types-b.ts", t: true }]);
    expect(byFrom("types-b.ts")).toEqual([{ to: "types-a.ts", t: true }]);
  });

  it("find_circular_deps filter (edge.type_only !== true) excludes type-only cycles", async () => {
    clearTsconfigCache();
    resetParseCache();

    const files = ["runtime-a.ts", "runtime-b.ts", "types-a.ts", "types-b.ts"].map(
      (path) => ({
        path,
        language: "typescript" as const,
        symbol_count: 1,
        last_modified: 0,
      }),
    );
    const index: CodeIndex = {
      repo: "test-fixture",
      root: FIXTURE,
      symbols: [],
      files,
      created_at: 0,
      updated_at: 0,
      symbol_count: 0,
      file_count: files.length,
    };

    const edges = await collectImportEdges(index);
    // Replicate the filter from findCircularDeps
    const runtimeEdges = edges.filter((e) => e.type_only !== true);
    expect(runtimeEdges.map((e) => `${e.from}->${e.to}`).sort()).toEqual([
      "runtime-a.ts->runtime-b.ts",
      "runtime-b.ts->runtime-a.ts",
    ]);
    // Type-only edges still in the full edge list (for other consumers)
    const typeOnly = edges.filter((e) => e.type_only === true);
    expect(typeOnly).toHaveLength(2);
  });
});
