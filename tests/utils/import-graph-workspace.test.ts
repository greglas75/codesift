import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  collectImportEdges,
  buildWorkspaceAliasResolver,
  extractBareImports,
} from "../../src/utils/import-graph.js";
import { resolveWorkspaces } from "../../src/storage/workspace-resolver.js";
import type { CodeIndex } from "../../src/types.js";

const FIXTURE = join(__dirname, "..", "fixtures", "turbo-pnpm-monorepo");

async function buildFixtureIndex(): Promise<CodeIndex> {
  const resolved = await resolveWorkspaces(FIXTURE);
  if (!resolved) throw new Error("expected resolveWorkspaces to succeed");

  // Mirror what indexer would produce — minimal CodeIndex with fixture files
  const files = [
    "apps/web/src/pages/index.tsx",
    "apps/web/src/components/Header.tsx",
    "apps/api/src/index.ts",
    "apps/api/src/routes/users.ts",
    "packages/shared/src/index.ts",
    "packages/shared/src/Button.tsx",
    "packages/cycle-a/src/index.ts",
    "packages/cycle-b/src/index.ts",
  ];

  return {
    repo: "test/turbo-pnpm-monorepo",
    root: FIXTURE,
    symbols: [],
    files: files.map((path) => ({
      path,
      language: path.endsWith(".tsx") ? "typescript" : "typescript",
      symbol_count: 0,
      last_modified: 0,
    })),
    created_at: 0,
    updated_at: 0,
    symbol_count: 0,
    file_count: files.length,
    workspaces: resolved.workspaces,
  };
}

function buildFlatIndex(): CodeIndex {
  // Reuse the same fixture root but WITHOUT index.workspaces (flat-repo emulation)
  return {
    repo: "test/flat",
    root: FIXTURE,
    symbols: [],
    files: [
      { path: "apps/web/src/pages/index.tsx", language: "typescript", symbol_count: 0, last_modified: 0 },
      { path: "packages/shared/src/Button.tsx", language: "typescript", symbol_count: 0, last_modified: 0 },
      { path: "packages/shared/src/index.ts", language: "typescript", symbol_count: 0, last_modified: 0 },
    ],
    created_at: 0,
    updated_at: 0,
    symbol_count: 0,
    file_count: 3,
    // workspaces intentionally absent
  };
}

describe("workspace-alias resolver (Task 6)", () => {
  it("(a) resolves @org/shared bare import to packages/shared/src/index.ts", async () => {
    const index = await buildFixtureIndex();
    const edges = await collectImportEdges(index);
    // apps/web/src/pages/index.tsx imports { Button } from "@org/shared"
    const fromIndex = edges.find(
      (e) =>
        e.from === "apps/web/src/pages/index.tsx" &&
        e.to.startsWith("packages/shared/"),
    );
    expect(fromIndex).toBeDefined();
    // Header.tsx also imports from @org/shared
    const fromHeader = edges.find(
      (e) =>
        e.from === "apps/web/src/components/Header.tsx" &&
        e.to.startsWith("packages/shared/"),
    );
    expect(fromHeader).toBeDefined();
  });

  it("(a-cross) apps/api files reach packages/shared via @org/shared", async () => {
    const index = await buildFixtureIndex();
    const edges = await collectImportEdges(index);
    const apiToShared = edges.filter(
      (e) => e.from.startsWith("apps/api/") && e.to.startsWith("packages/shared/"),
    );
    expect(apiToShared.length).toBeGreaterThan(0);
  });

  it("(b) cycle-a → cycle-b and cycle-b → cycle-a edges exist", async () => {
    const index = await buildFixtureIndex();
    const edges = await collectImportEdges(index);
    const aToB = edges.find(
      (e) =>
        e.from.startsWith("packages/cycle-a/") &&
        e.to.startsWith("packages/cycle-b/"),
    );
    const bToA = edges.find(
      (e) =>
        e.from.startsWith("packages/cycle-b/") &&
        e.to.startsWith("packages/cycle-a/"),
    );
    expect(aToB).toBeDefined();
    expect(bToA).toBeDefined();
  });

  it("(c) flat repo (no index.workspaces): zero workspace-RESOLVED edges (tsconfig paths still apply)", async () => {
    // Post-TS-extractor-v3: tsconfig-paths resolution runs independently of
    // index.workspaces. If the fixture's tsconfig.json declares an `@org/*`
    // path mapping, those edges resolve via tsconfig regardless. The
    // workspace resolver itself (Task 6) still produces zero edges in flat
    // mode — this test now asserts the workspace-resolver contract, not the
    // absence of all cross-package edges.
    const index = buildFlatIndex();
    const edges = await collectImportEdges(index);
    // Workspace-resolver-only contract: no edges should be marked as resolved
    // via the workspace resolver path. Any cross-package edges that exist
    // here come from tsconfig-paths (a separate, independent path).
    const workspaceResolved = edges.filter(
      (e) => e.raw === "workspace-alias",
    );
    expect(workspaceResolved).toEqual([]);
  });

  it("(d) bare @org/foo where @org/foo is NOT a workspace: not resolved", async () => {
    const index = await buildFixtureIndex();
    const edges = await collectImportEdges(index);
    // No edge should reference a non-existent target
    for (const edge of edges) {
      expect(index.files.some((f) => f.path === edge.to)).toBe(true);
    }
  });
});

