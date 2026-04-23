import { describe, it, expect } from "vitest";
import {
  buildJournalManifestEntries,
  mergeJournalIntoManifest,
  renderJournalSectionMd,
  insertJournalSectionIntoIndex,
  shouldSkipPhaseByHash,
  type JournalPhaseWrite,
} from "../../../src/tools/journal-generator-helpers.js";
import type {
  WikiManifest,
  JournalPageEntry,
  ExistingPageEntry,
} from "../../../src/tools/wiki-manifest.js";

// ─── 1. buildJournalManifestEntries ──────────────────────────────────────────
describe("buildJournalManifestEntries", () => {
  it("returns overview + phase entries when overviewPresent=true", () => {
    const writes: JournalPhaseWrite[] = [
      { slug: "p1", title: "P1", file: "journal/phases/p1.md", hash: "h" },
    ];
    const entries = buildJournalManifestEntries(writes, true);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      slug: "journal-overview",
      title: "Journal — Overview",
      type: "journal-overview",
      file: "journal/overview.md",
      outbound_links: [],
      source: "generated",
    });
    expect(entries[1]).toEqual({
      slug: "p1",
      title: "P1",
      type: "journal-phase",
      file: "journal/phases/p1.md",
      outbound_links: [],
      source: "generated",
      journal_content_hashes: { "phase-summary": "h" },
    });
  });

  it("omits overview entry when overviewPresent=false", () => {
    const entries = buildJournalManifestEntries(
      [{ slug: "p1", title: "P1", file: "journal/phases/p1.md", hash: "h" }],
      false,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("journal-phase");
  });
});

// ─── 2-3. mergeJournalIntoManifest ───────────────────────────────────────────
describe("mergeJournalIntoManifest", () => {
  it("creates minimal manifest with manifest_schema_version 2.1.0 when existing=null", () => {
    const entries: JournalPageEntry[] = [
      {
        slug: "p1", title: "P1", type: "journal-phase",
        file: "journal/phases/p1.md", outbound_links: [], source: "generated",
        journal_content_hashes: { "phase-summary": "h" },
      },
    ];
    const m = mergeJournalIntoManifest(null, entries);
    expect(m.manifest_schema_version).toBe("2.1.0");
    expect(m.pages).toEqual(entries);
    expect(m.slug_redirects).toEqual({});
    expect(m.token_estimates).toEqual({});
    expect(m.file_to_community).toEqual({});
    expect(m.degraded).toBe(false);
  });

  it("replaces all journal-* pages by slug match, preserves non-journal pages", () => {
    const nonJournal: ExistingPageEntry = {
      slug: "arch", title: "Architecture", type: "architecture",
      file: "architecture.md", outbound_links: ["foo"],
    };
    const oldJournal: JournalPageEntry = {
      slug: "p-old", title: "Old", type: "journal-phase",
      file: "journal/phases/p-old.md", outbound_links: [], source: "generated",
      journal_content_hashes: { "phase-summary": "old-hash" },
    };
    const existing: WikiManifest = {
      manifest_schema_version: "2.1.0",
      generated_at: "2026-01-01T00:00:00Z",
      index_hash: "abc", git_commit: "def",
      pages: [nonJournal, oldJournal],
      slug_redirects: { "x": "y" }, token_estimates: { "arch": 100 },
      file_to_community: { "src/foo.ts": "arch" },
      degraded: false,
    };
    const newEntries: JournalPageEntry[] = [
      {
        slug: "p-new", title: "New", type: "journal-phase",
        file: "journal/phases/p-new.md", outbound_links: [], source: "generated",
        journal_content_hashes: { "phase-summary": "new-hash" },
      },
    ];
    const merged = mergeJournalIntoManifest(existing, newEntries);
    expect(merged.pages).toHaveLength(2);
    expect(merged.pages[0]).toEqual(nonJournal);
    expect(merged.pages[1]!.slug).toBe("p-new");
    // old journal page removed
    expect(merged.pages.find((p) => p.slug === "p-old")).toBeUndefined();
    // preserved metadata
    expect(merged.slug_redirects).toEqual({ "x": "y" });
    expect(merged.index_hash).toBe("abc");
  });
});

