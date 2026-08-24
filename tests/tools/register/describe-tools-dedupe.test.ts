import { beforeEach, describe, expect, it } from "vitest";
import { describeTools, resetDeliveredSchemasForTesting } from "../../../src/register-tools/discovery.js";
import { resetSession } from "../../../src/storage/session-state.js";
import { runWithRequestContext } from "../../../src/server-helpers/request-context.js";

const POINTER = /already returned earlier in this session/;

beforeEach(() => {
  resetDeliveredSchemasForTesting();
  resetSession();
});

describe("describe_tools delivery dedupe", () => {
  it("returns the full schema the first time", () => {
    const r = describeTools(["scan_secrets"]);
    expect(r.tools[0]!.params.length).toBeGreaterThan(0);
    expect(r.tools[0]!.description).not.toMatch(POINTER);
  });

  it("returns a pointer instead of repeating a schema in the same session", () => {
    describeTools(["scan_secrets"]);
    const again = describeTools(["scan_secrets"]);
    expect(again.tools[0]!.params).toEqual([]);
    expect(again.tools[0]!.description).toMatch(POINTER);
  });

  // The response cache keys on the exact argument set, so it never saw this: a call for names of
  // which SOME were already delivered is a cache miss and a full re-send. Delivery is tracked per
  // name, so the overlap is caught and only the new schema is paid for.
  it("handles partial overlap — repeats pointer only for the names already sent", () => {
    describeTools(["scan_secrets", "audit_scan"]);
    const mixed = describeTools(["scan_secrets", "find_dead_code", "audit_scan"]);
    const byName = Object.fromEntries(mixed.tools.map((t) => [t.name, t]));
    expect(byName["scan_secrets"]!.params).toEqual([]);
    expect(byName["audit_scan"]!.params).toEqual([]);
    expect(byName["find_dead_code"]!.params.length).toBeGreaterThan(0);
  });

  // Context can be compacted between the two calls, so a pointer must be recoverable. Without this
  // the dedupe would trade tokens for an agent that cannot get a schema it genuinely lost.
  it("force=true returns the full schema again", () => {
    describeTools(["scan_secrets"]);
    const forced = describeTools(["scan_secrets"], { force: true });
    expect(forced.tools[0]!.params.length).toBeGreaterThan(0);
    expect(forced.tools[0]!.description).not.toMatch(POINTER);
  });

  it("still reports unknown names rather than silently dropping them", () => {
    const r = describeTools(["scan_secrets", "no_such_tool_xyz"]);
    expect(r.not_found).toContain("no_such_tool_xyz");
  });

  // The HTTP daemon serves many sessions from ONE process, and SESSION_ID is a per-process
  // constant — so there is no key that separates its sessions. Deduping there would tell session B
  // that session A's schema had already been delivered: a pointer to text it never received. The
  // guard is the presence of a request context, which only the daemon establishes.
  it("does not dedupe under a request context (the shared daemon)", async () => {
    await runWithRequestContext({ cwd: process.cwd() }, async () => {
      describeTools(["scan_secrets"]);
      const again = describeTools(["scan_secrets"]);
      expect(again.tools[0]!.params.length).toBeGreaterThan(0);
      expect(again.tools[0]!.description).not.toMatch(POINTER);
    });
  });

  // …and the stdio path is unaffected by that guard: one process there IS one session.
  it("still dedupes outside a request context (stdio)", () => {
    describeTools(["audit_scan"]);
    expect(describeTools(["audit_scan"]).tools[0]!.description).toMatch(POINTER);
  });
});
