import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetIndex = vi.fn();
vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: () => mockGetIndex(),
}));

import { getFileTree } from "../../src/tools/outline-tools.js";

function syntheticIndex(nFiles: number): unknown {
  return {
    root: "/repo",
    files: Array.from({ length: nFiles }, (_, i) => ({
      path: `src/dir${i % 12}/file${i}.ts`,
      symbol_count: 3,
    })),
    symbols: [],
  };
}

describe("getFileTree auto-compact (NESTED_TREE_MAX)", () => {
  beforeEach(() => mockGetIndex.mockReset());

  it("small repo (≤150 files), default → nested tree (array)", async () => {
    mockGetIndex.mockResolvedValue(syntheticIndex(50));
    const r = await getFileTree("local/x");
    expect(Array.isArray(r)).toBe(true);
    expect((r as Array<{ type?: string }>).some((n) => n.type === "dir" || n.type === "file")).toBe(true);
  });

  it("medium repo (>150 files), default → flat compact list, not nested", async () => {
    mockGetIndex.mockResolvedValue(syntheticIndex(200));
    const r = await getFileTree("local/x") as { entries: unknown[]; truncated: boolean; total: number; hint: string };
    expect(r.entries).toBeDefined();
    expect(r.total).toBe(200);
    expect(r.truncated).toBe(false); // 200 < MAX_TREE_FILES (500) → not truncated, just flattened
    expect(r.hint).toContain("flat list");
  });

  it("compact=false forces the nested view even above the threshold", async () => {
    mockGetIndex.mockResolvedValue(syntheticIndex(200));
    const r = await getFileTree("local/x", { compact: false });
    expect(Array.isArray(r)).toBe(true);
  });

  it("flat compact (>150) is far smaller than the nested view would be", async () => {
    mockGetIndex.mockResolvedValue(syntheticIndex(300));
    const flat = await getFileTree("local/x");               // auto-compacted
    mockGetIndex.mockResolvedValue(syntheticIndex(300));
    const nested = await getFileTree("local/x", { compact: false });
    expect(JSON.stringify(flat).length).toBeLessThan(JSON.stringify(nested).length);
  });
});
