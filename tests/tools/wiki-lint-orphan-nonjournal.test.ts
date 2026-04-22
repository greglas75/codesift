import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WikiManifest, JournalPageEntry, ExistingPageEntry } from "../../src/tools/wiki-manifest.js";
import type { CitationResult } from "../../scripts/journal-citation-check.js";

// ---------------------------------------------------------------------------
// Mock node:fs/promises so tests run without a real filesystem
// ---------------------------------------------------------------------------
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock citation-check — lazy import inside lintWiki uses this
// ---------------------------------------------------------------------------
vi.mock("../../scripts/journal-citation-check.js", () => ({
  runCitationCheck: vi.fn(),
}));

import { readFile, readdir } from "node:fs/promises";
import { runCitationCheck } from "../../scripts/journal-citation-check.js";
import { lintWiki } from "../../src/tools/wiki-lint.js";

const mockReadFile = vi.mocked(readFile);
const mockReaddir = vi.mocked(readdir);
const mockRunCitationCheck = vi.mocked(runCitationCheck as (file: string, threshold: number) => Promise<CitationResult>);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExistingPage(slug: string, file: string): ExistingPageEntry {
  return { slug, title: slug, type: "community", file, outbound_links: [] };
}

function makeJournalPage(slug: string, file: string, hashes?: Record<string, string>): JournalPageEntry {
  return {
    slug,
    title: slug,
    type: "journal-phase",
    file,
    outbound_links: [],
    source: "generated",
    ...(hashes !== undefined ? { journal_content_hashes: hashes } : {}),
  };
}

function makeManifest(pages: WikiManifest["pages"]): WikiManifest {
  return {
    manifest_schema_version: "2.1.0",
    generated_at: "2026-04-22T00:00:00.000Z",
    index_hash: "abc123",
    git_commit: "def456",
    pages,
    slug_redirects: {},
    token_estimates: {},
    file_to_community: {},
    degraded: false,
  };
}

const WIKI_DIR = "/fake/wiki";
const MANIFEST_PATH = `${WIKI_DIR}/wiki-manifest.json`;

// Minimal sentinel-clean phase file content
const CLEAN_PHASE = `# Phase 1
<!-- auto:begin meta -->
Some content here
<!-- auto:end meta -->
`;

// Phase file with unclosed sentinel
const BROKEN_SENTINEL_PHASE = `# Phase 1
<!-- auto:begin meta -->
Some content here
`;

