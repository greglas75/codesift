import { describe, it, expect, beforeEach } from "vitest";
import { wrapTool, resetSessionState } from "../../src/server-helpers.js";

describe("formatResponse behavior (via wrapTool)", () => {
  beforeEach(() => {
    resetSessionState();
  });

  it("passes short response through with savings hint", async () => {
    const result = await wrapTool("test_tool", { repo: "local/test" }, async () => "short response")();
    expect(result.content[0].text).toContain("short response");
  });

  it("truncates response exceeding MAX_RESPONSE_TOKENS", async () => {
    const bigStr = "x".repeat(110_000); // > 105K chars (30_000 tokens * 3.5 chars/token = 105_000)
    const result = await wrapTool("test_tool", { repo: "local/test" }, async () => bigStr)();
    expect(result.content[0].text.length).toBeLessThan(110_000);
    expect(result.content[0].text).toContain("truncated");
  });

  it("handles errors without crashing", async () => {
    const result = await wrapTool("test_tool", { repo: "local/test" }, async () => {
      throw new Error("test error");
    })();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("test error");
  });

  it("returns cached response for identical calls within TTL", async () => {
    let callCount = 0;
    const fn = async () => { callCount++; return "result"; };
    await wrapTool("list_repos", {}, fn)();
    await wrapTool("list_repos", {}, fn)();
    // list_repos is a SESSION_PERMANENT_TOOLS entry — second call should be cached
    expect(callCount).toBe(1);
  });
});
