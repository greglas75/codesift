import { describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaces } from "../../src/storage/workspace-resolver.js";

const FIXTURE = join(__dirname, "..", "fixtures", "turbo-pnpm-monorepo");

describe("resolveWorkspaces (Task 4)", () => {
  it("happy path: resolves 3 packages + 2 cycle packages on the turbo-pnpm fixture (internal excluded)", async () => {
    const result = await resolveWorkspaces(FIXTURE);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.manifest_tool).toBe("turbo");

    const names = result.workspaces.map((w) => w.name).sort();
    expect(names).toEqual([
      "@org/api",
      "@org/cycle-a",
      "@org/cycle-b",
      "@org/shared",
      "@org/web",
    ]);
    // packages/internal is excluded by `!packages/internal` negation
    expect(names.includes("@org/internal" as string | null)).toBe(false);
  });

  it("workspace dependencies are classified into workspace[] vs external[]", async () => {
    const result = await resolveWorkspaces(FIXTURE);
    if (!result) throw new Error("expected non-null");
    const web = result.workspaces.find((w) => w.name === "@org/web");
    expect(web).toBeDefined();
    expect(web?.dependencies.workspace).toEqual(["@org/shared"]);
    expect(web?.dependencies.external.sort()).toEqual(["next", "react", "react-dom"]);
  });

  it("detected_frameworks derived from per-workspace package.json deps", async () => {
    const result = await resolveWorkspaces(FIXTURE);
    if (!result) throw new Error("expected non-null");
    const web = result.workspaces.find((w) => w.name === "@org/web");
    const api = result.workspaces.find((w) => w.name === "@org/api");
    expect(web?.detected_frameworks).toEqual(expect.arrayContaining(["nextjs", "react"]));
    expect(api?.detected_frameworks).toContain("hono");
  });

  it("tsconfig paths are cached at index time per workspace", async () => {
    const result = await resolveWorkspaces(FIXTURE);
    if (!result) throw new Error("expected non-null");
    // Each fixture workspace extends the root tsconfig.base.json which defines
    // the `@org/*` -> `packages/*/src` alias. get-tsconfig follows `extends`
    // and surfaces the resolved paths.
    const web = result.workspaces.find((w) => w.name === "@org/web");
    expect(web?.tsconfig_paths.length).toBeGreaterThan(0);
    expect(web?.tsconfig_paths[0]?.from_pattern).toBe("@org/*");
  });

  it("returns null on non-monorepo project (no workspaces field)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codesift-flat-"));
    try {
      await writeFile(join(tmp, "package.json"), JSON.stringify({ name: "flat", version: "1.0.0" }));
      const result = await resolveWorkspaces(tmp);
      expect(result).toBeNull();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns null on malformed pnpm-workspace.yaml (graceful fallback)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codesift-malformed-"));
    try {
      await writeFile(join(tmp, "package.json"), JSON.stringify({ name: "broken", version: "1.0.0" }));
      // Invalid YAML — manypkg should throw, resolver should return null
      await writeFile(join(tmp, "pnpm-workspace.yaml"), "packages: [unterminated");
      const result = await resolveWorkspaces(tmp);
      expect(result).toBeNull();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("nx.json + yarn workspaces sets manifest_tool to 'nx'", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codesift-nx-"));
    try {
      await writeFile(
        join(tmp, "package.json"),
        JSON.stringify({
          name: "nx-root",
          version: "1.0.0",
          private: true,
          workspaces: ["packages/*"],
        }),
      );
      // yarn.lock is the marker @manypkg recognizes for npm/yarn workspaces
      await writeFile(join(tmp, "yarn.lock"), "");
      await writeFile(join(tmp, "nx.json"), JSON.stringify({ targetDefaults: {} }));
      await mkdir(join(tmp, "packages/foo"), { recursive: true });
      await writeFile(
        join(tmp, "packages/foo/package.json"),
        JSON.stringify({ name: "@x/foo", version: "1.0.0" }),
      );
      const result = await resolveWorkspaces(tmp);
      expect(result?.manifest_tool).toBe("nx");
      expect(result?.workspaces.find((w) => w.name === "@x/foo")).toBeDefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

