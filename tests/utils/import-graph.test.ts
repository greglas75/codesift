import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { resetParseCache } from "../../src/parser/parse-cache.js";
import { getParser } from "../../src/parser/parser-manager.js";
import type { CodeIndex } from "../../src/types.js";
import {
  buildFilePageRank,
  buildImportAdjacency,
  collectImportEdges,
  extractImports,
  type ImportEdge,
} from "../../src/utils/import-graph.js";

function makeIndex(root: string, paths: string[]): CodeIndex {
  return {
    repo: "test/import-graph-null-parse",
    root,
    symbols: [],
    files: paths.map((path) => ({
      path,
      language: "typescript" as const,
      symbol_count: 0,
      last_modified: 0,
    })),
    created_at: 0,
    updated_at: 0,
    symbol_count: 0,
    file_count: paths.length,
  };
}

describe("extractImports", () => {
  it("collects and deduplicates relative static, dynamic, and CommonJS imports", () => {
    const source = `
      import { alpha } from "./alpha.js";
      import("../beta.ts");
      const gamma = require("./gamma.cjs");
      import { external } from "external-package";
      import { alphaAgain } from "./alpha.js";
      require("./alpha.js");
    `;

    expect(extractImports(source)).toEqual(["./alpha.js", "../beta.ts", "./gamma.cjs"]);
  });
});

describe("buildImportAdjacency", () => {
  it("builds symmetric neighbor sets for every directed edge", () => {
    const edges: ImportEdge[] = [
      { from: "A.ts", to: "B.ts" },
      { from: "B.ts", to: "C.ts" },
    ];

    expect(buildImportAdjacency(edges)).toEqual(
      new Map([
        ["A.ts", new Set(["B.ts"])],
        ["B.ts", new Set(["A.ts", "C.ts"])],
        ["C.ts", new Set(["B.ts"])],
      ]),
    );
  });
});

describe("collectImportEdges", () => {
  it("falls back to regex imports when the TypeScript parser returns null", async () => {
    const root = await mkdtemp(join(tmpdir(), "codesift-import-graph-"));
    const parser = await getParser("typescript");
    expect(parser).not.toBeNull();
    const parseSpy = vi.spyOn(parser!, "parse").mockReturnValueOnce(null);
    const warningSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    resetParseCache();

    try {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "main.ts"), 'import { dep } from "./dep.ts";');
      await writeFile(join(root, "src", "dep.ts"), "export {};\n");

      const edges = await collectImportEdges(
        makeIndex(root, ["src/main.ts", "src/dep.ts"]),
        new Set(["src/main.ts"]),
      );

      expect(parseSpy).toHaveBeenCalledWith('import { dep } from "./dep.ts";');
      expect(warningSpy).toHaveBeenCalledWith(
        "[import-graph] TS parser returned null for src/main.ts; falling back to regex",
      );
      expect(edges).toContainEqual({ from: "src/main.ts", to: "src/dep.ts" });
    } finally {
      parseSpy.mockRestore();
      warningSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("buildFilePageRank", () => {
  it("returns empty Map for empty edge array", () => {
    expect(buildFilePageRank([])).toEqual(new Map());
  });

  it("returns scores for both nodes in a single A → B edge", () => {
    const edges: ImportEdge[] = [{ from: "A.ts", to: "B.ts" }];
    const pr = buildFilePageRank(edges);
    expect(pr.has("A.ts")).toBe(true);
    expect(pr.has("B.ts")).toBe(true);
    expect(pr.get("A.ts")).toBeCloseTo(0.350877, 5);
    expect(pr.get("B.ts")).toBeCloseTo(0.649123, 5);
  });

  it("keeps a self-loop node while excluding the self edge", () => {
    expect(buildFilePageRank([{ from: "A.ts", to: "A.ts" }])).toEqual(
      new Map([["A.ts", 1]]),
    );
  });

  it("deduplicates repeated directed edges", () => {
    const once = buildFilePageRank([{ from: "A.ts", to: "B.ts" }]);
    const repeated = buildFilePageRank([
      { from: "A.ts", to: "B.ts" },
      { from: "A.ts", to: "B.ts" },
    ]);
    expect(repeated).toEqual(once);
  });

  it("skips invalid nodes without discarding valid PageRank results", () => {
    const invalidEdges = [
      { from: "A.ts", to: "B.ts" },
      { from: Symbol("invalid-node"), to: "B.ts" },
    ] as unknown as ImportEdge[];
    const result = buildFilePageRank(invalidEdges);
    expect(result.has("A.ts")).toBe(true);
    expect(result.has("B.ts")).toBe(true);
  });

  it("handles cycle A → B → A", () => {
    const edges: ImportEdge[] = [
      { from: "A.ts", to: "B.ts" },
      { from: "B.ts", to: "A.ts" },
    ];
    const pr = buildFilePageRank(edges);
    expect(pr.size).toBe(2);
    for (const v of pr.values()) expect(Number.isFinite(v)).toBe(true);
  });

  it("handles disconnected components with finite scores", () => {
    const edges: ImportEdge[] = [
      { from: "A.ts", to: "B.ts" },
      { from: "C.ts", to: "D.ts" },
    ];
    const pr = buildFilePageRank(edges);
    expect(pr.size).toBe(4);
    for (const v of pr.values()) expect(Number.isFinite(v)).toBe(true);
  });

  it("excludes isolated nodes (no edges present in the array)", () => {
    // No edges mentioning Z.ts → Z.ts must not appear in the result
    const edges: ImportEdge[] = [{ from: "A.ts", to: "B.ts" }];
    const pr = buildFilePageRank(edges);
    expect(pr.has("Z.ts")).toBe(false);
  });
});
