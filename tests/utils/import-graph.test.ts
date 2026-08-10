import { describe, it, expect } from "vitest";
import {
  buildFilePageRank,
  buildImportAdjacency,
  extractImports,
  type ImportEdge,
} from "../../src/utils/import-graph.js";

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

  it("returns an empty Map when graph construction rejects an invalid node", () => {
    const invalidEdges = [
      { from: Symbol("invalid-node"), to: "B.ts" },
    ] as unknown as ImportEdge[];
    expect(buildFilePageRank(invalidEdges)).toEqual(new Map());
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
