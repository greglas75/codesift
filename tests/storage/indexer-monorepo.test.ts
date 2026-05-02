import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexFolder } from "../../src/tools/index-tools.js";
import { loadIndex, getIndexPath } from "../../src/storage/index-store.js";
import { loadConfig } from "../../src/config.js";

const FIXTURE = join(__dirname, "..", "fixtures", "turbo-pnpm-monorepo");

async function loadIndexFor(rootPath: string) {
  const config = loadConfig();
  const indexPath = getIndexPath(config.dataDir, rootPath);
  return loadIndex(indexPath);
}

describe("indexer monorepo wiring (Task 7)", () => {
  let tmpHome: string | null = null;

  beforeAll(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "codesift-index-test-"));
    process.env.CODESIFT_HOME = tmpHome;
  });

  afterAll(async () => {
    if (tmpHome) await rm(tmpHome, { recursive: true, force: true });
    delete process.env.CODESIFT_HOME;
    delete process.env.CODESIFT_DISABLE_MONOREPO;
  });

  it("(a) indexing the turbo-pnpm-monorepo fixture populates index.workspaces", async () => {
    delete process.env.CODESIFT_DISABLE_MONOREPO;
    await indexFolder(FIXTURE);
    const index = await loadIndexFor(FIXTURE);
    expect(index?.workspaces).toBeDefined();
    expect((index?.workspaces ?? []).length).toBeGreaterThanOrEqual(3);
    const names = (index?.workspaces ?? []).map((w) => w.name).filter(Boolean) as string[];
    expect(names).toEqual(expect.arrayContaining(["@org/web", "@org/api", "@org/shared"]));
  });

  it("(b) indexing a flat-repo fixture leaves index.workspaces undefined (no regression)", async () => {
    const flatRoot = await mkdtemp(join(tmpdir(), "codesift-flat-index-"));
    try {
      await writeFile(
        join(flatRoot, "package.json"),
        JSON.stringify({ name: "flat", version: "1.0.0" }),
      );
      await mkdir(join(flatRoot, "src"), { recursive: true });
      await writeFile(join(flatRoot, "src/index.ts"), "export const x = 1;");

      await indexFolder(flatRoot);
      const index = await loadIndexFor(flatRoot);
      expect(index?.workspaces).toBeUndefined();
    } finally {
      await rm(flatRoot, { recursive: true, force: true });
    }
  });

  it("(c) CODESIFT_DISABLE_MONOREPO=1 kill switch leaves index.workspaces undefined on monorepo fixture", async () => {
    process.env.CODESIFT_DISABLE_MONOREPO = "1";
    try {
      // Force a fresh index by using a temp copy (avoid hitting the cached fixture index)
      const copyRoot = await mkdtemp(join(tmpdir(), "codesift-killswitch-"));
      try {
        const { cpSync } = await import("node:fs");
        cpSync(FIXTURE, copyRoot, { recursive: true });
        await indexFolder(copyRoot);
        const index = await loadIndexFor(copyRoot);
        expect(index?.workspaces).toBeUndefined();
      } finally {
        await rm(copyRoot, { recursive: true, force: true });
      }
    } finally {
      delete process.env.CODESIFT_DISABLE_MONOREPO;
    }
  });
});
