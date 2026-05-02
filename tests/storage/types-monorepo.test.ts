import { describe, expect, it } from "vitest";
import type {
  AffectedResult,
  AffectedWorkspaceEntry,
  CodeIndex,
  Workspace,
  WorkspaceBoundaryRule,
  WorkspaceDependencies,
  WorkspaceTsconfigPath,
} from "../../src/types.js";
import { EXTRACTOR_VERSIONS } from "../../src/tools/project-tools.js";

describe("monorepo types (Task 1)", () => {
  it("Workspace shape matches spec D7", () => {
    const w: Workspace = {
      id: "@org/web",
      name: "@org/web",
      root: "/abs/apps/web",
      package_manager_role: "package",
      manifest_tool: "turbo",
      dependencies: { workspace: ["@org/shared"], external: ["next"] },
      tsconfig_paths: [{ from_pattern: "@/*", to_paths: ["src/*"] }],
      detected_frameworks: ["nextjs"],
    };
    expect(w.id).toBe("@org/web");
    expect(w.dependencies.workspace).toEqual(["@org/shared"]);
    expect(w.tsconfig_paths[0]?.from_pattern).toBe("@/*");
  });

  it("Workspace.name may be null for invalid packages", () => {
    const w: Workspace = {
      id: "packages/unnamed",
      name: null,
      root: "/abs/packages/unnamed",
      package_manager_role: "package",
      manifest_tool: "pnpm",
      dependencies: { workspace: [], external: [] },
      tsconfig_paths: [],
      detected_frameworks: [],
    };
    expect(w.name).toBeNull();
  });

  it("CodeIndex.workspaces is optional (preserves flat-repo backward compat)", () => {
    const flatIndex: CodeIndex = {
      repo: "x",
      root: "/x",
      symbols: [],
      files: [],
      created_at: 0,
      updated_at: 0,
      symbol_count: 0,
      file_count: 0,
    };
    expect(flatIndex.workspaces).toBeUndefined();

    const monoIndex: CodeIndex = { ...flatIndex, workspaces: [] };
    expect(Array.isArray(monoIndex.workspaces)).toBe(true);
  });

  it("WorkspaceBoundaryRule shape distinct from path-based BoundaryRule", () => {
    const rule: WorkspaceBoundaryRule = {
      from_workspace: "apps/web",
      cannot_import_workspaces: ["apps/api", "!apps/web"],
    };
    expect(rule.from_workspace).toBe("apps/web");
    // The shape must NOT collide with the existing BoundaryRule (path-based)
    // — verify by using fields that don't exist on BoundaryRule.
    expect("cannot_import_workspaces" in rule).toBe(true);
  });

  it("AffectedResult and AffectedWorkspaceEntry shape per spec D5", () => {
    const entry: AffectedWorkspaceEntry = {
      workspace_id: "@org/web",
      workspace_name: "@org/web",
      reason: "transitive",
      changed_files: [],
      via: ["@org/shared"],
    };
    const result: AffectedResult = {
      since_ref: "HEAD~1",
      changed_files: ["packages/shared/src/Button.tsx"],
      affected: [entry],
      excluded_lockfile_changes: [],
      root_changed_files: [],
    };
    expect(result.affected[0]?.reason).toBe("transitive");
    expect(result.excluded_lockfile_changes).toEqual([]);
  });

  it("AffectedResult.error union covers known error modes", () => {
    const noGit: AffectedResult = {
      since_ref: "HEAD~1",
      changed_files: [],
      affected: [],
      excluded_lockfile_changes: [],
      root_changed_files: [],
      error: "not_a_git_repository",
    };
    expect(noGit.error).toBe("not_a_git_repository");
  });

  it("WorkspaceDependencies and WorkspaceTsconfigPath are usable standalone", () => {
    const deps: WorkspaceDependencies = { workspace: [], external: [] };
    const tsp: WorkspaceTsconfigPath = { from_pattern: "@org/*", to_paths: ["packages/*"] };
    expect(deps.external).toEqual([]);
    expect(tsp.to_paths).toEqual(["packages/*"]);
  });
});

describe("EXTRACTOR_VERSIONS.monorepo bump (Task 1)", () => {
  it("monorepo extractor version is set so existing indices reindex on upgrade", () => {
    expect(EXTRACTOR_VERSIONS.monorepo).toBeDefined();
    expect(EXTRACTOR_VERSIONS.monorepo).toBe("1.0.0");
  });
});
