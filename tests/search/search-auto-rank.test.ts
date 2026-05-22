import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  indexFolder,
  stopAllWatchersForTesting,
  resetIndexFolderRedundancyForTesting,
} from "../../src/tools/index-tools.js";
import { searchText } from "../../src/tools/search-tools.js";
import type { TextMatch } from "../../src/types.js";

describe("searchText auto-rank for identifier-only queries", () => {
  let tmpRoot: string;
  let dataDir: string;
  let repoName: string;
  const originalDataDir = process.env["CODESIFT_DATA_DIR"];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "codesift-autorank-data-"));
    process.env["CODESIFT_DATA_DIR"] = dataDir;
    resetIndexFolderRedundancyForTesting();
    tmpRoot = await mkdtemp(join(tmpdir(), "auto-rank-"));
    await mkdir(join(tmpRoot, "src"), { recursive: true });
    await writeFile(
      join(tmpRoot, "src/auth.ts"),
      `export class OrganizationService {
  authorize(userId: string): boolean { return true; }
}
export function helper() {
  const svc = new OrganizationService();
  return svc.authorize("u1");
}
`,
    );
    const indexed = await indexFolder(tmpRoot, { watch: false });
    repoName = indexed.repo;
  });

  afterAll(async () => {
    await stopAllWatchersForTesting();
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (originalDataDir === undefined) delete process.env["CODESIFT_DATA_DIR"];
    else process.env["CODESIFT_DATA_DIR"] = originalDataDir;
  });

  it("auto-promotes ranked=true when query is an identifier and no grouping opts passed", async () => {
    const result = await searchText(repoName, "OrganizationService");
    // ranked-mode output is TextMatch[] (not grouped, not compact-string).
    expect(Array.isArray(result)).toBe(true);
    const arr = result as TextMatch[];
    expect(arr.length).toBeGreaterThan(0);
    // Ranked classification attaches containing_symbol on at least one match
    // when bm25 is available. We accept either: real classification, or
    // graceful fallback (matches without containing_symbol). The key signal
    // that the auto-rank PATH was taken is that the result is an UNGROUPED
    // array — not a TextMatchGroup[]. TextMatchGroup has a `count` field,
    // TextMatch does not.
    expect((arr[0] as any).count).toBeUndefined();
    expect(typeof (arr[0] as TextMatch).line).toBe("number");
  });

  it("does NOT auto-promote when query contains spaces or punctuation", async () => {
    // "is true" is not an identifier — ranked branch must not fire.
    const result = await searchText(repoName, "return true");
    expect(Array.isArray(result)).toBe(true);
    const arr = result as TextMatch[];
    // No containing_symbol expected since ranker didn't run.
    for (const m of arr) {
      expect(m.containing_symbol).toBeUndefined();
    }
  });

  it("does NOT auto-promote when caller already passed group_by_file", async () => {
    // If caller expressed a grouping preference, we honor it — no auto-rank.
    const result = await searchText(repoName, "OrganizationService", { group_by_file: true });
    // group_by_file returns TextMatchGroup[] which has `count` field per group
    expect(Array.isArray(result)).toBe(true);
    if ((result as any[]).length > 0) {
      expect((result as any)[0].count).toBeDefined();
    }
  });

  it("explicit ranked=true still works (positive control)", async () => {
    const result = await searchText(repoName, "OrganizationService", { ranked: true });
    expect(Array.isArray(result)).toBe(true);
    const arr = result as TextMatch[];
    expect((arr[0] as any).count).toBeUndefined();
  });
});
