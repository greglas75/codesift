import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "../..");

describe("nextjs scripts smoke test", () => {
  it("validate-nextjs-accuracy.ts exits with code 0", () => {
    const res = spawnSync(
      "npx",
      ["tsx", "scripts/validate-nextjs-accuracy.ts"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    if (res.status !== 0) {
      // Surface stderr to the test output for debugging
      console.error(res.stdout);
      console.error(res.stderr);
    }
    expect(res.status).toBe(0);
  }, 30000);

  it("benchmark-nextjs-tools.ts exits with code 0", () => {
    const res = spawnSync(
      "npx",
      ["tsx", "scripts/benchmark-nextjs-tools.ts"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    if (res.status !== 0) {
      console.error(res.stdout);
      console.error(res.stderr);
    }
    expect(res.status).toBe(0);
  }, 120000);

  it("validate-nextjs-route-count.ts exits with code 0", () => {
    const res = spawnSync(
      "npx",
      ["tsx", "scripts/validate-nextjs-route-count.ts"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    if (res.status !== 0) {
      console.error(res.stdout);
      console.error(res.stderr);
    }
    expect(res.status).toBe(0);
  }, 60000);
});
