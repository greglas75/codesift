import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — MUST be before imports so vi.mock hoists correctly
// ---------------------------------------------------------------------------

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

vi.mock("../../src/tools/project-tools.js", () => ({
  analyzeProject: vi.fn(),
}));

vi.mock("../../src/tools/community-tools.js", () => ({
  detectCommunities: vi.fn(),
}));

vi.mock("../../src/tools/coupling-tools.js", () => ({
  fanInFanOut: vi.fn(),
}));

vi.mock("../../src/tools/graph-tools.js", () => ({
  findCircularDeps: vi.fn(),
}));

import { architectureSummary } from "../../src/tools/architecture-tools.js";
import { getCodeIndex } from "../../src/tools/index-tools.js";
import { analyzeProject } from "../../src/tools/project-tools.js";
import { detectCommunities } from "../../src/tools/community-tools.js";
import { fanInFanOut } from "../../src/tools/coupling-tools.js";
import { findCircularDeps } from "../../src/tools/graph-tools.js";
import type { CodeIndex, FileEntry } from "../../src/types.js";
import type { CommunityResult } from "../../src/tools/community-tools.js";
import type { FanInFanOutResult } from "../../src/tools/coupling-tools.js";
import type { CircularDepsResult } from "../../src/tools/graph-tools.js";

// ---------------------------------------------------------------------------
// Typed mock handles
// ---------------------------------------------------------------------------

const mockedGetCodeIndex = vi.mocked(getCodeIndex);
const mockedAnalyzeProject = vi.mocked(analyzeProject);
const mockedDetectCommunities = vi.mocked(detectCommunities);
const mockedFanInFanOut = vi.mocked(fanInFanOut);
const mockedFindCircularDeps = vi.mocked(findCircularDeps);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(path: string, symbol_count = 1): FileEntry {
  return {
    path,
    language: "typescript",
    symbol_count,
    last_modified: Date.now(),
  };
}

function makeFakeIndex(overrides: Partial<CodeIndex> = {}): CodeIndex {
  return {
    repo: "test",
    root: "/test/repo",
    symbols: [],
    files: [
      makeFile("src/tools/a.ts", 10),
      makeFile("src/tools/b.ts", 8),
      makeFile("src/utils/helpers.ts", 5),
    ],
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: 23,
    file_count: 3,
    ...overrides,
  };
}

function makeFanResult(overrides: Partial<FanInFanOutResult> = {}): FanInFanOutResult {
  return {
    fan_in_top: [
      { file: "src/utils/helpers.ts", count: 8, connections: [] },
      { file: "src/types.ts", count: 3, connections: [] },
    ],
    fan_out_top: [
      { file: "src/tools/a.ts", count: 5, connections: [] },
      { file: "src/utils/helpers.ts", count: 2, connections: [] },
    ],
    hub_files: [
      { file: "src/register-tools.ts", count: 15, connections: ["in=8", "out=7"] },
    ],
    coupling_score: 85,
    total_files: 10,
    total_edges: 25,
    ...overrides,
  };
}

function makeCommunityResult(overrides: Partial<CommunityResult> = {}): CommunityResult {
  return {
    communities: [
      {
        id: 0,
        name: "tools",
        files: ["a.ts"],
        symbol_count: 10,
        internal_edges: 5,
        external_edges: 1,
        cohesion: 0.83,
      },
    ],
    modularity: 0.45,
    total_files: 3,
    algorithm: "louvain",
    resolution: 1.0,
    ...overrides,
  };
}

