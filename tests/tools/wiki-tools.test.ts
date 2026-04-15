import { vi, describe, it, expect, beforeEach } from "vitest";
import type { CodeIndex, FileEntry } from "../../src/types.js";
import type { CommunityResult, Community } from "../../src/tools/community-tools.js";
import type { SymbolRoleInfo } from "../../src/tools/graph-tools.js";
import type { FanInFanOutResult, CoChangeResult } from "../../src/tools/coupling-tools.js";
import type { HotspotResult } from "../../src/tools/hotspot-tools.js";
import type { ProfileSummary } from "../../src/tools/project-tools.js";

// ---------------------------------------------------------------------------
// Mocks — all I/O and analysis dependencies
// ---------------------------------------------------------------------------

const mockGetCodeIndex = vi.fn<(repo: string) => Promise<CodeIndex | null>>();
vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: (...args: unknown[]) => mockGetCodeIndex(args[0] as string),
}));

const mockDetectCommunities = vi.fn<(repo: string, focus?: string) => Promise<CommunityResult>>();
vi.mock("../../src/tools/community-tools.js", () => ({
  detectCommunities: (...args: unknown[]) =>
    mockDetectCommunities(args[0] as string, args[1] as string | undefined),
}));

const mockClassifySymbolRoles = vi.fn<(repo: string, options?: object) => Promise<SymbolRoleInfo[]>>();
vi.mock("../../src/tools/graph-tools.js", () => ({
  classifySymbolRoles: (...args: unknown[]) =>
    mockClassifySymbolRoles(args[0] as string, args[1] as object | undefined),
}));

const mockCoChangeAnalysis = vi.fn<(repo: string, options?: object) => Promise<CoChangeResult>>();
const mockFanInFanOut = vi.fn<(repo: string, options?: object) => Promise<FanInFanOutResult>>();
vi.mock("../../src/tools/coupling-tools.js", () => ({
  coChangeAnalysis: (...args: unknown[]) =>
    mockCoChangeAnalysis(args[0] as string, args[1] as object | undefined),
  fanInFanOut: (...args: unknown[]) =>
    mockFanInFanOut(args[0] as string, args[1] as object | undefined),
}));

const mockAnalyzeHotspots = vi.fn<(repo: string, options?: object) => Promise<HotspotResult>>();
vi.mock("../../src/tools/hotspot-tools.js", () => ({
  analyzeHotspots: (...args: unknown[]) =>
    mockAnalyzeHotspots(args[0] as string, args[1] as object | undefined),
}));

const mockAnalyzeProject = vi.fn<(repo: string) => Promise<ProfileSummary>>();
vi.mock("../../src/tools/project-tools.js", () => ({
  analyzeProject: (...args: unknown[]) => mockAnalyzeProject(args[0] as string),
}));

const mockComputeIndexHash = vi.fn<(files: Array<{ path: string; symbol_count: number }>) => string>();
vi.mock("../../src/storage/graph-store.js", () => ({
  computeIndexHash: (...args: unknown[]) =>
    mockComputeIndexHash(args[0] as Array<{ path: string; symbol_count: number }>),
}));

const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockReadFile = vi.fn().mockRejectedValue(new Error("not found"));
const mockReaddir = vi.fn().mockResolvedValue([]);
const mockRename = vi.fn().mockResolvedValue(undefined);
const mockUnlink = vi.fn().mockResolvedValue(undefined);

