import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mockExecFileSync = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: mockExecFileSync,
  };
});

const { COMMAND_MAP } = await import("../../src/cli/commands.js");

function psOutput(): string {
  return [
    " 101 1 204800 node /Users/greglas/DEV/codesift-mcp/dist/server.js",
    " 102 1 51200 npm exec chrome-devtools-mcp@latest --isolated",
    " 103 102 40960 chrome-devtools-mcp",
    " 104 1 61440 npm exec @sentry/mcp-server --access-token=secret",
    " 105 1 65536 npm exec @playwright/mcp@latest",
    " 106 1 102400 node /Users/greglas/.npm-global/bin/codesift-mcp",
    " 107 1 2048 node /tmp/other.js",
  ].join("\n");
}

describe("codesift cleanup-processes", () => {
  let stdout = "";
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = "";
    mockExecFileSync.mockReturnValue(psOutput());
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockExecFileSync.mockReset();
  });

  it("dry-run reports legacy and aux MCP processes without killing", async () => {
    await COMMAND_MAP["cleanup-processes"]!([], { json: true, "dry-run": true });

    expect(killSpy).not.toHaveBeenCalled();
    const out = JSON.parse(stdout);
    expect(out.dry_run).toBe(true);
    expect(out.matched).toBe(5);
    expect(out.by_reason["legacy-dev-dist-server"].count).toBe(1);
    expect(out.by_reason["sentry-mcp"].count).toBe(1);
    expect(out.by_reason["global-codesift-mcp"]).toBeUndefined();
  });

  it("kills legacy and aux MCP processes by default", async () => {
    await COMMAND_MAP["cleanup-processes"]!([], { json: true });

    expect(killSpy).toHaveBeenCalledTimes(5);
    expect(killSpy).toHaveBeenCalledWith(101, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(105, "SIGKILL");
    expect(killSpy).not.toHaveBeenCalledWith(106, "SIGKILL");
  });

  it("kills global codesift-mcp only when explicitly requested", async () => {
    await COMMAND_MAP["cleanup-processes"]!([], { json: true, "global-codesift": true });

    expect(killSpy).toHaveBeenCalledWith(106, "SIGKILL");
    const out = JSON.parse(stdout);
    expect(out.include_global_codesift).toBe(true);
    expect(out.by_reason["global-codesift-mcp"].count).toBe(1);
  });
});
