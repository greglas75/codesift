import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexFolder, stopAllWatchersForTesting } from "../../src/tools/index-tools.js";
import { loadIndex, getIndexPath } from "../../src/storage/index-store.js";
import { loadConfig, resetConfigCache } from "../../src/config.js";

let tmpHome: string | null = null;

beforeAll(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "codesift-flat-regression-"));
  process.env.CODESIFT_DATA_DIR = tmpHome;
  resetConfigCache();
});

afterAll(async () => {
  await stopAllWatchersForTesting();
  if (tmpHome) await rm(tmpHome, { recursive: true, force: true });
  delete process.env.CODESIFT_DATA_DIR;
  resetConfigCache();
});

/** A flat single-package TypeScript project — covers AC10. */
async function buildFlatFixture(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `codesift-flat-${label}-`));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: `flat-${label}`, version: "1.0.0" }),
  );
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", strict: true } }),
  );
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src/index.ts"),
    `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
  );
  await writeFile(
    join(root, "src/utils.ts"),
    `export function noop(): void {}\nexport const CONST = 42;\n`,
  );
  return root;
}

describe("flat-repo regression suite (AC10, Task 19)", () => {
  it("(a) flat-repo index has workspaces === undefined (no contamination from monorepo wiring)", async () => {
    const root = await buildFlatFixture("a");
    try {
      await indexFolder(root);
      const config = loadConfig();
      const indexPath = getIndexPath(config.dataDir, root);
      const index = await loadIndex(indexPath);
      expect(index?.workspaces).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("(b) flat-repo index symbol/file counts are non-zero (indexer functional after monorepo extensions)", async () => {
    const root = await buildFlatFixture("b");
    try {
      await indexFolder(root);
      const config = loadConfig();
      const indexPath = getIndexPath(config.dataDir, root);
      const index = await loadIndex(indexPath);
      expect(index).not.toBeNull();
      expect(index!.file_count).toBeGreaterThan(0);
      expect(index!.symbol_count).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("(c) workspace tools on a flat repo return shape-stable empty results", async () => {
    const root = await buildFlatFixture("c");
    try {
      const r = await indexFolder(root);
      const { listWorkspacesHandler, workspaceGraphHandler, affectedWorkspacesHandler, workspaceBoundariesHandler } =
        await import("../../src/tools/workspace-tools.js");

      const list = await listWorkspacesHandler({ repo: r.repo });
      expect(list).toEqual({ workspaces: [], monorepo_tool: null });

      const graph = await workspaceGraphHandler({ repo: r.repo });
      expect(graph.nodes).toEqual([]);
      expect(graph.edges).toEqual([]);

      const affected = await affectedWorkspacesHandler({ repo: r.repo, since: "HEAD~1" });
      expect(affected.affected).toEqual([]);
      expect(affected.changed_files).toEqual([]);

      const boundaries = await workspaceBoundariesHandler({
        repo: r.repo,
        rules: [{ from_workspace: "x", cannot_import_workspaces: ["y"] }],
      });
      expect(boundaries.violations).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
