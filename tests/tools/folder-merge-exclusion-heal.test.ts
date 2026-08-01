import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateAndMergeFolderWalk } from "../../src/tools/index-tools/folder-merge.js";
import type { CodeIndex, FileEntry } from "../../src/types.js";

/**
 * The sanity guard rejects a walk that returns <50% of the previously indexed
 * file count, to stop a truncated walk (WASM crash, FS error) from overwriting
 * a good index. Its auto-heal samples the old paths on disk — but a file the
 * walker now deliberately EXCLUDES is still on disk, so it reads as present and
 * the guard rejects.
 *
 * That made the vendor/ exclusion unshippable on exactly the repos it was for:
 * dropping tgm-collect from 11,622 files to 1,557 is an 87% shrink, and every
 * honest reindex would have been rejected forever.
 */
let root: string;

function fileEntry(path: string): FileEntry {
  return { path, language: "php", size: 10, mtime_ms: 1, symbol_count: 1 } as FileEntry;
}

function existingIndex(paths: string[]): CodeIndex {
  return {
    repo: "local/fixture",
    root,
    files: paths.map(fileEntry),
    symbols: [],
    file_count: paths.length,
    symbol_count: paths.length,
    updated_at: 1,
  } as unknown as CodeIndex;
}

function contextFor(existing: CodeIndex, walked: string[]) {
  return {
    existing,
    fileEntries: walked.map(fileEntry),
    symbols: [],
    newSnapshotFiles: {},
    oldSnapshot: null,
    rootPath: root,
    repoName: "local/fixture",
    startTime: Date.now(),
    maxFiles: 50_000,
    hitFileLimit: false,
    includePaths: undefined,
  };
}

/** The guard returns an IndexFolderResult (with `status`) only when it rejects. */
function wasRejected(result: unknown): boolean {
  return typeof result === "object" && result !== null && "status" in result;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cs-merge-heal-"));
  // Every path the fixtures reference must EXIST on disk, otherwise the older
  // on-disk auto-heal fires first and accepts for the wrong reason — which is
  // exactly what a first cut of this test did, passing the exclusion case while
  // proving nothing about it.
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "vendor", "dep"), { recursive: true });
  for (let i = 0; i < 100; i++) {
    await writeFile(join(root, "src", `Real${i}.php`), "<?php\n");
  }
  for (let i = 0; i < 90; i++) {
    await writeFile(join(root, "vendor", "dep", `File${i}.php`), "<?php\n");
  }
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("sanity guard vs a newly-excluded directory", () => {
  it("accepts the shrink when most of the old index is now excluded", async () => {
    // 90 vendor/ files + 10 real ones — the tgm-collect shape.
    const old = existingIndex([
      ...Array.from({ length: 90 }, (_, i) => `vendor/dep/File${i}.php`),
      ...Array.from({ length: 10 }, (_, i) => `src/Real${i}.php`),
    ]);
    const result = await validateAndMergeFolderWalk(
      contextFor(old, Array.from({ length: 10 }, (_, i) => `src/Real${i}.php`)),
    );
    expect(wasRejected(result)).toBe(false);
  });

  it("still rejects a genuine truncation, where the missing files are NOT excluded", async () => {
    // The guard's real job: same 90% drop, but everything lives under src/, so
    // nothing explains it except a failed walk.
    const old = existingIndex(Array.from({ length: 100 }, (_, i) => `src/Real${i}.php`));
    const result = await validateAndMergeFolderWalk(
      contextFor(old, Array.from({ length: 10 }, (_, i) => `src/Real${i}.php`)),
    );
    expect(wasRejected(result)).toBe(true);
    expect((result as { status?: string }).status).toBe("rejected_partial");
  });

  it("does not arm on a small index, matching the existing threshold", async () => {
    const old = existingIndex(Array.from({ length: 20 }, (_, i) => `src/Real${i}.php`));
    const result = await validateAndMergeFolderWalk(contextFor(old, ["src/Real0.php"]));
    expect(wasRejected(result)).toBe(false);
  });

  it("still rejects a truncated walk on a vendor-heavy repo", async () => {
    // The hole an adversarial pass found in the first cut: the excluded
    // fraction describes the OLD index's composition and says nothing about
    // whether the NEW walk succeeded. With 90 of 100 files excluded the bypass
    // fired unconditionally, so a walk that aborted after 2 of the 10 real
    // files was accepted and the other 8 were wiped.
    const old = existingIndex([
      ...Array.from({ length: 90 }, (_, i) => `vendor/dep/File${i}.php`),
      ...Array.from({ length: 100 }, (_, i) => `src/Real${i}.php`),
    ]);
    // 100 real files expected, walk returned 5.
    const result = await validateAndMergeFolderWalk(
      contextFor(old, Array.from({ length: 5 }, (_, i) => `src/Real${i}.php`)),
    );
    expect(wasRejected(result)).toBe(true);
  });
});
