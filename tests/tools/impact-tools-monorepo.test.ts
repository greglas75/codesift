import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupGitFixture, type GitFixture } from "../fixtures/turbo-pnpm-monorepo/setup-git.js";
import { indexFolder } from "../../src/tools/index-tools.js";
import { impactAnalysis } from "../../src/tools/impact-tools.js";

let tmpHome: string | null = null;
let gitFixture: GitFixture | null = null;
let repoName: string | null = null;

beforeAll(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "codesift-impact-mono-"));
  process.env.CODESIFT_HOME = tmpHome;
  gitFixture = setupGitFixture();
  const r = await indexFolder(gitFixture.root);
  repoName = r.repo;
});

afterAll(async () => {
  gitFixture?.cleanup();
  if (tmpHome) await rm(tmpHome, { recursive: true, force: true });
  delete process.env.CODESIFT_HOME;
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
