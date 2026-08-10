import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorkspaceAliasResolver } from "../../src/utils/import-graph/workspace-alias.js";
import {
  relativeWorkspaceRoot,
  resolveWorkspaceEntry,
} from "../../src/utils/import-graph/workspace-entry.js";
import type { CodeIndex, Workspace } from "../../src/types.js";

const tempRoots: string[] = [];

async function workspaceRoot(packageJson: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "import-graph-workspace-"));
  tempRoots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify(packageJson));
  return root;
}

function workspace(name: string, root: string, from = "@/*"): Workspace {
  return {
    id: name,
    name,
    root,
    package_manager_role: "package",
    manifest_tool: "test",
    dependencies: { workspace: [], external: [] },
    tsconfig_paths: [{ from_pattern: from, to_paths: ["src/*"] }],
    detected_frameworks: [],
  };
}

function file(path: string) {
  return { path, language: "typescript", symbol_count: 0, last_modified: 0 };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("resolveWorkspaceEntry", () => {
  it("prefers source over module and main", async () => {
    const root = await workspaceRoot({
      source: "src/source.ts",
      module: "src/module.ts",
      main: "src/main.js",
    });
    const files = new Set([
      "packages/pkg/src/source.ts",
      "packages/pkg/src/module.ts",
      "packages/pkg/src/main.js",
    ]);

    expect(resolveWorkspaceEntry(root, "packages/pkg", files, new Map())).toBe(
      "packages/pkg/src/source.ts",
    );
  });

  it("prefers module over main when source is absent", async () => {
    const root = await workspaceRoot({ module: "src/module.ts", main: "src/main.js" });
    const files = new Set(["packages/pkg/src/module.ts", "packages/pkg/src/main.js"]);

    expect(resolveWorkspaceEntry(root, "packages/pkg", files, new Map())).toBe(
      "packages/pkg/src/module.ts",
    );
  });

  it("falls back to a default entry when the configured entry is not indexed", async () => {
    const root = await workspaceRoot({ source: "src/missing.ts" });
    const files = new Set(["packages/pkg/src/index.ts"]);

    expect(resolveWorkspaceEntry(root, "packages/pkg", files, new Map())).toBe(
      "packages/pkg/src/index.ts",
    );
  });

  it("resolves a configured entry through the normalized path map", async () => {
    const root = await workspaceRoot({ source: "dist/index.js" });
    const normalized = new Map([["packages/pkg/dist/index", "packages/pkg/dist/index.ts"]]);

    expect(resolveWorkspaceEntry(root, "packages/pkg", new Set(), normalized)).toBe(
      "packages/pkg/dist/index.ts",
    );
  });

  it("supports string-valued package exports", async () => {
    const root = await workspaceRoot({ exports: "./src/public.ts" });
    const files = new Set(["packages/pkg/src/public.ts"]);

    expect(resolveWorkspaceEntry(root, "packages/pkg", files, new Map())).toBe(
      "packages/pkg/src/public.ts",
    );
  });

  it("prefers authoritative exports over a legacy main entry", async () => {
    const root = await workspaceRoot({
      exports: "./src/public.ts",
      main: "./dist/legacy.js",
    });
    const files = new Set([
      "packages/pkg/src/public.ts",
      "packages/pkg/dist/legacy.js",
    ]);

    expect(resolveWorkspaceEntry(root, "packages/pkg", files, new Map())).toBe(
      "packages/pkg/src/public.ts",
    );
  });

  it("prefers object exports over legacy module and main entries", async () => {
    const root = await workspaceRoot({
      exports: { ".": { import: "./src/public.ts" } },
      module: "./dist/module.js",
      main: "./dist/main.js",
    });
    const files = new Set([
      "packages/pkg/src/public.ts",
      "packages/pkg/dist/module.js",
      "packages/pkg/dist/main.js",
    ]);

    expect(resolveWorkspaceEntry(root, "packages/pkg", files, new Map())).toBe(
      "packages/pkg/src/public.ts",
    );
  });

  it("supports flat conditional exports shorthand", async () => {
    const root = await workspaceRoot({
      exports: { import: "./src/public.ts", require: "./dist/public.cjs" },
    });
    const files = new Set(["packages/pkg/src/public.ts"]);

    expect(resolveWorkspaceEntry(root, "packages/pkg", files, new Map())).toBe(
      "packages/pkg/src/public.ts",
    );
  });

  it("unwraps nested conditional exports", async () => {
    const root = await workspaceRoot({
      exports: { ".": { node: { import: "./src/node.ts" } } },
    });
    const files = new Set(["packages/pkg/src/node.ts"]);

    expect(resolveWorkspaceEntry(root, "packages/pkg", files, new Map())).toBe(
      "packages/pkg/src/node.ts",
    );
  });

  it("does not select a types condition as the runtime entry", async () => {
    const root = await workspaceRoot({
      exports: {
        ".": {
          types: "./types/index.d.ts",
          node: "./src/node.ts",
        },
      },
    });
    const files = new Set([
      "packages/pkg/types/index.d.ts",
      "packages/pkg/src/node.ts",
    ]);

    expect(resolveWorkspaceEntry(root, "packages/pkg", files, new Map())).toBe(
      "packages/pkg/src/node.ts",
    );
  });

  it("does not fall back when exports omits the package root", async () => {
    const root = await workspaceRoot({
      exports: { "./utils": "./src/utils.ts" },
      module: "./dist/module.js",
      main: "./dist/main.js",
    });
    const files = new Set([
      "packages/pkg/src/index.ts",
      "packages/pkg/dist/module.js",
      "packages/pkg/dist/main.js",
    ]);

    expect(resolveWorkspaceEntry(root, "packages/pkg", files, new Map())).toBeNull();
  });

});

describe("relativeWorkspaceRoot", () => {
  it("rejects sibling paths that only share the repository prefix", () => {
    expect(relativeWorkspaceRoot("/repo/application-extra", "/repo/app")).toBeNull();
  });
});

describe("buildWorkspaceAliasResolver ordering", () => {
  it("resolves an exact workspace name through its configured entry", async () => {
    const repoRoot = await workspaceRoot({});
    const packageRoot = join(repoRoot, "packages", "shared");
    const index: CodeIndex = {
      repo: "test/exact-workspace",
      root: repoRoot,
      symbols: [],
      files: [file("packages/shared/src/index.ts")],
      workspaces: [workspace("@org/shared", packageRoot, "unused/*")],
    };

    expect(buildWorkspaceAliasResolver(index).resolve("@org/shared", "src/main.ts")).toBe(
      "packages/shared/src/index.ts",
    );
  });

  it("uses the most deeply nested workspace tsconfig paths", () => {
    const repoRoot = "/repo";
    const index: CodeIndex = {
      repo: "test/nested-workspaces",
      root: repoRoot,
      symbols: [],
      files: [
        file("apps/web/src/value.ts"),
        file("apps/web/admin/src/value.ts"),
      ],
      workspaces: [
        workspace("@org/web", "/repo/apps/web"),
        workspace("@org/admin", "/repo/apps/web/admin"),
      ],
    };

    expect(
      buildWorkspaceAliasResolver(index).resolve(
        "@/value",
        "apps/web/admin/src/pages/index.ts",
      ),
    ).toBe("apps/web/admin/src/value.ts");
  });
});