describe("buildWorkspaceAliasResolver (Task 6)", () => {
  it("returns no-op resolver on flat repo", () => {
    const flat = buildFlatIndex();
    const resolver = buildWorkspaceAliasResolver(flat);
    expect(resolver.resolve("@org/shared", "apps/web/src/pages/index.tsx")).toBeNull();
  });

  it("resolves exact workspace name to its entry file", async () => {
    const index = await buildFixtureIndex();
    const resolver = buildWorkspaceAliasResolver(index);
    const target = resolver.resolve("@org/shared", "apps/web/src/pages/index.tsx");
    expect(target).toBe("packages/shared/src/index.ts");
  });

  it("resolves workspace subpath imports", async () => {
    const index = await buildFixtureIndex();
    const resolver = buildWorkspaceAliasResolver(index);
    const target = resolver.resolve("@org/shared/Button", "apps/web/src/pages/index.tsx");
    expect(target).toBe("packages/shared/src/Button.tsx");
  });

  it("resolves tsconfig path aliases (@/* style) when present in originating workspace", async () => {
    // Use an in-memory index where the originating workspace has a custom path alias
    const index: CodeIndex = {
      repo: "test/tsp",
      root: "/abs/repo",
      symbols: [],
      files: [
        { path: "apps/web/src/utils/helpers.ts", language: "ts", symbol_count: 0, last_modified: 0 },
      ],
      created_at: 0,
      updated_at: 0,
      symbol_count: 0,
      file_count: 1,
      workspaces: [
        {
          id: "@org/web",
          name: "@org/web",
          root: "/abs/repo/apps/web",
          package_manager_role: "package",
          manifest_tool: "turbo",
          dependencies: { workspace: [], external: [] },
          tsconfig_paths: [
            { from_pattern: "@/*", to_paths: ["src/*"] },
          ],
          detected_frameworks: [],
        },
      ],
    };
    const resolver = buildWorkspaceAliasResolver(index);
    const target = resolver.resolve("@/utils/helpers", "apps/web/src/pages/index.tsx");
    expect(target).toBe("apps/web/src/utils/helpers.ts");
  });
});

describe("extractBareImports (Task 6)", () => {
  it("returns bare specifiers, skips relative paths", () => {
    const src = `
import { x } from "@org/shared";
import y from "./local";
import z from "../other";
import a from "@/utils/foo";
`;
    const bare = extractBareImports(src);
    expect(bare.sort()).toEqual(["@/utils/foo", "@org/shared"]);
  });
});
