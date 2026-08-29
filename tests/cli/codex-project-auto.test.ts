import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureCodexProjectConfig } from "../../src/cli/setup/codex-project-auto.js";

/**
 * Codex keeps MCP config in ONE global file, and an HTTP entry carries exactly one directory — so
 * the global entry is bare and a per-project file has to supply the directory. Measured
 * 2026-08-29: 31 working trees on this machine, ZERO with a project config, and a Codex session in
 * one of them concluded CodeSift could not see its files.
 */
describe("ensureCodexProjectConfig", () => {
  let home: string | null = null;
  let repo: string | null = null;

  function makeHome(entry: "http" | "stdio" | "none"): string {
    const h = mkdtempSync(join(tmpdir(), "codex-home-"));
    mkdirSync(join(h, ".codex"), { recursive: true });
    const blocks: Record<string, string> = {
      http: '[mcp_servers.codesift]\nurl = "http://127.0.0.1:7077/mcp"\n',
      stdio: '[mcp_servers.codesift]\ncommand = "/opt/homebrew/bin/codesift-mcp"\n',
      none: '[mcp_servers.other]\ncommand = "x"\n',
    };
    writeFileSync(join(h, ".codex", "config.toml"), blocks[entry]!);
    return h;
  }

  function makeMainCheckout(): string {
    const r = mkdtempSync(join(tmpdir(), "codex-repo-"));
    mkdirSync(join(r, ".git", "info"), { recursive: true });   // directory => main checkout
    return r;
  }

  function makeLinkedWorktree(): string {
    const r = mkdtempSync(join(tmpdir(), "codex-wt-"));
    // A linked worktree's `.git` is a FILE pointing at the parent's gitdir.
    writeFileSync(join(r, ".git"), "gitdir: /somewhere/.git/worktrees/feature\n");
    return r;
  }

  afterEach(() => {
    for (const d of [home, repo]) if (d) rmSync(d, { recursive: true, force: true });
    home = null; repo = null;
  });

  it("writes the project config for a main checkout", async () => {
    home = makeHome("http"); repo = makeMainCheckout();
    expect(await ensureCodexProjectConfig(repo, { home, env: {} })).toBe("written");

    const written = readFileSync(join(repo, ".codex", "config.toml"), "utf-8");
    expect(written).toContain("[mcp_servers.codesift]");
    expect(written).toContain("cwd=");
  });

  it("excludes the file locally rather than through .gitignore", async () => {
    // The file pins an ABSOLUTE path, so committing it would break the repo for everyone else.
    home = makeHome("http"); repo = makeMainCheckout();
    await ensureCodexProjectConfig(repo, { home, env: {} });

    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf-8")).toContain(".codex/");
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
  });

  it("SKIPS a linked worktree — this is the whole point of the restriction", async () => {
    // Pointing a worktree at itself makes the daemon index it as a repository of its own. 27 of
    // those starting at once saturated this machine for hours on 2026-08-28.
    home = makeHome("http"); repo = makeLinkedWorktree();
    expect(await ensureCodexProjectConfig(repo, { home, env: {} })).toBe("skipped-linked-worktree");
    expect(existsSync(join(repo, ".codex"))).toBe(false);
  });

  it("refuses when the GLOBAL entry is stdio — a hybrid breaks every server in the file", async () => {
    // Codex merges per key: a project `url` over a global `command` yields
    // "url is not supported for stdio" and the whole config fails to load.
    home = makeHome("stdio"); repo = makeMainCheckout();
    expect(await ensureCodexProjectConfig(repo, { home, env: {} })).toBe("skipped-codex-not-http");
    expect(existsSync(join(repo, ".codex"))).toBe(false);
  });

  it("does nothing when Codex has no codesift entry at all", async () => {
    home = makeHome("none"); repo = makeMainCheckout();
    expect(await ensureCodexProjectConfig(repo, { home, env: {} })).toBe("skipped-codex-not-http");
  });

  it("upgrades a project file written before per-client tool lists", async () => {
    // Codex merges the project file into the global one per key, so a project `url` WITHOUT
    // `client=` overrides the global one that has it — and this project silently loses the
    // front-loaded surface. Leaving it alone would be the polite wrong answer.
    home = makeHome("http"); repo = makeMainCheckout();
    mkdirSync(join(repo, ".codex"), { recursive: true });
    writeFileSync(join(repo, ".codex", "config.toml"),
      '[mcp_servers.codesift]\nurl = "http://127.0.0.1:7077/mcp?cwd=%2Fx"\n');

    expect(await ensureCodexProjectConfig(repo, { home, env: {} })).toBe("upgraded");
    expect(readFileSync(join(repo, ".codex", "config.toml"), "utf-8")).toContain("client=codex");
  });

  it("leaves a project file that already carries client= alone", async () => {
    home = makeHome("http"); repo = makeMainCheckout();
    mkdirSync(join(repo, ".codex"), { recursive: true });
    const good = '[mcp_servers.codesift]\nurl = "http://127.0.0.1:7077/mcp?client=codex&cwd=%2Fx"\n';
    writeFileSync(join(repo, ".codex", "config.toml"), good);

    expect(await ensureCodexProjectConfig(repo, { home, env: {} })).toBe("already-present");
    expect(readFileSync(join(repo, ".codex", "config.toml"), "utf-8")).toBe(good);
  });

  it("never overwrites a hand-written file that is already current", async () => {
    home = makeHome("http"); repo = makeMainCheckout();
    mkdirSync(join(repo, ".codex"), { recursive: true });
    writeFileSync(join(repo, ".codex", "config.toml"),
      '# hand written\nurl = "http://127.0.0.1:7077/mcp?client=codex"\n');

    expect(await ensureCodexProjectConfig(repo, { home, env: {} })).toBe("already-present");
    expect(readFileSync(join(repo, ".codex", "config.toml"), "utf-8")).toContain("# hand written");
  });

  it("can be turned off", async () => {
    home = makeHome("http"); repo = makeMainCheckout();
    const env = { CODESIFT_CODEX_PROJECT_CONFIG: "0" } as NodeJS.ProcessEnv;
    expect(await ensureCodexProjectConfig(repo, { home, env })).toBe("skipped-disabled");
    expect(existsSync(join(repo, ".codex"))).toBe(false);
  });

  it("reports rather than throws on a directory that is not a working tree", async () => {
    // registerRepo awaits this; a repository must register whether or not a client can be set up.
    home = makeHome("http"); repo = mkdtempSync(join(tmpdir(), "codex-plain-"));
    expect(await ensureCodexProjectConfig(repo, { home, env: {} })).toBe("skipped-linked-worktree");
  });
});
