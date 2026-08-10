import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const checker = join(process.cwd(), "scripts/check-agent-codesift.mjs");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { home: string; project: string; configPath: string; extraClient: string } {
  const home = mkdtempSync(join(tmpdir(), "codesift-agent-check-"));
  dirs.push(home);
  const project = join(home, "DEV", "app");
  mkdirSync(project, { recursive: true });
  const configPath = join(home, "claude.json");
  const extraClient = join(home, "extra-client.json");
  return { home, project, configPath, extraClient };
}

function run(
  fx: ReturnType<typeof fixture>,
  config: object,
  options: { extraClient?: object; path?: string } = {},
) {
  writeFileSync(fx.configPath, JSON.stringify(config), "utf-8");
  if (options.extraClient) writeFileSync(fx.extraClient, JSON.stringify(options.extraClient), "utf-8");
  return spawnSync(process.execPath, [checker, "--json"], {
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: fx.home,
      PATH: options.path ?? process.env.PATH,
      CODESIFT_CHECK_CONFIG: fx.configPath,
      CODESIFT_CHECK_EXTRA_CLIENT: fx.extraClient,
    },
  });
}

describe("check-agent-codesift", () => {
  it("resolves the configured executable instead of treating its first argument as argv0", () => {
    const fx = fixture();
    const result = run(fx, {
      projects: {
        [fx.project]: { mcpServers: { codesift: { command: process.execPath, args: ["serve"] } } },
      },
      mcpServers: { codesift: { command: process.execPath } },
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).broken).toEqual([]);
  });

  it("reports a missing codesift script stored in another client's args", () => {
    const fx = fixture();
    const missing = join(fx.home, "missing-codesift", "dist", "cli.js");
    const result = run(
      fx,
      { mcpServers: { codesift: { command: process.execPath } } },
      { extraClient: { mcpServers: { codesift: { command: process.execPath, args: [missing] } } } },
    );

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).broken).toEqual(
      expect.arrayContaining([expect.objectContaining({ dir: expect.stringContaining(missing) })]),
    );
  });

  it("skips runtime option values before validating the actual script", () => {
    const fx = fixture();
    const preload = join(fx.home, "preload.js");
    const missing = join(fx.home, "missing-codesift.js");
    writeFileSync(preload, "", "utf-8");
    const result = run(fx, {
      projects: {
        [fx.project]: {
          mcpServers: { codesift: { command: process.execPath, args: ["--require", preload, missing] } },
        },
      },
      mcpServers: { codesift: { command: process.execPath } },
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).broken).toEqual(
      expect.arrayContaining([expect.objectContaining({ why: expect.stringContaining(missing) })]),
    );
  });

  it("health-checks each distinct daemon origin", () => {
    const fx = fixture();
    const secondProject = join(fx.home, "DEV", "other");
    mkdirSync(secondProject, { recursive: true });
    const bin = join(fx.home, "bin");
    mkdirSync(bin);
    const curl = join(bin, "curl");
    writeFileSync(curl, "#!/bin/sh\ncase \"$*\" in *:2222/*) printf 503 ;; *) printf 200 ;; esac\n", "utf-8");
    chmodSync(curl, 0o755);

    const result = run(
      fx,
      {
        projects: {
          [fx.project]: { mcpServers: { codesift: { type: "http", url: "http://127.0.0.1:1111/mcp" } } },
          [secondProject]: { mcpServers: { codesift: { type: "http", url: "http://127.0.0.1:2222/mcp" } } },
        },
        mcpServers: { codesift: { command: process.execPath } },
      },
      { path: `${bin}:${process.env.PATH ?? ""}` },
    );

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).broken).toEqual(
      expect.arrayContaining([expect.objectContaining({ dir: secondProject })]),
    );
  });

  it("fails a pinned global HTTP fallback for an unlisted repository", () => {
    const fx = fixture();
    mkdirSync(join(fx.project, ".git"));
    const bin = join(fx.home, "bin");
    mkdirSync(bin);
    const curl = join(bin, "curl");
    writeFileSync(curl, "#!/bin/sh\nprintf 200\n", "utf-8");
    chmodSync(curl, 0o755);

    const result = run(
      fx,
      { mcpServers: { codesift: { type: "http", url: "http://127.0.0.1:1111/mcp?cwd=/wrong" } } },
      { path: `${bin}:${process.env.PATH ?? ""}` },
    );

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).broken).toEqual(
      expect.arrayContaining([expect.objectContaining({ why: expect.stringContaining("wrong repo") })]),
    );
  });

  it("reports a malformed global HTTP URL instead of crashing", () => {
    const fx = fixture();
    const result = run(fx, { mcpServers: { codesift: { type: "http", url: "://bad" } } });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).broken).toEqual(
      expect.arrayContaining([expect.objectContaining({ why: expect.stringContaining("invalid daemon URL") })]),
    );
  });
});
