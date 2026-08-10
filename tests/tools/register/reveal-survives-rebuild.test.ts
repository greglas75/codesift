import { describe, it, expect, beforeEach } from "vitest";
import { registerTools } from "../../../src/register-tools.js";
import {
  enableToolByName,
  getToolHandle,
  resetRevealedToolsForTesting,
} from "../../../src/register-tools/runtime.js";

/**
 * A revealed tool must stay callable when the server is rebuilt.
 *
 * Under stdio one `McpServer` lives for the whole session, so `describe_tools(reveal=true)` setting
 * `handle.enabled = true` was enough. The HTTP daemon serves STATELESSLY — it builds a fresh server
 * per request — and `resetToolRegistrationContext` clears the handle map, so the reveal applied to
 * the instance that handled that one request and was gone by the next.
 *
 * Measured 2026-08-07, identical sequence over both transports:
 *   stdio : 60 tools -> reveal -> 62 tools -> find_dead_code returned 873 symbols
 *   http  : 60 tools -> reveal -> 60 tools -> "Tool find_dead_code not found"
 *
 * The failure was quiet in the worst way: `describe_tools` returns the schema either way, so the
 * reveal LOOKED like it worked and the agent got a full parameter list for a tool it could not
 * call. Agents reported it as "codesift partially unavailable".
 */

/** Minimal stand-in for McpServer — registerTools only needs `registerTool` to hand back a handle. */
function fakeServer() {
  const registered: string[] = [];
  return {
    registered,
    registerTool(name: string) {
      registered.push(name);
      return { enabled: false, enable() { this.enabled = true; }, disable() { this.enabled = false; } };
    },
  };
}

const HIDDEN = "find_dead_code";

beforeEach(() => {
  resetRevealedToolsForTesting();
});

describe("a revealed tool survives a server rebuild", () => {
  it("is hidden before reveal, enabled after, and STILL enabled on a rebuilt server", () => {
    const first = fakeServer();
    registerTools(first as never, { deferNonCore: true });

    // Not part of the core surface, so it starts absent or disabled.
    expect(getToolHandle(HIDDEN)?.enabled ?? false).toBe(false);

    expect(enableToolByName(HIDDEN)).toBe(true);
    expect(getToolHandle(HIDDEN)?.enabled).toBe(true);

    // The daemon builds a NEW server for the next request. This is the assertion that failed.
    const second = fakeServer();
    registerTools(second as never, { deferNonCore: true });

    expect(getToolHandle(HIDDEN)?.enabled).toBe(true);
  });

  it("does not resurrect reveals from an earlier PROCESS", () => {
    // The set is process-scoped by design; a fresh process must start with the core surface only,
    // or hidden tools would leak into every future session's ListTools.
    const s1 = fakeServer();
    registerTools(s1 as never, { deferNonCore: true });
    enableToolByName(HIDDEN);
    expect(getToolHandle(HIDDEN)?.enabled).toBe(true);

    resetRevealedToolsForTesting(); // stands in for "a new process started"
    const s2 = fakeServer();
    registerTools(s2 as never, { deferNonCore: true });

    expect(getToolHandle(HIDDEN)?.enabled ?? false).toBe(false);
  });

  it("keeps the core surface unchanged — reveal adds, it does not widen the default", () => {
    const before = fakeServer();
    registerTools(before as never, { deferNonCore: true });
    const coreCount = before.registered.length;

    enableToolByName(HIDDEN);

    const after = fakeServer();
    registerTools(after as never, { deferNonCore: true });

    // Exactly one extra registration: the revealed tool. Commit 3e1ec6c measured that growing the
    // default ListTools depressed adoption by >90%, so "restore what was revealed" must never
    // become "enable more by default".
    expect(after.registered.length).toBe(coreCount + 1);
    expect(after.registered).toContain(HIDDEN);
  });
});
