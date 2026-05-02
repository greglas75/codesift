import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpSync } from "node:fs";
import { planTurn } from "../../src/tools/plan-turn-tools.js";
import { indexFolder } from "../../src/tools/index-tools.js";

let tmpHome: string | null = null;
let monoRepoName: string | null = null;
let monoRoot: string | null = null;

beforeAll(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "codesift-pt-boost-test-"));
  process.env.CODESIFT_HOME = tmpHome;

  monoRoot = await mkdtemp(join(tmpdir(), "codesift-pt-mono-"));
  cpSync(join(__dirname, "..", "fixtures", "turbo-pnpm-monorepo"), monoRoot, { recursive: true });
  const m = await indexFolder(monoRoot);
  monoRepoName = m.repo;
});

afterAll(async () => {
  if (monoRoot) await rm(monoRoot, { recursive: true, force: true });
  if (tmpHome) await rm(tmpHome, { recursive: true, force: true });
  delete process.env.CODESIFT_HOME;
});

describe("plan_turn monorepo term boost (Task 13)", () => {
  it("(a) SC1: query 'which packages depend on shared?' surfaces workspace_graph or list_workspaces in top 3", async () => {
    const result = await planTurn(monoRepoName!, "which packages depend on shared?", {
      skip_session: true,
    });
    const top3 = result.tools.slice(0, 3).map((t) => t.name);
    const hit = top3.some((name) =>
      ["workspace_graph", "list_workspaces", "affected_workspaces", "workspace_boundaries"].includes(name),
    );
    expect(hit).toBe(true);
  });

  it("(b) query 'affected workspaces since main' surfaces affected_workspaces in top 3", async () => {
    const result = await planTurn(monoRepoName!, "affected workspaces since main", {
      skip_session: true,
    });
    const top3 = result.tools.slice(0, 3).map((t) => t.name);
    expect(top3).toContain("affected_workspaces");
  });

  it("(c) non-monorepo query (e.g. 'find function foo'): no workspace tools in top 3", async () => {
    const result = await planTurn(monoRepoName!, "find function foo", {
      skip_session: true,
    });
    const top3 = result.tools.slice(0, 3).map((t) => t.name);
    const monorepoToolsInTop3 = top3.filter((name) =>
      ["workspace_graph", "list_workspaces", "affected_workspaces", "workspace_boundaries"].includes(name),
    );
    expect(monorepoToolsInTop3.length).toBe(0);
  });
});
