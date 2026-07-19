import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — MUST be before imports so vi.mock hoists correctly.
//
// Only the index/edge-acquisition boundary is mocked. The Louvain algorithm,
// modularity calculation, and community naming inside detectCommunities()
// run for real against the synthetic graphs built below — this is the first
// black-box coverage for community-tools.ts (every other suite that touches
// communities mocks detectCommunities() itself).
// ---------------------------------------------------------------------------

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

vi.mock("../../src/utils/import-graph.js", () => ({
  collectImportEdges: vi.fn(),
}));

import { detectCommunities } from "../../src/tools/community-tools.js";
import type { CommunityResult } from "../../src/tools/community-tools.js";
import { getCodeIndex } from "../../src/tools/index-tools.js";
import { collectImportEdges, type ImportEdge } from "../../src/utils/import-graph.js";
import type { CodeIndex, FileEntry } from "../../src/types.js";

const mockGetCodeIndex = vi.mocked(getCodeIndex);
const mockCollectImportEdges = vi.mocked(collectImportEdges);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(path: string, symbolCount = 1): FileEntry {
  return {
    path,
    language: "typescript",
    symbol_count: symbolCount,
    last_modified: Date.now(),
  };
}

function makeFakeIndex(files: FileEntry[]): CodeIndex {
  return {
    repo: "test",
    root: "/test/repo",
    symbols: [],
    files,
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: files.reduce((sum, f) => sum + f.symbol_count, 0),
    file_count: files.length,
  };
}

/** Assert result is the JSON shape (not { mermaid }) and narrow the type. */
function expectJsonResult(
  result: CommunityResult | { mermaid: string },
): asserts result is CommunityResult {
  if ("mermaid" in result) throw new Error("expected JSON CommunityResult, got mermaid output");
}

/**
 * Flatten every file listed across all returned communities. Fixtures below
 * stay well under MAX_FILES_PER_COMMUNITY (20), so no "... +N more"
 * truncation marker should ever appear — assert that invariant here so a
 * regression in the cap logic would fail loudly rather than silently
 * corrupting the partition check.
 */