function makeCircResult(overrides: Partial<CircularDepsResult> = {}): CircularDepsResult {
  return {
    cycles: [{ cycle: ["src/a.ts", "src/b.ts"], length: 2 }],
    total_files: 10,
    total_edges: 25,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("architectureSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockedGetCodeIndex.mockResolvedValue(makeFakeIndex());
    mockedAnalyzeProject.mockResolvedValue({ summary: "TypeScript project" } as any);
    mockedDetectCommunities.mockResolvedValue(makeCommunityResult());
    mockedFanInFanOut.mockResolvedValue(makeFanResult());
    mockedFindCircularDeps.mockResolvedValue(makeCircResult());
  });

  it("happy path: aggregates results from all 5 analyses", async () => {
    const result = await architectureSummary("test");

    // stack populated from analyzeProject
    expect(result.stack).toEqual({ summary: "TypeScript project" });

    // communities from detectCommunities
    expect(result.communities).toHaveLength(1);
    expect(result.communities[0]?.name).toBe("tools");

    // coupling_hotspots from fanInFanOut.hub_files
    expect(result.coupling_hotspots).toHaveLength(1);
    expect(result.coupling_hotspots[0]?.file).toBe("src/register-tools.ts");

    // circular_deps — unwrap {cycle, length} → string[][]
    expect(result.circular_deps).toEqual([["src/a.ts", "src/b.ts"]]);

    // loc_distribution computed from index.files
    expect(result.loc_distribution.length).toBeGreaterThan(0);

    // entry_points: helpers.ts fan_in=8, fan_out=2 → qualifies
    expect(result.entry_points).toContain("src/utils/helpers.ts");

    // duration_ms >= 0
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);

    // mermaid not set without output_format option
    expect(result.mermaid).toBeUndefined();
  });

  it("throws when getCodeIndex returns null", async () => {
    mockedGetCodeIndex.mockResolvedValue(null);

    await expect(architectureSummary("test")).rejects.toThrow(/not found/i);
  });

  it("gracefully degrades when fanInFanOut rejects", async () => {
    mockedFanInFanOut.mockRejectedValue(new Error("boom"));

    const result = await architectureSummary("test");

    // Other fields still populated
    expect(result.stack).toEqual({ summary: "TypeScript project" });
    expect(result.communities).toHaveLength(1);
    expect(result.circular_deps).toEqual([["src/a.ts", "src/b.ts"]]);

    // Fan-related fields are empty
    expect(result.coupling_hotspots).toEqual([]);
    expect(result.entry_points).toEqual([]);
  });

  it("includes a Mermaid diagram when output_format=mermaid", async () => {
    const result = await architectureSummary("test", { output_format: "mermaid" });

    expect(result.mermaid).toBeTypeOf("string");
    expect(result.mermaid?.length).toBeGreaterThan(0);
    expect(result.mermaid).toContain("graph TD");
  });

  it("passes focus option to detectCommunities, fanInFanOut (path), and findCircularDeps (file_pattern)", async () => {
    await architectureSummary("test", { focus: "src/tools" });

    expect(mockedDetectCommunities).toHaveBeenCalledWith("test", "src/tools");
    expect(mockedFanInFanOut).toHaveBeenCalledWith(
      "test",
      expect.objectContaining({ path: "src/tools", top_n: 10 }),
    );
    expect(mockedFindCircularDeps).toHaveBeenCalledWith(
      "test",
      expect.objectContaining({ file_pattern: "src/tools", max_cycles: 10 }),
    );
  });

  it("computes loc_distribution grouped by first two path segments", async () => {
    mockedGetCodeIndex.mockResolvedValue(
      makeFakeIndex({
        files: [
          makeFile("src/tools/a.ts", 10),
          makeFile("src/tools/b.ts", 8),
          makeFile("src/utils/helpers.ts", 5),
          makeFile("src/utils/other.ts", 2),
          makeFile("tests/foo.test.ts", 1),
        ],
      }),
    );

    const result = await architectureSummary("test");

    const dirs = Object.fromEntries(result.loc_distribution.map((d) => [d.dir, d]));

    expect(dirs["src/tools"]).toBeDefined();
    expect(dirs["src/tools"]?.file_count).toBe(2);
    expect(dirs["src/tools"]?.symbol_count).toBe(18);

    expect(dirs["src/utils"]).toBeDefined();
    expect(dirs["src/utils"]?.file_count).toBe(2);
    expect(dirs["src/utils"]?.symbol_count).toBe(7);

    expect(dirs["tests/foo.test.ts"]).toBeDefined();
    expect(dirs["tests/foo.test.ts"]?.file_count).toBe(1);

    // Sorted descending by symbol_count
    const symbolCounts = result.loc_distribution.map((d) => d.symbol_count);
    const sorted = [...symbolCounts].sort((a, b) => b - a);
    expect(symbolCounts).toEqual(sorted);
  });

  it("flags files with fan_in >= 5 and fan_out <= 3 as entry_points", async () => {
    mockedFanInFanOut.mockResolvedValue(
      makeFanResult({
        fan_in_top: [
          { file: "src/api.ts", count: 10, connections: [] }, // in=10, out=?
          { file: "src/noisy.ts", count: 6, connections: [] }, // in=6, out=5 (excluded)
          { file: "src/lowfanin.ts", count: 4, connections: [] }, // in=4 (excluded)
          { file: "src/silent.ts", count: 7, connections: [] }, // no fan_out_top entry → out=0
        ],
        fan_out_top: [
          { file: "src/api.ts", count: 2, connections: [] },
          { file: "src/noisy.ts", count: 5, connections: [] },
          { file: "src/lowfanin.ts", count: 1, connections: [] },
        ],
      }),
    );

    const result = await architectureSummary("test");

    expect(result.entry_points).toContain("src/api.ts");
    expect(result.entry_points).toContain("src/silent.ts");
    expect(result.entry_points).not.toContain("src/noisy.ts");
    expect(result.entry_points).not.toContain("src/lowfanin.ts");
  });
});