vi.mock("node:fs/promises", () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  readdir: (...args: unknown[]) => mockReaddir(...args),
  rename: (...args: unknown[]) => mockRename(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeIndex(root = "/repo"): CodeIndex {
  const now = Date.now();
  const files: FileEntry[] = [
    { path: "src/auth/login.ts", language: "typescript", symbol_count: 5, last_modified: now },
    { path: "src/db/query.ts", language: "typescript", symbol_count: 3, last_modified: now },
  ];
  return {
    repo: "test-repo",
    root,
    symbols: [],
    files,
    created_at: now,
    updated_at: now,
    symbol_count: 8,
    file_count: 2,
  };
}

function makeCommunity(name: string, files: string[]): Community {
  return {
    id: 0,
    name,
    files,
    symbol_count: files.length * 3,
    internal_edges: 5,
    external_edges: 2,
    cohesion: 0.71,
  };
}

function makeCommunityResult(): CommunityResult {
  return {
    communities: [
      makeCommunity("Auth Service", ["src/auth/login.ts", "src/auth/token.ts"]),
      makeCommunity("Data Layer", ["src/db/query.ts", "src/db/models.ts"]),
    ],
    modularity: 0.6,
    total_files: 4,
    algorithm: "louvain",
    resolution: 1.0,
  };
}

function makeRoles(): SymbolRoleInfo[] {
  return [
    { id: "r1", name: "login", kind: "function", file: "src/auth/login.ts", role: "core", callers: 5, callees: 3 },
  ];
}

function makeFanInOut(): FanInFanOutResult {
  return {
    fan_in_top: [],
    fan_out_top: [],
    hub_files: [],
    coupling_score: 0.1,
    total_files: 2,
    total_edges: 3,
  };
}

function makeCoChange(): CoChangeResult {
  return {
    pairs: [],
    clusters: [],
    total_commits_analyzed: 10,
    period: "90 days",
  };
}

function makeHotspots(): HotspotResult {
  return {
    hotspots: [
      {
        file: "src/auth/login.ts",
        commits: 20,
        lines_changed: 150,
        symbol_count: 5,
        churn_score: 3000,
        hotspot_score: 15000,
      },
    ],
    period: "90 days",
    total_files: 2,
    total_commits: 30,
  };
}

function makeProject(): ProfileSummary {
  return {
    status: "success",
    profile_path: "/repo/.codesift/project-profile.json",
    stack: {
      framework: null,
      language: "TypeScript",
      test_runner: null,
      package_manager: null,
      monorepo: false,
    },
    file_counts: {
      critical: 0,
      important: 2,
      routine: 0,
      total_analyzed: 2,
    },
    conventions_summary: null,
    dependency_health: null,
    git_health: null,
    duration_ms: 50,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupHappyPath(): void {
  mockGetCodeIndex.mockResolvedValue(makeIndex());
  mockDetectCommunities.mockResolvedValue(makeCommunityResult());
  mockClassifySymbolRoles.mockResolvedValue(makeRoles());
  mockFanInFanOut.mockResolvedValue(makeFanInOut());
  mockCoChangeAnalysis.mockResolvedValue(makeCoChange());
  mockAnalyzeHotspots.mockResolvedValue(makeHotspots());
  mockAnalyzeProject.mockResolvedValue(makeProject());
  mockComputeIndexHash.mockReturnValue("hash-abc123");
}

// ---------------------------------------------------------------------------
// Import the module AFTER mocks are declared
// ---------------------------------------------------------------------------

const { generateWiki } = await import("../../src/tools/wiki-tools.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Reset fs mocks to defaults
  mockWriteFile.mockResolvedValue(undefined);
  mockMkdir.mockResolvedValue(undefined);
  mockReadFile.mockRejectedValue(new Error("not found"));
  mockReaddir.mockResolvedValue([]);
  mockRename.mockResolvedValue(undefined);
  mockUnlink.mockResolvedValue(undefined);
});

describe("generateWiki", () => {
  it("happy path: all analyses resolve → returns correct shape and writes files", async () => {
    setupHappyPath();

    const result = await generateWiki("test-repo", { output_dir: "/tmp/wiki-out" });

    expect(result.wiki_dir).toBe("/tmp/wiki-out");
    expect(result.pages).toBeGreaterThan(0);
    expect(result.communities).toBe(2);
    expect(result.hubs).toBeGreaterThanOrEqual(0);
    expect(result.surprises).toBeGreaterThanOrEqual(0);
    expect(result.degraded).toBe(false);

    // writeFile should have been called for each page + manifest
    expect(mockWriteFile).toHaveBeenCalled();
    // At minimum: index page + 2 community pages + hubs page + hotspots page + manifest
    expect(mockWriteFile.mock.calls.length).toBeGreaterThanOrEqual(4);

    // mkdir called for output directory
    expect(mockMkdir).toHaveBeenCalledWith("/tmp/wiki-out", { recursive: true });
  });

  it("getCodeIndex returns null → throws error matching /not found/i", async () => {
    mockGetCodeIndex.mockResolvedValue(null);

    await expect(generateWiki("missing-repo")).rejects.toThrow(/not found/i);
  });

  it("detectCommunities rejects → degraded wiki still generated with degraded: true", async () => {
    setupHappyPath();
    mockDetectCommunities.mockRejectedValue(new Error("community detection failed"));

    const result = await generateWiki("test-repo", { output_dir: "/tmp/wiki-degraded" });

    expect(result.degraded).toBe(true);
    expect(result.communities).toBe(0);
    // Index and hotspot pages should still be generated
    expect(result.pages).toBeGreaterThan(0);
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it("detectCommunities never resolves (timeout) → degraded output returned", async () => {
    setupHappyPath();
    mockDetectCommunities.mockReturnValue(new Promise(() => {})); // hangs forever

    const result = await generateWiki("test-repo", { output_dir: "/tmp/wiki-timeout" });

    expect(result.degraded).toBe(true);
    expect(result.communities).toBe(0);
    expect(result.pages).toBeGreaterThan(0);
  }, 30_000); // allow up to 30s; timeout sentinel fires at ANALYSIS_TIMEOUT ms

  it("each analysis rejection individually produces partial output", async () => {
    // Each individual rejection still yields a result (not a throw)
    const analysisSetups: Array<() => void> = [
      () => mockClassifySymbolRoles.mockRejectedValue(new Error("roles failed")),
      () => mockCoChangeAnalysis.mockRejectedValue(new Error("cochange failed")),
      () => mockFanInFanOut.mockRejectedValue(new Error("fanin failed")),
      () => mockAnalyzeHotspots.mockRejectedValue(new Error("hotspots failed")),
      () => mockAnalyzeProject.mockRejectedValue(new Error("project failed")),
    ];

    for (const setup of analysisSetups) {
      vi.clearAllMocks();
      mockWriteFile.mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);
      mockReadFile.mockRejectedValue(new Error("not found"));
      mockReaddir.mockResolvedValue([]);

      setupHappyPath();
      setup();

      const result = await generateWiki("test-repo", { output_dir: "/tmp/wiki-partial" });

      expect(result.degraded).toBe(true);
      expect(result.pages).toBeGreaterThan(0);
    }
  });

  it("output_dir defaults to <root>/.codesift/wiki when not provided", async () => {
    setupHappyPath();
    const index = makeIndex("/my/project");
    mockGetCodeIndex.mockResolvedValue(index);

    const result = await generateWiki("test-repo");

    expect(result.wiki_dir).toBe("/my/project/.codesift/wiki");
    expect(mockMkdir).toHaveBeenCalledWith("/my/project/.codesift/wiki", { recursive: true });
  });
});
