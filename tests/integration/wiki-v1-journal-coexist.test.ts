/**
 * Task 18 — V1 rollback coexistence integration test.
 *
 * Verifies that when CODESIFT_WIKI_V1=1 is set (rollback mode), a pre-existing
 * wiki journal directory is left completely undisturbed:
 *
 *   (a) generateWiki() runs without throwing and does NOT touch journal/
 *   (b) lintWiki() returns zero issues (journal-lint exemption, Task 13)
 *   (c) journal/phases/foo.md is byte-equal before and after both calls
 *
 * Approach: full-real for (a) — uses the ts-monorepo fixture + indexFolder so
 * generateWiki() runs its genuine analysis pipeline.  lintWiki() is called
 * directly against the same wikiDir with the hand-crafted v2.0 manifest.
 *
 * Pre-journal manifest shape: plain v2.0 object with NO manifest_schema_version
 * field and NO journal pages — exactly what a wiki generated before v2.1 looks
 * like on disk.  lintWiki() parses the JSON without strict schema validation so
 * the missing field is intentional and must not cause a crash.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, cpSync, rmSync, existsSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Pre-journal manifest — schema v2.0 shape (no manifest_schema_version, no
 *  journal page types).  The lintWiki parser must tolerate this gracefully. */
function makePreJournalManifest(): object {
  return {
    generated_at: new Date().toISOString(),
    index_hash: "abc123",
    git_commit: "deadbeef",
    pages: [
      {
        slug: "index",
        type: "index",
        file: "index.md",
        outbound_links: [],
      },
    ],
    slug_redirects: {},
    token_estimates: {},
    file_to_community: {},
    degraded: false,
  };
}

/** Minimal journal phase file with a valid sentinel structure (Task 6 shape). */
const JOURNAL_PHASE_CONTENT = `## Example phase

<!-- auto:begin phase-summary -->
Content
<!-- auto:end phase-summary -->

<!-- source_commits: abc1234 -->
`;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("V1 rollback — journal coexistence (Task 18)", () => {
  let workdir: string;
  let wikiDir: string;
  let journalFile: string;
  let priorV1Env: string | undefined;

  beforeEach(async () => {
    // Copy the ts-monorepo fixture to a fresh tmpdir so generateWiki has a
    // real indexable repository to work with.
    const fixture = resolve(__dirname, "../fixtures/wiki-v2/ts-monorepo");
    workdir = mkdtempSync(join(tmpdir(), "wiki-v1-coexist-"));
    cpSync(fixture, workdir, { recursive: true });

    wikiDir = join(workdir, ".codesift", "wiki");
    await mkdir(wikiDir, { recursive: true });

    // Pre-journal wiki-manifest.json (v2.0 shape — no manifest_schema_version)
    await writeFile(
      join(wikiDir, "wiki-manifest.json"),
      JSON.stringify(makePreJournalManifest(), null, 2),
      "utf-8",
    );

    // Minimal index.md so the manifest's pages[0].file exists on disk
    await writeFile(join(wikiDir, "index.md"), "# Wiki Index\n", "utf-8");

    // Journal directory + phase file that must survive untouched
    const journalDir = join(wikiDir, "journal", "phases");
    await mkdir(journalDir, { recursive: true });
    journalFile = join(journalDir, "foo.md");
    await writeFile(journalFile, JOURNAL_PHASE_CONTENT, "utf-8");

    // Enable V1 rollback mode
    priorV1Env = process.env.CODESIFT_WIKI_V1;
    process.env.CODESIFT_WIKI_V1 = "1";
  });

  afterEach(() => {
    // Restore env
    if (priorV1Env === undefined) {
      delete process.env.CODESIFT_WIKI_V1;
    } else {
      process.env.CODESIFT_WIKI_V1 = priorV1Env;
    }
    if (workdir && existsSync(workdir)) {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // (a) generateWiki does not throw and does not touch journal/
  // -------------------------------------------------------------------------

  it("(a) generateWiki runs without throwing and leaves journal/ untouched", async () => {
    // Capture hash before
    const before = sha256(await readFile(journalFile));

    const { indexFolder } = await import("../../src/tools/index-tools.js");
    const { repo } = await indexFolder(workdir);

    const { generateWiki } = await import("../../src/tools/wiki-tools.js");
    // Must not throw — degraded mode is acceptable
    await expect(
      generateWiki(repo, { output_dir: wikiDir }),
    ).resolves.toBeDefined();

    // Journal file must still exist
    expect(existsSync(journalFile)).toBe(true);

    // Hash must be unchanged (byte-equal)
    const after = sha256(await readFile(journalFile));
    expect(after).toBe(before);
  }, 60_000);

  // -------------------------------------------------------------------------
  // (b) lintWiki returns zero issues (journal exemption, Task 13)
  // -------------------------------------------------------------------------

  it("(b) lintWiki exits with zero issues — journal files not flagged as orphans", async () => {
    const { lintWiki } = await import("../../src/tools/wiki-lint.js");
    const result = await lintWiki(wikiDir);

    // The journal file is NOT in the manifest pages, but the lint exemption
    // (Task 13) must prevent it from being flagged as an orphan-page error.
    const journalOrphanIssues = result.issues.filter(
      (i) => i.type === "orphan-page" && (i.target ?? "").startsWith("journal"),
    );
    expect(journalOrphanIssues).toHaveLength(0);

    // There must be no errors at all (index.md exists, no broken links, no
    // journal-related sentinel issues from the manifest)
    expect(result.issues).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // (c) journal file byte-equal after both calls
  // -------------------------------------------------------------------------

  it("(c) journal/phases/foo.md is byte-equal after generateWiki + lintWiki", async () => {
    const before = sha256(await readFile(journalFile));

    // Run both operations
    const { indexFolder } = await import("../../src/tools/index-tools.js");
    const { repo } = await indexFolder(workdir);
    const { generateWiki } = await import("../../src/tools/wiki-tools.js");
    await generateWiki(repo, { output_dir: wikiDir });

    const { lintWiki } = await import("../../src/tools/wiki-lint.js");
    await lintWiki(wikiDir);

    // Byte-equality check
    expect(existsSync(journalFile)).toBe(true);
    const after = sha256(await readFile(journalFile));
    expect(after).toBe(before);
  }, 60_000);
});
