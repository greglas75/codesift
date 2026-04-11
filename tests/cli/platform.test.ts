import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectPlatform, detectPlatformFromClientInfo } from "../../src/cli/platform.js";

describe("detectPlatform", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env["CLAUDECODE"];
    delete process.env["CODEX_THREAD_ID"];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("detects Claude Code from CLAUDECODE=1", () => {
    process.env["CLAUDECODE"] = "1";
    expect(detectPlatform()).toBe("claude");
  });

  it("detects Codex from CODEX_THREAD_ID", () => {
    process.env["CODEX_THREAD_ID"] = "abc-123";
    expect(detectPlatform()).toBe("codex");
  });

  it("returns 'unknown' when no env vars set", () => {
    expect(detectPlatform()).toBe("unknown");
  });

  it("Claude takes priority over Codex when both set", () => {
    process.env["CLAUDECODE"] = "1";
    process.env["CODEX_THREAD_ID"] = "abc-123";
    expect(detectPlatform()).toBe("claude");
  });
});

describe("detectPlatformFromClientInfo", () => {
  it("detects claude-code", () => {
    expect(detectPlatformFromClientInfo("claude-code")).toBe("claude");
  });

  it("detects codex-mcp-client", () => {
    expect(detectPlatformFromClientInfo("codex-mcp-client")).toBe("codex");
  });

  it("detects Codex Desktop via substring match", () => {
    expect(detectPlatformFromClientInfo("Codex Desktop")).toBe("codex");
  });

  it("detects gemini-cli-mcp-client", () => {
    expect(detectPlatformFromClientInfo("gemini-cli-mcp-client")).toBe("gemini");
  });

  it("detects Gemini CLI via substring match", () => {
    expect(detectPlatformFromClientInfo("Gemini CLI")).toBe("gemini");
  });

  it("detects Cline", () => {
    expect(detectPlatformFromClientInfo("Cline")).toBe("cline");
  });

  it("detects continue-client", () => {
    expect(detectPlatformFromClientInfo("continue-client")).toBe("continue");
  });

  it("returns 'unknown' for unrecognized client", () => {
    expect(detectPlatformFromClientInfo("some-other-client")).toBe("unknown");
  });
});