function allCommunityFiles(result: CommunityResult): string[] {
  const out: string[] = [];
  for (const c of result.communities) {
    for (const f of c.files) {
      expect(f.startsWith("...")).toBe(false);
      out.push(f);
    }
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// detectCommunities — real Louvain algorithm, mocked index/edge boundary
// ---------------------------------------------------------------------------

describe("detectCommunities (black-box, real Louvain algorithm)", () => {
  it("(a) assigns every indexed file to exactly one community — no file falls through", async () => {
    const files = [
      makeFile("src/a.ts"),
      makeFile("src/b.ts"),
      makeFile("src/c.ts"),
      makeFile("src/d.ts"),
      makeFile("src/e.ts"),
    ];
    const edges: ImportEdge[] = [
      { from: "src/a.ts", to: "src/b.ts" },
      { from: "src/b.ts", to: "src/c.ts" },
      { from: "src/c.ts", to: "src/d.ts" },
      { from: "src/d.ts", to: "src/e.ts" },
    ];
    mockGetCodeIndex.mockResolvedValue(makeFakeIndex(files));
    mockCollectImportEdges.mockResolvedValue(edges);

    const result = await detectCommunities("test");
    expectJsonResult(result);

    const seen = allCommunityFiles(result);
    // Partition property: every file appears, and appears exactly once.
    expect(seen.sort()).toEqual(files.map((f) => f.path).sort());
    expect(new Set(seen).size).toBe(seen.length);
    expect(result.total_files).toBe(files.length);
  });

  it("(b) handles an orphan file (zero edges) without throwing and lands it deterministically", async () => {
    const files = [
      makeFile("src/a.ts"),
      makeFile("src/b.ts"),
      makeFile("src/orphan.ts"),
    ];
    const edges: ImportEdge[] = [{ from: "src/a.ts", to: "src/b.ts" }];
    mockGetCodeIndex.mockResolvedValue(makeFakeIndex(files));
    mockCollectImportEdges.mockResolvedValue(edges);

    const run = async () => {
      const result = await detectCommunities("test");
      expectJsonResult(result);
      return result;
    };

    const result = await run();
    const seen = allCommunityFiles(result);
    expect(seen.sort()).toEqual(files.map((f) => f.path).sort());

    // Orphan lands in exactly one community, isolated from a/b's edges.
    const orphanCommunities = result.communities.filter((c) => c.files.includes("src/orphan.ts"));
    expect(orphanCommunities).toHaveLength(1);
    expect(orphanCommunities[0]!.internal_edges).toBe(0);
    expect(orphanCommunities[0]!.external_edges).toBe(0);

    // Same input twice → same placement (deterministic, not e.g. hash-order dependent).
    const second = await run();
    expect(second).toEqual(result);
  });

  it("(c) splits a two-cluster fixture into communities matching the dense-import groups", async () => {
    const files = [
      makeFile("src/a1.ts"),
      makeFile("src/a2.ts"),
      makeFile("src/a3.ts"),
      makeFile("src/b1.ts"),
      makeFile("src/b2.ts"),
      makeFile("src/b3.ts"),
    ];
    // Two dense triangles (group A, group B) joined by one weak inter-group edge.
    const edges: ImportEdge[] = [
      { from: "src/a1.ts", to: "src/a2.ts" },
      { from: "src/a2.ts", to: "src/a3.ts" },
      { from: "src/a1.ts", to: "src/a3.ts" },
      { from: "src/b1.ts", to: "src/b2.ts" },
      { from: "src/b2.ts", to: "src/b3.ts" },
      { from: "src/b1.ts", to: "src/b3.ts" },
      { from: "src/a1.ts", to: "src/b1.ts" },
    ];
    mockGetCodeIndex.mockResolvedValue(makeFakeIndex(files));
    mockCollectImportEdges.mockResolvedValue(edges);

    const result = await detectCommunities("test");
    expectJsonResult(result);

    expect(result.communities.length).toBeGreaterThanOrEqual(2);

    const commOf = (path: string) => result.communities.find((c) => c.files.includes(path));
    const commA = commOf("src/a1.ts");
    const commB = commOf("src/b1.ts");
    expect(commA).toBeDefined();
    expect(commB).toBeDefined();
    expect(commA!.id).not.toBe(commB!.id);

    expect([...commA!.files].sort()).toEqual(["src/a1.ts", "src/a2.ts", "src/a3.ts"]);
    expect([...commB!.files].sort()).toEqual(["src/b1.ts", "src/b2.ts", "src/b3.ts"]);

    // Every file still accounted for exactly once across the full partition.
    const seen = allCommunityFiles(result);
    expect(seen.sort()).toEqual(files.map((f) => f.path).sort());
  });

  it("community count and membership are stable across repeated calls with identical input", async () => {
    const files = [
      makeFile("src/a1.ts"),
      makeFile("src/a2.ts"),
      makeFile("src/a3.ts"),
      makeFile("src/b1.ts"),
      makeFile("src/b2.ts"),
      makeFile("src/b3.ts"),
    ];
    const edges: ImportEdge[] = [
      { from: "src/a1.ts", to: "src/a2.ts" },
      { from: "src/a2.ts", to: "src/a3.ts" },
      { from: "src/a1.ts", to: "src/a3.ts" },
      { from: "src/b1.ts", to: "src/b2.ts" },
      { from: "src/b2.ts", to: "src/b3.ts" },
      { from: "src/b1.ts", to: "src/b3.ts" },
      { from: "src/a1.ts", to: "src/b1.ts" },
    ];
    mockGetCodeIndex.mockResolvedValue(makeFakeIndex(files));
    mockCollectImportEdges.mockResolvedValue(edges);

    const first = await detectCommunities("test");
    const second = await detectCommunities("test");
    expectJsonResult(first);
    expectJsonResult(second);

    expect(second.communities.length).toBe(first.communities.length);
    expect(second.modularity).toBe(first.modularity);
    expect(second).toEqual(first);
  });
});
