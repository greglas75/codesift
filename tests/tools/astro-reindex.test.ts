import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, writeFile, readFile, stat, utimes } from "node:fs/promises";
import { openSync, closeSync, writeFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { EXTRACTOR_VERSIONS } from "../../src/tools/project-tools.js";
import {
  checkAstroExtractorVersion,
  ASTRO_LOCK_FILENAME,
  EXTRACTOR_VERSIONS_FILENAME,
} from "../../src/tools/index-tools.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = join(tmpdir(), "codesift-astro-reindex-test");

async function createTestDir(name: string): Promise<string> {
  const dir = join(TMP_ROOT, name, Date.now().toString());
  await mkdir(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EXTRACTOR_VERSIONS.astro", () => {
  it("has astro version set to 1.0.0", () => {
    expect(EXTRACTOR_VERSIONS.astro).toBe("1.0.0");
  });
});

describe("checkAstroExtractorVersion", () => {
  let dataDir: string;
  let repoRoot: string;

  beforeEach(async () => {
    dataDir = await createTestDir("data");
    repoRoot = await createTestDir("repo");
    // Create a simple .astro file in the repo
    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(join(repoRoot, "src/Page.astro"), `---\nconst x = 1;\n---\n<div>{x}</div>`);
  });

  afterEach(async () => {
    try {
      await rm(TMP_ROOT, { recursive: true, force: true });
    } catch { /* cleanup best-effort */ }
  });

  it("triggers re-extraction when astro version is missing from stored snapshot", async () => {
    // No extractor-versions.json exists — version mismatch
    const result = await checkAstroExtractorVersion(dataDir, repoRoot, [
      "src/Page.astro",
    ]);
    expect(result.reindexed).toBe(true);
    expect(result.files_reindexed).toBeGreaterThanOrEqual(1);
  });

  it("triggers re-extraction when astro version differs in stored snapshot", async () => {
    // Write a stale version snapshot
    const versionsPath = join(dataDir, EXTRACTOR_VERSIONS_FILENAME);
    await writeFile(versionsPath, JSON.stringify({ astro: "0.9.0" }));

    const result = await checkAstroExtractorVersion(dataDir, repoRoot, [
      "src/Page.astro",
    ]);
    expect(result.reindexed).toBe(true);
  });

  it("removes lockfile after successful re-extract", async () => {
    const lockPath = join(dataDir, ASTRO_LOCK_FILENAME);

    const result = await checkAstroExtractorVersion(dataDir, repoRoot, [
      "src/Page.astro",
    ]);
    expect(result.reindexed).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("does NOT re-extract when concurrent lockfile exists (recent)", async () => {
    const lockPath = join(dataDir, ASTRO_LOCK_FILENAME);

    // Create lockfile manually (simulates another process)
    closeSync(openSync(lockPath, "wx"));

    const result = await checkAstroExtractorVersion(dataDir, repoRoot, [
      "src/Page.astro",
    ]);
    expect(result.reindexed).toBe(false);
    expect(result.reason).toContain("in progress");

    // Cleanup
    unlinkSync(lockPath);
  });

  it("overwrites stale lockfile (mtime > 60s) and proceeds with re-extract", async () => {
    const lockPath = join(dataDir, ASTRO_LOCK_FILENAME);

    // Create lockfile and set mtime to 120s ago
    closeSync(openSync(lockPath, "wx"));
    const past = new Date(Date.now() - 120_000);
    await utimes(lockPath, past, past);

    const result = await checkAstroExtractorVersion(dataDir, repoRoot, [
      "src/Page.astro",
    ]);
    expect(result.reindexed).toBe(true);
    // Lockfile should be cleaned up
    expect(existsSync(lockPath)).toBe(false);
  });

  it("writes version snapshot file via atomic rename after success", async () => {
    const versionsPath = join(dataDir, EXTRACTOR_VERSIONS_FILENAME);

    await checkAstroExtractorVersion(dataDir, repoRoot, [
      "src/Page.astro",
    ]);

    // Verify snapshot was written
    expect(existsSync(versionsPath)).toBe(true);
    const snapshot = JSON.parse(await readFile(versionsPath, "utf-8"));
    expect(snapshot.astro).toBe(EXTRACTOR_VERSIONS.astro);
  });

  it("skips re-extraction when stored version matches current", async () => {
    // Write a matching version snapshot
    const versionsPath = join(dataDir, EXTRACTOR_VERSIONS_FILENAME);
    await writeFile(versionsPath, JSON.stringify({ astro: EXTRACTOR_VERSIONS.astro }));

    const result = await checkAstroExtractorVersion(dataDir, repoRoot, [
      "src/Page.astro",
    ]);
    expect(result.reindexed).toBe(false);
    expect(result.reason).toContain("up to date");
  });
});
