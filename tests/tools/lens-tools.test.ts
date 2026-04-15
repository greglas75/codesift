import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — MUST be before imports so vi.mock hoists correctly
// ---------------------------------------------------------------------------

const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockMkdir = vi.fn().mockResolvedValue(undefined);

vi.mock("node:fs/promises", () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
}));

import { generateLens } from "../../src/tools/lens-tools.js";
import { buildLensHtml, type LensData } from "../../src/tools/lens-template.js";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeLensData(overrides: Partial<LensData> = {}): LensData {
  return {
    repo: "my-repo",
    communities: [
      { name: "Auth", files: ["src/auth/login.ts", "src/auth/session.ts"], cohesion: 0.8, symbol_count: 12 },
      { name: "Database", files: ["src/db/query.ts", "src/db/schema.ts"], cohesion: 0.6, symbol_count: 8 },
    ],
    hubs: [
      { name: "createSession", file: "src/auth/session.ts", role: "core", callers: 10, callees: 3 },
      { name: "runQuery", file: "src/db/query.ts", role: "utility", callers: 5, callees: 2 },
    ],
    surprises: [
      {
        community_a: "Auth",
        community_b: "Database",
        combined_score: 0.75,
        edge_count: 4,
        example_files: ["src/auth/login.ts", "src/db/query.ts"],
      },
    ],
    hotspots: [
      { file: "src/auth/login.ts", hotspot_score: 0.9, commits: 42 },
    ],
    wiki_pages: [
      { slug: "auth", title: "Auth", content: "# Auth\n\nAuthentication community." },
      { slug: "hubs", title: "Hub Symbols", content: "# Hubs\n\nKey symbols." },
    ],
    generated_at: "2026-04-15T12:00:00.000Z",
    degraded: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildLensHtml", () => {
  it("T1: produces a string (truthy HTML output)", () => {
    const html = buildLensHtml(makeLensData());
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(100);
  });

  it("T2: HTML string contains <!DOCTYPE html> and </html>", () => {
    const html = buildLensHtml(makeLensData());
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });

  it("T3: HTML contains 5 tab buttons (Overview, Communities, Hubs, Surprises, Wiki)", () => {
    const html = buildLensHtml(makeLensData());
    expect(html).toContain("Overview");
    expect(html).toContain("Communities");
    expect(html).toContain("Hubs");
    expect(html).toContain("Surprises");
    expect(html).toContain("Wiki");
  });

  it("T4: HTML contains const DATA = with inline JSON data", () => {
    const html = buildLensHtml(makeLensData());
    expect(html).toContain("const DATA =");
    // Should contain actual JSON data (repo name embedded)
    expect(html).toContain('"my-repo"');
  });

  it("T5: HTML contains D3 CDN script tag", () => {
    const html = buildLensHtml(makeLensData());
    const hasD3 = html.includes("d3js.org") || html.includes("cdn.jsdelivr.net/npm/d3");
    expect(hasD3).toBe(true);
  });

  it("T6: escHtml applied — repo name with HTML chars is entity-encoded", () => {
    const html = buildLensHtml(makeLensData({ repo: "test<script>repo" }));
    // Should contain entity-encoded version
    expect(html).toContain("test&lt;script&gt;repo");
    // Must NOT contain raw unescaped version
    expect(html).not.toContain("test<script>repo");
  });

  it("T7: communities >= 2 → HTML contains chord diagram section", () => {
    const html = buildLensHtml(makeLensData());
    // Should have chord diagram container
    const hasChord = html.includes('id="chord"') || html.includes("id='chord'");
    expect(hasChord).toBe(true);
  });

  it("T8: communities <= 1 → HTML contains 'low modularity' notice instead of chord", () => {
    const html = buildLensHtml(makeLensData({
      communities: [
        { name: "All", files: ["src/index.ts"], cohesion: 0.3, symbol_count: 5 },
      ],
    }));
    expect(html).toContain("low modularity");
    // Chord container should NOT be present
    const hasChord = html.includes('id="chord"') || html.includes("id='chord'");
    expect(hasChord).toBe(false);
  });

  it("T9: empty hotspots array → HTML contains 'No hotspots' section", () => {
    const html = buildLensHtml(makeLensData({ hotspots: [] }));
    expect(html).toContain("No hotspots");
  });
});

describe("generateLens", () => {
  beforeEach(() => {
    mockWriteFile.mockClear();
    mockMkdir.mockClear();
  });

  it("T1 (integration): returns { path } object matching the given outputPath", async () => {
    const outputPath = "/tmp/repo/codesift-lens.html";
    const result = await generateLens(makeLensData(), outputPath);
    expect(result).toEqual({ path: outputPath });
  });

  it("T10 (integration): writeFile called with path ending in codesift-lens.html", async () => {
    const outputPath = "/tmp/my-project/codesift-lens.html";
    await generateLens(makeLensData(), outputPath);
    expect(mockWriteFile).toHaveBeenCalledOnce();
    const [calledPath] = mockWriteFile.mock.calls[0] as [string, string, string];
    expect(calledPath).toMatch(/codesift-lens\.html$/);
  });
});
