import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { wrapTool, resetSessionState, registerShortener, resetShorteningRegistry } from "../../src/server-helpers.js";

let tmpDir: string;

describe("formatResponse behavior (via wrapTool)", () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "codesift-test-"));
    process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
    resetSessionState();
  });

  afterEach(async () => {
    delete process.env["CODESIFT_DATA_DIR"];
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
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

describe("progressive cascade", () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "codesift-test-"));
    process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
    resetSessionState();
    resetShorteningRegistry();
  });

  afterEach(async () => {
    delete process.env["CODESIFT_DATA_DIR"];
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    resetShorteningRegistry();
  });

  it("triggers compact formatter when response > 52.5K chars", async () => {
    registerShortener("test_tool", {
      compact: () => "compacted result",
      counts: () => "3 items",
    });
    const bigData = { items: "x".repeat(55_000) };
    const result = await wrapTool("test_tool", { repo: "local/test" }, async () => bigData)();
    expect(result.content[0].text).toContain("[compact]");
    expect(result.content[0].text).toContain("compacted result");
  });

  it("triggers counts formatter when response > 87.5K chars", async () => {
    registerShortener("test_tool", {
      compact: () => "x".repeat(90_000), // compact is still too big
      counts: () => "3 items total",
    });
    const bigData = { items: "x".repeat(90_000) };
    const result = await wrapTool("test_tool", { repo: "local/test" }, async () => bigData)();
    expect(result.content[0].text).toContain("[counts]");
    expect(result.content[0].text).toContain("3 items total");
  });

  it("skips cascade for codebase_retrieval", async () => {
    registerShortener("codebase_retrieval", {
      compact: () => "should not appear",
    });
    const bigStr = "x".repeat(55_000);
    const result = await wrapTool("codebase_retrieval", { repo: "local/test" }, async () => bigStr)();
    expect(result.content[0].text).not.toContain("[compact]");
  });

  it("skips cascade when detail_level is explicitly set", async () => {
    registerShortener("test_tool", {
      compact: () => "should not appear",
    });
    const bigStr = "x".repeat(55_000);
    const result = await wrapTool("test_tool", { repo: "local/test", detail_level: "full" }, async () => bigStr)();
    expect(result.content[0].text).not.toContain("[compact]");
  });

  it("skips cascade when token_budget is explicitly set", async () => {
    registerShortener("test_tool", {
      compact: () => "should not appear",
    });
    const bigStr = "x".repeat(55_000);
    const result = await wrapTool("test_tool", { repo: "local/test", token_budget: 5000 }, async () => bigStr)();
    expect(result.content[0].text).not.toContain("[compact]");
  });

  it("does NOT skip cascade for falsy non-string detail_level", async () => {
    registerShortener("test_tool", {
      compact: () => "compacted",
    });
    const bigData = { items: "x".repeat(55_000) };
    const result = await wrapTool("test_tool", { repo: "local/test", detail_level: false }, async () => bigData)();
    expect(result.content[0].text).toContain("[compact]");
  });

  it("falls through gracefully for unregistered tool", async () => {
    const bigStr = "x".repeat(55_000);
    const result = await wrapTool("unregistered_tool", { repo: "local/test" }, async () => bigStr)();
    expect(result.content[0].text).not.toContain("[compact]");
    // Should still work — just no cascade, pass through as-is (or hard truncate if > 105K)
  });
});
