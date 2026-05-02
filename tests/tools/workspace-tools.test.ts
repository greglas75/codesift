import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpSync } from "node:fs";
import {
  listWorkspacesHandler,
  workspaceGraphHandler,
  affectedWorkspacesHandler,
  workspaceBoundariesHandler,
} from "../../src/tools/workspace-tools.js";
import { indexFolder } from "../../src/tools/index-tools.js";
import { setupGitFixture, type GitFixture } from "../fixtures/turbo-pnpm-monorepo/setup-git.js";

let tmpHome: string | null = null;
let fixtureRoot: string | null = null;
let gitFixture: GitFixture | null = null;
let repoName: string | null = null;
let gitRepoName: string | null = null;

beforeAll(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "codesift-ws-tools-test-"));
  process.env.CODESIFT_HOME = tmpHome;

  // 1) Index a copy of the static fixture (no git history) for list_workspaces /
  //    workspace_graph / workspace_boundaries.
  fixtureRoot = await mkdtemp(join(tmpdir(), "codesift-ws-static-"));
  cpSync(join(__dirname, "..", "fixtures", "turbo-pnpm-monorepo"), fixtureRoot, { recursive: true });
  const r1 = await indexFolder(fixtureRoot);
  repoName = r1.repo;

  // 2) Create a separate git-history fixture for affected_workspaces tests.
  gitFixture = setupGitFixture();
  const r2 = await indexFolder(gitFixture.root);
  gitRepoName = r2.repo;
});

afterAll(async () => {
  gitFixture?.cleanup();
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  if (tmpHome) await rm(tmpHome, { recursive: true, force: true });
  delete process.env.CODESIFT_HOME;
});

describe("list_workspaces (Task 8)", () => {
  it("(a) AC1: returns 5 packages on the turbo-pnpm fixture, monorepo_tool === 'turbo'", async () => {
    const result = await listWorkspacesHandler({ repo: repoName! });
    expect(result.workspaces.length).toBe(5);
    expect(result.monorepo_tool).toBe("turbo");
  });

  it("(c) AC9: returned workspace paths do NOT include packages/internal (negation honored)", async () => {
    const result = await listWorkspacesHandler({ repo: repoName! });
    const names = result.workspaces.map((w) => w.name);
    expect(names).not.toContain("@org/internal");
  });

  it("(b) on a flat repo (no index found): shape-stable empty", async () => {
    const result = await listWorkspacesHandler({ repo: "nonexistent-flat-repo" });
    expect(result).toEqual({ workspaces: [], monorepo_tool: null });
  });
});

describe("workspace_graph (Task 9)", () => {
  it("AC12: format=mermaid returns parseable Mermaid with all nodes and dep edges", async () => {
    const result = await workspaceGraphHandler({ repo: repoName!, format: "mermaid" });
    expect(typeof result.mermaid).toBe("string");
    expect(result.mermaid!.startsWith("graph TD")).toBe(true);
    // Each workspace name should appear as a node label
    expect(result.mermaid!).toContain("@org/web");
    expect(result.mermaid!).toContain("@org/shared");
    // Dependency edges (apps/web -> packages/shared via @org/shared)
    expect(result.mermaid!).toMatch(/-->/);
    // cycle-a <-> cycle-b
    expect(result.nodes.find((n) => n.name === "@org/cycle-a")).toBeDefined();
    expect(result.nodes.find((n) => n.name === "@org/cycle-b")).toBeDefined();
    const cycleEdges = result.edges.filter(
      (e) =>
        (e.from === "@org/cycle-a" && e.to === "@org/cycle-b") ||
        (e.from === "@org/cycle-b" && e.to === "@org/cycle-a"),
    );
    expect(cycleEdges.length).toBe(2);
  });

  it("format=json default returns structured nodes and edges", async () => {
    const result = await workspaceGraphHandler({ repo: repoName! });
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(Array.isArray(result.edges)).toBe(true);
    expect(result.mermaid).toBeUndefined();
  });

  it("format=dot returns digraph string", async () => {
    const result = await workspaceGraphHandler({ repo: repoName!, format: "dot" });
    expect(result.dot?.startsWith("digraph G")).toBe(true);
  });
});

describe("affected_workspaces (Task 10)", () => {
  it("(a) AC3: edit shared/Button -> @org/web AND @org/api in affected[] with reason='transitive'", async () => {
    const result = await affectedWorkspacesHandler({
      repo: gitRepoName!,
      since: gitFixture!.baseSha,
    });
    // The only edit at editSharedSha changed packages/shared/src/Button.tsx
    // The lockfile and deletion commits are also between baseSha and HEAD
    const names = result.affected.map((a) => a.workspace_name);
    expect(names).toContain("@org/web");
    expect(names).toContain("@org/api");
    const web = result.affected.find((a) => a.workspace_name === "@org/web");
    expect(web?.reason).toBe("transitive");
    expect(web?.via).toBeDefined();
  });

  it("(b) AC13: lockfile-only commit excluded from affected[]", async () => {
    // Diff between baseSha and lockfileSha = edit-shared + lockfile commits.
    // The lockfile commit's pnpm-lock.yaml change should be in excluded_lockfile_changes.
    const result = await affectedWorkspacesHandler({
      repo: gitRepoName!,
      since: gitFixture!.editSharedSha, // diff between editSharedSha..HEAD
    });
    expect(result.excluded_lockfile_changes).toContain("pnpm-lock.yaml");
  });

  it("(d) bad-ref handling: clear error", async () => {
    const result = await affectedWorkspacesHandler({
      repo: gitRepoName!,
      since: "0000000000000000000000000000000000000000",
    });
    expect(result.error).toBe("bad_ref");
    expect(result.affected).toEqual([]);
  });

  it("(e) non-git environment: returns shape-stable error", async () => {
    // Index a non-git directory
    const noGitRoot = await mkdtemp(join(tmpdir(), "codesift-nogit-"));
    try {
      cpSync(join(__dirname, "..", "fixtures", "turbo-pnpm-monorepo"), noGitRoot, { recursive: true });
      const r = await indexFolder(noGitRoot);
      const result = await affectedWorkspacesHandler({ repo: r.repo, since: "HEAD~1" });
      expect(result.error).toBe("not_a_git_repository");
      expect(result.affected).toEqual([]);
    } finally {
      await rm(noGitRoot, { recursive: true, force: true });
    }
  });
});

describe("workspace_boundaries (Task 11)", () => {
  it("AC4: rule against apps/api -> @org/web (deliberate violation seed) flags it", async () => {
    const result = await workspaceBoundariesHandler({
      repo: repoName!,
      rules: [
        { from_workspace: "@org/api", cannot_import_workspaces: ["@org/web"] },
      ],
    });
    expect(result.violations.length).toBeGreaterThan(0);
    const v = result.violations[0]!;
    expect(v.from_workspace).toBe("@org/api");
    expect(v.to_workspace).toBe("@org/web");
  });

  it("glob from_workspace selectors match", async () => {
    const result = await workspaceBoundariesHandler({
      repo: repoName!,
      rules: [
        { from_workspace: "@org/*", cannot_import_workspaces: ["@org/web"] },
      ],
    });
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("warns when rule references unknown workspace", async () => {
    const result = await workspaceBoundariesHandler({
      repo: repoName!,
      rules: [
        { from_workspace: "@org/does-not-exist", cannot_import_workspaces: ["@org/web"] },
      ],
    });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("@org/does-not-exist");
  });
});
