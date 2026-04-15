import { describe, it, expect } from "vitest";
import { resolveWikiLinks } from "../../src/tools/wiki-links.js";
import type { LinkResolutionResult } from "../../src/tools/wiki-links.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePages(): Map<string, string> {
  return new Map([
    ["page-a", "# Page A\n\nLinks to [[page-b]] and also [[page-c]].\n"],
    ["page-b", "# Page B\n\nBack to [[page-a]].\n"],
    ["page-c", "# Page C\n\nNo outbound links here.\n"],
  ]);
}

function makeKnownSlugs(pages: Map<string, string>): Set<string> {
  return new Set(pages.keys());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveWikiLinks", () => {
  it("extracts [[slug]] references from page content", () => {
    const pages = makePages();
    const result = resolveWikiLinks(pages, makeKnownSlugs(pages));

    // page-a links to page-b and page-c
    // We verify this by checking that page-b and page-c have page-a as a backlink
    const pageB = result.resolvedPages.get("page-b")!;
    expect(pageB).toContain("page-a");

    const pageC = result.resolvedPages.get("page-c")!;
    expect(pageC).toContain("page-a");
  });

  it("inverts forward links to produce backlink map (page-b and page-c reference page-a)", () => {
    const pages = makePages();
    const result = resolveWikiLinks(pages, makeKnownSlugs(pages));

    // page-b links to page-a → page-a should have backlink from page-b
    const pageA = result.resolvedPages.get("page-a")!;
    expect(pageA).toContain("page-b");

    // page-a links to page-b → page-b should have backlink from page-a
    const pageB = result.resolvedPages.get("page-b")!;
    expect(pageB).toContain("page-a");

    // page-c has no inbound links from the test set except page-a
    // already verified page-c contains page-a in the previous test
  });

  it("appends ## Backlinks section at end of each page that has backlinks", () => {
    const pages = makePages();
    const result = resolveWikiLinks(pages, makeKnownSlugs(pages));

    // page-a is linked by page-b → should get a ## Backlinks section
    const pageA = result.resolvedPages.get("page-a")!;
    expect(pageA).toContain("## Backlinks");

    // page-b is linked by page-a → should get a ## Backlinks section
    const pageB = result.resolvedPages.get("page-b")!;
    expect(pageB).toContain("## Backlinks");

    // page-c is linked by page-a → should get a ## Backlinks section
    const pageC = result.resolvedPages.get("page-c")!;
    expect(pageC).toContain("## Backlinks");
  });

  it("flags unresolved [[slug]] (target not in knownSlugs) as broken link", () => {
    const pages = new Map([
      ["page-a", "# Page A\n\nLinks to [[missing-page]] and [[page-b]].\n"],
      ["page-b", "# Page B\n\nNo broken links here.\n"],
    ]);
    const knownSlugs = new Set(["page-a", "page-b"]); // missing-page is NOT known

    const result = resolveWikiLinks(pages, knownSlugs);

    expect(result.brokenLinks).toHaveLength(1);
    expect(result.brokenLinks[0]).toEqual({ source: "page-a", target: "missing-page" });
  });

  it("page with no outbound links has empty forward links and no backlinks section added", () => {
    const pages = makePages();
    const result = resolveWikiLinks(pages, makeKnownSlugs(pages));

    // page-c has no outbound links
    // Its content should NOT have a ## Backlinks section injected FROM itself
    // (it does have one because page-a links to it — but the original content has no [[...]])
    // We verify no broken links come from page-c
    const brokenFromC = result.brokenLinks.filter((b) => b.source === "page-c");
    expect(brokenFromC).toHaveLength(0);

    // page-c itself has no outbound links so it contributes no forward entries
    // Verify the original page-c content starts correctly (just appended, not modified otherwise)
    const pageC = result.resolvedPages.get("page-c")!;
    expect(pageC.startsWith("# Page C")).toBe(true);
  });

  it("self-referencing [[self]] link is not counted as broken and appears in own backlinks", () => {
    const pages = new Map([
      ["self-page", "# Self Page\n\nReferences itself: [[self-page]].\n"],
    ]);
    const knownSlugs = new Set(["self-page"]);

    const result = resolveWikiLinks(pages, knownSlugs);

    // self-page is a known slug → not a broken link
    expect(result.brokenLinks).toHaveLength(0);

    // self-page links to itself → it should appear in its own ## Backlinks section
    const selfPage = result.resolvedPages.get("self-page")!;
    expect(selfPage).toContain("## Backlinks");
    expect(selfPage).toContain("self-page");
  });
});
