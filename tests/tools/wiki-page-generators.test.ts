import { describe, it, expect } from "vitest";
import {
  generateCommunityPage,
  generateCommunitySummary,
  generateHubsPage,
  generateSurprisePage,
  generateHotspotsPage,
  generateFrameworkPage,
  generateIndexPage,
  type CommunityPageData,
  type HubSymbol,
  type FileHotspot,
  type FrameworkInfo,
} from "../../src/tools/wiki-page-generators.js";
import type { SurpriseScore } from "../../src/tools/wiki-surprise.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const community = { name: "auth", files: ["src/auth/login.ts", "src/auth/token.ts"], size: 2 };

const hubs: HubSymbol[] = [
  { name: "AuthService", file: "src/auth/service.ts", role: "core", callers: 12, callees: 5 },
  { name: "verifyToken", file: "src/auth/token.ts", role: "entry", callers: 8, callees: 2 },
];

const hotspots: FileHotspot[] = [
  { file: "src/auth/login.ts", commits: 45, hotspot_score: 0.92 },
  { file: "src/core/index.ts", commits: 30, hotspot_score: 0.75 },
];

const communityPageData: CommunityPageData = {
  community,
  cohesion: 0.72,
  internal_edges: 14,
  external_edges: 6,
  hotspots,
  hub_symbols: hubs,
};

const surprises: SurpriseScore[] = [
  {
    community_a: "auth",
    community_b: "payments",
    structural_score: 2.5,
    temporal_score: 0.8,
    combined_score: 1.82,
    edge_count: 5,
    example_files: ["src/auth/token.ts", "src/payments/charge.ts"],
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateCommunityPage", () => {
  it("1. returns non-empty markdown with # heading", () => {
    const result = generateCommunityPage(communityPageData);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/^# /m);
  });

  it("9. with 20+ files → contains truncation note with +N more files", () => {
    const manyFiles = Array.from({ length: 22 }, (_, i) => `src/module/file${i}.ts`);
    const data: CommunityPageData = {
      ...communityPageData,
      community: { name: "bigmodule", files: manyFiles, size: 22 },
    };
    const result = generateCommunityPage(data);
    expect(result).toMatch(/\+\d+ more files/);
  });

  it("11. community name containing < → output contains backslash-escaped char", () => {
    const data: CommunityPageData = {
      ...communityPageData,
      community: { name: "a<b", files: [], size: 0 },
    };
    const result = generateCommunityPage(data);
    expect(result).toContain("\\<");
  });
});

describe("generateHubsPage", () => {
  it("2. returns markdown with hub symbols table", () => {
    const result = generateHubsPage(hubs);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("AuthService");
    // Should have a markdown table (pipe characters)
    expect(result).toMatch(/\|.+\|/);
  });
});

describe("generateSurprisePage", () => {
  it("3. returns markdown with surprise connections table", () => {
    const result = generateSurprisePage(surprises);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("auth");
    expect(result).toContain("payments");
    expect(result).toMatch(/\|.+\|/);
  });

  it("8. with empty surprises → contains 'No surprise connections detected'", () => {
    const result = generateSurprisePage([]);
    expect(result).toContain("No surprise connections detected");
  });
});

describe("generateHotspotsPage", () => {
  it("4. returns markdown with hotspot file list", () => {
    const result = generateHotspotsPage(hotspots);
    expect(result.length).toBeGreaterThan(0);
    // escMd escapes '.' and '-', so the path appears escaped in output
    expect(result).toContain("src/auth/login");
    expect(result).toContain("45");
  });
});

describe("generateFrameworkPage", () => {
  it("5. returns markdown with framework-specific content", () => {
    const fw: FrameworkInfo = { name: "nextjs", details: "App Router with 12 pages" };
    const result = generateFrameworkPage(fw);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("nextjs");
    expect(result).toContain("App Router with 12 pages");
  });

  it("12. with null framework → returns empty string", () => {
    const result = generateFrameworkPage(null);
    expect(result).toBe("");
  });
});

describe("generateIndexPage", () => {
  it("6. returns markdown with links to all pages", () => {
    const pages = [
      { slug: "overview", title: "Overview", type: "index" },
      { slug: "hubs", title: "Hub Symbols", type: "hubs" },
    ];
    const result = generateIndexPage(pages);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("[[overview]]");
    expect(result).toContain("[[hubs]]");
  });

  it("7. with 3 communities → contains 3 [[slug]] links", () => {
    const pages = [
      { slug: "community-auth", title: "auth", type: "community" },
      { slug: "community-payments", title: "payments", type: "community" },
      { slug: "community-core", title: "core", type: "community" },
    ];
    const result = generateIndexPage(pages);
    const matches = result.match(/\[\[[\w-]+\]\]/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});

describe("generateCommunitySummary", () => {
  it("10. returns string <= 1600 chars", () => {
    // Build a large community to stress the budget
    const manyFiles = Array.from({ length: 50 }, (_, i) => `src/module/file${i}.ts`);
    const manyHubs: HubSymbol[] = Array.from({ length: 20 }, (_, i) => ({
      name: `Symbol${i}`,
      file: `src/module/file${i}.ts`,
      role: "core" as const,
      callers: i * 3,
      callees: i,
    }));
    const bigData: CommunityPageData = {
      community: { name: "bigmodule", files: manyFiles, size: 50 },
      cohesion: 0.85,
      internal_edges: 200,
      external_edges: 50,
      hotspots: hotspots,
      hub_symbols: manyHubs,
    };
    const result = generateCommunitySummary(bigData);
    expect(result.length).toBeLessThanOrEqual(1600);
  });
});
