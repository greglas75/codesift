import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";

/**
 * Regression guard for the orphan-process leak: a stdio MCP server MUST exit
 * when its client disconnects (stdin EOF). Before the fix, transport.onclose
 * only logged, background timers held the event loop open, and the process
 * lingered under launchd forever — tens of GB and burned cores across sessions.
 */
describe("stdio server lifecycle — no orphan on parent disconnect", () => {
  it("exits promptly when stdin closes (EOF)", async () => {
    const serverPath = join(process.cwd(), "dist", "server.js");
    const child = spawn(process.execPath, [serverPath], {
      stdio: ["pipe", "ignore", "pipe"],
    });

    // Simulate the client going away: close stdin immediately.
    child.stdin.end();

    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(false); // still alive after the deadline → leak
      }, 8000);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    expect(exited).toBe(true);
  }, 15000);
});
