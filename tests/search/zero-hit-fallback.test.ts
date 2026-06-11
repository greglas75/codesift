import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  indexFolder,
  stopAllWatchersForTesting,
  resetIndexFolderRedundancyForTesting,
} from "../../src/tools/index-tools.js";
import { searchText, zeroHitFallback } from "../../src/tools/search-tools.js";

describe("zeroHitFallback — vocabulary suggestions on zero-hit searches", () => {
  let tmpRoot: string;
  let dataDir: string;
  let repoName: string;
  const originalDataDir = process.env["CODESIFT_DATA_DIR"];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "codesift-zerohit-data-"));
    process.env["CODESIFT_DATA_DIR"] = dataDir;
    resetIndexFolderRedundancyForTesting();
    tmpRoot = await mkdtemp(join(tmpdir(), "zero-hit-"));
    await mkdir(join(tmpRoot, "src"), { recursive: true });
    await writeFile(
      join(tmpRoot, "src/auth.ts"),
      `export class OrganizationService {
  authorizeUser(userId: string): boolean { return true; }
}
export function validatePayload(input: unknown): boolean { return input != null; }
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

  it("suggests near-miss symbol for a typo'd identifier (edit distance ≤ 2)", async () => {
    // sanity: the typo really is a zero-hit
    const matches = await searchText(repoName, "authorizeUsr");
    expect(matches).toHaveLength(0);

    const fallback = await zeroHitFallback(repoName, "authorizeUsr");
    expect(fallback.suggestions).toBeDefined();
    expect(fallback.suggestions).toContain("authorizeUser");
  });

  it("suggests symbols containing the query as a substring", async () => {
    const fallback = await zeroHitFallback(repoName, "OrganizationServ");
    expect(fallback.suggestions).toContain("OrganizationService");
  });

  it("returns no suggestions for multi-word queries", async () => {
    const fallback = await zeroHitFallback(repoName, "organization service config");
    expect(fallback.suggestions).toBeUndefined();
  });

  it("returns no suggestions for queries shorter than 3 chars", async () => {
    const fallback = await zeroHitFallback(repoName, "ab");
    expect(fallback.suggestions).toBeUndefined();
  });

  it("skips semantic rescue when no embeddings index exists", async () => {
    const fallback = await zeroHitFallback(repoName, "authorizeUsr");
    expect(fallback.semantic_results).toBeUndefined();
  });

  it("never throws on an unknown repo", async () => {
    const fallback = await zeroHitFallback("local/does-not-exist", "whatever");
    expect(fallback).toEqual({});
  });
});
