import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const checker = resolve("scripts/check-agent-codesift.mjs");

describe("check-agent-codesift", () => {
  let home: string;
  let project: string;
  let configPath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "codesift-agent-check-"));
    project = join(home, "DEV", "repo");
    mkdirSync(project, { recursive: true });
    configPath = join(home, ".claude.json");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function run(config: unknown) {
    writeFileSync(configPath, JSON.stringify(config));
    return spawnSync(process.execPath, [checker, "--json"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: home,
        CODESIFT_CHECK_CONFIG: configPath,
      },
    });
  }

  it("validates the command before a node script argument", () => {
    const entry = { command: process.execPath, args: [resolve("src/cli.ts")] };
    const result = run({ projects: { [project]: { mcpServers: { codesift: entry } } }, mcpServers: { codesift: entry } });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).broken).toEqual([]);
  });

  it("accepts the standard npx flag-first shape", () => {
    const npx = execFileSync("which", ["npx"], { encoding: "utf-8" }).trim();
    const entry = { command: npx, args: ["-y", "codesift-mcp"] };
    const result = run({ projects: { [project]: { mcpServers: { codesift: entry } } }, mcpServers: { codesift: entry } });

    expect(result.status).toBe(0);
  });

  it("fails when an interpreter target does not exist", () => {
    const entry = { command: process.execPath, args: ["missing-codesift.js"] };
    const result = run({ projects: { [project]: { mcpServers: { codesift: entry } } }, mcpServers: { codesift: entry } });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).broken[0].why).toMatch(/does not resolve/);
  });
});
