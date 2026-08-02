import { describe, it, expect } from "vitest";

import { withTimeout } from "../../src/register-tool-groups/handler-wrappers.js";
import {
  currentAbortSignal,
  currentCwd,
  runWithRequestContext,
} from "../../src/server-helpers/request-context.js";

/**
 * Answering the client is not the same as stopping the work.
 *
 * `withTimeout` resolved `timed_out` and left the handler running. Measured
 * over one day against a 90-second budget: `scan_secrets` reached 5.1 hours,
 * `find_references` 5.0, `search_patterns` 4.9 — all for callers that had
 * already given up, and typically alongside the narrower retry the agent issued
 * next. That is what drove this machine's load average past 600.
 *
 * `search_text` was the exception and stayed at ~2 minutes, because it has its
 * own wall clock with a real `controller.abort()`. These tests hold the general
 * wrapper to the same standard.
 */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("withTimeout cancels the work it abandons", () => {
  it("aborts the ambient signal when the budget expires", async () => {
    let signalSeen: AbortSignal | undefined;
    const handler = async (): Promise<string> => {
      signalSeen = currentAbortSignal();
      await sleep(300);
      return "late";
    };

    const result = await withTimeout(handler, 20, "slow_tool")();

    expect(result).toEqual({ status: "timed_out", tool: "slow_tool" });
    expect(signalSeen).toBeDefined();
    expect(signalSeen?.aborted).toBe(true);
  });

  it("leaves the signal unaborted when the handler finishes in time", async () => {
    let signalSeen: AbortSignal | undefined;
    const handler = async (): Promise<string> => {
      signalSeen = currentAbortSignal();
      return "fast";
    };

    await expect(withTimeout(handler, 5_000)()).resolves.toBe("fast");
    await sleep(20);
    expect(signalSeen?.aborted).toBe(false);
  });

  it("keeps the caller's working directory rather than replacing the context", async () => {
    // The wrapper adds a signal to whatever context is already in scope. If it
    // built a fresh one instead, every daemon-served call would lose the
    // client's directory and resolve repos against `/` again.
    let cwdSeen: string | undefined;
    const handler = async (): Promise<void> => {
      cwdSeen = currentCwd();
    };

    await runWithRequestContext({ cwd: "/some/client/project" }, () =>
      withTimeout(handler, 5_000)(),
    );

    expect(cwdSeen).toBe("/some/client/project");
  });

  it("still surfaces a handler error rather than swallowing it", async () => {
    const handler = async (): Promise<never> => {
      throw new Error("boom");
    };
    await expect(withTimeout(handler, 5_000)()).rejects.toThrow("boom");
  });
});
