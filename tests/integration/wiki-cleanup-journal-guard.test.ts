/**
 * D1 — Cleanup guard: generateWiki() must NEVER unlink files under
 * `.codesift/wiki/journal/` during its stale-page cleanup phase.
 *
 * Two-path coverage:
 *   Path A: real generateWiki() against a fixture, journal sentinel survives.
 *   Path B: pruneStaleWikiFiles() unit test with a mocked recursive readdir
 *           simulating a future change — the guard must still protect `journal/...`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, cpSync, rmSync, existsSync } from "node:fs";
import { mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resetConfigCache } from "../../src/config.js";

describe("Wiki cleanup — journal guard (D1)", () => {
  describe("Path A: real generateWiki leaves journal/ untouched", () => {
    let workdir: string;

    beforeEach(() => {
      const fixture = resolve(__dirname, "../fixtures/wiki-v2/ts-monorepo");
      workdir = mkdtempSync(join(tmpdir(), "cleanup-guard-"));
      process.env["CODESIFT_DATA_DIR"] = join(workdir, ".codesift-machine-data");
      resetConfigCache();
      cpSync(fixture, workdir, { recursive: true });
    });

    afterEach(() => {
      delete process.env["CODESIFT_DATA_DIR"];
      resetConfigCache();
      if (workdir && existsSync(workdir)) {
        rmSync(workdir, { recursive: true, force: true });
      }
    });

    it("preserves .codesift/wiki/journal/phases/test.md after generateWiki", async () => {
      const wikiDir = join(workdir, ".codesift", "wiki");
      const journalDir = join(wikiDir, "journal", "phases");
      await mkdir(journalDir, { recursive: true });
      const sentinel = join(journalDir, "test.md");
      await writeFile(sentinel, "# journal sentinel\n", "utf-8");

      const { indexFolder } = await import("../../src/tools/index-tools.js");
      const idxResult = await indexFolder(workdir);
      const { generateWiki } = await import("../../src/tools/wiki-tools.js");
      await generateWiki(idxResult.repo, { output_dir: wikiDir });

      // Sentinel must still exist — guard prevented cleanup from touching journal/.
      await expect(access(sentinel)).resolves.toBeUndefined();
    }, 60_000);
  });

  describe("Path B: pruneStaleWikiFiles with recursive-stub readdir", () => {
    beforeEach(() => {
      vi.resetModules();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.resetModules();
    });

    it("does NOT unlink journal/phases/test.md even when readdir surfaces it", async () => {
      const readdirMock = vi.fn().mockResolvedValueOnce([
        "journal/phases/test.md",
        "index.md",
      ]);
      const unlinkMock = vi.fn().mockResolvedValue(undefined);

      vi.doMock("node:fs/promises", async () => {
        const actual = await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
        return {
          ...actual,
          readdir: readdirMock,
          unlink: unlinkMock,
        };
      });

      const mod = await import("../../src/tools/wiki-tools.js");
      expect(
        typeof (mod as { pruneStaleWikiFiles?: unknown }).pruneStaleWikiFiles,
      ).toBe("function");

      const outputDir = "/virtual/wiki";
      const known = new Set<string>(["index.md"]);
      const deleted = await mod.pruneStaleWikiFiles(outputDir, known, [
        "journal",
      ]);

      // unlink must never be called for the journal path
      const unlinkCalls = unlinkMock.mock.calls.map((c) => String(c[0]));
      for (const p of unlinkCalls) {
        expect(p).not.toContain("journal/");
      }
      // And the returned deleted list must not include journal paths
      for (const p of deleted) {
        expect(p).not.toContain("journal/");
      }
      // The only candidate (index.md) is in knownFiles, so unlink was never called
      expect(unlinkMock).not.toHaveBeenCalled();
      expect(deleted).toEqual([]);
    });

    it("deletes a stale top-level .md file that is not in knownFiles and not under a protected prefix", async () => {
      const readdirMock = vi.fn().mockResolvedValueOnce([
        "journal/phases/test.md",
        "old-page.md",
        "index.md",
        "manifest.json",
        ".wiki-lock",
      ]);
      const unlinkedPaths: string[] = [];
      const unlinkMock = vi.fn().mockImplementation(async (p: string) => {
        unlinkedPaths.push(p);
      });

      vi.doMock("node:fs/promises", async () => {
        const actual = await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
        return {
          ...actual,
          readdir: readdirMock,
          unlink: unlinkMock,
        };
      });

      const mod = await import("../../src/tools/wiki-tools.js");
      const outputDir = "/virtual/wiki";
      const known = new Set<string>(["index.md"]);
      const deleted = await mod.pruneStaleWikiFiles(outputDir, known, [
        "journal",
      ]);

      expect(unlinkMock).toHaveBeenCalledTimes(1);
      expect(unlinkMock).toHaveBeenCalledWith(expect.stringContaining("old-page.md"));
      expect(unlinkedPaths[0]).toContain("old-page.md");
      expect(unlinkedPaths.every((p) => !p.includes("journal/"))).toBe(true);
      expect(deleted).toHaveLength(1);
      expect(deleted[0]).toContain("old-page.md");
    });

    it("deletes a stale .md file when protectedPrefixes is empty", async () => {
      const readdirMock = vi.fn().mockResolvedValueOnce([
        "stale-page.md",
        "current.md",
      ]);
      const unlinkMock = vi.fn().mockResolvedValue(undefined);

      vi.doMock("node:fs/promises", async () => {
        const actual = await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
        return {
          ...actual,
          readdir: readdirMock,
          unlink: unlinkMock,
        };
      });

      const mod = await import("../../src/tools/wiki-tools.js");
      const outputDir = "/virtual/wiki";
      const known = new Set<string>(["current.md"]);
      const deleted = await mod.pruneStaleWikiFiles(outputDir, known, []);

      // stale-page.md is unknown, not protected, and ends with .md → must be deleted
      expect(unlinkMock).toHaveBeenCalledTimes(1);
      expect(unlinkMock).toHaveBeenCalledWith(expect.stringContaining("stale-page.md"));
      expect(deleted).toHaveLength(1);
      expect(deleted[0]).toContain("stale-page.md");
    });
  });
});
