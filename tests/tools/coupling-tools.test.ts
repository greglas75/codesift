import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — MUST be before imports so vi.mock hoists correctly
// ---------------------------------------------------------------------------

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

vi.mock("../../src/utils/import-graph.js", () => ({
  collectImportEdges: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { fanInFanOut, coChangeAnalysis } from "../../src/tools/coupling-tools.js";
import { getCodeIndex } from "../../src/tools/index-tools.js";
import { collectImportEdges, type ImportEdge } from "../../src/utils/import-graph.js";
import { execFileSync } from "node:child_process";
import type { CodeIndex, FileEntry } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(path: string): FileEntry {
  return {
    path,
    language: "typescript",
    symbol_count: 1,
    last_modified: Date.now(),
  };
}

function makeFakeIndex(overrides: Partial<CodeIndex> = {}): CodeIndex {
  return {
    repo: "test",
    root: "/test/repo",
    symbols: [],
    files: [
      makeFile("src/a.ts"),
      makeFile("src/b.ts"),
      makeFile("src/c.ts"),
      makeFile("src/d.ts"),
      makeFile("src/utils.ts"),
      makeFile("src/types.ts"),
      makeFile("src/config.ts"),
      makeFile("src/helpers.ts"),
    ],
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: 0,
    file_count: 8,
    ...overrides,
  };
}

const mockGetCodeIndex = vi.mocked(getCodeIndex);
const mockCollectImportEdges = vi.mocked(collectImportEdges);
const mockExecFileSync = vi.mocked(execFileSync);

// ---------------------------------------------------------------------------
// fanInFanOut
// ---------------------------------------------------------------------------

describe("fanInFanOut", () => {
  const edges: ImportEdge[] = [
    { from: "src/a.ts", to: "src/utils.ts" },
    { from: "src/b.ts", to: "src/utils.ts" },
    { from: "src/c.ts", to: "src/utils.ts" },
    { from: "src/d.ts", to: "src/utils.ts" },
    { from: "src/utils.ts", to: "src/types.ts" },
    { from: "src/a.ts", to: "src/types.ts" },
    { from: "src/b.ts", to: "src/types.ts" },
    { from: "src/utils.ts", to: "src/config.ts" },
    { from: "src/utils.ts", to: "src/helpers.ts" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCodeIndex.mockResolvedValue(makeFakeIndex());
    mockCollectImportEdges.mockResolvedValue(edges);
  });

  it("returns correct fan-in counts (most imported files)", async () => {
    const result = await fanInFanOut("test");

    // utils.ts is imported by a, b, c, d → fan-in = 4
    const utils = result.fan_in_top.find((m) => m.file === "src/utils.ts");
    expect(utils).toBeDefined();
    expect(utils!.count).toBe(4);
    expect(utils!.connections).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
    ]);

    // types.ts is imported by utils, a, b → fan-in = 3
    const types = result.fan_in_top.find((m) => m.file === "src/types.ts");
    expect(types).toBeDefined();
    expect(types!.count).toBe(3);

    // Sorted descending
    expect(result.fan_in_top[0]!.count).toBeGreaterThanOrEqual(
      result.fan_in_top[1]!.count,
    );
    expect(result.total_edges).toBe(9);
  });

  it("returns correct fan-out counts (files with most imports)", async () => {
    const result = await fanInFanOut("test");

    // utils.ts imports types, config, helpers → fan-out = 3
    const utils = result.fan_out_top.find((m) => m.file === "src/utils.ts");
    expect(utils).toBeDefined();
    expect(utils!.count).toBe(3);
    expect(utils!.connections).toEqual([
      "src/config.ts",
      "src/helpers.ts",
      "src/types.ts",
    ]);

    // a.ts imports utils, types → fan-out = 2
    const a = result.fan_out_top.find((m) => m.file === "src/a.ts");
    expect(a).toBeDefined();
    expect(a!.count).toBe(2);

    // Sorted descending
    expect(result.fan_out_top[0]!.count).toBeGreaterThanOrEqual(
      result.fan_out_top[1]!.count,
    );
  });

  it("identifies hub files (high both fan-in and fan-out above 75th percentile)", async () => {
    // Hub semantics: a file must have BOTH fan-in AND fan-out STRICTLY greater
    // than the 75th percentile of each. Build an edge set where one file
    // clearly stands out on both axes.
    //
    // hub.ts is imported by a,b,c,d (fan-in = 4) and imports x,y,z,w (fan-out = 4).
    // Many leaf files contribute low fan-in / fan-out samples to drive the
    // 75th percentiles below 4.
    const hubEdges: ImportEdge[] = [
      // fan-in for hub.ts (4 importers)
      { from: "src/a.ts", to: "src/hub.ts" },
      { from: "src/b.ts", to: "src/hub.ts" },
      { from: "src/c.ts", to: "src/hub.ts" },
      { from: "src/d.ts", to: "src/hub.ts" },
      // fan-out for hub.ts (4 imports)
      { from: "src/hub.ts", to: "src/x.ts" },
      { from: "src/hub.ts", to: "src/y.ts" },
      { from: "src/hub.ts", to: "src/z.ts" },
      { from: "src/hub.ts", to: "src/w.ts" },
      // Many other files with fan-in/fan-out of just 1 each to keep
      // percentiles low. Pairs of isolated edges.
      { from: "src/p1.ts", to: "src/q1.ts" },
      { from: "src/p2.ts", to: "src/q2.ts" },
      { from: "src/p3.ts", to: "src/q3.ts" },
      { from: "src/p4.ts", to: "src/q4.ts" },
      { from: "src/p5.ts", to: "src/q5.ts" },
      { from: "src/p6.ts", to: "src/q6.ts" },
      { from: "src/p7.ts", to: "src/q7.ts" },
      { from: "src/p8.ts", to: "src/q8.ts" },
    ];
    mockCollectImportEdges.mockResolvedValue(hubEdges);

    const result = await fanInFanOut("test");

    const hub = result.hub_files.find((h) => h.file === "src/hub.ts");
    expect(hub).toBeDefined();
    expect(hub!.connections).toContain("in=4");
    expect(hub!.connections).toContain("out=4");
    expect(hub!.count).toBe(8);

    // Leaf files (fan-in=1 or fan-out=1 only) must NOT be hubs.
    expect(result.hub_files.find((h) => h.file === "src/q1.ts")).toBeUndefined();
    expect(result.hub_files.find((h) => h.file === "src/p1.ts")).toBeUndefined();

    expect(result.coupling_score).toBeGreaterThanOrEqual(0);
    expect(result.coupling_score).toBeLessThanOrEqual(100);
  });

  it("respects top_n parameter", async () => {
    const result = await fanInFanOut("test", { top_n: 2 });

    expect(result.fan_in_top.length).toBeLessThanOrEqual(2);
    expect(result.fan_out_top.length).toBeLessThanOrEqual(2);
    expect(result.hub_files.length).toBeLessThanOrEqual(2);
  });

  it("respects path focus (only edges where at least one side is under the path)", async () => {
    // Add edges outside "src/" AND one crossing edge.
    const crossingEdge: ImportEdge = { from: "lib/foo.ts", to: "src/utils.ts" };
    const purelyOutsideEdge: ImportEdge = { from: "lib/foo.ts", to: "lib/bar.ts" };
    const extraEdges: ImportEdge[] = [
      ...edges,
      purelyOutsideEdge,
      crossingEdge,
    ];
    mockCollectImportEdges.mockResolvedValue(extraEdges);

    const result = await fanInFanOut("test", { path: "src/" });

    // Purely-outside edge (lib/foo.ts → lib/bar.ts) must be dropped:
    //   - lib/bar.ts should not show up as a fan-in target
    expect(result.fan_in_top.find((m) => m.file === "lib/bar.ts")).toBeUndefined();

    // The crossing edge IS kept, so lib/foo.ts legitimately appears in fan_out
    // (imports src/utils.ts), but lib/bar.ts (from the dropped edge) must NOT.
    const libFoo = result.fan_out_top.find((m) => m.file === "lib/foo.ts");
    expect(libFoo).toBeDefined();
    // lib/foo.ts should import only src/utils.ts, NOT lib/bar.ts
    expect(libFoo!.connections).toEqual(["src/utils.ts"]);

    // utils.ts should still be the top fan-in target
    const utils = result.fan_in_top.find((m) => m.file === "src/utils.ts");
    expect(utils).toBeDefined();
    // Importers should include lib/foo.ts (from crossing edge) plus a..d
    expect(utils!.connections).toContain("lib/foo.ts");
  });

  it("throws when repo not found", async () => {
    mockGetCodeIndex.mockResolvedValue(null);

    await expect(fanInFanOut("missing")).rejects.toThrow(
      /Repository "missing" not found/,
    );
  });

  it("returns empty results when no edges", async () => {
    mockCollectImportEdges.mockResolvedValue([]);

    const result = await fanInFanOut("test");

    expect(result.fan_in_top).toEqual([]);
    expect(result.fan_out_top).toEqual([]);
    expect(result.hub_files).toEqual([]);
    expect(result.total_files).toBe(0);
    expect(result.total_edges).toBe(0);
    // No hubs / no files → perfect coupling score
    expect(result.coupling_score).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// coChangeAnalysis
// ---------------------------------------------------------------------------

describe("coChangeAnalysis", () => {
  // 4 commits:
  //  1: a, b         → pair (a,b)
  //  2: a, b         → pair (a,b)
  //  3: a, b, c      → pairs (a,b), (a,c), (b,c)
  //  4: a, c         → pair (a,c)
  //
  // Co-counts:
  //   a↔b = 3
  //   a↔c = 2
  //   b↔c = 1
  //
  // File commit counts: a=4, b=3, c=2
  //
  // Jaccards:
  //   a↔b = 3 / (4+3-3) = 3/4 = 0.75
  //   a↔c = 2 / (4+2-2) = 2/4 = 0.5
  //   b↔c = 1 / (3+2-1) = 1/4 = 0.25
  const gitLogOutput = [
    "abc123",
    "",
    "src/a.ts\nsrc/b.ts",
    "",
    "def456",
    "",
    "src/a.ts\nsrc/b.ts",
    "",
    "ghi789",
    "",
    "src/a.ts\nsrc/b.ts\nsrc/c.ts",
    "",
    "jkl012",
    "",
    "src/a.ts\nsrc/c.ts",
  ].join("\n");

  function makeCoChangeIndex(): CodeIndex {
    return {
      repo: "test",
      root: "/test/repo",
      symbols: [],
      files: [
        {
          path: "src/a.ts",
          language: "typescript",
          symbol_count: 5,
          last_modified: Date.now(),
        },
        {
          path: "src/b.ts",
          language: "typescript",
          symbol_count: 3,
          last_modified: Date.now(),
        },
        {
          path: "src/c.ts",
          language: "typescript",
          symbol_count: 2,
          last_modified: Date.now(),
        },
      ],
      created_at: Date.now(),
      updated_at: Date.now(),
      symbol_count: 10,
      file_count: 3,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCodeIndex.mockResolvedValue(makeCoChangeIndex());
    mockExecFileSync.mockReturnValue(gitLogOutput as unknown as Buffer);
  });

  it("returns correct co-change pairs with Jaccard values", async () => {
    // min_support=1 so all three pairs qualify; min_jaccard=0 to keep them
    const result = await coChangeAnalysis("test", {
      min_support: 1,
      min_jaccard: 0,
    });

    expect(result.total_commits_analyzed).toBe(4);
    expect(result.pairs.length).toBe(3);

    const ab = result.pairs.find(
      (p) =>
        (p.file_a === "src/a.ts" && p.file_b === "src/b.ts") ||
        (p.file_a === "src/b.ts" && p.file_b === "src/a.ts"),
    );
    expect(ab).toBeDefined();
    expect(ab!.co_commits).toBe(3);
    expect(ab!.jaccard).toBeCloseTo(0.75, 5);

    const ac = result.pairs.find(
      (p) =>
        (p.file_a === "src/a.ts" && p.file_b === "src/c.ts") ||
        (p.file_a === "src/c.ts" && p.file_b === "src/a.ts"),
    );
    expect(ac).toBeDefined();
    expect(ac!.co_commits).toBe(2);
    expect(ac!.jaccard).toBeCloseTo(0.5, 5);

    const bc = result.pairs.find(
      (p) =>
        (p.file_a === "src/b.ts" && p.file_b === "src/c.ts") ||
        (p.file_a === "src/c.ts" && p.file_b === "src/b.ts"),
    );
    expect(bc).toBeDefined();
    expect(bc!.co_commits).toBe(1);
    expect(bc!.jaccard).toBeCloseTo(0.25, 5);

    // Sorted by jaccard descending
    expect(result.pairs[0]!.jaccard).toBeGreaterThanOrEqual(
      result.pairs[1]!.jaccard,
    );
    expect(result.pairs[1]!.jaccard).toBeGreaterThanOrEqual(
      result.pairs[2]!.jaccard,
    );
  });

  it("respects min_jaccard filter", async () => {
    const result = await coChangeAnalysis("test", {
      min_support: 1,
      min_jaccard: 0.6,
    });

    // Only a↔b (0.75) passes the 0.6 threshold
    expect(result.pairs.length).toBe(1);
    expect(result.pairs[0]!.co_commits).toBe(3);
    expect(result.pairs[0]!.jaccard).toBeCloseTo(0.75, 5);
  });

  it("respects min_support filter (default 3 means only a↔b qualifies)", async () => {
    // Use default min_support (3), and very low jaccard threshold
    const result = await coChangeAnalysis("test", { min_jaccard: 0 });

    expect(result.pairs.length).toBe(1);
    const pair = result.pairs[0]!;
    expect(pair.co_commits).toBe(3);
    const files = [pair.file_a, pair.file_b].sort();
    expect(files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("detects clusters (groups of files that always change together)", async () => {
    // a↔b has jaccard 0.75 > 0.7 threshold used by cluster detection
    const result = await coChangeAnalysis("test", {
      min_support: 1,
      min_jaccard: 0,
    });

    expect(result.clusters.length).toBeGreaterThanOrEqual(1);
    const cluster = result.clusters.find(
      (c) => c.includes("src/a.ts") && c.includes("src/b.ts"),
    );
    expect(cluster).toBeDefined();
    // Cluster contains at least these two files
    expect(cluster!.length).toBeGreaterThanOrEqual(2);
  });

  it("respects path focus", async () => {
    // Mix in an unrelated file in the git log output
    const mixed = [
      "abc123",
      "",
      "src/a.ts\nsrc/b.ts",
      "",
      "def456",
      "",
      "src/a.ts\nsrc/b.ts",
      "",
      "ghi789",
      "",
      "src/a.ts\nsrc/b.ts",
      "",
      "jkl012",
      "",
      "lib/x.ts\nlib/y.ts",
      "",
      "mno345",
      "",
      "lib/x.ts\nlib/y.ts",
      "",
      "pqr678",
      "",
      "lib/x.ts\nlib/y.ts",
    ].join("\n");
    mockExecFileSync.mockReturnValue(mixed as unknown as Buffer);

    const result = await coChangeAnalysis("test", {
      min_support: 1,
      min_jaccard: 0,
      path: "src/",
    });

    // Every pair must have at least one side under src/
    for (const p of result.pairs) {
      const match = p.file_a.startsWith("src/") || p.file_b.startsWith("src/");
      expect(match).toBe(true);
    }

    // lib/x.ts ↔ lib/y.ts should be excluded (neither side under src/)
    const libPair = result.pairs.find(
      (p) =>
        (p.file_a === "lib/x.ts" && p.file_b === "lib/y.ts") ||
        (p.file_a === "lib/y.ts" && p.file_b === "lib/x.ts"),
    );
    expect(libPair).toBeUndefined();
  });

  it("throws when repo not found", async () => {
    mockGetCodeIndex.mockResolvedValue(null);

    await expect(coChangeAnalysis("missing")).rejects.toThrow(
      /Repository "missing" not found/,
    );
  });
});
