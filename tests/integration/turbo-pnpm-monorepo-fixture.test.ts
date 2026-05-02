import { describe, expect, it, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setupGitFixture, type GitFixture } from "../fixtures/turbo-pnpm-monorepo/setup-git.js";

const FIXTURE_ROOT = join(__dirname, "..", "fixtures", "turbo-pnpm-monorepo");

describe("turbo-pnpm-monorepo fixture (Task 3)", () => {
  it("(a) fixture root exists", () => {
    expect(existsSync(FIXTURE_ROOT)).toBe(true);
  });

  it("(b) each expected workspace package.json is parseable JSON with name", () => {
    const expected = [
      ["apps/web", "@org/web"],
      ["apps/api", "@org/api"],
      ["packages/shared", "@org/shared"],
      ["packages/cycle-a", "@org/cycle-a"],
      ["packages/cycle-b", "@org/cycle-b"],
      ["packages/internal", "@org/internal"],
    ];
    for (const [rel, name] of expected) {
      const pkg = JSON.parse(readFileSync(join(FIXTURE_ROOT, rel, "package.json"), "utf-8"));
      expect(pkg.name).toBe(name);
    }
  });

  it("(c) pnpm-workspace.yaml contains !packages/internal negation", () => {
    const ws = readFileSync(join(FIXTURE_ROOT, "pnpm-workspace.yaml"), "utf-8");
    expect(ws).toMatch(/!packages\/internal/);
  });

  it("(d) apps/web/src/pages/index.tsx imports from @org/shared", () => {
    const src = readFileSync(join(FIXTURE_ROOT, "apps/web/src/pages/index.tsx"), "utf-8");
    expect(src).toMatch(/from\s+["']@org\/shared["']/);
  });

  it("(e) apps/api/src/routes/users.ts contains the deliberate @org/web import (boundary violation seed)", () => {
    const src = readFileSync(join(FIXTURE_ROOT, "apps/api/src/routes/users.ts"), "utf-8");
    expect(src).toMatch(/from\s+["']@org\/web/);
  });

  it("(f) packages/cycle-a and packages/cycle-b import each other", () => {
    const a = readFileSync(join(FIXTURE_ROOT, "packages/cycle-a/src/index.ts"), "utf-8");
    const b = readFileSync(join(FIXTURE_ROOT, "packages/cycle-b/src/index.ts"), "utf-8");
    expect(a).toMatch(/from\s+["']@org\/cycle-b["']/);
    expect(b).toMatch(/from\s+["']@org\/cycle-a["']/);
  });
});

describe("turbo-pnpm-monorepo git-setup helper (Task 3)", () => {
  let fixture: GitFixture | null = null;

  afterAll(() => {
    fixture?.cleanup();
  });

  it("creates a temp copy with 4-commit history (init / edit-shared / lockfile / delete-cycle-a)", () => {
    fixture = setupGitFixture();
    expect(fixture.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(fixture.editSharedSha).toMatch(/^[0-9a-f]{40}$/);
    expect(fixture.lockfileSha).toMatch(/^[0-9a-f]{40}$/);
    expect(fixture.deleteCycleASha).toMatch(/^[0-9a-f]{40}$/);
    // SHAs must all be distinct (each commit changed something)
    const shas = new Set([
      fixture.baseSha,
      fixture.editSharedSha,
      fixture.lockfileSha,
      fixture.deleteCycleASha,
    ]);
    expect(shas.size).toBe(4);
    // packages/cycle-a is gone at HEAD
    expect(existsSync(join(fixture.root, "packages/cycle-a"))).toBe(false);
    // pnpm-workspace.yaml present
    expect(existsSync(join(fixture.root, "pnpm-workspace.yaml"))).toBe(true);
  });
});
