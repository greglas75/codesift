import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupGitFixture, type GitFixture } from "../fixtures/turbo-pnpm-monorepo/setup-git.js";
import { indexFolder, stopAllWatchersForTesting } from "../../src/tools/index-tools.js";
import { impactAnalysis } from "../../src/tools/impact-tools.js";
import { resetConfigCache } from "../../src/config.js";

let tmpHome: string | null = null;
let gitFixture: GitFixture | null = null;
let repoName: string | null = null;

beforeAll(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "codesift-impact-mono-"));
  process.env.CODESIFT_DATA_DIR = tmpHome;
  resetConfigCache();
  gitFixture = setupGitFixture();
  const r = await indexFolder(gitFixture.root);
  repoName = r.repo;
});

afterAll(async () => {
  await stopAllWatchersForTesting();
  gitFixture?.cleanup();
  if (tmpHome) await rm(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  delete process.env.CODESIFT_DATA_DIR;
  resetConfigCache();
});

describe("impact_analysis cross-package propagation (Task 14)", () => {
  it("(a) does not crash on a monorepo fixture; returns shape-stable ImpactResult", async () => {
    const result = await impactAnalysis(repoName!, gitFixture!.baseSha);
    // Output shape must include the documented top-level fields.
    expect(result).toHaveProperty("changed_files");
    expect(result).toHaveProperty("affected_symbols");
    expect(result).toHaveProperty("dependency_graph");
    expect(Array.isArray(result.changed_files)).toBe(true);
  });
});
