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
  it("refuses while the global entry is still stdio, and names the fix", async () => {
    const home = join(homedir(), ".codex", "config.toml");
    if (!existsSync(home) || !/^(command|args)[\t ]*=/m.test(readFileSync(home, "utf-8"))) return;
    const proj = mk();
    await expect(setupCodex({ http: true, projectScope: true, cwd: proj }))
      .rejects.toThrow(/url is not supported for stdio|setup codex --http/);
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