// Phase file with known block hash (will be computed fresh in test)
const PHASE_WITH_SUMMARY = `# Phase 1
<!-- auto:begin phase-summary -->
Summary text here
<!-- auto:end phase-summary -->
`;

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// (a) Non-journal orphan regression — stray.md not in manifest → orphan-page
// ---------------------------------------------------------------------------
describe("(a) non-journal orphan regression", () => {
  it("emits orphan-page error with severity 'error' for stray.md", async () => {
    const manifest = makeManifest([makeExistingPage("index", "index.md")]);
    mockReadFile.mockImplementation(async (path: unknown) => {
      if ((path as string) === MANIFEST_PATH) return JSON.stringify(manifest);
      if ((path as string) === `${WIKI_DIR}/index.md`) return "# Index";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mockReaddir.mockResolvedValue(["index.md", "stray.md"] as never);

    const result = await lintWiki(WIKI_DIR);

    const orphanIssue = result.issues.find((i) => i.type === "orphan-page" && i.target === "stray.md");
    expect(orphanIssue).toBeDefined();
    expect(orphanIssue?.severity).toBe("error");
    expect(orphanIssue?.message).toMatch(/stray\.md/);
  });
});

// ---------------------------------------------------------------------------
// (b) Journal exemption — journal/ directory NOT flagged as orphan
// ---------------------------------------------------------------------------
describe("(b) journal orphan exemption", () => {
  it("does not emit orphan-page for journal/ entries", async () => {
    const journalPage = makeJournalPage("phase-1", "journal/phases/phase-1.md");
    const manifest = makeManifest([makeExistingPage("index", "index.md"), journalPage]);
    mockReadFile.mockImplementation(async (path: unknown) => {
      if ((path as string) === MANIFEST_PATH) return JSON.stringify(manifest);
      if ((path as string) === `${WIKI_DIR}/index.md`) return "# Index";
      if ((path as string) === `${WIKI_DIR}/journal/phases/phase-1.md`) return CLEAN_PHASE;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    // readdir returns top-level: "index.md" + "journal" (the directory)
    mockReaddir.mockResolvedValue(["index.md", "journal"] as never);

    const result = await lintWiki(WIKI_DIR);

    const journalOrphan = result.issues.find((i) => i.type === "orphan-page" && i.target === "journal");
    expect(journalOrphan).toBeUndefined();
    expect(result.issues.filter((i) => i.type === "orphan-page")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (c) Sentinel integrity check — unclosed begin → sentinel-integrity error
// ---------------------------------------------------------------------------
describe("(c) sentinel integrity check", () => {
  it("emits sentinel-integrity error with file and line for unclosed block", async () => {
    const journalPage = makeJournalPage("phase-1", "journal/phases/phase-1.md");
    const manifest = makeManifest([journalPage]);
    mockReadFile.mockImplementation(async (path: unknown) => {
      if ((path as string) === MANIFEST_PATH) return JSON.stringify(manifest);
      if ((path as string) === `${WIKI_DIR}/journal/phases/phase-1.md`) return BROKEN_SENTINEL_PHASE;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mockReaddir.mockResolvedValue(["journal"] as never);

    const result = await lintWiki(WIKI_DIR);

    const sentinelIssue = result.issues.find((i) => i.type === "sentinel-integrity");
    expect(sentinelIssue).toBeDefined();
    expect(sentinelIssue?.severity).toBe("error");
    expect(sentinelIssue?.target).toBe("journal/phases/phase-1.md");
    expect(sentinelIssue?.line).toBeTypeOf("number");
    expect(sentinelIssue?.message).toMatch(/meta/i);
  });
});

// ---------------------------------------------------------------------------
// (d) Hash-mismatch warning — recorded hash != current content hash
// ---------------------------------------------------------------------------
describe("(d) hash-mismatch warning", () => {
  it("emits journal-hash-drift warning (severity warning) when block hash drifted", async () => {
    // The manifest records "old-hash" but the current file produces a different hash
    const journalPage = makeJournalPage("phase-1", "journal/phases/phase-1.md", {
      "phase-summary": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const manifest = makeManifest([journalPage]);
    mockReadFile.mockImplementation(async (path: unknown) => {
      if ((path as string) === MANIFEST_PATH) return JSON.stringify(manifest);
      if ((path as string) === `${WIKI_DIR}/journal/phases/phase-1.md`) return PHASE_WITH_SUMMARY;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mockReaddir.mockResolvedValue(["journal"] as never);

    const result = await lintWiki(WIKI_DIR);

    const driftWarning = result.warnings.find((w) => w.type === "journal-hash-drift");
    expect(driftWarning).toBeDefined();
    expect(driftWarning?.severity).toBe("warning");
    expect(driftWarning?.target).toBe("journal/phases/phase-1.md");
    expect(driftWarning?.message).toMatch(/hash drifted/i);
    // Should NOT be in issues (exit code 0 — non-blocking)
    expect(result.issues.find((i) => i.type === "journal-hash-drift")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (e) --strict citation dispatch
// ---------------------------------------------------------------------------
describe("(e) --strict citation dispatch", () => {
  it("calls runCitationCheck once per journal-phase in strict mode", async () => {
    const journalPage = makeJournalPage("phase-1", "journal/phases/phase-1.md");
    const manifest = makeManifest([journalPage]);
    mockReadFile.mockImplementation(async (path: unknown) => {
      if ((path as string) === MANIFEST_PATH) return JSON.stringify(manifest);
      if ((path as string) === `${WIKI_DIR}/journal/phases/phase-1.md`) return CLEAN_PHASE;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mockReaddir.mockResolvedValue(["journal"] as never);

    // Mock returns 50% grounded → should surface citation-ungrounded warning
    mockRunCitationCheck.mockResolvedValue({
      total: 4,
      grounded: 2,
      percentage: 50,
      ungrounded: [
        { literal: "abc1234", kind: "sha" },
        { literal: "xyz5678", kind: "sha" },
      ],
    });

    const result = await lintWiki(WIKI_DIR, undefined, { strict: true });

    expect(mockRunCitationCheck).toHaveBeenCalledTimes(1);
    expect(mockRunCitationCheck).toHaveBeenCalledWith(
      `${WIKI_DIR}/journal/phases/phase-1.md`,
      95,
    );

    const citationWarn = result.warnings.find((w) => w.type === "citation-ungrounded");
    expect(citationWarn).toBeDefined();
    expect(citationWarn?.severity).toBe("warning");
    expect(citationWarn?.target).toBe("journal/phases/phase-1.md");
    expect(citationWarn?.message).toMatch(/2\/4/);
  });

  it("does NOT call runCitationCheck when strict is not set", async () => {
    const journalPage = makeJournalPage("phase-1", "journal/phases/phase-1.md");
    const manifest = makeManifest([journalPage]);
    mockReadFile.mockImplementation(async (path: unknown) => {
      if ((path as string) === MANIFEST_PATH) return JSON.stringify(manifest);
      if ((path as string) === `${WIKI_DIR}/journal/phases/phase-1.md`) return CLEAN_PHASE;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mockReaddir.mockResolvedValue(["journal"] as never);

    await lintWiki(WIKI_DIR);

    expect(mockRunCitationCheck).toHaveBeenCalledTimes(0);
  });
});
