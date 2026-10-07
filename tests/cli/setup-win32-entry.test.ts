import { describe, expect, it } from "vitest";
import { resolveMcpServerEntry } from "../../src/cli/setup/mcp.js";

describe("resolveMcpServerEntry on win32", () => {
  // Under Git Bash, `which` answered `/c/Users/x/AppData/Roaming/npm/codesift-mcp`, which Node on
  // Windows cannot spawn, and the real global binary is a `.cmd` shim a shell-less client cannot run.
  it("names this node and this package's server.js, never a `which` path", () => {
    const entry = resolveMcpServerEntry("win32");
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toHaveLength(1);
    expect(entry.args[0]).toMatch(/dist[\\/]server\.js$/);
  });
});
