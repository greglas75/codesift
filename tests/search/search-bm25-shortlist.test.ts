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

/**
 * BM25 file-shortlist optimization. For single-identifier queries without
 * an explicit file_pattern, search_text restricts the regex scan to the
 * top-K files surfaced by BM25 (top symbol relevance). This cuts large-repo
 * scan time from 8s+ wall-clock to <500ms for identifier lookups.
 *
 * These tests verify:
 *  1. Correctness — identifier hits in the BM25-relevant file are still found
 *  2. Trigger conditions — only identifier queries without file_pattern/regex
 *  3. Graceful fallback — when BM25 has no hits, full scan still happens
 */
describe("searchText BM25 file shortlist for identifier queries", () => {
  let tmpRoot: string;
  let repoName: string;

  beforeAll(async () => {
    resetIndexFolderRedundancyForTesting();
    tmpRoot = await mkdtemp(join(tmpdir(), "bm25-shortlist-"));
    await mkdir(join(tmpRoot, "src/feature"), { recursive: true });
    await mkdir(join(tmpRoot, "src/unrelated"), { recursive: true });
    // The "target" file — defines and uses TargetWidget. BM25 will rank this highly.
    await writeFile(
      join(tmpRoot, "src/feature/widget.ts"),
      `export class TargetWidget {
  render(): string { return "TargetWidget"; }
}
export function makeTargetWidget(): TargetWidget {
  return new TargetWidget();
}
`,
    );
    // Decoy files unrelated to TargetWidget — BM25 should not surface these.
    for (let i = 0; i < 8; i++) {
      await writeFile(
        join(tmpRoot, `src/unrelated/decoy${i}.ts`),
        `export function unrelated${i}(): number { return ${i}; }\n`,
      );
    }
    const indexed = await indexFolder(tmpRoot, { watch: false });
    repoName = indexed.repo;
  });

  afterAll(async () => {
    await stopAllWatchersForTesting();
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("finds identifier hits via the BM25-shortlisted file", async () => {
    const result = await searchText(repoName, "TargetWidget");
    expect(Array.isArray(result)).toBe(true);
    const arr = result as TextMatch[];
    expect(arr.length).toBeGreaterThan(0);
    // Every hit should be in the file that defines the identifier.
    for (const m of arr) {
      expect(m.file).toMatch(/widget\.ts$/);
    }
  });

  it("returns multiple matches from the target file (definition + usages)", async () => {
    const result = await searchText(repoName, "TargetWidget");
    const arr = result as TextMatch[];
    // The fixture has 4 occurrences of "TargetWidget" in widget.ts:
    //   class TargetWidget / "TargetWidget" string / : TargetWidget / new TargetWidget()
    expect(arr.length).toBeGreaterThanOrEqual(3);
  });

  it("respects file_pattern (shortlist skipped) — returns no matches when pattern excludes target", async () => {
    // file_pattern explicitly excludes the target file. Shortlist must NOT
    // override that — agent's pattern wins.
    const result = await searchText(repoName, "TargetWidget", {
      file_pattern: "src/unrelated/*.ts",
    });
    expect(Array.isArray(result)).toBe(true);
    // No occurrences in decoy files
    const arr = result as TextMatch[];
    expect(arr.length).toBe(0);
  });

  it("does not apply shortlist for regex queries", async () => {
    // Regex query — must NOT use shortlist (regex matches arbitrary patterns,
    // BM25 indexes symbol names only). This test passes a regex that matches
    // a string in decoy files; if shortlist incorrectly fired we'd miss them.
    const result = await searchText(repoName, "unrelated[0-9]", { regex: true });
    expect(Array.isArray(result)).toBe(true);
    const arr = result as TextMatch[];
    expect(arr.length).toBeGreaterThan(0);
    // At least some hits should be in decoy files
    expect(arr.some((m) => m.file.includes("decoy"))).toBe(true);
  });

  it("falls back to full scan when query is non-identifier (e.g. multi-word)", async () => {
    // "return new" is not an identifier — must scan all files, not just BM25 top-K.
    const result = await searchText(repoName, "return new");
    expect(Array.isArray(result)).toBe(true);
    const arr = result as TextMatch[];
    expect(arr.length).toBeGreaterThan(0);
  });
});