// ─── 4. renderJournalSectionMd ───────────────────────────────────────────────
describe("renderJournalSectionMd", () => {
  it("renders ## journal heading + bullets, phases sorted by slug", () => {
    const entries: JournalPageEntry[] = [
      {
        slug: "journal-overview", title: "Journal — Overview", type: "journal-overview",
        file: "journal/overview.md", outbound_links: [], source: "generated",
      },
      {
        slug: "2026-04-z", title: "Z", type: "journal-phase",
        file: "journal/phases/2026-04-z.md", outbound_links: [], source: "generated",
      },
      {
        slug: "2026-03-a", title: "A", type: "journal-phase",
        file: "journal/phases/2026-03-a.md", outbound_links: [], source: "generated",
      },
    ];
    const md = renderJournalSectionMd(entries);
    expect(md).toContain("## journal");
    expect(md).toContain("Weekly phase narratives auto-registered");
    expect(md).toContain("- [journal/overview](journal/overview.md) — At a glance / Themes / Sources");
    // Sort: 2026-03-a before 2026-04-z
    const aIdx = md.indexOf("2026-03-a");
    const zIdx = md.indexOf("2026-04-z");
    expect(aIdx).toBeGreaterThan(-1);
    expect(zIdx).toBeGreaterThan(aIdx);
    expect(md).toContain("- [journal/phases/2026-03-a](journal/phases/2026-03-a.md) — A");
    expect(md).toContain("- [journal/phases/2026-04-z](journal/phases/2026-04-z.md) — Z");
  });
});

// ─── 5-6. insertJournalSectionIntoIndex ──────────────────────────────────────
describe("insertJournalSectionIntoIndex", () => {
  const section = "## journal\n\nBullet\n- [x](x) — X\n";

  it("inserts before ## hubs when no section exists", () => {
    const existing = "# Index\n\nIntro.\n\n## hubs\n\n- hub1\n";
    const result = insertJournalSectionIntoIndex(existing, section);
    const journalIdx = result.indexOf("## journal");
    const hubsIdx = result.indexOf("## hubs");
    expect(journalIdx).toBeGreaterThan(-1);
    expect(hubsIdx).toBeGreaterThan(journalIdx);
    // Original hubs content preserved
    expect(result).toContain("- hub1");
  });

  it("replaces body of existing ## journal section up to next ## heading", () => {
    const existing =
      "# Index\n\n## journal\n\nOLD body line 1\nOLD body line 2\n\n## hubs\n\n- hub1\n";
    const newSection = "## journal\n\nNEW body\n";
    const result = insertJournalSectionIntoIndex(existing, newSection);
    expect(result).toContain("NEW body");
    expect(result).not.toContain("OLD body");
    // hubs still preserved
    expect(result).toContain("## hubs");
    expect(result).toContain("- hub1");
    // Only one ## journal heading
    expect(result.match(/^## journal$/gm)?.length ?? 0).toBe(1);
  });

  it("appends section when no ## journal and no ## hubs", () => {
    const existing = "# Index\n\nIntro only.\n";
    const result = insertJournalSectionIntoIndex(existing, section);
    expect(result).toContain("# Index");
    expect(result).toContain("## journal");
    expect(result.indexOf("## journal")).toBeGreaterThan(result.indexOf("Intro only."));
  });
});

// ─── 7-10. shouldSkipPhaseByHash ─────────────────────────────────────────────
describe("shouldSkipPhaseByHash", () => {
  const matchingManifest = (): WikiManifest => ({
    manifest_schema_version: "2.1.0",
    generated_at: "2026-04-20T00:00:00Z",
    index_hash: "", git_commit: "",
    pages: [
      {
        slug: "p1", title: "P1", type: "journal-phase",
        file: "journal/phases/p1.md", outbound_links: [], source: "generated",
        journal_content_hashes: { "phase-summary": "h" },
      },
    ],
    slug_redirects: {}, token_estimates: {},
    file_to_community: {}, degraded: false,
  });

  it("returns true when force=false and manifest has matching slug+hash", () => {
    expect(shouldSkipPhaseByHash("p1", "h", { force: false, manifest: matchingManifest() })).toBe(true);
  });

  it("returns false when force=true (force wins)", () => {
    expect(shouldSkipPhaseByHash("p1", "h", { force: true, manifest: matchingManifest() })).toBe(false);
  });

  it("returns false when currentHash differs from manifest recorded hash", () => {
    expect(shouldSkipPhaseByHash("p1", "different", { force: false, manifest: matchingManifest() })).toBe(false);
  });

  it("returns false when manifest is null", () => {
    expect(shouldSkipPhaseByHash("p1", "h", { force: false, manifest: null })).toBe(false);
  });

  it("returns false when slug not found in manifest", () => {
    expect(shouldSkipPhaseByHash("other-slug", "h", { force: false, manifest: matchingManifest() })).toBe(false);
  });
});
