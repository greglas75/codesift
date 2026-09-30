import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTsserverPath } from "../../src/lsp/lsp-servers.js";

const TS = join("node_modules", "typescript", "lib", "tsserver.js");
const none = () => null;

function only(...present: string[]) {
  const set = new Set(present);
  return (p: string) => set.has(p);
}

describe("resolveTsserverPath", () => {
  it("prefers the workspace's own TypeScript", () => {
    const root = "/repo/wt";
    const own = join(root, TS);
    expect(resolveTsserverPath(root, {
      exists: only(own, "/global/typescript/lib/tsserver.js"),
      gitCommonDir: none, env: {}, ownResolve: none, globalRoot: () => "/global",
    })).toBe(own);
  });

  it("walks up to a monorepo root", () => {
    const hit = join("/repo", TS);
    expect(resolveTsserverPath("/repo/packages/api", {
      exists: only(hit), gitCommonDir: none, env: {}, ownResolve: none, globalRoot: none,
    })).toBe(hit);
  });

  it("uses the main checkout of a linked worktree that has no node_modules", () => {
    const main = join("/DEV/tgm-survey-platform", TS);
    expect(resolveTsserverPath("/DEV/tgm-worktrees/feature-x", {
      exists: only(main),
      gitCommonDir: () => "/DEV/tgm-survey-platform/.git",
      env: {}, ownResolve: none, globalRoot: none,
    })).toBe(main);
  });

  it("honours CODESIFT_TSSERVER_PATH before CodeSift's own and the global install", () => {
    expect(resolveTsserverPath("/x", {
      exists: only("/custom/tsserver.js", "/own/tsserver.js", "/g/typescript/lib/tsserver.js"),
      gitCommonDir: none, env: { CODESIFT_TSSERVER_PATH: "/custom/tsserver.js" },
      ownResolve: () => "/own/tsserver.js", globalRoot: () => "/g",
    })).toBe("/custom/tsserver.js");
  });

  it("falls back to the global npm install", () => {
    expect(resolveTsserverPath("/x", {
      exists: only("/g/typescript/lib/tsserver.js"),
      gitCommonDir: none, env: {}, ownResolve: none, globalRoot: () => "/g",
    })).toBe("/g/typescript/lib/tsserver.js");
  });

  it("returns null when nothing exists — the server then looks for itself, as before", () => {
    expect(resolveTsserverPath("/x", {
      exists: () => false, gitCommonDir: none, env: { CODESIFT_TSSERVER_PATH: "/missing" },
      ownResolve: () => "/missing2", globalRoot: () => "/g",
    })).toBeNull();
  });
});
