import { describe, it, expect } from "vitest";
import { buildFilePageRank, type ImportEdge } from "../../src/utils/import-graph.js";

describe("buildFilePageRank", () => {
  it("returns empty Map for empty edge array", () => {
    expect(buildFilePageRank([])).toEqual(new Map());
  });

  it("returns scores for both nodes in a single A → B edge", () => {
    const edges: ImportEdge[] = [{ from: "A.ts", to: "B.ts" }];
    const pr = buildFilePageRank(edges);
    expect(pr.has("A.ts")).toBe(true);
    expect(pr.has("B.ts")).toBe(true);
    // B receives the edge so its rank should exceed A's
    expect(pr.get("B.ts")!).toBeGreaterThan(pr.get("A.ts")!);
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
