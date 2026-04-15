import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lintWiki } from "../../src/tools/wiki-lint.js";
import type { WikiManifest } from "../../src/tools/wiki-manifest.js";

function makeManifest(overrides: Partial<WikiManifest> = {}): WikiManifest {
  return {
    generated_at: new Date().toISOString(),
    index_hash: "abc123",
    git_commit: "def456",
    pages: [
      { slug: "page-a", title: "Page A", type: "community", file: "page-a.md", outbound_links: ["page-b"] },
      { slug: "page-b", title: "Page B", type: "hubs", file: "page-b.md", outbound_links: [] },
    ],
    slug_redirects: {},
    token_estimates: { "page-a": 100, "page-b": 50 },
    file_to_community: { "src/a.ts": "page-a" },
    degraded: false,
    ...overrides,
  };
}

describe("lintWiki", () => {
  let wikiDir: string;

  beforeEach(() => {
    wikiDir = mkdtempSync(join(tmpdir(), "wiki-lint-"));
  });

  afterEach(() => {
    rmSync(wikiDir, { recursive: true, force: true });
  });

  it("valid wiki returns zero issues", async () => {
    const manifest = makeManifest();
    writeFileSync(join(wikiDir, "wiki-manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(wikiDir, "page-a.md"), "# Page A\nSee [[page-b]]");
    writeFileSync(join(wikiDir, "page-b.md"), "# Page B\nNo links here");

    const result = await lintWiki(wikiDir);
    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("broken [[slug]] returns issue", async () => {
    const manifest = makeManifest();
    writeFileSync(join(wikiDir, "wiki-manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(wikiDir, "page-a.md"), "# Page A\nSee [[nonexistent]]");
    writeFileSync(join(wikiDir, "page-b.md"), "# Page B");

    const result = await lintWiki(wikiDir);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.type).toBe("broken-link");
    expect(result.issues[0]!.source).toBe("page-a");
    expect(result.issues[0]!.target).toBe("nonexistent");
  });

  it("orphan pages detected", async () => {
    const manifest = makeManifest();
    writeFileSync(join(wikiDir, "wiki-manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(wikiDir, "page-a.md"), "# Page A");
    writeFileSync(join(wikiDir, "page-b.md"), "# Page B");
    writeFileSync(join(wikiDir, "orphan.md"), "# Orphan");

    const result = await lintWiki(wikiDir);
    expect(result.issues.some((i) => i.type === "orphan-page" && i.target === "orphan.md")).toBe(true);
  });

  it("missing manifest throws", async () => {
    await expect(lintWiki(wikiDir)).rejects.toThrow(/manifest not found/i);
  });

  it("stale index hash returns warning", async () => {
    const manifest = makeManifest({ index_hash: "old-hash" });
    writeFileSync(join(wikiDir, "wiki-manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(wikiDir, "page-a.md"), "# Page A\nSee [[page-b]]");
    writeFileSync(join(wikiDir, "page-b.md"), "# Page B");

    const result = await lintWiki(wikiDir, "new-hash");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.type).toBe("stale-hash");
  });
});
