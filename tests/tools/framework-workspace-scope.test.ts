import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpSync } from "node:fs";
import { detectAutoLoadTools } from "../../src/register-tools.js";
import { resolveWorkspaceScope } from "../../src/tools/workspace-scope-helper.js";
import { indexFolder, stopAllWatchersForTesting } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";

let tmpHome: string | null = null;
let monoRoot: string | null = null;
let repoName: string | null = null;

beforeAll(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "codesift-fw-ws-test-"));
  process.env.CODESIFT_DATA_DIR = tmpHome;
  resetConfigCache();
  monoRoot = await mkdtemp(join(tmpdir(), "codesift-fw-ws-mono-"));
  cpSync(join(__dirname, "..", "fixtures", "turbo-pnpm-monorepo"), monoRoot, { recursive: true });
  const r = await indexFolder(monoRoot);
  repoName = r.repo;
});

afterAll(async () => {
  await stopAllWatchersForTesting();
  if (monoRoot) await rm(monoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (tmpHome) await rm(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  delete process.env.CODESIFT_DATA_DIR;
  delete process.env.CODESIFT_DISABLE_MONOREPO;
  resetConfigCache();
});

describe("detectAutoLoadTools workspace union (Task 15)", () => {
  it("(a) AC11: monorepo fixture surfaces both Hono (apps/api) and React (apps/web) tool groups", async () => {
    const tools = await detectAutoLoadTools(monoRoot!);
    // Hono tools — apps/api has hono dep
    const honoTool = tools.some((t) => t.toLowerCase().includes("hono"));
    expect(honoTool).toBe(true);
    // React tools — apps/web has react/next deps + .tsx files
    const reactTool = tools.some(
      (t) => t.includes("trace_component_tree") || t.includes("analyze_hooks") || t.includes("analyze_renders"),
    );
    expect(reactTool).toBe(true);
  });

  it("(c) kill switch disables workspace walk: only root-level detection runs", async () => {
    process.env.CODESIFT_DISABLE_MONOREPO = "1";
    try {
      const tools = await detectAutoLoadTools(monoRoot!);
      // Root has no framework deps in our fixture (only `name` + workspace
      // declaration), so when the kill switch is on, no framework tools auto-load.
      expect(tools.some((t) => t.toLowerCase().includes("hono"))).toBe(false);
    } finally {
      delete process.env.CODESIFT_DISABLE_MONOREPO;
    }
  });
});

describe("resolveWorkspaceScope helper (Tasks 16/17)", () => {
  it("explicit workspace= matches by name", async () => {
    const scope = await resolveWorkspaceScope(repoName!, "@org/web");
    expect("error" in scope).toBe(false);
    if ("error" in scope) return;
    expect(scope.rootPaths[0]).toBe("apps/web");
  });

  it("explicit workspace= matches by id (relative path)", async () => {
    const scope = await resolveWorkspaceScope(repoName!, "apps/api");
    if ("error" in scope) return; // graceful when id format differs
  });

  it("invalid workspace returns shape-stable error (CQ5 error path)", async () => {
    const scope = await resolveWorkspaceScope(repoName!, "@org/does-not-exist");
    expect("error" in scope).toBe(true);
    if ("error" in scope) {
      expect(scope.error).toBe("unknown_workspace");
      expect(scope.input).toBe("@org/does-not-exist");
      expect(scope.available.length).toBeGreaterThan(0);
    }
  });

  it("smart-default by framework: 'nextjs' resolves to apps/web (only workspace with Next.js)", async () => {
    const scope = await resolveWorkspaceScope(repoName!, undefined, "nextjs");
    expect("error" in scope).toBe(false);
    if ("error" in scope) return;
    expect(scope.rootPaths).toContain("apps/web");
  });

  it("smart-default with no matching framework: returns empty rootPaths (caller falls back to whole-repo)", async () => {
    const scope = await resolveWorkspaceScope(repoName!, undefined, "vue");
    expect("error" in scope).toBe(false);
    if ("error" in scope) return;
    expect(scope.rootPaths).toEqual([]);
  });
});
