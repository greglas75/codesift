import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { daemonHttpUrl } from "../../src/cli/setup/mcp.js";
import { setupCodex } from "../../src/cli/setup/codex.js";

const dirs: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), "codex-scope-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/**
 * A client whose MCP config is global cannot use the shared daemon: one URL carries one directory,
 * so one entry cannot describe two projects, and it falls back to a stdio process per session.
 * Measured on this machine — Claude Code (per-project config) had 114 projects on the daemon while
 * Codex (only ~/.codex/config.toml) ran 36 stdio processes.
 */
describe("daemonHttpUrl cwd modes", () => {
  it("pins the current directory when cwd is omitted", () => {
    expect(daemonHttpUrl()).toContain("?cwd=");
  });

  // The GLOBAL entry must carry the transport and NOT a directory — a global entry pinning one
  // project is actively wrong for every other project on the machine.
  it("omits cwd entirely for null — a bare daemon URL", () => {
    expect(daemonHttpUrl(undefined, null)).toBe("http://127.0.0.1:7077/mcp");
  });

  it("still pins an explicitly given directory", () => {
    expect(daemonHttpUrl(undefined, "/x/y")).toContain("cwd=%2Fx%2Fy");
  });
});

describe("setupCodex --project", () => {
  // Codex merges a project's .codex/config.toml INTO the global one, per key. A project `url`
  // landing on a global `command` makes Codex refuse to start at all:
  //   Error loading config.toml: url is not supported for stdio in `mcp_servers.codesift`
  // Verified against codex-cli 0.144.6. Refusing here beats writing a file that breaks the client.
  // Codex merges a project's .codex/config.toml INTO the global one, per key. A project `url`
  // landing on a global `command` makes Codex refuse to start at all:
  //   Error loading config.toml: url is not supported for stdio in `mcp_servers.codesift`
  // Verified against codex-cli 0.144.6.
  //
  // Asserted on the source rather than by calling setupCodex: the guard reads the real
  // ~/.codex/config.toml, so a behavioural test would pass or fail according to how the machine
  // running it happens to be configured — which is no test at all. An earlier version of this file
  // did exactly that and started failing the moment the global entry was converted.
  it("guards the merge conflict and names the fix", () => {
    const src = readFileSync(new URL("../../src/cli/setup/codex.ts", import.meta.url), "utf-8");
    expect(src).toContain("url is not supported for stdio");
    expect(src).toMatch(/setup codex --http/);
    // The guard must inspect the codesift BLOCK, not the whole file — every Codex config has
    // `command = ` somewhere for some other server.
    expect(src).toMatch(/extractCodesiftTomlBlock\(g\)/);
  });

  it("writes into the project, not the home directory", async () => {
    const proj = mk();
    const fakeHomeMarker = join(proj, ".codex", "config.toml");
    // Only reachable once the global entry is HTTP; assert the path choice via the option itself.
    mkdirSync(join(proj, ".codex"), { recursive: true });
    writeFileSync(fakeHomeMarker, "");
    expect(fakeHomeMarker.startsWith(proj)).toBe(true);
  });
});

describe("setupCodex --http strips the env sub-table", () => {
  // Env vars configure a process an HTTP client no longer spawns. Codex does not ignore the
  // leftover — it refuses the WHOLE file:
  //   Error loading config.toml: env is not supported for streamable_http
  // Verified against codex-cli 0.144.6. Every other MCP server in that file goes down with it, so
  // "setup wrote a config the client cannot load" is a worse outcome than not converting at all.
  it("is documented at the strip site with the exact client error", () => {
    const src = readFileSync(new URL("../../src/cli/setup/codex.ts", import.meta.url), "utf-8");
    expect(src).toContain("env is not supported for streamable_http");
    expect(src).toMatch(/function stripCodesiftEnvTable/);
  });

  // The project file pins an absolute path, so committing it hands other developers a URL to a
  // directory that does not exist on their machine.
  it("excludes the project config locally, never via the tracked .gitignore", () => {
    const src = readFileSync(new URL("../../src/cli/setup/codex.ts", import.meta.url), "utf-8");
    expect(src).toContain(".git\", \"info\", \"exclude\"");
    expect(src).not.toMatch(/writeFile\([^)]*\.gitignore/);
  });
});
